// Spec 769.5b — scrub filmstrip (human UI). Shows ONLY on Pause/Freeze. Fetches
// per-checkpoint thumbnails (769.5a), renders them as a horizontal strip; clicking
// a frame restores the FULL machine to that point (screen + cycles jump back,
// stays paused). Per selected frame: Continue (run on from there) or Dump (.c64re).
// No range/trim. FUNCTIONAL first pass — the look is refined via the annotate loop.

import React, { useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";

interface Thumb {
  id: string; cycles: number; frame: number; pinned: boolean;
  width: number; height: number; palette: string; indices: string; // base64
}

function b64ToU8(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function ThumbCanvas({ t, selected, onClick }: { t: Thumb; selected: boolean; onClick: () => void }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const pal = b64ToU8(t.palette), idx = b64ToU8(t.indices);
    const img = new ImageData(t.width, t.height);
    for (let i = 0; i < idx.length; i++) {
      const p = (idx[i]! & 0x0f) * 3, o = i * 4;
      img.data[o] = pal[p]!; img.data[o + 1] = pal[p + 1]!; img.data[o + 2] = pal[p + 2]!; img.data[o + 3] = 0xff;
    }
    c.width = t.width; c.height = t.height;
    c.getContext("2d")!.putImageData(img, 0, 0);
  }, [t]);
  return (
    <canvas
      ref={ref}
      className={`wb-film-thumb${selected ? " sel" : ""}${t.pinned ? " pin" : ""}`}
      title={`cycle ${t.cycles}`}
      onClick={onClick}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

export function Filmstrip(
  { sessionId, setRunState }: { sessionId: string; setRunState?: (s: "running" | "paused" | "off") => void },
): React.JSX.Element | null {
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the strip when it opens (on pause). One-shot — the ring is static while paused.
  useEffect(() => {
    let alive = true;
    getClient().call<{ thumbnails: Thumb[] }>("checkpoint/thumbnails", { session_id: sessionId })
      .then((r) => { if (alive) setThumbs(r.thumbnails ?? []); })
      .catch(() => { /* no ring yet */ });
    return () => { alive = false; };
  }, [sessionId]);

  const restore = async (id: string, then: "pause" | "run") => {
    setBusy(true);
    try {
      await getClient().call("checkpoint/restore", { session_id: sessionId, id, then });
      setSel(id);
      if (then === "run") setRunState?.("running");
    } finally { setBusy(false); }
  };
  const dump = async (id: string) => {
    setBusy(true);
    try {
      // restore to the point (so "current" = that anchor), then dump current state
      await getClient().call("checkpoint/restore", { session_id: sessionId, id, then: "pause" });
      setSel(id);
      const path = `dumps/scrub-${id}-${Date.now()}.c64re`;
      const r = await getClient().call<{ path: string }>("snapshot/dump", { session_id: sessionId, path });
      console.log("[filmstrip] dumped →", r?.path ?? path);
    } finally { setBusy(false); }
  };

  if (!thumbs.length) return <div className="wb-filmstrip empty">no checkpoints captured yet</div>;

  return (
    <div className={`wb-filmstrip${busy ? " busy" : ""}`}>
      <div className="wb-film-strip">
        {thumbs.map((t) => (
          <ThumbCanvas key={t.id} t={t} selected={sel === t.id} onClick={() => restore(t.id, "pause")} />
        ))}
      </div>
      <div className="wb-film-actions">
        <span className="wb-film-hint">{sel ? `@ cycle ${thumbs.find((x) => x.id === sel)?.cycles ?? "?"}` : "click a frame to rewind"}</span>
        <button disabled={!sel || busy} onClick={() => sel && restore(sel, "run")}>▶ Continue</button>
        <button disabled={!sel || busy} onClick={() => sel && dump(sel)}>⬇ Dump .c64re</button>
      </div>
    </div>
  );
}
