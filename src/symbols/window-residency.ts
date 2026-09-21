// Spec 867 D3 — which claimant is actually in the window.
//
// D2 answers who COULD be at an address: every payload whose window covers it.
// Which of them is there at a given moment is not a static fact and is never
// guessed. Two sources answer it, in this order:
//
//   1. THE BYTES. Spec 804's residency, unchanged and not reimplemented: the
//      runtime hands over memory at a freeze or a trace anchor and C64RE matches
//      it against the payloads' own code bytes (`PayloadBytes`, the same class the
//      name resolver uses). Decided, not inferred.
//   2. THE READING. Where no capture exists, the code that loads the window says
//      what it puts there: a load call naming a track and a sector, and the
//      payload whose sector chain starts there. The call is the evidence.
//
// Where neither settles it the answer says the window is ambiguous and names the
// claimants. It never picks one silently.

import { readFileSync } from "node:fs";
import { claimantsAt, describeWindow, hex4, loadWindows, type PayloadWindow, type WindowSpace } from "../knowledge-graph/windows.js";
import { detectSectorLoads, type AnalysedInstruction } from "../project-knowledge/loader-entrypoint-detect.js";
import { findAnalysisFiles, PayloadBytes } from "./payload-bytes.js";
import type { ByteSource, RuntimeSpace } from "./types.js";

/** How many of a project's analyses the reading may open before it gives up and says so. */
export const READING_SCAN_LIMIT = 48;

export interface ClaimantResidency {
  owner: string;
  window: string;
  /** bytes: how many code bytes were compared and how many matched */
  compared?: number;
  matched?: number;
  resident?: boolean;
  /** the reading: the load call that names this payload's first sector */
  loadCall?: string;
  note?: string;
}

export interface WindowResidency {
  address: number;
  space: WindowSpace;
  /** D2 — who could be here */
  claimants: string[];
  /** the one that IS here, when something decided it */
  resident?: { owner: string; by: "bytes" | "reading"; evidence: string };
  /** why nothing decided it — present exactly when `resident` is absent */
  ambiguous?: string;
  /** per claimant, what each source said */
  evidence: ClaimantResidency[];
}

/** A payload's place on its medium, as the record carries it — the first sector of its chain. */
export interface ClaimantMedium {
  owner: string;
  track?: number;
  sector?: number;
  /** a Spec 750 LUT row that claims this payload, when one does */
  claim?: string;
}

export interface WindowResidencyInput {
  projectDir: string;
  /** the graph store to read the windows from */
  store: Parameters<typeof loadWindows>[0];
  address: number;
  space?: WindowSpace;
  bank?: number | null;
  /** a capture: memory as the runtime holds it now (Spec 804 §4.2) */
  bytes?: ByteSource;
  /** where each claimant's bytes sit on the medium, for the reading */
  media?: ClaimantMedium[];
  /** narrow the reading to one call site */
  loadCall?: number;
  /** how many analyses the reading may open (default READING_SCAN_LIMIT) */
  scanLimit?: number;
}

const runtimeSpace = (s: WindowSpace): RuntimeSpace => (s === "drv" ? "drive8" : "c64");

/** The ctx owner an entity id names — `wl:ram/eng:payload:1000` → `eng`. */
export function ownerOfEntityId(id: string): string | undefined {
  const parts = id.split(":");
  if (parts.length !== 4) return undefined;
  const ctx = (parts[1] ?? "").split("/");
  return ctx.length > 1 ? ctx[1] : undefined;
}

/**
 * Where each payload's bytes start on its medium, from the records the project
 * already holds: the FIRST sector of its chain, and the Spec 750 row that claims
 * it. This is the half the reading matches a load call against.
 */
