// One candidate run = ONE sandbox/runMany: run 0 without a patch (the baseline), runs 1..N one per
// variant, all from the same anchor with the same inputs and the same cycle budget, each on a clone
// of its own. The shared machine is touched only to take the anchor's snapshot. Each variant's end
// state is then judged against run 0 with the runtime's component diff, equivalence preset.

import type { Candidate, Variant, Verdict } from "./store.js";

export type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface RunReply {
  id?: string;
  state?: string;
  message?: string;
  endStateId?: string;
  cycles?: number;
  registers?: Record<string, number>;
  ramDigest?: string;
  inputsPlayed?: number;
  inputsSkipped?: number;
}

interface DiffReply {
  verdict?: { identical?: boolean; differing?: string[] };
  components?: Record<string, { identical?: boolean; summary?: string }>;
}

export interface CandidateRunResult {
  baseline: Verdict;
  variants: Array<{ name: string; verdict: Verdict }>;
  from: string;
  /** set when the input list was non-empty: how many of its inputs each run played */
  inputsNote?: string;
}

/** What the runtime's answer to "is anchor X still there" is, decided from the ring itself. */
export async function resolveFrom(call: Call, cand: Candidate): Promise<string> {
  const marks = (await call("mark/list", {})) as { marks?: Array<{ name: string; anchorId: string; cycle: number }> };
  if (marks.marks?.some((m) => m.name === cand.anchor)) return cand.anchor;
  const cps = (await call("checkpoint/list", {})) as { checkpoints?: Array<{ id: string }> };
  if (cps.checkpoints?.some((c) => c.id === cand.anchor)) return cand.anchor;
  throw new Error(
    `the anchor "${cand.anchor}" is not in the ring any more`
    + (cand.anchorCycle !== undefined ? ` (the candidate recorded it at cycle ${cand.anchorCycle}${cand.anchorFrame !== undefined ? `, frame ${cand.anchorFrame}` : ""})` : "")
    + ` — bring the machine to that instant and set the anchor "${cand.anchor}" again; the variants and inputs are kept.`,
  );
}

function verdictOf(run: RunReply, now: string): Verdict {
  if (run.state === "failed") return { state: "failed", message: run.message, ranAt: now };
  return {
    state: "done",
    endStateId: run.endStateId,
    cycles: run.cycles,
    registers: run.registers,
    ramDigest: run.ramDigest,
    inputsPlayed: run.inputsPlayed,
    inputsSkipped: run.inputsSkipped,
    ranAt: now,
  };
}

function changesOf(d: DiffReply): string[] {
  const out: string[] = [];
  for (const [name, c] of Object.entries(d.components ?? {})) {
    if (c.identical === false) out.push(`${name}: ${c.summary ?? "differs"}`);
  }
  return out;
}

