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
// Three rules follow.
//
//   AGREEMENT IS NOT A CONTRADICTION. Five readers annotating one entry point is the
//   normal case. Two claims that say the same thing collapse into one and nobody is
//   asked anything.
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
  why?: string;
}

// ------------------------------------------------------------------- claims

type ClaimKind = "segment" | "label" | "routine" | "name";

interface Claim {
  fragment: string;
  /** The identity of the claim — two claims with the same signature agree. */
  signature: string;
  /** How it reads in a message a human answers. */
  described: string;
  /** The entry as it would be written, canonical already. */
  entry: Record<string, unknown>;
}

interface Contest {
  key: string;
  kind: ClaimKind;
  address: string;
  claims: Claim[];
}

const $ = (hex: string): string => `$${hex}`;

function describeSegment(e: Record<string, unknown>): string {
  return `${$(String(e.start))}-${$(String(e.end))}  ${String(e.kind)}${e.label ? `  "${String(e.label)}"` : ""}`;
}

// ------------------------------------------------------------------ merging

export interface MergePlan {
  doc: AnnotationsDocument;
  /** The contradictions, in address order — empty means nothing was contested. */
  contests: Contest[];
  /** The resolutions applied, paired with the contest each one settled. */
  settled: Array<{ contest: Contest; resolution: Required<Pick<ResolutionInput, "key" | "why">> & { winner?: string; value?: Record<string, unknown> }; winning: Claim | { fragment: null; described: string; entry: Record<string, unknown>; signature: string } }>;
  notes: string[];
}

