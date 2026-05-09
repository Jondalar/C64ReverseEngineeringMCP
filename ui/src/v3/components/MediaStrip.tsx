// Spec 353 — media + project flow.
// Drive 8/9 strips. Mount-only (no auto-LOAD/RUN). Drag/drop support.

import React, { useEffect, useState } from "react";
import { getClient } from "../ws-client.js";

interface MediaEntry { path: string; name: string; type: string; }
interface Drive {
  device: number; ledOn: boolean; motorOn: boolean;
  halfTrack: number; track: number; drivePc: number;
}

interface Props {
  sessionId: string;
  drive: Drive | null;
  drive9: Drive | null;
  activeMedia: string;
  activeMedia9: string;
  onMounted: (slot: 8 | 9, path: string) => void;
}

export function MediaStrip({ sessionId, drive, drive9, activeMedia, activeMedia9, onMounted }: Props): JSX.Element {
  const [media, setMedia] = useState<MediaEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const c = getClient();
    const fetchMedia = () => {
      c.call("media/recent").then((list: any) => {
        if (Array.isArray(list)) setMedia(list);
      }).catch(() => {});
    };
    if (c.getState() === "open") fetchMedia();
    return c.onState((s) => { if (s === "open") fetchMedia(); });
  }, []);

  const mount = async (slot: 8 | 9, path: string) => {
    if (!sessionId) return;
    try {
      await getClient().call("media/mount", { session_id: sessionId, slot, path });
      onMounted(slot, path);
    } catch (e) { console.error("mount:", e); }
  };
  const eject = async (slot: 8 | 9) => {
    if (!sessionId) return;
    try {
      await getClient().call("media/unmount", { session_id: sessionId, slot });
      onMounted(slot, "");
    } catch (e) { console.error("eject:", e); }
  };

  const onDrop = async (e: React.DragEvent, slot: 8 | 9) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // Browser FileReader can't get full path; user must pick from project list
    // for the path-resolved mount. Show note.
    alert(`Drag/drop received "${files[0]!.name}". For now, please pick from the project media list — full-path drop wiring requires Spec 353 backend route.`);
  };

  const driveStrip = (slot: 8 | 9, d: Drive | null, current: string) => {
    const isCrt = current.toLowerCase().endsWith(".crt");
    return (
      <div className="wb-drive-strip">
        <div className="wb-drive-label">
          <span className={`wb-led ${d?.ledOn ? "on" : ""}`} title="Drive LED" />
          <strong>Drive {slot}</strong>
          {d && <span className="wb-muted">T{d.track}{d.halfTrack % 2 === 1 ? ".5" : ""} {d.motorOn ? "▶" : "■"}</span>}
        </div>
        <select
          value={current}
          onChange={(e) => { if (e.target.value) mount(slot, e.target.value); }}
        >
          <option value="">— empty —</option>
          {media.map((m) => (
            <option key={m.path} value={m.path}>{m.name}</option>
          ))}
        </select>
        <button onClick={() => eject(slot)} disabled={!current}>Eject</button>
        {isCrt && <span className="wb-warn" title="CRT cartridges require power cycle">⚠ power cycle</span>}
      </div>
    );
  };

  return (
    <div
      className={`wb-media ${dragOver ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => onDrop(e, 8)}
    >
      {driveStrip(8, drive, activeMedia)}
      {driveStrip(9, drive9, activeMedia9)}
      <div className="wb-drop-hint">Drop .d64 / .g64 / .crt / snapshot here</div>
    </div>
  );
}
