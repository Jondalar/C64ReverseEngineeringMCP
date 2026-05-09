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
import { MediaStrip } from "../components/MediaStrip.js";
import { MachineControls } from "../components/MachineControls.js";
import { ExploreOverlay } from "../components/ExploreOverlay.js";

interface DriveStatus {
  device: number; ledOn: boolean; motorOn: boolean;
  halfTrack: number; track: number; drivePc: number;
}

function keyEventToC64(e: KeyboardEvent): string | null {
  if (e.key === "Enter") return "\r";
  if (e.key === "Backspace") return "";
  if (e.key === "Escape") return "";
  if (e.key === "Tab") return "";
  if (e.key.length === 1) return e.key;
  return null;
}

export function LiveTab({ sessionId, setSessionId, runState = "running", setRunState }: TabProps): JSX.Element {
  const [imgUrl, setImgUrl] = useState<string>("");
  const [fps, setFps] = useState(0);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [drive9, setDrive9] = useState<DriveStatus | null>(null);
  const [activeMedia, setActiveMedia] = useState<string>("");
  const [activeMedia9, setActiveMedia9] = useState<string>("");
  const [screenFocused, setScreenFocused] = useState(false);
  const [monitorMax, setMonitorMax] = useState(false);
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
        await client.call("session/run", { session_id: sessionId, cycles: 19705 });
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

  // Drive status poll
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

  // Live keyboard capture (running only, no focus required).
  // Old behaviour required screen focus; that left users confused
  // because there was no visible focus state. Now: any keystroke
  // while emulator is running goes through, unless the focused
  // element is an input/textarea (so monitor/forms still work).
  useEffect(() => {
    if (!sessionId || runState !== "running") return;
    const client = getClient();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      const c = keyEventToC64(e);
      if (c === null) return;
      e.preventDefault();
      if (c === "") return;
      client.call("session/type", { session_id: sessionId, text: c }).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionId, runState]);

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
        <InspectorPanel sessionId={sessionId} drive={drive} drive9={drive9} />
      </div>
      <MonitorPanel
        sessionId={sessionId}
        maximized={monitorMax}
        onToggleMax={() => setMonitorMax(!monitorMax)}
      />
      <MediaStrip
        sessionId={sessionId}
        drive={drive}
        drive9={drive9}
        activeMedia={activeMedia}
        activeMedia9={activeMedia9}
        onMounted={(slot, path) => {
          if (slot === 8) setActiveMedia(path); else setActiveMedia9(path);
        }}
      />
    </div>
  );
}
