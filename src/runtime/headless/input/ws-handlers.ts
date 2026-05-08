// Spec 264 — WebSocket handlers for browser input events.
//
// These handlers are designed to be registered with V3WsServer
// (src/workspace-ui/v3-ws-server.ts) via `server.on(method, handler)`.
//
// Protocol (JSON-RPC 2.0 methods):
//   input/keyboard_press   { session_id, code }
//   input/keyboard_release { session_id, code }
//   input/joystick_set     { session_id, port, directions, fire }
//   input/load_config      {}  → InputConfig
//   input/save_config      { config: InputConfig }  → { ok: true }
//
// The handlers call session.keyboard.pressKey / setJoystick* on the
// integrated session. They are wired in during V3WsServer construction
// via registerInputHandlers().
//
// Note: keyboard_press/release use the "live press" model — the key
// remains active until release. holdCycles is set to a large sentinel
// (MaxSafeInt) and the keyboard matrix is cleared on release by name.

import type { InputConfig } from "./input-config.js";
import { loadInputConfig, saveInputConfig } from "./input-config.js";
import { translateKey } from "./keymap.js";

// ------------------------------------------------------------------
// Session adapter — matches IntegratedSession API from agent-workflows.
// The WS handler calls these methods; the session implements them.
// ------------------------------------------------------------------
export interface InputSessionAdapter {
  keyboard: {
    pressKey(key: string, holdCycles: number, delayCycles?: number): void;
    clearEventByKey?: (key: string) => void;
    clearEvents(): void;
  };
  joystick1: { up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean };
  joystick2: { up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean };
  setJoystick1?(state: Partial<{ up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean }>): void;
  setJoystick2?(state: Partial<{ up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean }>): void;
  triggerRestoreNmi?(): void;
}

// Sentinel hold-cycles value meaning "hold until explicit release".
const HELD_CYCLES = 0x7fff_ffff;

// Per-client state: tracks which keys are currently held.
// keyed by session_id → set of held C64KeyName strings.
const heldKeys = new Map<string, Set<string>>();

function getHeldKeys(sessionId: string): Set<string> {
  let s = heldKeys.get(sessionId);
  if (!s) { s = new Set(); heldKeys.set(sessionId, s); }
  return s;
}

// ------------------------------------------------------------------
// Individual handler implementations
// ------------------------------------------------------------------

/** input/keyboard_press — translate and hold key until release. */
export function handleKeyboardPress(
  params: { session_id: string; code: string; mode?: "qwerty" | "positional" },
  getSession: (id: string) => InputSessionAdapter | undefined,
): { ok: true; c64Key: string } | { error: string } {
  const session = getSession(params.session_id);
  if (!session) return { error: `no session ${params.session_id}` };

  const config = loadInputConfig();
  const mode = params.mode ?? config.keyboardMode;
  const tr = translateKey(params.code, mode);
  if (!tr) return { error: `no C64 mapping for ${params.code}` };

  if (tr.key === "RESTORE") {
    // RESTORE → NMI trigger, not a held key.
    if (session.triggerRestoreNmi) session.triggerRestoreNmi();
    return { ok: true, c64Key: "RESTORE" };
  }

  // Press the key (held).
  session.keyboard.pressKey(tr.key, HELD_CYCLES);
  getHeldKeys(params.session_id).add(tr.key);

  if (tr.shift) {
    session.keyboard.pressKey("L_SHIFT", HELD_CYCLES);
    getHeldKeys(params.session_id).add("L_SHIFT");
  }

  return { ok: true, c64Key: tr.key };
}

/** input/keyboard_release — release a held key. */
export function handleKeyboardRelease(
  params: { session_id: string; code: string; mode?: "qwerty" | "positional" },
  getSession: (id: string) => InputSessionAdapter | undefined,
): { ok: true } | { error: string } {
  const session = getSession(params.session_id);
  if (!session) return { error: `no session ${params.session_id}` };

  const config = loadInputConfig();
  const mode = params.mode ?? config.keyboardMode;
  const tr = translateKey(params.code, mode);
  if (!tr) return { ok: true }; // nothing to release

  const held = getHeldKeys(params.session_id);

  // Clear the specific key from the event queue.
  if (session.keyboard.clearEventByKey) {
    session.keyboard.clearEventByKey(tr.key);
    if (tr.shift) session.keyboard.clearEventByKey("L_SHIFT");
  } else {
    // Fallback: rebuild held state by clearing all and re-pressing remaining.
    held.delete(tr.key);
    if (tr.shift) held.delete("L_SHIFT");
    session.keyboard.clearEvents();
    for (const k of held) {
      session.keyboard.pressKey(k, HELD_CYCLES);
    }
  }
  held.delete(tr.key);
  if (tr.shift) held.delete("L_SHIFT");

  return { ok: true };
}

/** input/joystick_set — set joystick state directly. */
export function handleJoystickSet(
  params: { session_id: string; port: 1 | 2; directions: string[]; fire: boolean },
  getSession: (id: string) => InputSessionAdapter | undefined,
): { ok: true } | { error: string } {
  const session = getSession(params.session_id);
  if (!session) return { error: `no session ${params.session_id}` };

  const state = {
    up:    params.directions.includes("up"),
    down:  params.directions.includes("down"),
    left:  params.directions.includes("left"),
    right: params.directions.includes("right"),
    fire:  params.fire,
  };

  if (params.port === 1) {
    if (session.setJoystick1) {
      session.setJoystick1(state);
    } else {
      Object.assign(session.joystick1, state);
    }
  } else {
    if (session.setJoystick2) {
      session.setJoystick2(state);
    } else {
      Object.assign(session.joystick2, state);
    }
  }

  return { ok: true };
}

/** input/load_config — return current InputConfig. */
export function handleLoadConfig(_params: unknown): InputConfig {
  return loadInputConfig();
}

/** input/save_config — persist InputConfig to joystick.json. */
export function handleSaveConfig(
  params: { config: InputConfig },
): { ok: true } | { error: string } {
  try {
    saveInputConfig(params.config);
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ------------------------------------------------------------------
// Registration helper for V3WsServer
// ------------------------------------------------------------------

export interface WsServerLike {
  on(method: string, handler: (params: any, ctx: any) => any): void;
}

/**
 * Register all Spec 264 input handlers on a V3WsServer instance.
 * getSession must return an InputSessionAdapter for a given session_id.
 */
export function registerInputHandlers(
  server: WsServerLike,
  getSession: (id: string) => InputSessionAdapter | undefined,
): void {
  server.on("input/keyboard_press", (params) =>
    handleKeyboardPress(params, getSession),
  );
  server.on("input/keyboard_release", (params) =>
    handleKeyboardRelease(params, getSession),
  );
  server.on("input/joystick_set", (params) =>
    handleJoystickSet(params, getSession),
  );
  server.on("input/load_config", handleLoadConfig);
  server.on("input/save_config", handleSaveConfig);
}
