// Spec 814 §7 — REC, in the top bar.
//
// Arming a recorder is a transport state like running or warping: it is on or it is
// not, and you must see it AT ALL TIMES. A recorder you forgot is armed produces a
// file full of everything you did while thinking. The top bar is the only strip
// that is always on screen, which is the whole reason this button is not down with
// the thing it produces.
//
// The button ARMS the daemon's journal and reads it back on stop. It never times
// anything itself: a UI that stamps its own click records the WebSocket round-trip
// and the render loop, and the replay then lands somewhere else on the machine
// (§2). What this component contributes is the WATCHING — the observations that let
// a gap be written as a state anchor instead of a frame count — and even those
// carry the daemon's cycle, not the browser's clock.

import React, { useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";
import { recordScenario, type AnchorObservation, type JournalEntry, type RecordResult } from "../../../../src/reel/record-scenario.js";
import { screenCodesToRows, normalizeScreenText } from "../../../../src/project-knowledge/region.js";
import type { Shot } from "./CaptureOverlay.js";

interface Props {
  sessionId: string;
  runState: "running" | "paused" | "off";
  /** Shots taken so far — the ones inside the recording become `I capture` steps. */
  shots: readonly Shot[];
  onRecorded: (result: RecordResult) => void;
}

/** What `session/state` gives us that this component needs. */
interface MachineState {
  c64Cycles: number;
  vic?: { screenBase?: number; mode?: number };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function RecorderButton({ sessionId, runState, shots, onRecorded }: Props): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const armedAt = useRef(0);
  const anchors = useRef<AnchorObservation[]>([]);
  const seenText = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const driveWasBusy = useRef(false);

  // ── the watcher ────────────────────────────────────────────────────────────────
  //
  // Sampling is paced by the browser, but every observation is STAMPED with the
  // machine cycle the daemon reports in the same breath. The wall clock decides only
  // when we look; it never decides when something happened.
  //
  // Two things are watched, and both are things a human would point at afterwards:
  // text that APPEARED on the screen, and the drive going busy and then idle again.
  // What it cannot do is know which one you meant — so it offers, and the editor is
  // where you keep or replace it (§3).
  useEffect(() => {
    if (!armed || !sessionId) return;
    const client = getClient();
    let alive = true;

    const sample = async (): Promise<void> => {
      if (!alive) return;
      try {
        const st = await client.call<MachineState>("session/state", { session_id: sessionId });
        const cycle = st.c64Cycles ?? 0;

        // The drive going idle after work is the honest way to wait out a loader.
        try {
          const ds = await client.call<{ motorOn?: boolean; ledOn?: boolean }>("session/drive_status", {
            session_id: sessionId,
          });
          const busy = !!(ds?.motorOn || ds?.ledOn);
          if (driveWasBusy.current && !busy) {
            anchors.current.push({ cycle, predicate: "the drive is idle" });
          }
          driveWasBusy.current = busy;
        } catch { /* no drive, no anchor */ }

        // Text mode only: the C64 text screen IS characters, so this is a table
        // lookup, not OCR. In a bitmap mode there is nothing to read and we say
        // nothing rather than guessing at pixels.
        const mode = st.vic?.mode ?? 0;
        const base = st.vic?.screenBase;
        if (base !== undefined && (mode === 0 || mode === 1)) {
          const r = await client.call<{ chunks?: { bytes?: string }[] }>("session/read_memory", {
            session_id: sessionId,
            ranges: [{ addr: base, len: 1000, lens: "ram" }],
          });
          const raw = r.chunks?.[0]?.bytes;
          if (raw) {
            // The FIRST sample is the baseline. What was already on screen when
            // recording started did not "appear", and an anchor on it would wait for
            // something that is already true — which is a wait of zero dressed up as
            // a condition.
            const baseline = !primed.current;
            primed.current = true;
            for (const row of screenCodesToRows(b64ToBytes(raw))) {
              const t = normalizeScreenText(row);
              // Short runs are noise (a border of spaces, a one-digit counter); a line
              // worth anchoring on is one a human would read out loud.
              if (t.length < 4) continue;
              if (seenText.current.has(t)) continue;
              seenText.current.add(t);
              if (!baseline) anchors.current.push({ cycle, predicate: `the screen shows "${t}"` });
            }
          }
        }

        const j = await client.call<{ entries?: unknown[] }>("session/input_journal", { session_id: sessionId });
        if (alive) setCount(j.entries?.length ?? 0);
      } catch { /* a sample that fails is a sample we skip */ }
      if (alive) setTimeout(() => void sample(), 250);
    };

    // Prime the baseline BEFORE the first anchor can be produced.
    void (async () => {
      try {
        const st = await client.call<MachineState>("session/state", { session_id: sessionId });
        armedAt.current = st.c64Cycles ?? 0;
      } catch { /* ignore */ }
      void sample();
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, sessionId]);

  const arm = async (): Promise<void> => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      const r = await getClient().call<{ armedAtCycle?: number }>("session/input_journal", {
        session_id: sessionId,
        arm: true,
      });
      armedAt.current = r.armedAtCycle ?? 0;
      anchors.current = [];
      seenText.current = new Set();
      primed.current = false;
      driveWasBusy.current = false;
      setCount(0);
      setArmed(true);
    } catch (e) {
      onRecorded({ text: "", warnings: [`could not arm the recorder: ${(e as Error).message}`], steps: 0 });
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!sessionId || busy) return;
    setBusy(true);
    setArmed(false);
    try {
      const client = getClient();
      const j = await client.call<{
        armedAtCycle?: number; cycle?: number; dropped?: number; entries?: JournalEntry[];
      }>("session/input_journal", { session_id: sessionId, arm: false });

      // §4 — the Given comes from the SESSION, not from a guess. A mounted medium
      // makes the file self-contained; anything else is honest about needing a
      // snapshot beside it.
      let origin: Parameters<typeof recordScenario>[1]["origin"];
      try {
        const st = await client.call<{ media?: { disk?: { path?: string }; cart?: { path?: string } } }>(
          "session/state",
          { session_id: sessionId },
        );
        // A cartridge before a disk: when both are in, the cart is what the machine
        // boots from, so it is what a reader has to have.
        const path = st.media?.cart?.path || st.media?.disk?.path;
        origin = path
          ? { kind: "medium", path, why: "a medium is mounted, so this file is self-contained — a paste is enough" }
          : { kind: "bare", why: "no medium is mounted; if the machine was not at power-on, save a snapshot beside this file and change this Given" };
      } catch {
        origin = { kind: "bare", why: "the session did not say what it was started from" };
      }

      const armedCycle = j.armedAtCycle ?? armedAt.current;
      const endCycle = j.cycle ?? armedCycle;
      const result = recordScenario(j.entries ?? [], {
        name: "recorded run",
        armedAtCycle: armedCycle,
        endCycle,
        origin,
        anchors: anchors.current,
        captures: shots
          .filter((s) => s.cycle >= armedCycle && s.cycle <= endCycle)
          .map((s) => ({ cycle: s.cycle, label: s.label })),
      });
      const warnings = j.dropped
        ? [...result.warnings, `${j.dropped} input(s) past the journal cap were not recorded`]
        : result.warnings;
      onRecorded({ ...result, warnings });
    } catch (e) {
      onRecorded({ text: "", warnings: [`the recording could not be turned into a scenario: ${(e as Error).message}`], steps: 0 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={() => void (armed ? stop() : arm())}
      disabled={runState === "off" || busy}
      className={armed ? "wb-rec-on" : ""}
      title={
        armed
          ? `Stop recording (${count} input${count === 1 ? "" : "s"} so far) and open the scenario`
          : "Record what you do as a .feature scenario — the daemon stamps every input with its cycle"
      }
    >
      {armed ? `⏺ REC ● ${count}` : "⏺ REC"}
    </button>
  );
}
