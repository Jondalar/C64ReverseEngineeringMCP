// Spec 761.2 — ring-bound scrub timeline (the LIVE-tab rewind strip).
//
// One tick per checkpoint-ring anchor (705.B), newest right. Click a tick to
// scrub-and-look (checkpoint/restore then:"pause" — the frozen frame shows via
// the existing debug/stopped → grabScreenshot path). "▶ Resume here" restores
// then runs on from that anchor (then:"run", auto-pins it per 761 OQ2). 📌
// pins/unpins so an interesting moment survives evict-oldest.
//
// Deliberately ONE strip — no new design language (Spec 761 §761.2). Run/pause
// state syncs through the backend's restore broadcasts; this component only
// issues checkpoint/* and reflects the ring.

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
interface RingStats {
  count: number;
  totalBytes: number;
  pinnedCount: number;
  budgetBytes?: number;
}
interface Props {
  sessionId: string;
  runState: "running" | "paused" | "off";
}

function spanLabel(list: CheckpointRef[]): string {
  if (list.length < 2) return list.length === 1 ? "1 anchor" : "no anchors yet";
  const ms = list[list.length - 1]!.createdAtMs - list[0]!.createdAtMs;
  const s = Math.max(0, ms / 1000);
  return `${list.length} anchors · ${s.toFixed(1)} s window`;
}
function ago(ref: CheckpointRef, newestMs: number): string {
  const d = (newestMs - ref.createdAtMs) / 1000;
  if (d < 0.05) return "now";
  return `-${d.toFixed(1)}s`;
}

export function ScrubTimeline({ sessionId, runState }: Props): React.JSX.Element | null {
  const c = getClient();
  const [list, setList] = useState<CheckpointRef[]>([]);
  const [stats, setStats] = useState<RingStats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const reload = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await c.call<{ checkpoints: CheckpointRef[]; stats: RingStats }>(
        "checkpoint/list", { session_id: sessionId },
      );
      setList(r.checkpoints ?? []);
      setStats(r.stats ?? null);
    } catch { /* ignore — ring may not exist until first capture */ }
  }, [sessionId, c]);

  // Tail new anchors while running; refresh once when paused; reload on any
  // backend checkpoint restore (another client / the monitor may scrub too).
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

  const restore = useCallback(async (id: string, then: "pause" | "run") => {
    if (!sessionId || busy) return;
    setBusy(true);
    setSelected(id);
    try {
      await c.call("checkpoint/restore", { session_id: sessionId, id, then });
      await reload();
    } catch (e) { console.error("checkpoint/restore:", e); }
    finally { setBusy(false); }
  }, [sessionId, busy, c, reload]);

  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    if (!sessionId) return;
    try { await c.call(pinned ? "checkpoint/unpin" : "checkpoint/pin", { session_id: sessionId, id }); await reload(); }
    catch (e) { console.error("checkpoint/pin:", e); }
  }, [sessionId, c, reload]);

  if (runState === "off") return null;

  const newestMs = list.length ? list[list.length - 1]!.createdAtMs : 0;
  const sel = list.find((x) => x.id === selected) ?? null;

  return (
    <div className="wb-scrub">
      <span className="wb-scrub-title" title="Rewind over the in-memory checkpoint ring (705.B). Transient: oldest anchors are evicted.">⟲ Scrub</span>
      <div className="wb-scrub-track" role="slider" aria-label="checkpoint timeline">
        {list.length === 0 && <span className="wb-scrub-empty">capturing anchors…</span>}
        {list.map((cp) => (
          <button
            key={cp.id}
            className={`wb-scrub-tick${cp.id === selected ? " sel" : ""}${cp.pinned ? " pinned" : ""}`}
            title={`${ago(cp, newestMs)} · frame ${cp.frame}${cp.pinned ? " · pinned" : ""}\nclick = scrub here (pause)`}
            onClick={() => restore(cp.id, "pause")}
            disabled={busy}
          >
            <span className="wb-scrub-pip" />
          </button>
        ))}
      </div>
      <button
        className="wb-scrub-resume"
        disabled={!sel || busy}
        title={sel ? "Restore this anchor and run on from here" : "Pick an anchor first"}
        onClick={() => sel && restore(sel.id, "run")}
      >▶ Resume here</button>
      {sel && (
        <button
          className={`wb-scrub-pin${sel.pinned ? " on" : ""}`}
          title={sel.pinned ? "Unpin (allow eviction)" : "Pin (keep this anchor)"}
          onClick={() => togglePin(sel.id, sel.pinned)}
        >{sel.pinned ? "📌" : "📍"}</button>
      )}
      <span className="wb-scrub-span" title={stats ? `${(stats.totalBytes / (1024 * 1024)).toFixed(1)} MiB used` : ""}>
        {spanLabel(list)}{sel ? ` · at ${ago(sel, newestMs)}` : ""}
      </span>
    </div>
  );
}