export type MergeOutcome = { plan: MergePlan } | { refusal: string };

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
): MergeOutcome {
  if (fragments.length === 0) {
    return { refusal: "REFUSED — no fragments. Nothing was written.\n\nPass `fragments: [{ name, ... }]` — each one a reading, with a name, because the name is the WHO in \"who claimed what\"." };
  }

  // ---- 1. read each fragment and check it on its own
  const named: Array<{ name: string; sections: RawSections; origin: string }> = [];
  const seenNames = new Map<string, string>();
  const problems: Problem[] = [];
  for (const [i, f] of fragments.entries()) {
    const origin = f.path ? f.path : `fragments[${i}]`;
    let sections: RawSections = { segments: f.segments, labels: f.labels, routines: f.routines, pointerTables: f.pointerTables, jumpTables: f.jumpTables, immediates: f.immediates };
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
    const own = buildAnnotationsDocument(sections, binary);
    for (const p of own.problems) problems.push({ ...p, where: `${name}.${p.where}` });
    named.push({ name, sections, origin });
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
  // the name space is its own contest: one identifier gets one definition, and the
  // second one is what stops the assembler. A site is (kind, address) and not address
  // alone — a routine and a label may sit at one address legitimately, and a name
  // contest must not take the one that was not in it.
  const nameSites = new Map<string, Array<{ fragment: string; kind: ClaimKind; address: string; described: string }>>();

  for (const { name: frag, sections } of named) {
    const doc = buildAnnotationsDocument(sections, binary).doc;
    for (const s of doc.segments) {
      const entry = { ...s } as unknown as Record<string, unknown>;
      claim("segment", s.start, frag, `${s.end}|${s.kind}|${s.label ?? ""}`, describeSegment(entry), entry);
      if (s.label) push(nameSites, s.label, { fragment: frag, kind: "segment", address: s.start, described: `segment ${$(s.start)}` });
    }
    for (const l of doc.labels) {
      claim("label", l.address, frag, l.label, `"${l.label}"`, { ...l } as unknown as Record<string, unknown>);
      push(nameSites, l.label, { fragment: frag, kind: "label", address: l.address, described: `label ${$(l.address)}` });
    }
    for (const r of doc.routines) {
      claim("routine", r.address, frag, r.name, `"${r.name}"`, { ...r } as unknown as Record<string, unknown>);
      push(nameSites, r.name, { fragment: frag, kind: "routine", address: r.address, described: `routine ${$(r.address)}` });
    }
  }

  const contests: Contest[] = [];
  for (const c of [...byKey.values()].sort(byAddress)) {
    if (new Set(c.claims.map((x) => x.signature)).size > 1) contests.push(c);
  }
  // one name at two addresses — the defect that fails in the assembler, not the listing
  const nameContests: Contest[] = [];
  for (const [nm, sites] of [...nameSites.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const places = new Set(sites.map((s) => `${s.kind}:${s.address}`));
    if (places.size < 2) continue;
    nameContests.push({
      key: `name:${nm}`, kind: "name", address: [...sites].sort((a, b) => parseInt(a.address, 16) - parseInt(b.address, 16))[0]!.address,
      claims: sites.map((s) => ({ fragment: s.fragment, signature: `${s.kind}:${s.address}`, described: `${s.described} — "${nm}"`, entry: { address: s.address, name: nm, site: `${s.kind}:${s.address}` } })),
    });
  }
  const allContests = [...contests, ...nameContests];

  // ---- 3. the resolutions
  const byResolutionKey = new Map<string, ResolutionInput>();
  for (const r of resolutions) {
    const key = normaliseKey(r.key);
    if (byResolutionKey.has(key)) return { refusal: `REFUSED — two resolutions for ${key}. Nothing was written.` };
    byResolutionKey.set(key, { ...r, key });
  }
  const contestByKey = new Map(allContests.map((c) => [c.key, c]));

  const stray = [...byResolutionKey.keys()].filter((k) => !contestByKey.has(k));
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

  const settled: MergePlan["settled"] = [];
  const badWinners: string[] = [];
  const noReason: string[] = [];
  const bothGiven: string[] = [];
  const resolvedEntry = new Map<string, Record<string, unknown>>();
  // The sites a name contest took the name away from, keyed `${kind}:${address}` — an
  // address alone would also hit the routine that happens to sit at a label's address
  // and was never in the contest.
  const nameLoser = new Map<string, { name: string; winner: string }>();

  for (const c of allContests) {
    const r = byResolutionKey.get(c.key);
    if (!r) continue;
    if (r.winner && r.value) { bothGiven.push(c.key); continue; }
    const why = (r.why ?? "").trim();
    if (why.length < 10) { noReason.push(c.key); continue; }
    if (r.winner) {
      const hit = c.claims.find((x) => x.fragment === r.winner);
      if (!hit) { badWinners.push(`${c.key} — "${r.winner}" claimed nothing there; the claimants are ${[...new Set(c.claims.map((x) => x.fragment))].join(", ")}`); continue; }
      settled.push({ contest: c, resolution: { key: c.key, why, winner: r.winner }, winning: hit });
      if (c.kind === "name") {
        for (const other of c.claims) {
          if (other.signature === hit.signature) continue;
          nameLoser.set(String(other.entry.site), { name: String(other.entry.name), winner: r.winner });
        }
      } else {
        resolvedEntry.set(c.key, hit.entry);
      }
      continue;
    }
    if (r.value) {
      if (c.kind === "name") { badWinners.push(`${c.key} — a name contest is settled by picking the address that keeps the name (\`winner\`), not by a value; to rename one side, change it in the fragment`); continue; }
      const built = buildOne(c, r.value);
      if ("refusal" in built) { badWinners.push(`${c.key} — ${built.refusal}`); continue; }
      settled.push({ contest: c, resolution: { key: c.key, why, value: r.value }, winning: { fragment: null, signature: "", described: built.described, entry: built.entry } });
      resolvedEntry.set(c.key, built.entry);
      continue;
    }
    badWinners.push(`${c.key} — neither a \`winner\` (a fragment name) nor a \`value\` (an entry neither side proposed)`);
  }

  if (bothGiven.length > 0) {
    return { refusal: `REFUSED — a resolution names both a winner and a value. Nothing was written.\n\n${bothGiven.map((k) => `  ${k}`).join("\n")}\n\nOne or the other: \`winner\` takes a fragment's claim as it stands, \`value\` replaces both with something neither proposed.` };
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

  const unresolved = allContests.filter((c) => !byResolutionKey.has(c.key));
  if (unresolved.length > 0) {
    return { refusal: renderContests(unresolved) };
  }

  // ---- 4. build the merged document, winners applied
  const merged: RawSections = { segments: [], labels: [], routines: [], pointerTables: [], jumpTables: [], immediates: [] };
  const notes: string[] = [];
  const taken = new Set<string>();
  const put = (kind: ClaimKind, address: string, entry: Record<string, unknown>): void => {
    const key = `${kind}:${address}`;
    if (taken.has(key)) return;
    taken.add(key);
    const use = resolvedEntry.get(key) ?? entry;
    if (kind === "segment") merged.segments!.push(use);
    else if (kind === "label") merged.labels!.push(use);
    else merged.routines!.push(use);
  };
  for (const c of [...byKey.values()].sort(byAddress)) {
    const lost = nameLoser.get(c.key);
    if (lost && !resolvedEntry.has(c.key)) {
      if (c.kind === "segment") {
        // a segment is a range and a kind as well as a name; it keeps both and loses
        // only the name it may not have.
        notes.push(`${c.key} keeps its range and kind but loses the name "${lost.name}" — that name is ${lost.winner}'s by the resolution of name:${lost.name}.`);
        const { label: _dropped, ...rest } = c.claims[0]!.entry as Record<string, unknown> & { label?: unknown };
        put(c.kind, c.address, rest);
        continue;
      }
      // a label or a routine whose whole content was the name has nothing left to say.
      notes.push(`${c.key} dropped: "${lost.name}" is ${lost.winner}'s by the resolution of name:${lost.name}.`);
      continue;
    }
    const first = c.claims[0]!;
    // comments may differ where the claim agrees; the first fragment's is kept and said so
    const comments = new Set(c.claims.map((x) => String(x.entry.comment ?? "")).filter((x) => x !== ""));
    if (comments.size > 1 && !resolvedEntry.has(c.key)) notes.push(`${c.key}: ${comments.size} fragments described it differently in prose while agreeing on the claim — ${first.fragment}'s comment was kept.`);
    put(c.kind, c.address, first.entry);
  }
  // the optional sections are additive: they carry no id the graph keys on
  for (const { sections } of named) {
    const doc = buildAnnotationsDocument(sections, binary).doc;
    for (const t of doc.pointerTables ?? []) merged.pointerTables!.push(t as unknown as Record<string, unknown>);
    for (const t of doc.jumpTables ?? []) merged.jumpTables!.push(t as unknown as Record<string, unknown>);
    for (const t of doc.immediates ?? []) merged.immediates!.push(t as unknown as Record<string, unknown>);
  }

  const final = buildAnnotationsDocument(merged, binary);
  if (final.problems.length > 0) {
    return { refusal: renderProblems("REFUSED — the merged file would not be accepted. Nothing was written and nothing was recorded.", final.problems) };
  }
  notes.push(...final.notes);
  return { plan: { doc: final.doc, contests: allContests, settled, notes } };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

function byAddress(a: { address: string }, b: { address: string }): number {
  return parseInt(a.address, 16) - parseInt(b.address, 16);
}

/** `segment:$82e6` and `SEGMENT:82E6` are the key the refusal printed. */
function normaliseKey(raw: string): string {
  const [kind, ...rest] = raw.trim().split(":");
  const k = (kind ?? "").trim().toLowerCase();
  const tail = rest.join(":").trim();
  if (k === "name") return `name:${tail}`;
  const hex = canonHex(tail);
  return hex ? `${k}:${hex}` : `${k}:${tail}`;
}

/** An entry a resolution supplies directly — checked the same way as any other. */
function buildOne(c: Contest, value: Record<string, unknown>): { entry: Record<string, unknown>; described: string } | { refusal: string } {
  const template = c.claims[0]!.entry;
  const section = c.kind === "segment" ? "segments" : c.kind === "label" ? "labels" : "routines";
  // a value may state only what it changes; the rest comes from the first claim, so a
  // pure rename is `{ label: "exit_door_probe" }` and nothing else.
  const entry: Record<string, unknown> = { ...template, ...value };
  entry[c.kind === "segment" ? "start" : "address"] = c.address;
  const built = buildAnnotationsDocument({ [section]: [entry] } as RawSections, "");
  if (built.problems.length > 0) return { refusal: built.problems.map((p) => p.reason).join("; ") };
  const out = (built.doc[section as "segments" | "labels" | "routines"] as unknown as Record<string, unknown>[])[0]!;
  const described = c.kind === "segment" ? describeSegment(out) : `"${String(out.label ?? out.name)}"`;
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
  lines.push(`  { key: "${first.key}", value: { ${first.kind === "segment" ? 'end: "8305", kind: "pointer_table"' : first.kind === "routine" ? 'name: "exit_door_probe"' : 'label: "exit_door_probe"'} }, why: "<why>" }`);
  lines.push("");
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
  const label = contest.kind === "name" ? `name "${contest.key.slice(5)}"` : `${contest.kind} ${$(contest.address)}`;
  const heading = resolution.winner
    ? `${label} — ${resolution.winner} over ${[...new Set(contest.claims.map((c) => c.fragment))].filter((f) => f !== resolution.winner).join(", ")}`
    : `${label} — a value neither reading proposed`;
  const lines = [
    `${contest.claims.length} readings of ${label}.`,
    "",
  ];
  for (const c of contest.claims) {
    const won = resolution.winner === c.fragment;
    lines.push(`  ${c.fragment}  ${c.described}${won ? "   <- WON" : ""}`);
  }
  if (!resolution.winner) lines.push(`  (none)  ${winning.described}   <- WON, supplied by the resolution`);
  lines.push("", `Why: ${resolution.why}`, "", `Merged into ${outputPath} by merge_annotations.`);
  const start = parseInt(contest.address, 16);
  const endHex = contest.kind === "segment" ? String((winning.entry as { end?: string }).end ?? contest.address) : contest.address;
  return {
    id: `annmerge-${contest.key.replace(/[^A-Za-z0-9]+/gu, "-").toLowerCase()}`,
    title: `Merge resolution: ${heading}`,
    summary: lines.join("\n"),
    addressStart: start,
    addressEnd: parseInt(endHex, 16),
    tags: ["annotation-merge", `merge-${contest.kind}`],
  };
}