export async function runCandidateOnce(call: Call, cand: Candidate): Promise<CandidateRunResult> {
  if (cand.variants.length === 0) throw new Error(`candidate ${cand.id} has no variants — add one with runtime_candidate_variant`);
  const from = await resolveFrom(call, cand);
  const inputs = cand.inputs ?? [];
  const mk = (patches: unknown[]) => ({ cycles: cand.cycleBudget, patches, ...(inputs.length > 0 ? { inputs } : {}) });
  const runs = [
    mk([]),
    ...cand.variants.map((v: Variant) => mk(v.targets.map((t) => ({ space: t.space, ...(t.space === "ram" ? {} : { bank: t.bank ?? 0 }), addr: t.addr, bytes: t.bytes })))),
  ];
  const reply = (await call("sandbox/runMany", { from, runs })) as { runs?: RunReply[] };
  const got = reply.runs ?? [];
  if (got.length !== runs.length) throw new Error(`sandbox/runMany answered ${got.length} runs for ${runs.length} asked`);
  const now = new Date().toISOString();

  // A runtime that does not know `inputs` ignores it and ran the baseline WITHOUT the presses —
  // a verdict that looks like a result and is not one. Refuse rather than store it.
  if (inputs.length > 0 && got[0]!.state !== "failed" && typeof got[0]!.inputsPlayed !== "number") {
    throw new Error(
      "this runtime did not play the input script: its sandbox answer carries no inputsPlayed, so the runs ran without the presses. "
      + "Sandbox runs with inputs need a TRX64 that plays them; nothing was stored.",
    );
  }

  const baseline = verdictOf(got[0]!, now);
  if (baseline.state === "failed") throw new Error(`the baseline run (no patch) failed: ${got[0]!.message ?? "no reason given"}`);
  const variants: CandidateRunResult["variants"] = [];
  for (let i = 0; i < cand.variants.length; i++) {
    const run = got[i + 1]!;
    const verdict = verdictOf(run, now);
    if (verdict.state === "done" && run.endStateId && baseline.endStateId) {
      // The variant's own bytes differ from the baseline's by construction — that is the patch being
      // there, not something it did. They are masked, so the verdict is about what the code CAUSED.
      const own = cand.variants[i]!.targets.filter((t) => t.space === "ram" && t.bytes.length > 0).map((t) => ({
        space: "c64ram", from: `$${(t.addr & 0xffff).toString(16)}`, to: `$${Math.min(0xffff, (t.addr & 0xffff) + t.bytes.length - 1).toString(16)}`,
      }));
      const d = (await call("runtime/component_diff", {
        idA: baseline.endStateId, idB: run.endStateId, exclude: { presets: ["equivalence"], ranges: own },
      })) as DiffReply;
      verdict.identical = d.verdict?.identical === true;
      verdict.differing = d.verdict?.differing ?? [];
      verdict.changes = changesOf(d);
    }
    variants.push({ name: cand.variants[i]!.name, verdict });
  }
  const played = got.map((r) => r.inputsPlayed).filter((n): n is number => typeof n === "number");
  const skipped = got.map((r) => r.inputsSkipped).filter((n): n is number => typeof n === "number");
  const inputsNote = inputs.length === 0 ? undefined
    : `inputs: ${inputs.length} given, ${Math.max(0, ...played)} played per run${skipped.some((n) => n > 0) ? `, ${Math.max(...skipped)} past the budget and skipped` : ""}`;
  return { baseline, variants, from, ...(inputsNote ? { inputsNote } : {}) };
}

/** The table the run returns: variant, cycles, verdict, what changed. */
export function renderRun(cand: Candidate, r: CandidateRunResult): string {
  const hx = (n: number | undefined) => (n === undefined ? "?" : `$${n.toString(16).padStart(4, "0")}`);
  const lines = [
    `Candidate ${cand.id} from anchor "${r.from}" — ${cand.variants.length + 1} runs in parallel on clones; the shared machine was not touched.`,
    `Budget ${cand.cycleBudget} cycles per run.${r.inputsNote ? ` ${r.inputsNote}.` : ""}`,
    "",
    "variant            cycles      PC     verdict vs the run without a patch (the variant's own patched bytes are not counted as a difference)",
    `${"(baseline)".padEnd(18)} ${String(r.baseline.cycles ?? "?").padEnd(11)} ${hx(r.baseline.registers?.pc).padEnd(6)} —`,
  ];
  for (const v of r.variants) {
    const x = v.verdict;
    const word = x.state === "failed" ? `FAILED: ${x.message ?? ""}` : x.identical ? "same as baseline" : `DIFFERS — ${(x.changes ?? []).join("; ") || (x.differing ?? []).join(", ") || "see the diff"}`;
    lines.push(`${v.name.padEnd(18)} ${String(x.cycles ?? "?").padEnd(11)} ${hx(x.registers?.pc).padEnd(6)} ${word}${cand.chosen === v.name ? "   <- chosen" : ""}`);
  }
  return lines.join("\n");
}
