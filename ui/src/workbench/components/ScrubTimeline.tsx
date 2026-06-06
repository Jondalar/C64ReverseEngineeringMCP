// Spec 761.2 — ring-bound scrub timeline (the LIVE-tab rewind bar).
//
// A fixed-width video-player seekbar: the bar always spans 100% (never scrolls,
// never pushes the layout). The ring anchors (705.B) are mapped onto it by
// capture time — dense markers read like a video timeline. Click the bar to
// seek to the nearest anchor (then:"keep" = preserve play/pause, like dragging a
// video scrubber). "▶ Resume here" restores + runs on from the selected anchor
// (then:"run", auto-pins per 761 OQ2). 📌 pins so a moment survives evict-oldest.
//
// After any restore we session/release_keys: a checkpoint re-presses the keys
// that were down at capture time, which would jam live keyboard input — the
// human's fingers are no longer on those keys, so clear them.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";

interface CheckpointRef {
  id: string;
  frame: number;
  cycles: number;
  pinned: boolean;
  byteSize: number;
  createdAtMs: number;
}
interface RingStats { count: number; totalBytes: number; pinnedCount: number; budgetBytes?: number; }
interface Props {
  sessionId: string;
  runState: "running" | "paused" | "off";
}

// Fraction 0..1 along the timeline for an anchor (by wall-clock capture time).
function frac(cp: CheckpointRef, oldestMs: number, spanMs: number): number {
  if (spanMs <= 0) return 1;
  return Math.min(1, Math.max(0, (cp.createdAtMs - oldestMs) / spanMs));
}

export function ScrubTimeline({ sessionId, runState }: Props): React.JSX.Element | null {
  const c = getClient();
  const [list, setList] = useState<CheckpointRef[]>([]);
  const [stats, setStats] = useState<RingStats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await c.call<{ checkpoints: CheckpointRef[]; stats: RingStats }>(
        "checkpoint/list", { session_id: sessionId },
      );
      setList(r.checkpoints ?? []);
      setStats(r.stats ?? null);
      // drop a stale selection (e.g. after a power-cycle clears the ring)
      setSelected((cur) => (cur && (r.checkpoints ?? []).some((x) => x.id === cur) ? cur : null));
    } catch { /* ring may not exist until first capture */ }
  }, [sessionId, c]);

  useEffect(() => {
    if (!sessionId) return;
    void reload();
    const off = c.onNotification("debug/checkpoint_restored", (p: any) => {
      if (p?.session_id && p.session_id !== sessionId) return;
      void reload();
    });
    let timer: ReturnType<typeof setInterval> | null = null;
    if (runState === "running") timer = setInterval(reload, 1000);
    return () => { off(); if (timer) clearInterval(timer); };
  }, [sessionId, runState, reload, c]);

  const restore = useCallback(async (id: string, then: "keep" | "run") => {
    if (!sessionId || busy) return;
    setBusy(true);
    setSelected(id);
    try {
      await c.call("checkpoint/restore", { session_id: sessionId, id, then });
      // clear keys re-pressed by the checkpoint so live typing is not jammed
      await c.call("session/release_keys", { session_id: sessionId }).catch(() => {});
      await reload();
    } catch (e) { console.error("checkpoint/restore:", e); }
    finally { setBusy(false); }
  }, [sessionId, busy, c, reload]);

  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    if (!sessionId) return;
    try { await c.call(pinned ? "checkpoint/unpin" : "checkpoint/pin", { session_id: sessionId, id }); await reload(); }
    catch (e) { console.error("checkpoint/pin:", e); }
  }, [sessionId, c, reload]);

  // Click the bar → nearest anchor by horizontal position → seek (then:"keep").
  const onBarClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!list.length || busy) return;
    const el = barRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const oldestMs = list[0]!.createdAtMs;
    const spanMs = list[list.length - 1]!.createdAtMs - oldestMs;
    let best = list[0]!, bestD = Infinity;
    for (const cp of list) {
      const d = Math.abs(frac(cp, oldestMs, spanMs) - x);
      if (d < bestD) { bestD = d; best = cp; }
    }
    void restore(best.id, "keep");
  }, [list, busy, restore]);

  if (runState === "off") return null;

  const oldestMs = list.length ? list[0]!.createdAtMs : 0;
  const newestMs = list.length ? list[list.length - 1]!.createdAtMs : 0;
  const spanMs = newestMs - oldestMs;
  const spanS = spanMs / 1000;
  const sel = list.find((x) => x.id === selected) ?? null;
  const playPct = sel ? frac(sel, oldestMs, spanMs) * 100 : 100; // unselected playhead = "now" (right)
  const agoS = sel ? (newestMs - sel.createdAtMs) / 1000 : 0;

  return (
    <div className="wb-scrub">
      <span className="wb-scrub-title" title="Rewind over the in-memory checkpoint ring (705.B). Transient: oldest anchors are evicted; a power-cycle starts a fresh ring.">⟲ Scrub</span>
      <div
        ref={barRef}
        className={`wb-scrub-bar${busy ? " busy" : ""}`}
        role="slider"
        aria-label="checkpoint timeline"
        title={list.length ? "Click to seek to the nearest snapshot" : "capturing snapshots…"}
        onClick={onBarClick}
      >
        {list.length === 0 && <span className="wb-scrub-empty">capturing snapshots…</span>}
        {list.map((cp) => (
          <span
            key={cp.id}
            className={`wb-scrub-mark${cp.pinned ? " pinned" : ""}${cp.id === selected ? " sel" : ""}`}
            style={{ left: `${frac(cp, oldestMs, spanMs) * 100}%` }}
          />
        ))}
        {list.length > 0 && <span className="wb-scrub-head" style={{ left: `${playPct}%` }} />}
      </div>
      <button
        className="wb-scrub-resume"
        disabled={!sel || busy}
        title={sel ? "Restore this snapshot and run on from here" : "Click the bar to pick a snapshot first"}
        onClick={() => sel && restore(sel.id, "run")}
      >▶ Resume here</button>
      {sel && (
        <button
          className={`wb-scrub-pin${sel.pinned ? " on" : ""}`}
          title={sel.pinned ? "Unpin (allow eviction)" : "Pin (keep this snapshot)"}
          onClick={() => togglePin(sel.id, sel.pinned)}
        >{sel.pinned ? "📌" : "📍"}</button>
      )}
      <span className="wb-scrub-span" title={stats ? `${(stats.totalBytes / (1024 * 1024)).toFixed(1)} MiB · ${stats.count} snapshots` : ""}>
        {list.length < 2 ? `${list.length} snap` : `${list.length} · ${spanS.toFixed(0)}s`}
        {sel ? ` · -${agoS.toFixed(1)}s` : " · now"}
      </span>
    </div>
  );
}
