// Merging N readings of one payload into one annotations file — and keeping the
// judgement that the merge required.
//
// Measured, from a run watched live: five subagents each produced a fragment, and the
// script that combined them carried the judgements as Python literals in a scratchpad
// that dies with the session —
//
//     order   = ["C","D","B","E","A"]      # whose reading wins a tie
//     segpref = {"82E6": "E"}              # two agents disagreed here; E won
//     rename  = {("D","64BF"): "exit_door_probe"}
//
// Who was right at $82E6 and why is exactly what the project exists to remember. It was
// lost: the graph received the merged result and never learned the merge was contested.
//
// Four rules follow.
//
//   AGREEMENT IS NOT A CONTRADICTION. Five readers annotating one entry point is the
//   normal case. Two claims that say the same thing collapse into one and nobody is
//   asked anything.
//
//   ONE ADDRESS CARRIES ONE NAME, AND ONE NAME LIVES AT ONE ADDRESS — across every record
//   that names an address: a segment's `label`, `labels[]` and `routines[]`. The same name
//   at the same address from any mix of them is ONE claim, however many records and
//   fragments say it. Two names at one address, or one name at two addresses, is a
//   contradiction. Names are compared as the assembler identifier they become (a routine's
//   "Turn advance" is `Turn_advance`), so a label and a routine that spell one identifier
//   agree. An immediate (`lda #<x`) names no address of its own: it is keyed by the
//   instruction address, and when the label it points at loses a resolution it follows the
//   winner at that address — or, if the name was deleted, goes with it — and never survives
//   pointing at a name the file no longer defines.
//
//   A CONTRADICTION IS REFUSED BY NAMING BOTH SIDES. Not resolved by a priority order,
//   because a priority order is a judgement with the reasoning deleted — `order =
//   ["C","D","B","E","A"]` says nothing about $82E6 and never did. The refusal names the
//   key, every claimant and what each of them claimed, so the caller answers the
//   question that was actually asked.
//
//   A RESOLUTION IS A FINDING. Per contradiction, in the project, naming who claimed
//   what, which one won and why — in the caller's own words. That is the whole point of
//   this door; the merged file alone is the thing that was already achievable with a
//   scratchpad.
//
// A contradiction whose existence depends on another one is not listed until that one is
// answered (an immediate pointing at a label that is still in dispute, a name that a
// segment's own unresolved contest would change). A refusal can therefore be followed by
// a second one after the first is answered; a refusal never lists a key that the answer
// to another key could make vanish.

import { basename } from "node:path";
import {
  buildAnnotationsDocument, canonHex, renderProblems, readSections,
  type AnnotationsDocument, type Problem, type RawSections,
} from "./annotation-file.js";

// ------------------------------------------------------------------- inputs

export interface FragmentInput extends RawSections {
  name?: string;
  path?: string;
}

export interface ResolutionInput {
  key: string;
  winner?: string;
  value?: Record<string, unknown>;
  /** Remove the contested entry (or, for a `name:` key, every site of the name). */
  delete?: boolean;
  why?: string;
}

// ------------------------------------------------------------------- claims

type ClaimKind = "segment" | "label" | "routine" | "name" | "split" | "immediate" | "memoryMap";
type NameFrom = "segment" | "label" | "routine";

interface Claim {
  fragment: string;
  /** The identity of the claim — two claims with the same signature agree. */
  signature: string;
  /** How it reads in a message a human answers. */
  described: string;
  /** The entry as it would be written, canonical already. */
  entry: Record<string, unknown>;
  /** Which record carried the name, for `label:` / `routine:` contests. */
  from?: NameFrom;
  name?: string;
}

interface Contest {
  key: string;
  kind: ClaimKind;
  address: string;
  claims: Claim[];
}

const $ = (hex: string): string => `$${hex}`;

/** The assembler identifier a name becomes — the loader's own `toLabelIdent`. */
function identOf(name: string): string {
  const s = name.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1");
  return s.length ? s : name.trim();
}

function describeSplit(e: Record<string, unknown>): string {
  if (e.reject !== undefined) return `$${String(e.lo)}/$${String(e.hi)}  REJECTED: ${String(e.reject)}`;
  const parts = [`count ${String(e.count)}`];
  if (e.adjust !== undefined) parts.push(`adjust ${String(e.adjust)}`);
  if (e.base !== undefined) parts.push(`base ${String(e.base)}`);
  return `$${String(e.lo)}/$${String(e.hi)}  ${parts.join(", ")}`;
}

function describeSegment(e: Record<string, unknown>): string {
  return `${$(String(e.start))}-${$(String(e.end))}  ${String(e.kind)}${e.label ? `  "${String(e.label)}"` : ""}`;
}

function describeMemory(e: Record<string, unknown>): string {
  const routines = Array.isArray(e.routines) && e.routines.length > 0 ? `, only the code of ${(e.routines as string[]).map($).join(", ")}` : ", everywhere";
  return `${$(String(e.start))}-${$(String(e.end))}  ${String(e.as)}${routines}`;
}

function describeImmediate(e: Record<string, unknown>): string {
  return `${String(e.kind)} "${String(e.label)}"`;
}

const REMOVED = "removed by the resolution";

// ------------------------------------------------------------------ merging

