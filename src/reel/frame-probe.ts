// Spec 899 D3/D4 — a window of frames, watched by the runtime.
//
// `Then $D01C@io is $04` is decided where the step before it ended, and a value that is
// wrong for three frames out of two hundred falls between two such checks. The runtime's
// frame probe advances the machine N frames and samples the addresses once per frame at a
// fixed raster line, inside the daemon: one call, every frame. This module is the C64RE
// side of it — the refusal when the runtime cannot, the sample line, and the reading of
// what comes back. It emulates nothing and keeps no timing of its own: the beam position
// and the sampling are the runtime's, and every row carries the cycle it was really taken at.

import type { Check, SeriesRead } from "../project-knowledge/scenario-gherkin.js";

/** What the runtime has to be, said to the caller when it is not. */
export const PROBE_RUNTIME_NEED =
  "a TRX64 with cycle-exact input and the frame probe (session/frame_probe, `at_cycle` on key_down/key_up/" +
  "joystick_set/joystick_clear) — TRX64 0.12.10 or later. Update the runtime (c64re runtime install), or point " +
  "C64RE_RUNTIME_BIN at a build that has them. Nothing was run, and nothing fell back to frame-boundary input.";

type Call = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** Does this runtime have the frame probe and scheduled input? A refusal naming what is needed, if not. */
export async function requireProbeRuntime(call: Call, what: string): Promise<void> {
  try {
    // Empty params: a runtime that has the method answers "invalid params"; one that does
    // not answers "method not found". Neither advances the machine.
    await call("session/frame_probe", {});
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/method not found/i.test(m)) {
      throw new Error(`${what} needs ${PROBE_RUNTIME_NEED}`);
    }
    // Any other answer (-32602 invalid params) is the method being there.
  }
}

/** The raster line a window is sampled at when the caller names none: the line after the visible area. */
export async function defaultProbeLine(call: Call, model: string, linesPerFrame: number): Promise<number> {
  const r = await call<{ models?: { name: string; displayWindow?: { lastLine?: number } }[] }>("session/models");
  const row = r.models?.find((m) => m.name === model);
  const last = row?.displayWindow?.lastLine;
  if (typeof last !== "number") {
    throw new Error(
      `the runtime does not report ${model}'s visible window, so there is no default sample line — ` +
        `say \`at raster line N\` (the line after the visible area is 288 on PAL)`,
    );
  }
  return (last + 1) % linesPerFrame;
}

export interface ProbeRow {
  readonly frame: number;
  readonly c64Cycles: number;
  readonly line: number;
  readonly cycle: number;
  /** All sampled ranges, back to back, in the order asked for. */
  readonly bytes: readonly number[];
}

/** The probe stopped on something armed in the machine: not a pass and not a fail. */
export interface ProbeStop {
  readonly kind: string;
  readonly frame: number;
  readonly c64Cycles: number;
  readonly line: number;
  readonly cycle: number;
  readonly pc: number;
}

export interface ProbeSeries {
  readonly rows: readonly ProbeRow[];
  readonly samples: number;
  readonly changes: number;
  /** Where the machine stands afterwards. */
  readonly c64Cycles: number;
  readonly stopped?: ProbeStop;
}

interface RawStop {
  stopped?: string; frame: number; c64Cycles: number; line: number; cycle: number; pc: number;
  rows?: ProbeRow[]; samples?: number; changes?: number;
}

const stopOf = (r: RawStop): ProbeStop => ({
  kind: r.stopped!, frame: r.frame, c64Cycles: r.c64Cycles, line: r.line, cycle: r.cycle, pc: r.pc,
});

const addressesOf = (reads: readonly { addr: number; len: number; lens: string }[]) =>
  reads.map((r) => ({ addr: r.addr, len: r.len, lens: r.lens }));

/** Series mode: the first sample, then only the frames where a sampled byte differs from the one before. */
export async function probeSeries(
  call: Call, p: { frames: number; line: number; reads: readonly SeriesRead[] },
): Promise<ProbeSeries> {
  const r = await call<RawStop & { c64Cycles: number }>("session/frame_probe", {
    frames: p.frames, line: p.line, addresses: addressesOf(p.reads), mode: "series",
  });
  return {
    rows: r.rows ?? [], samples: r.samples ?? 0, changes: r.changes ?? 0, c64Cycles: r.c64Cycles,
    ...(r.stopped ? { stopped: stopOf(r) } : {}),
  };
}

