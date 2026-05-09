import React, { useEffect, useState, useRef } from "react";
import { getClient } from "../ws-client.js";
import type { TabProps } from "./Live.types.js";

interface DriveStatus {
  device: number;
  ledOn: boolean;
  motorOn: boolean;
  halfTrack: number;
  track: number;
  drivePc: number;
}

interface MediaEntry {
  path: string;
  name: string;
  type: string;
}

// Browser keyboard event → C64 PETSCII char(s) for typeText.
function keyEventToC64(e: KeyboardEvent): string | null {
  if (e.key === "Enter") return "\r";
  if (e.key === "Backspace") return "";  // INST/DEL — TODO map
  if (e.key === "Escape") return "";     // RUN/STOP — TODO map
  if (e.key === "Tab") return "";
  if (e.key.length === 1) return e.key;
  return null;
}

export function LiveTab({ sessionId, setSessionId }: TabProps): JSX.Element {
  const [imgUrl, setImgUrl] = useState<string>("");
  // Auto-start running so cursor blinks + frame poll fires from
  // first page load. User can pause via ⏸ button.
  const [running, setRunning] = useState(true);
  const [fps, setFps] = useState(0);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [media, setMedia] = useState<MediaEntry[]>([]);
  const [activeMedia, setActiveMedia] = useState<string>("");
  const [screenFocused, setScreenFocused] = useState(false);
  const fpsCounterRef = useRef({ frames: 0, lastT: Date.now() });

  // Auto-pick first session.
  useEffect(() => {
    if (sessionId) return;
    const client = getClient();
    if (client.getState() !== "open") return;
    client.call("session/list").then((sessions: any[]) => {
      if (sessions.length > 0) setSessionId(sessions[0].sessionId);
    }).catch(() => {});
  }, [sessionId, setSessionId]);

  // Recent media list.
  useEffect(() => {
    const client = getClient();
    let alive = true;
    const fetchMedia = () => {
      client.call("media/recent").then((list: any) => {
        if (alive && Array.isArray(list)) setMedia(list);
      }).catch(() => {});
    };
    if (client.getState() === "open") {
      fetchMedia();
    }
    // Retry on every state change to "open" (= reconnect or initial open).
    const off = client.onState((s) => {
      if (s === "open") fetchMedia();
    });
    return () => { alive = false; off(); };
  }, []);

  // Frame poll loop.
  useEffect(() => {
    if (!sessionId || !running) return;
    const client = getClient();
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        await client.call("session/run", { session_id: sessionId, cycles: 19705 });
        const r = await client.call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
        if (alive) {
          setImgUrl(r.dataUrl);
          const c = fpsCounterRef.current;
          c.frames++;
          const now = Date.now();
          if (now - c.lastT >= 1000) {
            setFps(c.frames); c.frames = 0; c.lastT = now;
          }
        }
      } catch (e) { console.error("frame loop:", e); }
      if (alive) setTimeout(tick, 20);
    };
    tick();
    return () => { alive = false; };
  }, [sessionId, running]);

  // Drive status poll.
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
      if (alive) setTimeout(tick, 250);
    };
    tick();
    return () => { alive = false; };
  }, [sessionId]);

  // Live keyboard capture.
  useEffect(() => {
    if (!screenFocused || !sessionId) return;
    const client = getClient();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const c = keyEventToC64(e);
      if (c === null) return;
      e.preventDefault();
      if (c === "") return;
      client.call("session/type", { session_id: sessionId, text: c, hold_cycles: 30_000, gap_cycles: 5_000 }).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screenFocused, sessionId]);

  const snapshot = async () => {
    if (!sessionId) return;
    try {
      const r = await getClient().call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
      setImgUrl(r.dataUrl);
    } catch (e) { console.error(e); }
  };

  const reset = async () => {
    if (!sessionId) return;
    try {
      await getClient().call("session/reset", { session_id: sessionId, video: "pal-default" });
      // Auto-advance ~3 frames so cursor settles.
      await getClient().call("session/run", { session_id: sessionId, cycles: 60_000 });
      await snapshot();
      setRunning(true);
    } catch (e) { console.error(e); }
  };

  const sendKeys = async (text: string) => {
    if (!sessionId) return;
    try {
      await getClient().call("session/type", { session_id: sessionId, text });
      await getClient().call("session/run", { session_id: sessionId, cycles: 200_000 });
      await snapshot();
    } catch (e) { console.error(e); }
  };

  const mountMedia = async (path: string) => {
    if (!sessionId) return;
    try {
      const client = getClient();
      // Mount + cold reset = fresh 1541 init + clean BASIC READY.
      // User drives boot via LOAD"*",8,1 button + RUN button themselves.
      // No auto-chain (= no UI blocking, no mystery 30s wait).
      await client.call("media/mount", { session_id: sessionId, slot: 8, path });
      setActiveMedia(path);
      await client.call("session/reset", { session_id: sessionId, video: "pal-default" });
      // server's reset handler already advances 5M cycles to BASIC READY.
      setRunning(true);  // keep frame poll alive
    } catch (e) { console.error("mount:", e); }
  };

  if (!sessionId) {
    return (
      <div className="v3-tab-stub">
        <h2>Live</h2>
        <p>No session active.</p>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ marginBottom: "0.5rem", display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setRunning(!running)}>{running ? "⏸ Pause" : "▶ Run"}</button>
        <button onClick={snapshot}>📷 Snap</button>
        <button onClick={reset}>⟲ Reset</button>
        <button onClick={() => sendKeys('LOAD"*",8,1\r')}>↵ LOAD"*",8,1</button>
        <button onClick={() => sendKeys("RUN\r")}>↵ RUN</button>
        <select
          value={activeMedia}
          onChange={(e) => { if (e.target.value) mountMedia(e.target.value); }}
          style={{ background: "var(--c64-bg-2)", color: "var(--c64-fg)", border: "1px solid var(--c64-border)", padding: "0.25rem", fontFamily: "inherit" }}
        >
          <option value="">— mount disk —</option>
          {media.map((m) => (
            <option key={m.path} value={m.path}>{m.name}</option>
          ))}
        </select>
        {drive && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--c64-fg-muted)", fontSize: 12 }}>
            <span
              title={drive.ledOn ? "Drive LED ON" : "Drive LED off"}
              style={{
                display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                background: drive.ledOn ? "#ef5350" : "#333",
                boxShadow: drive.ledOn ? "0 0 6px #ef5350" : "none",
              }}
            />
            <span>D{drive.device}</span>
            <span>T{drive.track}{drive.halfTrack % 2 === 1 ? ".5" : ""}</span>
            <span>{drive.motorOn ? "▶" : "■"}</span>
          </span>
        )}
        {running && <span style={{ color: "var(--c64-fg-muted)", fontSize: 12 }}>{fps} fps</span>}
      </div>

      {imgUrl ? (
        <img
          src={imgUrl}
          alt="C64 screen"
          tabIndex={0}
          onFocus={() => setScreenFocused(true)}
          onBlur={() => setScreenFocused(false)}
          onClick={(e) => e.currentTarget.focus()}
          style={{
            imageRendering: "pixelated",
            width: 736, height: 544, // 2× of 368×272 — matches new server crop
            border: screenFocused ? "2px solid #6c5ce7" : "2px solid var(--c64-border)",
            outline: "none",
            cursor: "text",
          }}
        />
      ) : (
        <p style={{ color: "var(--c64-fg-muted)" }}>Click Snap or Run.</p>
      )}
      {screenFocused && (
        <p style={{ color: "#7c6cee", fontSize: 11, margin: "0.25rem 0" }}>
          ⌨ Keyboard capture active — click outside to disable
        </p>
      )}
    </div>
  );
}