type Winning = Claim | { fragment: null; described: string; entry: Record<string, unknown>; signature: string };

export interface MergePlan {
  doc: AnnotationsDocument;
  /** The contradictions, in address order — empty means nothing was contested. */
  contests: Contest[];
  /** The resolutions applied, paired with the contest each one settled. */
  settled: Array<{ contest: Contest; resolution: Required<Pick<ResolutionInput, "key" | "why">> & { winner?: string; value?: Record<string, unknown>; delete?: boolean }; winning: Winning }>;
  notes: string[];
}

export type MergeOutcome = { plan: MergePlan } | { refusal: string };

type Decision = { kind: "keep"; ident: string; name: string } | { kind: "rename"; ident: string; name: string } | { kind: "delete" };

/**
 * Read every fragment, check each one on its own, then find what they disagree about.
 *
 * The per-fragment pass is the writer's own validation: a fragment that could not be
 * written on its own is named with its fragment name, before anything is compared,
 * because "these five disagree" is not a useful thing to be told about a file that was
 * malformed to begin with.
 */
export function planMerge(
  projectDir: string,
  fragments: FragmentInput[],
  resolutions: ResolutionInput[],
  binary: string,
  image?: { start: number; end: number },
): MergeOutcome {
  if (fragments.length === 0) {
    return { refusal: "REFUSED — no fragments. Nothing was written.\n\nPass `fragments: [{ name, ... }]` — each one a reading, with a name, because the name is the WHO in \"who claimed what\"." };
  }

  // ---- 1. read each fragment and check it on its own
  const named: Array<{ name: string; doc: AnnotationsDocument }> = [];
  const seenNames = new Map<string, string>();
  const problems: Problem[] = [];
  for (const [i, f] of fragments.entries()) {
    const origin = f.path ? f.path : `fragments[${i}]`;
    let sections: RawSections = { segments: f.segments, labels: f.labels, routines: f.routines, pointerTables: f.pointerTables, jumpTables: f.jumpTables, splitTables: f.splitTables, immediates: f.immediates, memoryMap: f.memoryMap };
    if (f.path) {
      const read = readSections(f.path);
      if ("refusal" in read) return { refusal: `REFUSED — fragment ${f.name ?? `fragments[${i}]`}: ${read.refusal}\n\nNothing was written.` };
      sections = read.sections;
    }
    const name = (f.name ?? (f.path ? basename(f.path).replace(/(_annotations)?\.json$/u, "") : "")).trim();
    if (!name) return { refusal: `REFUSED — fragments[${i}] has no name. Nothing was written.\n\nA fragment's name is the WHO in \"who claimed what\": it is what a resolution picks a winner by and what the recorded judgement quotes. Give each reading a name.` };
    const clash = seenNames.get(name);
    if (clash) return { refusal: `REFUSED — two fragments are both called "${name}" (${clash} and ${origin}). Nothing was written.\n\nA resolution picks a winner BY NAME, so two fragments may not share one.` };
    seenNames.set(name, origin);
    const own = buildAnnotationsDocument(sections, binary, image);
    for (const p of own.problems) problems.push({ ...p, where: `${name}.${p.where}` });
    named.push({ name, doc: own.doc });
  }
  if (problems.length > 0) {
    return { refusal: renderProblems("REFUSED — a fragment could not be written on its own, so there is nothing to merge.", problems) };
  }

  // ---- 2. collect every claim, keyed
  const byKey = new Map<string, Contest>();
  const claim = (kind: ClaimKind, address: string, fragment: string, signature: string, described: string, entry: Record<string, unknown>): void => {
    const key = `${kind}:${address}`;
    const c = byKey.get(key) ?? { key, kind, address, claims: [] };
    c.claims.push({ fragment, signature, described, entry });
    byKey.set(key, c);
  };
  // every name any record gives an address, label and routine side — a segment's label is
  // added once the segment itself is settled
  const nameClaims = new Map<string, Array<{ fragment: string; from: NameFrom; name: string; ident: string }>>();
  const addNameClaim = (address: string, fragment: string, from: NameFrom, name: string): void => {
    const a = nameClaims.get(address);
    const v = { fragment, from, name, ident: identOf(name) };
    if (a) a.push(v); else nameClaims.set(address, [v]);
  };

  for (const { name: frag, doc } of named) {
    for (const s of doc.segments) {
      const entry = { ...s } as unknown as Record<string, unknown>;
      claim("segment", s.start, frag, `${s.end}|${s.kind}|${s.label ?? ""}`, describeSegment(entry), entry);
    }
    for (const l of doc.labels) {
      claim("label", l.address, frag, identOf(l.label), `"${l.label}"`, { ...l } as unknown as Record<string, unknown>);
      addNameClaim(l.address, frag, "label", l.label);
    }
    for (const r of doc.routines) {
      claim("routine", r.address, frag, identOf(r.name), `"${r.name}"`, { ...r } as unknown as Record<string, unknown>);
      addNameClaim(r.address, frag, "routine", r.name);
    }
    // a split table is claimed by its pair; two readings that state it the same way agree
    for (const t of doc.splitTables ?? []) {
      const entry = { ...t } as unknown as Record<string, unknown>;
      claim("split", `${t.lo}-${t.hi}`, frag, `${t.count ?? ""}|${t.adjust ?? 0}|${t.base ?? ""}|${t.reject ?? ""}`, describeSplit(entry), entry);
    }
    // a range is claimed by its bounds; two readings that call it the same thing agree, whatever routines they name
    for (const m of doc.memoryMap ?? []) {
      const entry = { ...m } as unknown as Record<string, unknown>;
      claim("memoryMap", `${m.start}-${m.end}`, frag, m.as, describeMemory(entry), entry);
    }
  }

  // ---- 3. the resolutions
  const byResolutionKey = new Map<string, ResolutionInput>();
  for (const r of resolutions) {
    const key = normaliseKey(r.key);
    if (byResolutionKey.has(key)) return { refusal: `REFUSED — two resolutions for ${key}. Nothing was written.` };
    byResolutionKey.set(key, { ...r, key });
  }
  const usedResolutions = new Set<string>();
  /** `label:3807` and `routine:3807` are one contest when label and routine disagree there. */
  const resolutionFor = (key: string): ResolutionInput | undefined => {
    for (const k of [key, key.replace(/^label:/u, "routine:"), key.replace(/^routine:/u, "label:")]) {
      const r = byResolutionKey.get(k);
      if (r) { usedResolutions.add(k); return r; }
    }
    return undefined;
  };

  const allContests: Contest[] = [];
  const settled: MergePlan["settled"] = [];
  const badWinners: string[] = [];
  const noReason: string[] = [];
  const bothGiven: string[] = [];
  const resolvedEntry = new Map<string, Record<string, unknown>>();
  const resolvedFrom = new Map<string, string>();
  const removed = new Set<string>();
  const decisions = new Map<string, Decision>();
  const settledKeys = new Set<string>();
  // The sites a name contest took the name away from, keyed `${kind}:${address}` — an
  // address alone would also hit the routine that happens to sit at a label's address
  // and was never in the contest.
  const nameLoser = new Map<string, { name: string; winner: string }>();
  const deletedIdents = new Set<string>();

  const removedWinning: Winning = { fragment: null, signature: "", described: REMOVED, entry: {} };

  /** Apply the resolution for one contest, if there is one. Returns whether it settled. */
  const settle = (c: Contest): boolean => {
    allContests.push(c);
    const r = resolutionFor(c.key);
    if (!r) return false;
    const given = [r.winner ? 1 : 0, r.value ? 1 : 0, r.delete === true ? 1 : 0].reduce((a, b) => a + b, 0);
    if (given > 1) { bothGiven.push(c.key); return false; }
    const why = (r.why ?? "").trim();
    if (why.length < 10) { noReason.push(c.key); return false; }
    const done = (res: { winner?: string; value?: Record<string, unknown>; delete?: boolean }, winning: Winning): boolean => {
      settled.push({ contest: c, resolution: { key: c.key, why, ...res }, winning });
      settledKeys.add(c.key);
      return true;
    };
    if (r.delete === true) {
      if (c.kind === "name") {
        for (const other of c.claims) nameLoser.set(String(other.entry.site), { name: String(other.entry.name), winner: "(deleted)" });
        deletedIdents.add(c.key.slice(5));
      } else if (c.kind === "label" || c.kind === "routine") {
        decisions.set(c.address, { kind: "delete" });
      } else {
        removed.add(c.key);
      }
      return done({ delete: true }, removedWinning);
    }
    if (r.winner) {
      const [wf, wk] = splitWinner(r.winner);
      const hits = c.claims.filter((x) => x.fragment === wf && (wk === undefined || x.from === wk));
      if (hits.length === 0) {
        badWinners.push(`${c.key} — "${r.winner}" claimed nothing there; the claimants are ${[...new Set(c.claims.map((x) => `${x.fragment}${x.from ? `:${x.from}` : ""}`))].join(", ")}`);
        return false;
      }
      const hit = hits[0]!;
      if ((c.kind === "label" || c.kind === "routine" || c.kind === "immediate") && new Set(hits.map((h) => h.signature)).size > 1) {
        badWinners.push(`${c.key} — "${r.winner}" claimed more than one thing there (${hits.map((h) => h.described).join(", ")}); ${c.kind === "immediate" ? "give a \`value\` or \`delete\` instead" : `name the record: "${wf}:label", "${wf}:routine" or "${wf}:segment"`}`);
        return false;
      }
      if (c.kind === "name") {
        for (const other of c.claims) {
          if (other.entry.address === hit.entry.address) continue;
          nameLoser.set(String(other.entry.site), { name: String(other.entry.name), winner: wf });
        }
      } else if (c.kind === "label" || c.kind === "routine") {
        decisions.set(c.address, { kind: "keep", ident: hit.signature, name: hit.name! });
      } else {
        resolvedEntry.set(c.key, hit.entry);
        resolvedFrom.set(c.key, wf);
      }
      return done({ winner: r.winner }, hit);
    }
    if (r.value) {
      if (c.kind === "name") { badWinners.push(`${c.key} — a name contest is settled by picking the address that keeps the name (\`winner\`), or by \`delete\`, not by a value; to rename one side, change it in the fragment`); return false; }
      if (c.kind === "label" || c.kind === "routine") {
        const nm = typeof r.value.label === "string" ? r.value.label : typeof r.value.name === "string" ? r.value.name : undefined;
        if (nm === undefined || nm.trim() === "") { badWinners.push(`${c.key} — a value here is the one name the address carries: { label: "…" } (or { name: "…" })`); return false; }
        decisions.set(c.address, { kind: "rename", ident: identOf(nm), name: nm.trim() });
        return done({ value: r.value }, { fragment: null, signature: "", described: `"${nm.trim()}"`, entry: { name: nm.trim() } });
      }
      const built = buildOne(c, r.value);
      if ("refusal" in built) { badWinners.push(`${c.key} — ${built.refusal}`); return false; }
      resolvedEntry.set(c.key, built.entry);
      resolvedFrom.set(c.key, "(resolution)");
      return done({ value: r.value }, { fragment: null, signature: "", described: built.described, entry: built.entry });
    }
    badWinners.push(`${c.key} — neither a \`winner\` (a fragment name), a \`value\` (an entry neither side proposed) nor \`delete: true\``);
    return false;
  };

  // ---- 4a. stage one: the segments, the split tables and the memory map
  for (const c of [...byKey.values()].sort(byAddress)) {
    if (c.kind !== "segment" && c.kind !== "split" && c.kind !== "memoryMap") continue;
    if (new Set(c.claims.map((x) => x.signature)).size > 1) settle(c);
  }

  // The label each segment carries once settled. A segment still in dispute carries none
  // yet — its label comes into the name checks when the segment is settled.
  const segLabel = new Map<string, { fragment: string; name: string }>();
  for (const c of [...byKey.values()].filter((x) => x.kind === "segment")) {
    const contested = new Set(c.claims.map((x) => x.signature)).size > 1;
    let entry: Record<string, unknown> | undefined;
    let fragment = c.claims[0]!.fragment;
    if (contested) {
      if (removed.has(c.key)) continue;
      entry = resolvedEntry.get(c.key);
      fragment = resolvedFrom.get(c.key) ?? fragment;
    } else entry = c.claims[0]!.entry;
    if (entry && typeof entry.label === "string" && entry.label !== "") segLabel.set(c.address, { fragment, name: entry.label });
  }

  // ---- 4b. stage two: one address, one name
  const nameAddresses = new Set([...nameClaims.keys(), ...segLabel.keys()]);
  const claimsAt = (address: string): Array<{ fragment: string; from: NameFrom; name: string; ident: string }> => {
    const seg = segLabel.get(address);
    return [...(nameClaims.get(address) ?? []), ...(seg ? [{ fragment: seg.fragment, from: "segment" as const, name: seg.name, ident: identOf(seg.name) }] : [])];
  };
  const pendingAddress = new Set<string>();
  for (const address of [...nameAddresses].sort((a, b) => parseInt(a, 16) - parseInt(b, 16))) {
    const cl = claimsAt(address);
    if (new Set(cl.map((x) => x.ident)).size < 2) continue;
    const froms = new Set(cl.map((x) => x.from));
    const kind: "label" | "routine" = froms.size === 1 && froms.has("routine") ? "routine" : "label";
    const c: Contest = {
      key: `${kind}:${address}`, kind, address,
      claims: cl.map((x) => ({
        fragment: x.fragment, signature: x.ident, from: x.from, name: x.name,
        described: `${x.from === "segment" ? "segment label" : x.from} "${x.name}"`,
        entry: { address, name: x.name, from: x.from },
      })),
    };
    if (!settle(c)) pendingAddress.add(address);
  }

  // what each decided address did to the names it held
  const identsAt = new Map<string, Set<string>>();
  for (const a of nameAddresses) for (const x of claimsAt(a)) {
    const s = identsAt.get(x.ident) ?? new Set<string>();
    s.add(a);
    identsAt.set(x.ident, s);
  }
  const renameTo = new Map<string, string>(); // loser ident -> winning name
  const pendingIdents = new Set<string>();
  for (const a of nameAddresses) {
    const cl = claimsAt(a);
    if (pendingAddress.has(a)) { for (const x of cl) pendingIdents.add(x.ident); continue; }
    const d = decisions.get(a);
    if (!d) continue;
    for (const x of cl) {
      if (d.kind !== "delete" && x.ident === d.ident) continue;
      const elsewhere = [...(identsAt.get(x.ident) ?? [])].some((o) => o !== a);
      if (elsewhere) continue;
      if (d.kind === "delete") deletedIdents.add(x.ident); else renameTo.set(x.ident, d.name);
    }
  }

  // ---- 4c. stage three: one name, one address
  {
    const sites = new Map<string, Array<{ fragment: string; from: NameFrom; address: string; name: string }>>();
    for (const a of nameAddresses) {
      if (pendingAddress.has(a)) continue;
      const d = decisions.get(a);
      const cl = claimsAt(a);
      let live: Array<{ fragment: string; from: NameFrom; name: string; ident: string }>;
      if (d?.kind === "delete") live = [];
      else if (d?.kind === "rename") live = [{ fragment: "(resolution)", from: renameHost(cl), name: d.name, ident: d.ident }];
      else if (d?.kind === "keep") live = cl.filter((x) => x.ident === d.ident);
      else live = cl;
      for (const x of live) push(sites, x.ident, { fragment: x.fragment, from: x.from, address: a, name: x.name });
    }
    for (const [ident, ss] of [...sites.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (new Set(ss.map((s) => s.address)).size < 2) continue;
      settle({
        key: `name:${ident}`, kind: "name", address: [...ss].sort((a, b) => parseInt(a.address, 16) - parseInt(b.address, 16))[0]!.address,
        claims: ss.map((s) => ({
          fragment: s.fragment, signature: `${s.from}:${s.address}`,
          described: `${s.from === "segment" ? "segment" : s.from} ${$(s.address)} — "${s.name}"`,
          entry: { address: s.address, name: s.name, site: `${s.from}:${s.address}` },
        })),
      });
    }
  }

  // ---- 4d. stage four: the immediates, after the labels they point at are settled
  const notes: string[] = [];
  const immClaims = new Map<string, Array<{ fragment: string; entry: Record<string, unknown>; pending: boolean }>>();
  for (const { name: frag, doc } of named) {
    for (const im of doc.immediates ?? []) {
      let label = im.label;
      const id = identOf(label);
      if (deletedIdents.has(id)) {
        notes.push(`immediate ${$(im.address)} ${im.kind} "${label}" dropped: the name "${label}" was deleted by a resolution.`);
        continue;
      }
      const to = renameTo.get(id);
      if (to !== undefined && to !== label) {
        notes.push(`immediate ${$(im.address)} ${im.kind}: "${label}" → "${to}" — the label it pointed at lost its address to "${to}".`);
        label = to;
      }
      const list = immClaims.get(im.address) ?? [];
      list.push({ fragment: frag, entry: { ...im, label } as unknown as Record<string, unknown>, pending: pendingIdents.has(id) });
      immClaims.set(im.address, list);
    }
  }
  const immKey = (a: string): string => `immediate:${a}`;
  for (const address of [...immClaims.keys()].sort((a, b) => parseInt(a, 16) - parseInt(b, 16))) {
    const list = immClaims.get(address)!;
    const live = list.filter((x) => !x.pending);
    if (new Set(live.map((x) => `${String(x.entry.kind)}|${String(x.entry.label)}`)).size < 2) continue;
    settle({
      key: immKey(address), kind: "immediate", address,
      claims: live.map((x) => ({ fragment: x.fragment, signature: `${String(x.entry.kind)}|${String(x.entry.label)}`, described: describeImmediate(x.entry), entry: x.entry })),
    });
  }

  // ---- 5. what has to be answered before anything is written
  if (bothGiven.length > 0) {
    return { refusal: `REFUSED — a resolution names more than one of winner, value and delete. Nothing was written.\n\n${bothGiven.map((k) => `  ${k}`).join("\n")}\n\nOne of them: \`winner\` takes a fragment's claim as it stands, \`value\` replaces both with something neither proposed, \`delete\` removes the entry.` };
  }
  if (noReason.length > 0) {
    return { refusal: [
      "REFUSED — a resolution without a reason. Nothing was written and nothing was recorded.",
      "",
      ...noReason.map((k) => `  ${k}`),
      "",
      "The reason IS the record. A merge that keeps only the winner is a merge whose judgement dies with the",
      "session — which is the thing this door exists to stop. Say why, in a sentence, and it is stored with",
      "both readings against the address.",
    ].join("\n") };
  }
  if (badWinners.length > 0) {
    return { refusal: `REFUSED — a resolution could not be applied. Nothing was written and nothing was recorded.\n\n${badWinners.map((b) => `  ${b}`).join("\n")}` };
  }

  const unresolved = allContests.filter((c) => !settledKeys.has(c.key));
  if (unresolved.length > 0) {
    // a resolution for a key that is not (yet) a contest is reported by the refusal below
    // only when nothing is open; while something is, the open list is the answer to give
    return { refusal: renderContests(unresolved.sort(byAddress)) };
  }

  const stray = [...byResolutionKey.keys()].filter((k) => !usedResolutions.has(k));
  if (stray.length > 0) {
    return { refusal: [
      "REFUSED — a resolution was given for something nothing disputes. Nothing was written and nothing was recorded.",
      "",
      ...stray.map((k) => `  ${k} — every fragment that mentions it says the same thing`),
      "",
      "A recorded judgement about a dispute that did not happen is worse than no record: it reads, later, as if",
      "there had been two readings. Drop the resolution, or check you meant a different key.",
      allContests.length > 0 ? `\nThe keys that ARE contested: ${allContests.map((c) => c.key).join(", ")}` : "",
    ].filter((l) => l !== "").join("\n") };
  }

  // ---- 6. build the merged document, winners applied
  const merged: RawSections = { segments: [], labels: [], routines: [], pointerTables: [], jumpTables: [], splitTables: [], immediates: [], memoryMap: [] };
  /** Comments that belonged to an entry a resolution removed, by address. */
  const rescued = new Map<string, string[]>();
  const rescue = (address: string, entry: Record<string, unknown>): void => {
    const c = typeof entry.comment === "string" ? entry.comment.trim() : "";
    if (c) push(rescued, address, c);
  };
  const decisionAt = (address: string): Decision | undefined => decisions.get(address);

  // segments, split tables
  for (const c of [...byKey.values()].sort(byAddress)) {
    if (c.kind !== "segment" && c.kind !== "split") continue;
    if (removed.has(c.key)) { notes.push(`${c.key} removed by its resolution.`); continue; }
    const first = c.claims[0]!;
    const comments = new Set(c.claims.map((x) => String(x.entry.comment ?? "")).filter((x) => x !== ""));
    if (comments.size > 1 && !resolvedEntry.has(c.key)) notes.push(`${c.key}: ${comments.size} fragments described it differently in prose while agreeing on the claim — ${first.fragment}'s comment was kept.`);
    const entry = { ...(resolvedEntry.get(c.key) ?? first.entry) };
    if (!resolvedEntry.has(c.key) && comments.size === 1 && entry.comment === undefined) entry.comment = [...comments][0]!;
    if (c.kind === "segment") {
      const lost = nameLoser.get(c.key);
      const d = decisionAt(c.address);
      const label = typeof entry.label === "string" ? entry.label : undefined;
      if (label !== undefined) {
        // a segment is a range and a kind as well as a name; it keeps both and loses only the name it may not have.
        if (lost) {
          delete entry.label;
          notes.push(`${c.key} keeps its range and kind but loses the name "${lost.name}" — that name is ${lost.winner}'s by the resolution of name:${identOf(lost.name)}.`);
        } else if (d?.kind === "delete") delete entry.label;
        else if (d?.kind === "rename") { if (renameHostOf(c.address, claimsAt) === "segment") entry.label = d.name; else delete entry.label; }
        else if (d?.kind === "keep" && identOf(label) !== d.ident) delete entry.label;
      }
    }
    if (c.kind === "split") merged.splitTables!.push(entry); else merged.segments!.push(entry);
  }

  // labels and routines: per address, the entries the decision at that address leaves
  const labelEntries = new Map<string, Record<string, unknown>>();
  const routineEntries = new Map<string, Record<string, unknown>>();
  for (const kind of ["label", "routine"] as const) {
    for (const c of [...byKey.values()].filter((x) => x.kind === kind).sort(byAddress)) {
      const d = decisionAt(c.address);
      const lost = nameLoser.get(c.key);
      const nameKey = kind === "label" ? "label" : "name";
      let use = c.claims;
      let rename: string | undefined;
      if (d?.kind === "delete") use = [];
      else if (d?.kind === "keep") use = c.claims.filter((x) => x.signature === d.ident);
      else if (d?.kind === "rename") {
        if (renameHostOf(c.address, claimsAt) === kind) { use = [c.claims[0]!]; rename = d.name; } else use = [];
      }
      if (lost) {
        notes.push(`${c.key} dropped: "${lost.name}" is ${lost.winner}'s by the resolution of name:${identOf(lost.name)}.`);
        use = [];
      }
      if (use.length === 0) {
        for (const x of c.claims) rescue(c.address, x.entry);
        continue;
      }
      const first = use[0]!;
      const comments = new Set(use.map((x) => String(x.entry.comment ?? "")).filter((x) => x !== ""));
      if (comments.size > 1) notes.push(`${c.key}: ${comments.size} fragments described it differently in prose while agreeing on the claim — ${first.fragment}'s comment was kept.`);
      for (const x of c.claims) if (!use.includes(x) && x.entry.comment !== first.entry.comment) rescue(c.address, x.entry);
      // the first fragment's prose wins; a fragment that said nothing does not erase one that did
      const prose = use.map((x) => x.entry.comment).find((x) => typeof x === "string" && x !== "");
      const entry = { ...first.entry, ...(prose !== undefined ? { comment: prose } : {}), ...(rename !== undefined ? { [nameKey]: rename } : {}) };
      (kind === "label" ? labelEntries : routineEntries).set(c.address, entry);
    }
  }
  // a label that only repeats what a routine or the segment already names at its address
  // is the same claim stated twice; it stays only when it carries prose of its own
  const mergedSegments = merged.segments as Array<Record<string, unknown>>;
  for (const [address, l] of [...labelEntries.entries()].sort((a, b) => parseInt(a[0], 16) - parseInt(b[0], 16))) {
    const lid = identOf(String(l.label));
    const rt = routineEntries.get(address);
    const sg = mergedSegments.find((s) => s.start === address && typeof s.label === "string");
    const other = [rt && identOf(String(rt.name)) === lid ? rt : undefined, sg && identOf(String(sg.label)) === lid ? sg : undefined].filter((x): x is Record<string, unknown> => x !== undefined);
    const own = typeof l.comment === "string" ? l.comment : "";
    if (other.length > 0 && (own === "" || other.some((o) => o.comment === own))) continue;
    merged.labels!.push(l);
  }
  for (const [, r] of [...routineEntries.entries()].sort((a, b) => parseInt(a[0], 16) - parseInt(b[0], 16))) merged.routines!.push(r);

  // the comments of removed entries go to the entry that survived at that address
  for (const [address, texts] of rescued) {
    const host = routineEntries.get(address) ?? merged.labels!.find((l) => (l as Record<string, unknown>).address === address) as Record<string, unknown> | undefined
      ?? mergedSegments.find((s) => s.start === address);
    for (const t of texts) {
      if (!host) { notes.push(`the comment of a removed entry at ${$(address)} had nowhere to go and is dropped: ${JSON.stringify(t)}`); continue; }
      const cur = typeof host.comment === "string" ? host.comment : "";
      if (cur.includes(t)) continue;
      host.comment = cur ? `${cur}\n${t}` : t;
      notes.push(`${$(address)}: the comment of a removed entry was kept on the entry that survived.`);
    }
  }

  // immediates
  for (const address of [...immClaims.keys()].sort((a, b) => parseInt(a, 16) - parseInt(b, 16))) {
    const key = immKey(address);
    if (removed.has(key)) { notes.push(`${key} removed by its resolution.`); continue; }
    const list = immClaims.get(address)!;
    merged.immediates!.push({ ...(resolvedEntry.get(key) ?? list[0]!.entry) });
  }

  // the memory map: in the order the fragments gave it (a later range wins where two overlap), a range once
  for (const c of [...byKey.values()].filter((x) => x.kind === "memoryMap")) {
    if (removed.has(c.key)) { notes.push(`${c.key} removed by its resolution.`); continue; }
    const resolved = resolvedEntry.get(c.key);
    if (resolved) { (merged.memoryMap as Array<Record<string, unknown>>).push({ ...resolved }); continue; }
    const first = { ...c.claims[0]!.entry } as Record<string, unknown>;
    // agreeing readings hold for the union of the routines they name — and for everywhere if any of them names none
    if (c.claims.some((x) => !Array.isArray(x.entry.routines) || (x.entry.routines as unknown[]).length === 0)) delete first.routines;
    else first.routines = [...new Set(c.claims.flatMap((x) => x.entry.routines as string[]))];
    (merged.memoryMap as Array<Record<string, unknown>>).push(first);
  }

  // the optional sections are additive: they carry no id the graph keys on
  for (const { doc } of named) {
    for (const t of doc.pointerTables ?? []) merged.pointerTables!.push(t as unknown as Record<string, unknown>);
    for (const t of doc.jumpTables ?? []) merged.jumpTables!.push(t as unknown as Record<string, unknown>);
  }

  const final = buildAnnotationsDocument(merged, binary, image);
  if (final.problems.length > 0) {
    return { refusal: renderProblems("REFUSED — the merged file would not be accepted. Nothing was written and nothing was recorded.", final.problems) };
  }
  notes.push(...final.notes);
  return { plan: { doc: final.doc, contests: allContests.sort(byAddress), settled, notes } };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

function byAddress(a: { address: string; key?: string }, b: { address: string; key?: string }): number {
  return parseInt(a.address, 16) - parseInt(b.address, 16) || a.address.localeCompare(b.address) || String(a.key ?? "").localeCompare(String(b.key ?? ""));
}

/** `{ label }` / `{ name }` as a value renames the first record that names the address: a label, else a routine, else the segment. */
function renameHost(cl: Array<{ from: NameFrom }>): NameFrom {
  for (const f of ["label", "routine", "segment"] as const) if (cl.some((x) => x.from === f)) return f;
  return "label";
}

function renameHostOf(address: string, claimsAt: (a: string) => Array<{ from: NameFrom }>): NameFrom {
  return renameHost(claimsAt(address));
}

/** `A` is a fragment; `A:routine` is that fragment's routine record (a fragment may name one address twice). */
function splitWinner(raw: string): [string, NameFrom | undefined] {
  const m = /^(.*):(label|routine|segment)$/u.exec(raw.trim());
  return m ? [m[1]!, m[2] as NameFrom] : [raw.trim(), undefined];
}

/** `segment:$82e6` and `SEGMENT:82E6` are the key the refusal printed. */
function normaliseKey(raw: string): string {
  const [kind, ...rest] = raw.trim().split(":");
  const k = (kind ?? "").trim().toLowerCase();
  const tail = rest.join(":").trim();
  if (k === "name") return `name:${tail}`;
  if (k === "memorymap") {
    const [lo, hi] = tail.split(/[-/]/u).map((x) => canonHex(x.trim().replace(/^\$/u, "")));
    return lo && hi ? `memoryMap:${lo}-${hi}` : `memoryMap:${tail}`;
  }
  if (k === "split") {
    const [lo, hi] = tail.split(/[-/]/u).map((x) => canonHex(x.trim().replace(/^\$/u, "")));
    return lo && hi ? `split:${lo}-${hi}` : `split:${tail}`;
  }
  const hex = canonHex(tail);
  return hex ? `${k}:${hex}` : `${k}:${tail}`;
}

/** An entry a resolution supplies directly — checked the same way as any other. */
function buildOne(c: Contest, value: Record<string, unknown>): { entry: Record<string, unknown>; described: string } | { refusal: string } {
  const template = c.claims[0]!.entry;
  const section = c.kind === "segment" ? "segments" : c.kind === "split" ? "splitTables" : c.kind === "memoryMap" ? "memoryMap" : "immediates";
  // a value may state only what it changes; the rest comes from the first claim, so a
  // pure change is `{ end: "8305" }` and nothing else.
  const entry: Record<string, unknown> = { ...template, ...value };
  if (c.kind === "split") { const [lo, hi] = c.address.split("-"); entry.lo = lo; entry.hi = hi; }
  else if (c.kind === "memoryMap") { const [start, end] = c.address.split("-"); entry.start = start; entry.end = end; }
  else entry[c.kind === "segment" ? "start" : "address"] = c.address;
  const built = buildAnnotationsDocument({ [section]: [entry] } as RawSections, "");
  if (built.problems.length > 0) return { refusal: built.problems.map((p) => p.reason).join("; ") };
  const out = (built.doc[section as "segments" | "splitTables" | "immediates" | "memoryMap"] as unknown as Record<string, unknown>[])[0]!;
  const described = c.kind === "segment" ? describeSegment(out) : c.kind === "split" ? describeSplit(out) : c.kind === "memoryMap" ? describeMemory(out) : describeImmediate(out);
  return { entry: out, described };
}

/** The refusal: every contested key, every claimant, and how to answer. */
export function renderContests(contests: Contest[]): string {
  const lines = [
    "REFUSED — the fragments contradict each other. Nothing was written and nothing was recorded.",
    "",
  ];
  for (const c of contests) {
    lines.push(`${c.key}`);
    for (const claim of c.claims) lines.push(`  ${claim.fragment}  ${claim.described}`);
    lines.push("");
  }
  lines.push("A contradiction is not resolved by a priority order: an order says which fragment usually wins and");
  lines.push("nothing about THIS address, which is the only thing anyone will want to know later. Answer each key,");
  lines.push("with a reason, and the answer is recorded as a finding — who claimed what, which one won, and why:");
  lines.push("");
  const first = contests[0]!;
  lines.push(`  resolutions: [{ key: "${first.key}", winner: "${first.claims[0]!.fragment}", why: "<what you read that decides it>" }]`);
  lines.push("");
  lines.push("A resolution may also name a value neither fragment proposed — it states only what it changes:");
  const example = first.kind === "segment" ? 'end: "8305", kind: "pointer_table"'
    : first.kind === "routine" || first.kind === "label" ? 'label: "exit_door_probe"'
    : first.kind === "immediate" ? 'label: "exit_door_probe"'
    : first.kind === "split" ? "count: 9"
    : first.kind === "memoryMap" ? 'as: "ram"' : 'label: "exit_door_probe"';
  lines.push(`  { key: "${first.key}", value: { ${example} }, why: "<why>" }`);
  lines.push("");
  lines.push("or remove the entry (for a `name:` key: every site of the name) — the answer is recorded the same way:");
  lines.push(`  { key: "${first.key}", delete: true, why: "<why>" }`);
  lines.push("");
  lines.push("When one fragment names the address twice (a label and a routine), say which record wins: winner: \"A:routine\".");
  lines.push("Pass dry_run to see what the merge would produce without writing it.");
  return lines.join("\n");
}

// ----------------------------------------------------------- the record kept

export interface ResolutionRecord {
  id: string;
  title: string;
  summary: string;
  addressStart: number;
  addressEnd: number;
  tags: string[];
}

/** One resolution, as the finding that outlives the session. */
export function resolutionFinding(entry: MergePlan["settled"][number], outputPath: string): ResolutionRecord {
  const { contest, resolution, winning } = entry;
  const label = contest.kind === "name" ? `name "${contest.key.slice(5)}"`
    : contest.kind === "split" ? `split table ${contest.address.replace("-", "/")}`
    : contest.kind === "memoryMap" ? `memory map ${contest.address.split("-").map($).join("-")}`
    : `${contest.kind} ${$(contest.address)}`;
  const w = resolution.winner;
  const losers = w ? [...new Set(contest.claims.map((c) => c.fragment))].filter((f) => f !== w.split(":")[0]) : [];
  const heading = resolution.delete
    ? `${label} — removed`
    : w
      ? `${label} — ${w}${losers.length > 0 ? ` over ${losers.join(", ")}` : ""}`
      : `${label} — a value neither reading proposed`;
  const lines = [
    `${contest.claims.length} readings of ${label}.`,
    "",
  ];
  for (const c of contest.claims) {
    const won = !resolution.delete && resolution.winner !== undefined && c === winning;
    lines.push(`  ${c.fragment}  ${c.described}${won ? "   <- WON" : ""}`);
  }
  if (resolution.delete) lines.push(`  (none)  ${winning.described}   <- every reading dropped`);
  else if (!resolution.winner) lines.push(`  (none)  ${winning.described}   <- WON, supplied by the resolution`);
  lines.push("", `Why: ${resolution.why}`, "", `Merged into ${outputPath} by merge_annotations.`);
  const start = parseInt(contest.address, 16);
  const splitCount = Number((winning.entry as { count?: number }).count);
  const endHex = contest.kind === "segment"
    ? String((winning.entry as { end?: string }).end ?? contest.address)
    : contest.kind === "split"
      ? (start + (Number.isInteger(splitCount) && splitCount > 0 ? splitCount - 1 : 0)).toString(16)
      : contest.kind === "memoryMap"
        ? contest.address.split("-")[1]!
        : contest.address;
  return {
    id: `annmerge-${contest.key.replace(/[^A-Za-z0-9]+/gu, "-").toLowerCase()}`,
    title: `Merge resolution: ${heading}`,
    summary: lines.join("\n"),
    addressStart: start,
    addressEnd: parseInt(endHex, 16),
    tags: ["annotation-merge", `merge-${contest.kind}`],
  };
}
