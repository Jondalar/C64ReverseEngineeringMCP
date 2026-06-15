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
import { getClient, BIN_TYPE_VIC_FRAME } from "../ws-client.js";
import type { TabProps } from "./Live.types.js";
// Spec 754 — the monitor is now the pop-out (MON button → separate window,
// MonitorPopout). The in-page bottom MonitorPanel is removed; MonitorPanel.tsx
// stays (the pop-out renders it).
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
  // BUG-042 — machine booted from this cart (green LED base state).
  booted?: boolean;
  // Spec 709.13 — backend-owned source filename; the CART display derives from
  // this (not a per-tab local path), so Live + Media never diverge.
  sourceName?: string;
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
    // BUG-026 — left-edge mapping matches the physical C64 layout:
    //   host ESC (top-left) → C64 ← (LARROW), the top-left "ESCAPE"-position key
    //   host ^ (Backquote)  → C64 CTRL
    //   host TAB            → C64 RUN/STOP
    case "Escape":     return ["LARROW"];
    case "Tab":        return ["RUN_STOP"];
    case "Backquote":  return ["CTRL"];
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

export function LiveTab({ sessionId, setSessionId, runState = "running", setRunState, statusSlot }: TabProps): React.JSX.Element {
  const [hasFrame, setHasFrame] = useState(false);
  const [fps, setFps] = useState(0);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [drive9, setDrive9] = useState<DriveStatus | null>(null);
  const [cart, setCart] = useState<CartStatus | null>(null);
  const [activeMedia, setActiveMedia] = useState<string>("");
  const [activeMedia9, setActiveMedia9] = useState<string>("");
  // Spec 709.13 — the CART (slot 0) display is derived from backend cart_status
  // (cart.sourceName), NOT a per-tab local path, so it can't diverge across tabs.
  const [screenFocused, setScreenFocused] = useState(false);
  // Mirror runState in a ref so async backend broadcasts can tell whether the
  // machine is OFF (a real off state must NOT be clobbered into "paused" by the
  // debug/paused that our own off→debug/pause produces).
  const runStateRef = useRef(runState);
  runStateRef.current = runState;
  const [bpSignal, setBpSignal] = useState<{ pc: number; num: number; registers: string; seq: number; observer?: string; message?: string } | null>(null);
  // Spec 764 — true while the last stop was a JAM (KIL): screen border goes
  // red instead of the paused yellow. Cleared by the next debug/running.
  const [jammed, setJammed] = useState(false);
  const [exploreSelection, setExploreSelection] = useState<{x:number;y:number;w:number;h:number} | null>(null);
  const fpsCounterRef = useRef({ frames: 0, lastT: Date.now() });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameImgRef = useRef<ImageData | null>(null); // reused per-frame (no 50fps GC churn)

  // Auto-pick first session
  useEffect(() => {
    if (sessionId) return;
    const client = getClient();
    if (client.getState() !== "open") return;
    client.call("session/list").then((sessions: any[]) => {
      if (sessions.length > 0) setSessionId(sessions[0].sessionId);
    }).catch(() => {});
  }, [sessionId, setSessionId]);

  // Spec 701 — the BACKEND owns the emulation clock. The UI is a pure MIRROR of
  // the daemon run-state: run/pause COMMANDS originate only from explicit user
  // actions (MachineControls buttons, which call debug/run|pause themselves) and
  // from media-ingress; the resulting debug/running|paused broadcasts flow back
  // and set `runState`. There is deliberately NO effect that re-sends `runState`
  // to the backend: that round-trip is an echo loop — a CRT mount broadcasts
  // paused→running within ~10ms, the lagging UI then replays a stale command,
  // which is a real backend transition, which broadcasts the opposite state…
  // oscillating run↔pause forever (yellow border flicker + starved audio).
  //
  // Paint a frame buffer onto the canvas. Spec 701 §7: the live transport is
  // a raw-RGBA binary WS frame ([w:u16][h:u16][fmt:u8][rsvd][cycle:u32] + RGBA),
  // blitted via putImageData — no per-frame PNG/base64 decode.
  const drawFrame = (payload: Uint8Array) => {
    const cv = canvasRef.current;
    if (!cv || payload.length < 10) return;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const w = dv.getUint16(0, true), h = dv.getUint16(2, true);
    const fmt = payload[4];
    if (!w || !h) return;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // Reuse one ImageData (write into its backing buffer) so a 50fps stream
    // doesn't allocate per-frame → no GC churn / tab crash.
    let img = frameImgRef.current;
    if (!img || img.width !== w || img.height !== h) { img = new ImageData(w, h); frameImgRef.current = img; }
    const out = img.data;
    if (fmt === 1) {
      // Palette-indexed (Spec 701 §7): [10 hdr][48 palette RGB][w*h indices].
      const palOff = 10, idxOff = 58, n = w * h;
      if (payload.length < idxOff + n) return;
      for (let p = 0; p < n; p++) {
        const idx = payload[idxOff + p]! & 0x0f;
        const pe = palOff + idx * 3;
        const o = p * 4;
        out[o] = payload[pe]!; out[o + 1] = payload[pe + 1]!; out[o + 2] = payload[pe + 2]!; out[o + 3] = 0xff;
      }
    } else {
      // fmt 0 = raw RGBA.
      if (payload.length < 10 + w * h * 4) return;
      out.set(payload.subarray(10, 10 + w * h * 4));
    }
    ctx.putImageData(img, 0, 0);
    if (!hasFrame) setHasFrame(true);
  };

  // grabScreenshot: one-shot PNG (session/screenshot — manual/export primitive,
  // Spec 701 §7) blitted onto the same canvas. Used for paused/breakpoint/reset
  // moments when the live frame stream is not running.
  const grabScreenshot = useRef(async () => {});
  grabScreenshot.current = async () => {
    if (!sessionId) return;
    try {
      const r = await getClient().call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
      const cv = canvasRef.current; if (!cv) return;
      const img = new Image();
      img.onload = () => {
        const ctx = cv.getContext("2d"); if (!ctx) return;
        if (cv.width !== img.width) cv.width = img.width;
        if (cv.height !== img.height) cv.height = img.height;
        ctx.drawImage(img, 0, 0);
        setHasFrame(true);
      };
      img.src = r.dataUrl;
    } catch { /* ignore */ }
  };

  // (B) Presentation = backend frame PUSH (Spec 701 §7). The backend streams
  //     binary RGBA frames at its presentation cadence (25fps PAL / bounded
  //     warp, latest-frame-wins); we just blit them. This does NOT advance the
  //     machine and carries no PNG/base64 cost. The old session/screenshot
  //     poll is gone.
  useEffect(() => {
    if (!sessionId) return;
    const client = getClient();
    const off = client.onBinary(BIN_TYPE_VIC_FRAME, (frame) => {
      drawFrame(frame.payload);
      const c = fpsCounterRef.current;
      c.frames++;
      const now = Date.now();
      if (now - c.lastT >= 1000) { setFps(c.frames); c.frames = 0; c.lastT = now; }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // (C) Backend broadcasts → UI state. The loop self-halts on a breakpoint
  //     and announces it; the UI reacts (drops into the monitor, freezes the
  //     run-state, grabs the frozen frame) instead of inferring halt from a
  //     polling timeout.
  useEffect(() => {
    if (!sessionId) return;
    const client = getClient();
    // Spec 764 — seed the JAM flag for a UI that (re)connects to an already-
    // jammed machine: the one-shot debug/stopped broadcast is long gone, but
    // session/state carries the controller's last stopReason.
    client.call<{ runState?: string; stopReason?: string }>("session/state", { session_id: sessionId })
      .then((s) => { if (s?.runState === "paused" && s?.stopReason === "jam") setJammed(true); })
      .catch(() => { /* state poll best-effort */ });
    const offHit = client.onNotification("debug/breakpoint_hit", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      setBpSignal({ pc: p.pc, num: p.num, registers: p.registers, seq: Date.now() });
      setRunState?.("paused");
      grabScreenshot.current();
    });
    // Observer `break` halt (Spec 754 §3.3e) — mirror the breakpoint reaction:
    // freeze the run-state + grab the frozen frame. The banner/focus is in the
    // MON popout (MonitorPanel via debug/observer_hit).
    const offObsHit = client.onNotification("debug/observer_hit", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      setBpSignal({ pc: p.pc, num: -1, registers: p.registers, seq: Date.now(), observer: p.observer ?? "?", message: p.message ?? undefined });
      setRunState?.("paused");
      grabScreenshot.current();
    });
    const offStopped = client.onNotification("debug/stopped", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      if (runStateRef.current === "off") return; // OFF stays OFF (black), not paused
      // Spec 764 — a JAM stop tints the screen border red (crashed CPU), any
      // other stop keeps the normal paused yellow.
      setJammed(p?.stop?.reason === "jam");
      setRunState?.("paused");
      grabScreenshot.current();
    });
    const offPaused = client.onNotification("debug/paused", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      if (runStateRef.current === "off") return; // OFF stays OFF (black), not paused
      setRunState?.("paused");
      grabScreenshot.current();
    });
    const offRunning = client.onNotification("debug/running", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      setJammed(false);
      setRunState?.("running");
    });
    // Spec 761 — a checkpoint restore (scrub seek with then:"keep") rolls the
    // machine back but does NOT emit stopped/paused, so the canvas would keep
    // showing the stale pre-scrub frame. Grab a fresh frame so the picture
    // matches the rolled-back state. (then:"run" resumes the frame stream on
    // its own; harmless to also grab once here.)
    const offRestored = client.onNotification("debug/checkpoint_restored", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      grabScreenshot.current();
    });
    return () => { offHit(); offObsHit(); offStopped(); offPaused(); offRunning(); offRestored(); };
  }, [sessionId, setRunState]);

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

  // Force a single-frame re-render even when paused (= draw one screenshot
  // onto the canvas). Used after reset/power so a paused machine shows a frame.
  const snapshot = async () => {
    await grabScreenshot.current();
  };

  return (
    <div className="wb-live">
      <MachineControls
        sessionId={sessionId}
        runState={runState}
        setRunState={setRunState}
        fps={fps}
        onSnapshotTaken={snapshot}
        statusSlot={statusSlot}
      />
      {/* BUG-049 — scrub timeline removed pending the checkpoint-ring re-spec
          (its 1s checkpoint/list poll + the always-on ring auto-capture drove
          the audio kratzen). Re-introduced by the new zero-alloc-ring spec. */}
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
          ) : (
            <>
              <canvas
                ref={canvasRef}
                width={384}
                height={272}
                tabIndex={runState === "running" ? 0 : -1}
                onFocus={() => setScreenFocused(true)}
                onBlur={() => setScreenFocused(false)}
                onClick={(e) => runState === "running" && e.currentTarget.focus()}
                className={`wb-screen ${runState === "paused" ? (jammed ? "paused jammed" : "paused") : ""} ${screenFocused ? "focused" : ""}`}
                style={{ imageRendering: "pixelated" }}
              />
              {!hasFrame && (
                <div className="wb-screen-empty">
                  <p>No frame yet — emulator booting…</p>
                </div>
              )}
            </>
          )}
          {runState === "paused" && canvasRef.current && (
            <ExploreOverlay
              sessionId={sessionId}
              screenEl={canvasRef.current}
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
          activeCartMedia={cart?.sourceName ?? ""}
          onMounted={(slot, path) => {
            // Spec 709.13 — slots 8/9 = drives (local display); slot 0 = CART is
            // backend-derived (cart_status poll), so nothing to set here.
            if (slot === 8) setActiveMedia(path);
            else if (slot === 9) setActiveMedia9(path);
          }}
          joyMode={joyMode}
          setJoyMode={setJoyMode}
          joyBits={joyBits}
          pressedKeys={pressedKeys}
        />
      </div>
    </div>
  );
}
