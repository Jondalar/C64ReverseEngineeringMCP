// Spec 844 D2 — an empty required slot is a QUERY RESULT, not an assertion.
//
// This is the half of the spec that replaces the owner as the project's memory. He
// currently has to remember, every session, which relationships were never named; here
// that is computed from what the project holds.
//
// Two ways a slot fills, and both count:
//
//   EXPLICIT — a finding or entity tagged `slot:S3`. Always available, for every slot.
//   DERIVED  — the project's own records already answer it (S2 from registered media,
//              S3 from ordered loader-stage entities, S12 from address coverage). A
//              derived fill needs no ceremony: doing the work IS filling the slot.
//
// S11 is the one slot with a third state on purpose. Four corpus projects claimed free
// RAM from reading and all four were corrected by running, so a read-derived claim fills
// it only as `hypothesis` — enough to be visible, not enough to open the doors that
// allocate.

import type { SlotDef, SlotId } from "./schema.js";
import { SLOTS } from "./schema.js";

export type SlotStatus =
  /** Answered, by a record or by the project's own data. */
  | "filled"
  /** Claimed, but not by an instrument that settles it (S11 read-derived). */
  | "hypothesis"
  /** Required here and unanswered. */
  | "empty"
  /** Its condition does not hold — e.g. S6 in a one-runtime game. */
  | "n/a";

export interface SlotState {
  slot: SlotDef;
  status: SlotStatus;
  /** How it was filled, or what was looked for and not found. Always populated. */
  detail: string;
}

export interface SlotReport {
  states: SlotState[];
  /** Knowledge records of any kind. Below, "has this project begun?" is asked of it. */
  records: number;
  /** Required slots that are empty. The answer to "what is still unmapped". */
  missing: SlotState[];
  coverage: CoverageReport;
}

export interface CoverageReport {
  /** Bytes inside at least one known address range. */
  covered: number;
  /** Bytes in the artifacts that could be measured. */
  total: number;
  ratio: number;
  /** Artifacts with neither an addressRange nor a fileSize — named, never silently dropped. */
  unmeasured: string[];
  threshold: number;
}

const SLOT_TAG = /^slot:(S\d{1,2})$/i;

function coverageThreshold(): number {
  const raw = process.env.C64RE_COVERAGE_THRESHOLD?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
}

/** Union of [start,end] ranges, in bytes. Overlaps counted once. */
function unionSize(ranges: Array<{ start: number; end: number }>): number {
  if (ranges.length === 0) return 0;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let total = 0, curStart = sorted[0].start, curEnd = sorted[0].end;
  for (const r of sorted.slice(1)) {
    if (r.start <= curEnd + 1) curEnd = Math.max(curEnd, r.end);
    else { total += curEnd - curStart + 1; curStart = r.start; curEnd = r.end; }
  }
  return total + (curEnd - curStart + 1);
}

