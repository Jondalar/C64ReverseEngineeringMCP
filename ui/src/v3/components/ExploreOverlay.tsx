// Spec 354 — Frozen Explore overlay.
// Active only while VM is paused. Click+drag on the screen creates a
// region selection. Selection inspector shows coordinates, VIC mode,
// memory hints. Toolbar lets user mark selection as Logo/Text/Sprite/
// Charset/Bitmap and create an artifact in the project knowledge store.

import React, { useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";

type Kind = "select" | "logo" | "text" | "sprite" | "charset" | "bitmap";
type Selection = { x: number; y: number; w: number; h: number };

interface Props {
  sessionId: string;
  screenEl: HTMLCanvasElement; // Spec 701 §7 — live frame is a <canvas> now
  selection: Selection | null;
  onSelection: (s: Selection | null) => void;
}

export function ExploreOverlay({ sessionId, screenEl, selection, onSelection }: Props): JSX.Element {
  const [kind, setKind] = useState<Kind>("select");
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState<{ start: { x: number; y: number } } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Map browser pixel → C64 screen coord (= 0..391 visible).
  const toC64 = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = screenEl.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return { x: Math.round(sx * 384), y: Math.round(sy * 272) };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const p = toC64(e.clientX, e.clientY);
    setDragging({ start: p });
    onSelection({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const p = toC64(e.clientX, e.clientY);
    const x = Math.min(dragging.start.x, p.x);
    const y = Math.min(dragging.start.y, p.y);
    const w = Math.abs(p.x - dragging.start.x);
    const h = Math.abs(p.y - dragging.start.y);
    onSelection({ x, y, w, h });
  };
  const onMouseUp = () => setDragging(null);

  const createArtifact = async () => {
    if (!selection || !sessionId) return;
    try {
      const r = await getClient().call<any>("explore/create_artifact", {
        session_id: sessionId,
        kind: `visual.${kind === "select" ? "logo" : kind}`,
        name: name || `${kind} at ${selection.x},${selection.y}`,
        screenRegion: selection,
      });
      console.log("artifact:", r.id);
      alert(`Artifact created: ${r.id ?? "(id pending backend wire-up)"}`);
    } catch (e: any) {
      alert(`explore/create_artifact backend not wired yet: ${e.message ?? e}`);
    }
  };

  // Position overlay over screen
  const rect = screenEl.getBoundingClientRect();

  return (
    <>
      <div
        ref={overlayRef}
        className="wb-explore-overlay"
        style={{
          position: "fixed",
          left: rect.left, top: rect.top,
          width: rect.width, height: rect.height,
          cursor: "crosshair",
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        {selection && selection.w > 0 && selection.h > 0 && (
          <div
            className="wb-explore-selection"
            style={{
              position: "absolute",
              left: (selection.x / 384) * rect.width,
              top: (selection.y / 272) * rect.height,
              width: (selection.w / 384) * rect.width,
              height: (selection.h / 272) * rect.height,
            }}
          />
        )}
      </div>
      <div className="wb-explore-toolbar">
        <strong>Explore (frozen):</strong>
        {(["select", "logo", "text", "sprite", "charset", "bitmap"] as Kind[]).map((k) => (
          <button
            key={k}
            className={kind === k ? "active" : ""}
            onClick={() => setKind(k)}
          >{k}</button>
        ))}
        {selection && (
          <>
            <input
              placeholder="Artifact name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button onClick={createArtifact}>Create Artifact</button>
            <span className="wb-muted">
              {selection.w}×{selection.h} @ ({selection.x},{selection.y})
            </span>
          </>
        )}
      </div>
    </>
  );
}
