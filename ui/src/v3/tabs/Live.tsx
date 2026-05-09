import React, { useEffect, useState, useRef } from "react";
import { getClient } from "../ws-client.js";
import type { TabProps } from "./Live.types.js";

export function LiveTab({ sessionId, setSessionId }: TabProps): JSX.Element {
  const [imgUrl, setImgUrl] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [fps, setFps] = useState(0);
  const fpsCounterRef = useRef({ frames: 0, lastT: Date.now() });

  // Auto-pick first session on mount.
  useEffect(() => {
    if (sessionId) return;
    const client = getClient();
    if (client.getState() !== "open") return;
    client.call("session/list").then((sessions: any[]) => {
      if (sessions.length > 0) setSessionId(sessions[0].sessionId);
    }).catch(() => {});
  }, [sessionId, setSessionId]);

  // Frame poll loop — request screenshot, advance, repeat.
  useEffect(() => {
    if (!sessionId || !running) return;
    const client = getClient();
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      try {
        // Advance ~1/50s = 19705 cycles PAL
        await client.call("session/run", { session_id: sessionId, cycles: 19705 });
        const r = await client.call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
        if (alive) {
          setImgUrl(r.dataUrl);
          // FPS calc
          const c = fpsCounterRef.current;
          c.frames++;
          const now = Date.now();
          if (now - c.lastT >= 1000) {
            setFps(c.frames);
            c.frames = 0;
            c.lastT = now;
          }
        }
      } catch (e) {
        console.error("frame loop error:", e);
      }
      if (alive) setTimeout(tick, 20); // ~50fps target
    };
    tick();
    return () => { alive = false; };
  }, [sessionId, running]);

  // Single-shot snapshot
  const snapshot = async () => {
    if (!sessionId) return;
    const client = getClient();
    try {
      const r = await client.call<{ dataUrl: string }>("session/screenshot", { session_id: sessionId });
      setImgUrl(r.dataUrl);
    } catch (e) { console.error(e); }
  };

  if (!sessionId) {
    return (
      <div className="v3-tab-stub">
        <h2>Live</h2>
        <p>No session active. Mount media in the Media tab.</p>
      </div>
    );
  }

  const reset = async () => {
    if (!sessionId) return;
    setRunning(false);
    try {
      await getClient().call("session/reset", { session_id: sessionId, video: "pal-default" });
      await snapshot();
    } catch (e) { console.error(e); }
  };

  const sendKeyboard = async (text: string) => {
    if (!sessionId) return;
    try {
      await getClient().call("session/type", { session_id: sessionId, text });
      // Auto-flush a couple frames so the keystrokes process.
      await getClient().call("session/run", { session_id: sessionId, cycles: 200_000 });
      await snapshot();
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ textAlign: "center" }}>
      <h2 style={{ color: "var(--c64-blue-bright)", marginBottom: "0.5rem" }}>Live</h2>
      <div style={{ marginBottom: "0.5rem" }}>
        <button onClick={() => setRunning(!running)} style={{ marginRight: 8 }}>
          {running ? "⏸ Pause" : "▶ Run"}
        </button>
        <button onClick={snapshot} style={{ marginRight: 8 }}>📷 Snapshot</button>
        <button onClick={reset} style={{ marginRight: 8 }}>⟲ Reset (Power Cycle)</button>
        <button onClick={() => sendKeyboard('LOAD"*",8,1\r')} style={{ marginRight: 8 }}>↵ LOAD"*",8,1</button>
        <button onClick={() => sendKeyboard("RUN\r")}>↵ RUN</button>
        {running && <span style={{ marginLeft: 12, color: "var(--c64-fg-muted)" }}>{fps} fps</span>}
      </div>
      <div style={{ marginBottom: "0.5rem" }}>
        <input
          type="text"
          placeholder='Type C64 commands here (e.g. POKE 53280,0)'
          style={{
            width: 400, padding: "0.25rem 0.5rem",
            background: "var(--c64-bg-2)", color: "var(--c64-fg)",
            border: "1px solid var(--c64-border)", fontFamily: "inherit",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const target = e.currentTarget;
              const text = target.value + "\r";
              target.value = "";
              sendKeyboard(text);
            }
          }}
        />
        <span style={{ marginLeft: 8, color: "var(--c64-fg-muted)", fontSize: 11 }}>(press Enter to send)</span>
      </div>
      {imgUrl ? (
        <img
          src={imgUrl}
          alt="C64 framebuffer"
          style={{ imageRendering: "pixelated", width: 784, height: 544, border: "2px solid var(--c64-border)" }}
        />
      ) : (
        <p style={{ color: "var(--c64-fg-muted)" }}>Click Snapshot or Run to see frame.</p>
      )}
    </div>
  );
}