export function mediaFromEntities(
  entities: ReadonlyArray<{ id: string; mediumSpans?: ReadonlyArray<Record<string, unknown>>; payloadClaimedByLutId?: string; payloadClaimedByRow?: number }>,
): ClaimantMedium[] {
  const out: ClaimantMedium[] = [];
  for (const e of entities) {
    const owner = ownerOfEntityId(e.id);
    if (!owner) continue;
    const first = (e.mediumSpans ?? []).find((s) => s.kind === "sector");
    out.push({
      owner,
      ...(typeof first?.track === "number" ? { track: first.track } : {}),
      ...(typeof first?.sector === "number" ? { sector: first.sector } : {}),
      ...(e.payloadClaimedByLutId ? { claim: `${e.payloadClaimedByLutId}#${e.payloadClaimedByRow ?? "?"}` } : {}),
    });
  }
  return out;
}

/** The window context as prose — the shape every door prints. */
export function formatWindowResidency(r: WindowResidency): string[] {
  const lines: string[] = [`Window at ${hex4(r.address)} (${r.space}): ${r.claimants.length} claimant${r.claimants.length === 1 ? "" : "s"}`];
  for (const e of r.evidence) {
    const verdict = e.resident === true ? `resident — ${e.matched}/${e.compared} code bytes match memory`
      : e.resident === false ? `not resident — ${e.matched}/${e.compared} code bytes match memory`
      : e.loadCall ? `named by the reading — ${e.loadCall}`
      : e.note ?? "nothing decided";
    lines.push(`  ${e.owner} ${e.window}: ${verdict}`);
  }
  if (r.resident) lines.push(`Resident: ${r.resident.owner} — decided by the ${r.resident.by}: ${r.resident.evidence}`);
  if (r.ambiguous) lines.push(`Ambiguous: ${r.ambiguous}`);
  return lines;
}

/**
 * The window's context at one address: who claims it, who is in it, and — when
 * nobody can say — why not.
 */
export async function windowResidency(input: WindowResidencyInput): Promise<WindowResidency> {
  const windows = loadWindows(input.store);
  const found = claimantsAt(windows, { address: input.address, space: input.space, bank: input.bank });
  const claimants = found.claimants;
  const space = input.space ?? claimants[0]?.space ?? "ram";
  const base: WindowResidency = {
    address: input.address,
    space,
    claimants: claimants.map((w) => w.owner),
    evidence: [],
  };
  if (claimants.length === 0) {
    return { ...base, ambiguous: `no payload window covers ${hex4(input.address)} — nobody claims this address` };
  }

  // 1 — the bytes. Spec 804's residency, one comparison set per claimant.
  if (input.bytes) {
    const decided = await byBytes(input, claimants, space);
    base.evidence.push(...decided.evidence);
    if (decided.resident) return { ...base, resident: decided.resident };
    // a capture that settled nothing still leaves the reading its turn
  }

  // 2 — the reading.
  const read = byReading(input, claimants);
  base.evidence.push(...read.evidence);
  if (read.resident) return { ...base, resident: read.resident };

  const names = claimants.map((w) => describeWindow(w)).join("; ");
  const why = input.bytes
    ? "no claimant's code bytes are the bytes in memory"
    : "no capture was offered, and no load call in this project names exactly one of them";
  return {
    ...base,
    ambiguous: claimants.length === 1
      ? `${hex4(input.address)} has one claimant, ${claimants[0]!.owner}, but nothing says it is in the window now: ${why}`
      : `the window at ${hex4(input.address)} is ambiguous — ${why}. The claimants are: ${names}`,
  };
}

