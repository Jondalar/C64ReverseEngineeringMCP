// Spec 769.5b + reverse-debug 1c — scrub filmstrip (human UI). Shows ONLY on
// Pause/Freeze. Fetches per-checkpoint thumbnails (769.5a), renders them as a
// horizontal strip; clicking a frame restores the FULL machine to that point
// (screen + cycles jump back, stays paused). Per selected frame: Continue (run on)
// or Dump (.c64re). SHIFT-click a second frame to mark a RANGE [a..b]; "Build trace"
// then carves a `.c64retrace` for EXACTLY those cycles out of the always-on delta
// ring (trace/build_from_ring, Phase 1c) — readable via swimlane/map/taint.
// FUNCTIONAL first pass — the look is refined via the annotate loop.

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

function ThumbCanvas(
  { t, selected, inRange, onClick }:
  { t: Thumb; selected: boolean; inRange: boolean; onClick: (shift: boolean) => void },
): React.JSX.Element {
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
      className={`wb-film-thumb${selected ? " sel" : ""}${inRange ? " in-range" : ""}${t.pinned ? " pin" : ""}`}
      title={`cycle ${t.cycles}${selected ? " — selected (shift-click another for a range)" : ""}`}
      onClick={(e) => onClick(e.shiftKey || e.metaKey || e.ctrlKey)}
      style={{ imageRendering: "pixelated", ...(inRange && !selected ? { outline: "2px solid #5bd6ff", outlineOffset: "-2px" } : {}) }}
    />
  );
}

export function Filmstrip(
  { sessionId, setRunState }: { sessionId: string; setRunState?: (s: "running" | "paused" | "off") => void },
): React.JSX.Element | null {
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [sel, setSel] = useState<string | null>(null);   // anchor frame (a)
  const [selB, setSelB] = useState<string | null>(null); // range end (b) — set by shift-click
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<string | null>(null);

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
      // render:true on a paused scrub → backend re-sims 1 frame so the canvas
      // shows the picture (auto-anchors omit the framebuffer). 769.5.
      await getClient().call("checkpoint/restore", { session_id: sessionId, id, then, render: then === "pause" });
      setSel(id);
      if (then === "run") setRunState?.("running");
    } finally { setBusy(false); }
  };
  const dump = async (id: string) => {
    setBusy(true);
    try {
      await getClient().call("checkpoint/restore", { session_id: sessionId, id, then: "pause" });
      setSel(id);
      const path = `dumps/scrub-${id}-${Date.now()}.c64re`;
      const r = await getClient().call<{ path: string }>("snapshot/dump", { session_id: sessionId, path });
      console.log("[filmstrip] dumped →", r?.path ?? path);
    } finally { setBusy(false); }
  };

  // Click: plain = rewind to that frame (clears any range). Shift/Cmd/Ctrl = mark the
  // second endpoint of a range [a..b] for "Build trace" (no rewind).
  const handleClick = (id: string, withModifier: boolean) => {
    if (withModifier && sel && sel !== id) { setSelB(id); setBuilt(null); return; }
    setSelB(null);
    void restore(id, "pause");
  };

  const cycOf = (id: string | null) => (id ? thumbs.find((x) => x.id === id)?.cycles ?? null : null);
  const cA = cycOf(sel), cB = cycOf(selB);
  const lo = cA != null && cB != null ? Math.min(cA, cB) : null;
  const hi = cA != null && cB != null ? Math.max(cA, cB) : null;
  const rangeCount = lo != null && hi != null ? thumbs.filter((t) => t.cycles >= lo && t.cycles <= hi).length : 0;
  const inRange = (t: Thumb) => lo != null && hi != null && t.cycles >= lo && t.cycles <= hi;

  const buildTrace = async () => {
    if (lo == null || hi == null) return;
    setBusy(true);
    try {
      const r = await getClient().call<{ retrace_path: string; event_count: number }>(
        "trace/build_from_ring", { session_id: sessionId, cycle_start: lo, cycle_end: hi });
      const file = (r?.retrace_path ?? "").split("/").pop() ?? "trace";
      setBuilt(`✓ built ${r?.event_count ?? 0} events from cycles ${lo}–${hi} → ${file} · read it with \`swimlane ${lo} ${hi}\` / map / taint`);
    } catch (e) {
      setBuilt(`✕ build trace failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  if (!thumbs.length) return <div className="wb-filmstrip empty">no checkpoints captured yet</div>;

  return (
    <div className={`wb-filmstrip${busy ? " busy" : ""}`}>
      <div className="wb-film-strip">
        {thumbs.map((t) => (
          <ThumbCanvas
            key={t.id}
            t={t}
            selected={sel === t.id || selB === t.id}
            inRange={inRange(t)}
            onClick={(shift) => handleClick(t.id, shift)}
          />
        ))}
      </div>
      <div className="wb-film-actions">
        {selB ? (
          <>
            <span className="wb-film-hint">range {lo}–{hi} · {rangeCount} frames</span>
            <button disabled={busy} onClick={() => void buildTrace()}>🎬 Build trace</button>
            <button disabled={busy} onClick={() => { setSelB(null); setBuilt(null); }}>✕ clear range</button>
          </>
        ) : (
          <>
            <span className="wb-film-hint">{sel ? `@ cycle ${cycOf(sel) ?? "?"} · shift-click a 2nd frame for a range` : "click a frame to rewind · shift-click a 2nd for a range"}</span>
            <button disabled={!sel || busy} onClick={() => sel && restore(sel, "run")}>▶ Continue</button>
            <button disabled={!sel || busy} onClick={() => sel && dump(sel)}>⬇ Dump .c64re</button>
          </>
        )}
      </div>
      {built && <div className="wb-film-built">{built}</div>}
    </div>
  );
}