export type AssertOutcome =
  | { readonly held: true; readonly samples: number; readonly c64Cycles: number }
  | {
      readonly held: false; readonly frame: number; readonly c64Cycles: number; readonly line: number;
      readonly cycle: number; readonly actual: readonly { addr: number; value: number; expected: number; mask: number; ok: boolean }[];
    }
  | { readonly stopped: ProbeStop };

/** Assert mode: stops at the FIRST sample where an expectation fails; the machine stays there. */
export async function probeAssert(
  call: Call,
  p: { frames: number; line: number; addr: number; lens: string; expect: readonly number[] },
): Promise<AssertOutcome> {
  const r = await call<RawStop & {
    held?: boolean; actual?: { addr: number; value: number; expected: number; mask: number; ok: boolean }[];
  }>("session/frame_probe", {
    frames: p.frames, line: p.line, mode: "assert",
    addresses: [{ addr: p.addr, len: p.expect.length, lens: p.lens }],
    expect: p.expect.map((value, i) => ({ addr: p.addr + i, value })),
  });
  if (r.stopped) return { stopped: stopOf(r) };
  if (r.held) return { held: true, samples: r.samples ?? 0, c64Cycles: r.c64Cycles };
  return { held: false, frame: r.frame, c64Cycles: r.c64Cycles, line: r.line, cycle: r.cycle, actual: r.actual ?? [] };
}

/**
 * `every N frames`: the probe samples every frame and a series keeps only the changes, so the
 * value at frame k is the value of the last row at or before k. Sampling every N-th frame is
 * therefore a reading of those rows, not a second run. A row's `frame` is the sampled frame;
 * `seenFrame` and `c64Cycles` say where the probe first saw that value.
 */
export function everyNth(
  rows: readonly ProbeRow[], everyFrames: number, frames: number,
): (ProbeRow & { seenFrame: number })[] {
  const out: (ProbeRow & { seenFrame: number })[] = [];
  let j = 0;
  let last: string | undefined;
  for (let f = 0; f < frames; f += everyFrames) {
    while (j + 1 < rows.length && rows[j + 1].frame <= f) j++;
    const row = rows[j];
    if (!row) break;
    const key = row.bytes.join(",");
    if (key !== last) {
      out.push({ ...row, frame: f, seenFrame: row.frame });
      last = key;
    }
  }
  return out;
}

const hex2 = (v: number): string => `$${v.toString(16).padStart(2, "0").toUpperCase()}`;
const hex4 = (v: number): string => `$${v.toString(16).padStart(4, "0").toUpperCase()}`;

/** Does one sampled byte satisfy a one-byte `isNot` / `oneOf` check? */
function byteHolds(check: Extract<Check, { kind: "memory" }>, got: number): boolean {
  return check.op === "isNot" ? got !== check.values[0] : check.values.includes(got);
}

/** The first series row on which an `is not` / `is one of` check does not hold, if any. */
export function firstViolation(check: Extract<Check, { kind: "memory" }>, rows: readonly ProbeRow[]): ProbeRow | undefined {
  return rows.find((r) => !byteHolds(check, r.bytes[0]));
}

/** A failed `is` window, said in the check's own terms. */
export function describeAssertFailure(f: Extract<AssertOutcome, { held: false }>): string {
  const bad = f.actual.filter((a) => !a.ok);
  const what = bad.map((a) => `${hex4(a.addr)} is ${hex2(a.value)}, wanted ${hex2(a.expected)}`).join("; ");
  return `frame ${f.frame}, cycle ${f.c64Cycles} (raster line ${f.line}, cycle ${f.cycle}): ${what} — it held for ${f.frame} frames before that`;
}

export function describeRowViolation(check: Extract<Check, { kind: "memory" }>, r: ProbeRow): string {
  const want = check.op === "isNot" ? `anything but ${hex2(check.values[0])}` : `one of ${check.values.map(hex2).join(", ")}`;
  return `frame ${r.frame}, cycle ${r.c64Cycles} (raster line ${r.line}, cycle ${r.cycle}): ${hex4(check.address)} is ${hex2(r.bytes[0])}, wanted ${want} — it held for ${r.frame} frames before that`;
}

export function describeStop(s: ProbeStop): string {
  return `the probe was stopped by a ${s.kind} at PC ${hex4(s.pc)} in frame ${s.frame}, cycle ${s.c64Cycles} (raster line ${s.line}, cycle ${s.cycle})`;
}