async function byBytes(
  input: WindowResidencyInput,
  claimants: PayloadWindow[],
  space: WindowSpace,
): Promise<{ resident?: WindowResidency["resident"]; evidence: ClaimantResidency[] }> {
  // The same byte-matcher the name resolver uses: a payload's own code bytes near
  // the address, from its analysis, self-modified operands excluded. No second
  // implementation of residency exists and none is wanted (Spec 804 §4.2).
  const bytes = new PayloadBytes(input.projectDir, new Map(), new Map());
  const evidence: ClaimantResidency[] = [];
  const resident: PayloadWindow[] = [];
  for (const w of claimants) {
    const set = bytes.comparisonSet({ kind: "analysis", owner: w.owner }, input.address);
    if (set.length === 0) {
      evidence.push({ owner: w.owner, window: describeWindow(w), note: "too few code bytes near this address to decide by bytes" });
      continue;
    }
    const live = await input.bytes!.read(runtimeSpace(space), undefined, set);
    const code = bytes.codeBytes({ kind: "analysis", owner: w.owner });
    let matched = 0;
    let compared = 0;
    for (const addr of set) {
      const have = live.get(addr);
      if (have === undefined) continue;
      compared += 1;
      if (have === code.get(addr)) matched += 1;
    }
    const ok = compared >= 4 && matched === compared;
    evidence.push({ owner: w.owner, window: describeWindow(w), compared, matched, resident: ok });
    if (ok) resident.push(w);
  }
  if (resident.length === 1) {
    const w = resident[0]!;
    const e = evidence.find((x) => x.owner === w.owner)!;
    return {
      resident: {
        owner: w.owner,
        by: "bytes",
        evidence: `${e.matched}/${e.compared} of ${w.owner}'s own code bytes around ${hex4(input.address)} are the bytes in memory (Spec 804 residency)`,
      },
      evidence,
    };
  }
  return { evidence };
}

interface AnalysisDoc { codeAnalysis?: { instructions?: AnalysedInstruction[] } }

function byReading(
  input: WindowResidencyInput,
  claimants: PayloadWindow[],
): { resident?: WindowResidency["resident"]; evidence: ClaimantResidency[] } {
  const media = input.media ?? [];
  const wanted = new Map<string, ClaimantMedium>();
  for (const w of claimants) {
    const m = media.find((x) => x.owner.toLowerCase() === w.owner);
    if (m) wanted.set(w.owner, m);
  }
  const evidence: ClaimantResidency[] = [];
  if (wanted.size === 0) return { evidence };

  // Every sector-load call site the project's own disassembly holds: an immediate
  // track and an immediate sector, then the call. Read-derived (Spec 750.4), never
  // a byte-shape guess.
  const files = [...findAnalysisFiles(input.projectDir).values()].slice(0, input.scanLimit ?? READING_SCAN_LIMIT);
  const calls: Array<{ track: number; sector: number; address: number; evidence: string }> = [];
  for (const path of files) {
    let doc: AnalysisDoc;
    try { doc = JSON.parse(readFileSync(path, "utf8")) as AnalysisDoc; } catch { continue; }
    const ins = doc.codeAnalysis?.instructions ?? [];
    if (ins.length === 0) continue;
    for (const p of detectSectorLoads(ins)) {
      if (p.track === undefined || p.sector === undefined) continue;
      if (input.loadCall !== undefined && p.address !== input.loadCall && !p.witnesses.includes(input.loadCall)) continue;
      calls.push({ track: p.track, sector: p.sector, address: p.address, evidence: p.evidence.join("; ") });
    }
  }

  const named: Array<{ owner: string; call: string }> = [];
  for (const [owner, m] of wanted) {
    const hit = m.track !== undefined && m.sector !== undefined
      ? calls.find((c) => c.track === m.track && c.sector === m.sector)
      : undefined;
    const w = claimants.find((x) => x.owner === owner)!;
    if (hit) {
      const call = `a load call at ${hex4(hit.address)} names track ${hit.track} sector ${hit.sector}, which is where ${owner}'s bytes start (${hit.evidence})`;
      evidence.push({ owner, window: describeWindow(w), loadCall: call });
      named.push({ owner, call });
    } else {
      evidence.push({ owner, window: describeWindow(w), note: m.track !== undefined ? `no load call in this project names track ${m.track} sector ${m.sector}` : "this payload's record says nothing about where its bytes are on the medium" });
    }
  }
  if (named.length === 1) {
    return { resident: { owner: named[0]!.owner, by: "reading", evidence: named[0]!.call }, evidence };
  }
  return { evidence };
}
