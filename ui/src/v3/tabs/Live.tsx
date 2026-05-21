// Spec 351 — Emulator Live machine UX cockpit.
// Layout:
//   Machine controls bar
//   ┌─────────────────────────┬──────────────┐
//   │ C64 SCREEN              │ Inspector    │
//   ├─────────────────────────┴──────────────┤
//   │ Monitor (with [max])                    │
//   ├─────────────────────────────────────────┤
//   │ Media strip (Drive 8/9 + drop zone)     │
//   └─────────────────────────────────────────┘
//
// Per Spec 350: NO LOAD"*" / RUN buttons. Spec 353: explicit mount,
// no auto-LOAD. Spec 354: pause → Explore overlay.

import React, { useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";
import type { TabProps } from "./Live.types.js";
import { MonitorPanel } from "../components/MonitorPanel.js";
import { InspectorPanel } from "../components/InspectorPanel.js";
import { MachineControls } from "../components/MachineControls.js";
import { ExploreOverlay } from "../components/ExploreOverlay.js";

interface DriveStatus {
  device: number;
  ledOn: boolean;
  ledFlashing?: boolean;
  motorOn: boolean;
  rwMode?: "read" | "write";
  halfTrack: number;
  track: number;
  sector?: number;
  drivePc: number;
  dd00?: { pra: number; ddr: number };
  transferMode?: "kernal" | "custom" | "idle";
}

interface CartStatus {
  type: string;
  bank: number;
  activity: "read" | "write" | "idle";
}

// Spec 310 — symbolic mapping: host KeyboardEvent → C64 matrix key name(s).
// Returns null if no mapping. Returns array of 1-2 keys (= base + optional
// L_SHIFT for shifted-only chars like ", ?, etc).
type C64KeyName = string;
function keyEventToC64Keys(e: KeyboardEvent): C64KeyName[] | null {
  // Special non-printable keys (host code → C64 matrix).
  const code = e.code;
  switch (code) {
    case "Enter":      return ["RETURN"];
    case "Backspace":  return ["DEL"];
    case "Escape":     return ["RUN_STOP"];
    case "Tab":        return ["C_EQ"];
    case "Home":       return ["HOME"];
    case "ControlLeft":
    case "ControlRight": return ["CTRL"];
    case "ShiftLeft":  return ["L_SHIFT"];
    case "ShiftRight": return ["R_SHIFT"];
    case "ArrowDown":  return ["CRSR_DN"];
    case "ArrowRight": return ["CRSR_RT"];
    case "ArrowUp":    return ["L_SHIFT", "CRSR_DN"];
    case "ArrowLeft":  return ["L_SHIFT", "CRSR_RT"];
    case "F1":         return ["F1"];
    case "F2":         return ["L_SHIFT", "F1"];
    case "F3":         return ["F3"];
    case "F4":         return ["L_SHIFT", "F3"];
    case "F5":         return ["F5"];
    case "F6":         return ["L_SHIFT", "F5"];
    case "F7":         return ["F7"];
    case "F8":         return ["L_SHIFT", "F7"];
    case "Space":      return ["SPACE"];
  }
  // Printable: use e.key (= already host-layout-resolved character).
  // C64 matrix is uppercase letters; map digits + punctuation directly.
  const k = e.key;
  if (k.length !== 1) return null;
  const ch = k.toUpperCase();
  // Letters A-Z
  if (ch >= "A" && ch <= "Z") {
    const out = [ch];
    if (e.shiftKey) out.unshift("L_SHIFT");
    return out;
  }
  // Digits 0-9 (non-shifted)
  if (ch >= "0" && ch <= "9" && !e.shiftKey) return [ch];
  // Common punctuation (= unshifted host = C64 key)
  switch (k) {
    case "+": return ["+"];
    case "-": return ["-"];
    case "*": return ["*"];
    case "/": return ["/"];
    case "=": return ["="];
    case ":": return [":"];
    case ";": return [";"];
    case ",": return [","];
    case ".": return ["."];
    case "@": return ["@"];
  }
  // Shifted punctuation: emit L_SHIFT + base C64 key per matrix.
  if (e.shiftKey) {
    switch (k) {
      case "\"": return ["L_SHIFT", "2"];
      case "?":  return ["L_SHIFT", "/"];
      case "(":  return ["L_SHIFT", "8"];
      case ")":  return ["L_SHIFT", "9"];
      case "<":  return ["L_SHIFT", ","];
      case ">":  return ["L_SHIFT", "."];
      case "!":  return ["L_SHIFT", "1"];
      case "$":  return ["L_SHIFT", "4"];
      case "%":  return ["L_SHIFT", "5"];
      case "&":  return ["L_SHIFT", "6"];
      case "'":  return ["L_SHIFT", "7"];
    }
  }
  return null;
}

// Spec 310 — virtual joystick mapping: WASD + Space → bits.
// Returns the bit name (= JoystickState property) or null if not a joy key.
type JoyBit = "up" | "down" | "left" | "right" | "fire";
function joystickBitForCode(code: string): JoyBit | null {
  switch (code) {
    case "KeyW": return "up";
    case "KeyA": return "left";
    case "KeyS": return "down";
    case "KeyD": return "right";
    case "Space": return "fire";
  }
  return null;
}
type JoystickMode = "off" | "port1" | "port2";

export function LiveTab({ sessionId, setSessionId, runState = "running", setRunState }: TabProps): JSX.Element {
  const [imgUrl, setImgUrl] = useState<string>("");
  const [fps, setFps] = useState(0);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [drive9, setDrive9] = useState<DriveStatus | null>(null);
  const [cart, setCart] = useState<CartStatus | null>(null);
  const [activeMedia, setActiveMedia] = useState<string>("");
  const [activeMedia9, setActiveMedia9] = useState<string>("");
  const [screenFocused, setScreenFocused] = useState(false);
  const [monitorMax, setMonitorMax] = useState(false);
  const [bpSignal, setBpSignal] = useState<{ pc: number; num: number; registers: string; seq: number } | null>(null);
  const [exploreSelection, setExploreSelection] = useState<{x:number;y:number;w:number;h:number} | null>(null);
  const fpsCounterRef = useRef({ frames: 0, lastT: Date.now() });
  const screenRef = useRef<HTMLImageElement>(null);

  // Auto-pick first session
  useEffect(() => {
    if (sessionId) return;
    const client = getClient();
    if (client.getState() !== "open") return;
    client.call("session/list").then((sessions: any[]) => {
      if (sessions.length > 0) setSessionId(sessions[0].sessionId);
    }).catch(() => {});
  }, [sessionId, setSessionId]);

  // Frame poll loop — only when running
  useEffect(() => {
    if (!sessionId || runState !== "running") return;
    const client = getClient();
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const rr = await client.call<{ breakpoint?: { pc: number; num: number; registers: string } }>(
          "session/run", { session_id: sessionId, cycles: 19705 });
        if (rr?.breakpoint && alive) {
          // Halted at a monitor breakpoint: drop into the monitor (the
          // panel prints "#N BREAK" + registers + focuses), pause the run
          // loop, and show the frozen frame.
          setBpSignal({ ...rr.breakpoint, seq: Date.now() });
          setRunState?.("paused");
          try {
            const sc = await client.call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
            if (alive) setImgUrl(sc.dataUrl);
          } catch { /* ignore */ }
          return; // stop ticking — resume via monitor 'g'
        }
        const r = await client.call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
        if (alive) {
          setImgUrl(r.dataUrl);
          const c = fpsCounterRef.current;
          c.frames++;
          const now = Date.now();
          if (now - c.lastT >= 1000) { setFps(c.frames); c.frames = 0; c.lastT = now; }
        }
      } catch (e) { console.error("frame loop:", e); }
      if (alive) setTimeout(tick, 20);
    };
    tick();
    return () => { alive = false; };
  }, [sessionId, runState]);

  // Drive + cart status poll
  useEffect(() => {
    if (!sessionId) return;
    const client = getClient();
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const ds = await client.call<DriveStatus>("session/drive_status", { session_id: sessionId });
        if (alive) setDrive(ds);
      } catch { /* ignore */ }
      try {
        const cs = await client.call<CartStatus | null>("session/cart_status", { session_id: sessionId });
        if (alive) setCart(cs ?? null);
      } catch { /* ignore */ }
      if (alive) setTimeout(tick, 250);
    };
    tick();
    return () => { alive = false; };
  }, [sessionId]);

  // Spec 310 — virtual joystick UI state (per-tab; not persisted).
  const [joyMode, setJoyMode] = useState<JoystickMode>("off");
  const [joyBits, setJoyBits] = useState<Record<JoyBit, boolean>>({ up: false, down: false, left: false, right: false, fire: false });
  const [pressedKeys, setPressedKeys] = useState<string[]>([]);

  // Spec 310 — live keyboard + virtual joystick passthrough.
  // While emulator runs: keydown → key_down WS, keyup → key_up WS.
  // If joyMode != "off" and key is WASD+Space: route to joystick_set
  // instead and DO NOT also send to keyboard matrix.
  // Inputs/textareas (monitor) keep host focus → bypass.
  // Window blur / unmount → release_keys (= clear all live keys + joy).
  useEffect(() => {
    if (!sessionId || runState !== "running") return;
    const client = getClient();
    // Track which keys we currently consider "pressed" by us, so we can
    // emit clean keyup pairs even if the browser repeats keydown.
    const pressedDown = new Set<string>(); // tracking by event.code
    const joyState: Record<JoyBit, boolean> = { up: false, down: false, left: false, right: false, fire: false };

    const sendJoy = () => {
      const port = joyMode === "port1" ? 1 : joyMode === "port2" ? 2 : 0;
      if (port === 0) return;
      client.call("session/joystick_set", { session_id: sessionId, port, ...joyState }).catch(() => {});
      setJoyBits({ ...joyState });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      // Virtual joystick path: swallow WASD/Space when active.
      if (joyMode !== "off") {
        const bit = joystickBitForCode(e.code);
        if (bit) {
          e.preventDefault();
          if (joyState[bit]) return; // already down
          joyState[bit] = true;
          sendJoy();
          return;
        }
      }
      // Keyboard path.
      const keys = keyEventToC64Keys(e);
      if (!keys) return;
      e.preventDefault();
      if (pressedDown.has(e.code)) return;
      pressedDown.add(e.code);
      for (const key of keys) {
        client.call("session/key_down", { session_id: sessionId, key }).catch(() => {});
      }
      setPressedKeys(Array.from(pressedDown));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      if (joyMode !== "off") {
        const bit = joystickBitForCode(e.code);
        if (bit) {
          e.preventDefault();
          if (!joyState[bit]) return;
          joyState[bit] = false;
          sendJoy();
          return;
        }
      }
      const keys = keyEventToC64Keys(e);
      if (!keys) return;
      if (!pressedDown.has(e.code)) return;
      pressedDown.delete(e.code);
      for (const key of keys) {
        client.call("session/key_up", { session_id: sessionId, key }).catch(() => {});
      }
      setPressedKeys(Array.from(pressedDown));
    };
    const onBlur = () => {
      pressedDown.clear();
      for (const k of Object.keys(joyState) as JoyBit[]) joyState[k] = false;
      setPressedKeys([]);
      setJoyBits({ ...joyState });
      client.call("session/release_keys", { session_id: sessionId }).catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      onBlur();
    };
  }, [sessionId, runState, joyMode]);

  // Snapshot single frame (= force re-render even when paused)
  const snapshot = async () => {
    if (!sessionId) return;
    try {
      const r = await getClient().call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
      setImgUrl(r.dataUrl);
    } catch (e) { console.error(e); }
  };

  return (
    <div className="wb-live">
      <MachineControls
        sessionId={sessionId}
        runState={runState}
        setRunState={setRunState}
        fps={fps}
        onSnapshotTaken={snapshot}
      />
      <div className="wb-live-grid">
        <div className="wb-screen-wrap">
          {runState === "off" ? (
            <div className="wb-screen-off" style={{
              background: "#000",
              width: "100%", height: "100%",
              minHeight: 300,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#444", fontSize: 14, fontFamily: "monospace",
            }}>
              POWER OFF
            </div>
          ) : imgUrl ? (
            <img
              ref={screenRef}
              src={imgUrl}
              alt="C64 screen"
              tabIndex={runState === "running" ? 0 : -1}
              onFocus={() => setScreenFocused(true)}
              onBlur={() => setScreenFocused(false)}
              onClick={(e) => runState === "running" && e.currentTarget.focus()}
              className={`wb-screen ${runState === "paused" ? "paused" : ""} ${screenFocused ? "focused" : ""}`}
            />
          ) : (
            <div className="wb-screen-empty">
              <p>No frame yet — emulator booting…</p>
            </div>
          )}
          {runState === "paused" && screenRef.current && (
            <ExploreOverlay
              sessionId={sessionId}
              screenEl={screenRef.current}
              selection={exploreSelection}
              onSelection={setExploreSelection}
            />
          )}
          {screenFocused && runState === "running" && (
            <p className="wb-screen-hint">⌨ Keyboard captured — click outside to disable</p>
          )}
        </div>
        <InspectorPanel
          sessionId={sessionId}
          drive={drive}
          drive9={drive9}
          cart={cart}
          activeMedia={activeMedia}
          activeMedia9={activeMedia9}
          onMounted={(slot, path) => {
            if (slot === 8) setActiveMedia(path); else if (slot === 9) setActiveMedia9(path);
          }}
          joyMode={joyMode}
          setJoyMode={setJoyMode}
          joyBits={joyBits}
          pressedKeys={pressedKeys}
        />
      </div>
      <MonitorPanel
        sessionId={sessionId}
        maximized={monitorMax}
        onToggleMax={() => setMonitorMax(!monitorMax)}
        breakpoint={bpSignal}
      />
    </div>
  );
}