export async function slotReport(projectDir: string): Promise<SlotReport> {
  const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
  const rec = new KnowledgeRecords(projectDir);

  const findings = rec.listFindings();
  const entities = rec.listEntities();
  const relations = rec.listRelations();
  const routines = rec.listRoutineNodes();

  // ---- explicit fills -------------------------------------------------------
  const tagged = new Map<SlotId, string[]>();
  const note = (id: SlotId, what: string) => tagged.set(id, [...(tagged.get(id) ?? []), what]);
  for (const f of findings) {
    for (const t of f.tags ?? []) {
      const m = SLOT_TAG.exec(t);
      if (m) note(m[1].toUpperCase() as SlotId, `finding "${f.title}"`);
    }
  }
  for (const e of entities) {
    for (const t of e.tags ?? []) {
      const m = SLOT_TAG.exec(t);
      if (m) note(m[1].toUpperCase() as SlotId, `entity "${e.name}"`);
    }
  }

  // ---- coverage (S12) -------------------------------------------------------
  const ranges: Array<{ start: number; end: number }> = [];
  for (const r of routines) if (r.endAddress != null) ranges.push({ start: r.address, end: r.endAddress });
  for (const e of entities) if (e.addressRange) ranges.push(e.addressRange);
  for (const f of findings) {
    const ar = f.addressRange ?? f.evidence?.[0]?.addressRange;
    if (ar) ranges.push(ar);
  }
  const artifacts = rec.listArtifacts();
  let total = 0;
  const unmeasured: string[] = [];
  for (const a of artifacts) {
    if (a.addressRange) total += a.addressRange.end - a.addressRange.start + 1;
    else if (a.fileSize && a.fileSize > 2) total += a.fileSize - 2; // minus the load address
    else unmeasured.push(a.title);
  }
  const covered = Math.min(unionSize(ranges), total || Number.MAX_SAFE_INTEGER);
  const threshold = coverageThreshold();
  const coverage: CoverageReport = {
    covered: total === 0 ? 0 : covered,
    total,
    ratio: total === 0 ? 0 : covered / total,
    unmeasured,
    threshold,
  };

  // ---- derived fills --------------------------------------------------------
  const mediaKinds = new Set(["d64", "g64", "crt", "prg", "raw"]);
  const media = artifacts.filter((a) => mediaKinds.has(a.kind));
  const loaderStages = entities.filter((e) => e.kind === "loader-stage");
  const payloads = entities.filter((e) => e.kind === "payload");
  const refutations = findings.filter((f) => f.kind === "refutation");
  const runtimeClaim = findings.find((f) => (f.tags ?? []).some((t) => /^slot:S5$/i.test(t)));
  const runtimeCount = runtimeClaim ? parseRuntimeCount(runtimeClaim.title + " " + (runtimeClaim.summary ?? "")) : undefined;

  const derived = new Map<SlotId, string>();
  if (media.length > 0) derived.set("S2", `${media.length} media artifact(s) registered`);
  if (loaderStages.length >= 2) derived.set("S3", `${loaderStages.length} loader-stage entities`);
  // S4 is deliberately NOT derived from the payload entities that exist. It gates
  // `register_payload`, and deriving it from the payloads that call produces would let
  // the door feed itself: first registration fills the slot that was meant to precede
  // it. The geometry — where payloads sit, how they are addressed, how each is packed —
  // is read off the directory / LUT BEFORE anything is registered, so it is an explicit
  // claim or it is nothing.
  if (refutations.length > 0) derived.set("S14", `${refutations.length} refutation finding(s) kept`);
  if (coverage.total > 0 && coverage.ratio >= threshold) {
    derived.set("S12", `${(coverage.ratio * 100).toFixed(1)} % of ${coverage.total} bytes covered`);
  }
  // S6 is answered by a relation that names the handover, as well as by a tagged claim.
  // RelationRecord carries no tags, so the link is made the other way round: a finding
  // tagged slot:S6 references the relation, which is the explicit path below.
  void relations;

  // ---- conditions -----------------------------------------------------------
  // A conditional slot is n/a until its trigger is ANSWERED. That ordering matters:
  // an unanswered S5 must not make S6 look satisfied.
  const applies = (s: SlotDef): { applies: boolean; why: string } => {
    if (s.required === "always") return { applies: true, why: "" };
    switch (s.id) {
      case "S6":
        if (runtimeCount === undefined) return { applies: false, why: "S5 has not stated a runtime count yet" };
        return runtimeCount > 1
          ? { applies: true, why: `S5 states ${runtimeCount} runtimes` }
          : { applies: false, why: `S5 states ${runtimeCount} runtime` };
      case "S7":
        return payloads.length > 1
          ? { applies: true, why: `${payloads.length} payloads reload structurally` }
          : { applies: false, why: "no structured reloading claimed yet (S4)" };
      case "S8":
      case "S9": {
        const engine = tagged.has("S7");
        return engine
          ? { applies: true, why: "S7 claims an engine" }
          : { applies: false, why: "S7 has not claimed an engine" };
      }
      case "S10":
        return media.length > 0
          ? { applies: true, why: "a medium exists to save to" }
          : { applies: false, why: "no medium registered (S2)" };
      default:
        return { applies: true, why: "" };
    }
  };

  // ---- assemble -------------------------------------------------------------
  const states: SlotState[] = SLOTS.map((slot) => {
    const cond = applies(slot);
    if (!cond.applies) return { slot, status: "n/a" as const, detail: cond.why };

    const explicit = tagged.get(slot.id);
    if (explicit && explicit.length > 0) {
      // S11's method marker is the one place where a claim is not automatically an answer.
      if (slot.id === "S11") {
        const byRun = findings.some((f) =>
          (f.tags ?? []).some((t) => /^slot:S11$/i.test(t)) && (f.tags ?? []).some((t) => /^method:run$/i.test(t)));
        return byRun
          ? { slot, status: "filled", detail: `${explicit[0]}, confirmed by running` }
          : { slot, status: "hypothesis", detail: `${explicit[0]}, read-derived — a run has not confirmed it` };
      }
      return { slot, status: "filled", detail: explicit.join(", ") };
    }

    const d = derived.get(slot.id);
    if (d) return { slot, status: "filled", detail: d };

    if (slot.id === "S12") {
      return {
        slot, status: "empty",
        detail: coverage.total === 0
          ? "nothing measurable is registered yet"
          : `${(coverage.ratio * 100).toFixed(1)} % of ${coverage.total} bytes covered, threshold ${(threshold * 100).toFixed(0)} %`,
      };
    }
    return { slot, status: "empty", detail: `no record tagged slot:${slot.id}` };
  });

  return {
    states,
    records: findings.length + entities.length + routines.length,
    missing: states.filter((s) => s.status === "empty" || s.status === "hypothesis"),
    coverage,
  };
}

/** "3 runtimes", "one runtime", "n=2". Deliberately forgiving — the claim is prose. */
function parseRuntimeCount(text: string): number | undefined {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const w = /\b(one|two|three|four|five|six|seven|eight|nine)\b\s+runtime/i.exec(text);
  if (w) return words[w[1].toLowerCase()];
  const n = /\b(\d+)\s*runtime/i.exec(text);
  if (n) return Number(n[1]);
  return undefined;
}

export function formatSlotReport(r: SlotReport): string {
  const mark = (s: SlotStatus) => s === "filled" ? "✓" : s === "hypothesis" ? "~" : s === "n/a" ? "·" : "✗";
  const lines = r.states.map((s) =>
    `${mark(s.status)} ${s.slot.id.padEnd(3)} ${s.slot.name.padEnd(20)} ${s.detail}`);
  const req = r.states.filter((s) => s.status !== "n/a").length;
  const done = r.states.filter((s) => s.status === "filled").length;
  return [
    `Slots: ${done}/${req} filled` + (r.missing.length ? `, ${r.missing.length} open` : ""),
    "",
    ...lines,
    "",
    r.coverage.total > 0
      ? `Coverage: ${r.coverage.covered} / ${r.coverage.total} bytes = ${(r.coverage.ratio * 100).toFixed(1)} % (threshold ${(r.coverage.threshold * 100).toFixed(0)} %)`
      : "Coverage: nothing measurable registered yet",
    ...(r.coverage.unmeasured.length ? [`  unmeasured (no addressRange, no fileSize): ${r.coverage.unmeasured.join(", ")}`] : []),
  ].join("\n");
}
