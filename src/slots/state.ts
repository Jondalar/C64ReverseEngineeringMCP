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
  /** 848 — named-ness, which coverage alone cannot see. */
  naming: NamedReport;
  /** Knowledge records of any kind. Below, "has this project begun?" is asked of it. */
  records: number;
  /** Required slots that are empty. The answer to "what is still unmapped". */
  missing: SlotState[];
  coverage: CoverageReport;
}

/**
 * Spec 848 — is this name a NAME, or is it an address wearing one?
 *
 * The first unattended run produced 273 entities and zero routine nodes. Its names were
 * `unknown_3E00_41D8`, `addr_0006`, `entry_0300` — machine output from the analyser — plus
 * the disk directory's own filenames. Coverage said 100 % and the orphan count said
 * 220-of-229 placed, because both measure bytes inside a RANGE and a machine-named region
 * is a range like any other. Both metrics were blind to the thing that actually matters.
 */
const MACHINE_NAME = /^(unknown|addr|code|data|seg|sub|block|chunk|entry|loc|w)[_-]?[0-9a-fA-F]{2,}(_[0-9a-fA-F]{2,})?$/i;

/**
 * Kinds where a name MEANS something.
 *
 * `payload` is excluded deliberately, and the first measurement is why: a payload node is
 * named after its disk directory entry — `a`, `i`, `01_neuromancer` — and spans the whole
 * file, so one of them painted an entire project "100 % named" while 176 of its 208 nodes
 * carried machine names. A filename is not an understanding. `segment` is a machine split
 * and `entry` is an address with a prefix; neither is either.
 */
const NAMED_KINDS = new Set(["routine", "data_block", "lookup_table", "pointer_table"]);

export function isMachineName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return n.length === 0 || MACHINE_NAME.test(n);
}

/**
 * Named-ness is counted per NODE, not per byte — and the reason is structural, not a
 * preference. An annotation gives a name and a start address; it does not give an
 * extent. All 978 named routines in Ultima VI carry `end_address = null`, so "named
 * bytes" cannot be computed from the layer where names live. The first cut measured
 * bytes because coverage measures bytes, and reported 0 % for a project with 978 named
 * routines.
 */
export interface NamedReport {
  /** Meaning-bearing nodes carrying a human name. */
  named: number;
  /** Meaning-bearing nodes altogether. */
  members: number;
  ratio: number;
  /** Of `members`, how many carry only a machine name. */
  machineNamed: number;
}

export interface CoverageReport {
  /** Bytes inside at least one range that CLAIMS something about them. */
  covered: number;
  /** Bytes in ranges classified `unknown` — declared, honestly, and not coverage. */
  declaredUnknown: number;
  /** Bytes in ranges carrying only a machine name and no classification. */
  machineOnly: number;
  /** Bytes in the artifacts that could be measured, each distinct payload counted ONCE. */
  total: number;
  ratio: number;
  /** Artifacts with neither an addressRange nor a fileSize — named, never silently dropped. */
  unmeasured: string[];
  threshold: number;
  /** How many distinct loadable artifacts the denominator is made of. */
  artifacts: number;
  /** How many were left out as another copy of content already counted. */
  duplicates: number;
}

const SLOT_TAG = /^slot:(S\d{1,2})$/i;

/** What COUNTS as bytes of the game. A generated .asm is an output, not a payload;
 *  counting it would both double-count and measure text. */
const MEASURABLE_KINDS = new Set(["prg", "raw", "extract"]);

/** "analysis/disk/game/07_game.prg" -> "07_game", which is what the graph calls its owner. */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function coverageThreshold(contractRatio?: number): number {
  // Spec 848 — the contract decides. The env var stays as an override for a one-off run,
  // and the hardcoded 0.6 is only what a project with neither says: it was picked blind
  // and Ultima VI showed it wrong on first contact.
  if (contractRatio !== undefined && contractRatio > 0 && contractRatio <= 1) return contractRatio;
  const raw = process.env.C64RE_COVERAGE_THRESHOLD?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
}

/**
 * Does this node's extent ACCOUNT for its bytes?
 *
 * S12 asks how many bytes are accounted for. It used to count every range the
 * graph held, and an autonomous run found what that rewards: it emitted
 * `unknown` segments named `unnamed_XXXX` over ranges it had ALREADY named as
 * routines — the loader among them — because a placeholder with an extent moved
 * the number and a named routine did not. It reverted all 47 by hand and left
 * coverage at 89.0 %. A metric that scores a blanket above a name is the defect,
 * not the run.
 *
 * So a range counts when something is claimed about those bytes:
 *
 *   `segment_kind: "unknown"`  — never. That is the word for "I have not
 *                                established this", and declaring it is honest
 *                                work that is worth nothing as coverage. It is
 *                                counted and reported separately.
 *   any other classification   — counts. Somebody or something said what these
 *                                bytes ARE: code, a charset, a pointer table.
 *                                A wrong one is a checkable claim (the rebuild
 *                                renders it, the critic reads it); a blanket
 *                                `unknown` is not a claim at all.
 *   no classification          — counts only with a HUMAN name on it. A machine
 *                                name over an extent (`unknown_3E00_41D8`,
 *                                `W0801`) is a range the analyser walked, not an
 *                                account of what is in it. Naming it is the work,
 *                                and now it is the work that moves the number.
 */
function claimsItsBytes(kind: string | null, segmentKind: string | null, name: string | null): "counts" | "unknown" | "machine" {
  if ((segmentKind ?? "") === "unknown") return "unknown";
  if (segmentKind) return "counts";
  return isMachineName(name) ? "machine" : "counts";
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
  const { loadContract } = await import("../contract/contract.js");
  const { contract, contractPresent } = ((): { contract: import("../contract/contract.js").ProjectContract; contractPresent: boolean } => {
    const r = loadContract(projectDir);
    return { contract: r.contract, contractPresent: r.present };
  })();
  /** Slots this project owes. The contract may demand FEWER — 844 is a template. */
  const owed = contractPresent ? contract.deliver?.slots : undefined;
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
  //
  // The first cut of this was wrong in two ways and a run against Ultima VI's real
  // project showed both inside a second. It summed the fileSize of ALL 321 registered
  // artifacts — 27 MB of generated .asm text and 23 MB of internal files included — and
  // it unioned address ranges across every artifact at once, as though $2000 in one
  // overlay were the same byte as $2000 in another. That capped the ratio at a few
  // percent structurally, no matter how well anyone worked, and reported 0.1 %.
  //
  // So: coverage is computed PER OWNER, the way the bytes actually lie. An owner is a
  // loadable file's stem, which is exactly what the graph already carries on its nodes.
  // The denominator is every non-internal loadable artifact, INCLUDING the ones nobody
  // has looked at yet — S12 asks how many of the bytes present are accounted for, and an
  // unanalysed file is present.
  // Two lists, deliberately. COVERAGE may only count what can be measured, but the
  // MEDIUM questions (S2's derived fill, S10's and S15's applicability) ask whether a
  // disk exists at all — and a .d64 is not a measurable kind. Deriving both from the
  // measurable list meant `media` could only ever hold prg/raw: on a disk-only project
  // S2 never filled from its own registered images and S10 was permanently n/a, i.e.
  // the save model went unasked on every game that has one. Found by S15's gate case,
  // which is the first one whose fixture registers a d64 rather than a prg.
  const visible = rec.listArtifacts().filter((a) => !a.internal);
  const artifacts = visible.filter((a) => MEASURABLE_KINDS.has(a.kind));

  const rangesByOwner = new Map<string, Array<{ start: number; end: number }>>();
  // The same union, for the two buckets a range can fall into instead. They are
  // reported, never counted: a reader who sees 41 % must be able to see where the
  // other 59 % is and what would move it.
  const unknownByOwner = new Map<string, Array<{ start: number; end: number }>>();
  const machineByOwner = new Map<string, Array<{ start: number; end: number }>>();
  // 848 — named-ness, counted over the nodes where a name means something.
  let machineNamed = 0, memberNodes = 0;
  try {
    const { GraphStore } = await import("../knowledge-graph/store.js");
    const store = GraphStore.open(projectDir, { readOnly: true });
    try {
      // The layers must be MERGED BY ID before anything is counted.
      //
      // The graph stores one id in up to two rows — PRIMARY KEY (id, layer). The
      // machine layer carries `owner` and `end_address`; the human layer carries the
      // NAME an annotation gave it. Ultima VI holds 1853 routine nodes: 799 with
      // owner+extent, 978 with a real name, and ZERO with both. A query joining on
      // owner can therefore never see a name, and the first cut of this measure
      // reported 0 % named for a project with 978 named routines.
      const rows = store.db.prepare(
        `SELECT id,
                MAX(CASE WHEN layer = 'human' THEN name END) AS human_name,
                MAX(name)        AS any_name,
                MAX(owner)       AS owner,
                MAX(kind)        AS kind,
                MIN(address)     AS address,
                MAX(end_address) AS end_address,
                MAX(json_extract(attrs, '$.segment_kind')) AS segment_kind
         FROM nodes
         WHERE kind IN ('routine','segment','payload','data_block','entry','lookup_table','pointer_table')
         GROUP BY id
         HAVING owner IS NOT NULL`,
      ).all() as Array<{ human_name: string | null; any_name: string | null; owner: string; kind: string; address: number; end_address: number | null; segment_kind: string | null }>;
      for (const r of rows) {
        if (r.end_address !== null) {
          const verdict = claimsItsBytes(r.kind, r.segment_kind, r.human_name ?? r.any_name);
          const into = verdict === "counts" ? rangesByOwner : verdict === "unknown" ? unknownByOwner : machineByOwner;
          const list = into.get(r.owner) ?? [];
          list.push({ start: r.address, end: r.end_address });
          into.set(r.owner, list);
        }
        if (!NAMED_KINDS.has(r.kind)) continue;
        memberNodes++;
        if (isMachineName(r.human_name ?? r.any_name)) machineNamed++;
      }
    } finally { store.close(); }
  } catch { /* no graph yet — every artifact is simply uncovered */ }

  // The denominator must be reachable, and it was not.
  //
  // A real project registered three .d64s, 252 extracts, 271 cartridge chunks and 504
  // generated listings, and the measurable set still held the same bytes five and six
  // times over: the extract of a file, the depacked copy of that extract, and the
  // cart chunk carrying the same content each counted in full, while the numerator is
  // a per-owner address union in a 64 KB space. 13 514 / 1 184 478 = 1.1 %, and no
  // amount of work could move it — the number was structurally unreachable, which is
  // worse than no number.
  //
  // So each distinct piece of CONTENT is counted once. Identity, in order: the content
  // hash the store already records; else the lineage root, which is how Spec 025 says
  // a derived copy points at its origin; else the path. Same rule the UI applies when
  // it shows one artifact per lineage.
  const identityOf = (a: typeof artifacts[number]): string =>
    a.contentHash ? `hash:${a.contentHash}` : a.lineageRoot ? `lineage:${a.lineageRoot}` : `path:${a.relativePath ?? a.path ?? a.title}`;
  const seen = new Set<string>();
  let total = 0;
  let covered = 0;
  let declaredUnknown = 0;
  let machineOnly = 0;
  let counted = 0;
  let duplicates = 0;
  const unmeasured: string[] = [];
  for (const a of artifacts) {
    const id = identityOf(a);
    if (seen.has(id)) { duplicates += 1; continue; }
    seen.add(id);
    const size = a.addressRange
      ? a.addressRange.end - a.addressRange.start + 1
      : (a.fileSize && a.fileSize > 2 ? a.fileSize - 2 : 0); // minus the load address
    if (size <= 0) { unmeasured.push(a.title); continue; }
    total += size;
    counted += 1;
    const own = stemOf(a.relativePath ?? a.path ?? a.title);
    // Clipped to the file: ranges live in load-address space and a union can otherwise
    // exceed the artifact it describes. The cap is a cap, not a measurement, and it is
    // better than a ratio above 1.
    const clip = (list: Array<{ start: number; end: number }> | undefined) =>
      list ? Math.min(unionSize(list), size) : 0;
    covered += clip(rangesByOwner.get(own));
    declaredUnknown += clip(unknownByOwner.get(own));
    machineOnly += clip(machineByOwner.get(own));
  }

  const threshold = coverageThreshold(contractPresent ? contract.deliver?.coverageRatio : undefined);
  const coverage: CoverageReport = {
    covered, declaredUnknown, machineOnly, total,
    ratio: total === 0 ? 0 : covered / total,
    unmeasured,
    threshold,
    artifacts: counted,
    duplicates,
  };

  // ---- derived fills --------------------------------------------------------
  const mediaKinds = new Set(["d64", "g64", "crt", "prg", "raw"]);
  const media = visible.filter((a) => mediaKinds.has(a.kind));
  const loaderStages = entities.filter((e) => e.kind === "loader-stage");
  const payloads = entities.filter((e) => e.kind === "payload");
  const refutations = findings.filter((f) => f.kind === "refutation");
  // Every S5 claim, newest first (listFindings orders by updated_at DESC), and a
  // claim that carries the count as a FIELD wins over one that only says it in
  // prose — re-recording S5 with a number must settle it, which was the second
  // half of the reported defect.
  const runtimeClaims = findings.filter((f) => (f.tags ?? []).some((t) => /^slot:S5$/i.test(t)));
  const runtimeClaim = runtimeClaims.find((f) => taggedRuntimeCount(f.tags) !== undefined) ?? runtimeClaims[0];
  const runtimeCount = runtimeClaim
    ? taggedRuntimeCount(runtimeClaim.tags)
      ?? parseRuntimeCount(`${runtimeClaim.title} ${runtimeClaim.summary ?? ""}`)
    : undefined;

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
        // Two different states, and printing one message for both made the report
        // contradict itself: "✓ S5 Runtime count" three lines above "S5 has not stated
        // a runtime count yet". S5 WAS answered — "One resident image per phase, five
        // in all" — and the answer simply carries no parseable number, which is a
        // different problem with a different fix.
        if (runtimeCount === undefined) {
          return {
            applies: false,
            why: runtimeClaim
              ? `S5 is answered but no count can be read from its wording ("${runtimeClaim.title.slice(0, 60)}${runtimeClaim.title.length > 60 ? "…" : ""}") — record the number as a FIELD rather than a sentence: slot_record(slot="S5", count=N, …). S6 then becomes required or n/a by arithmetic instead of by regex`
              : "S5 has not stated a runtime count yet",
          };
        }
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
      case "S15":
        // Same trigger as S10 and a different reason: S10 asks where the GAME writes,
        // S15 where WE may. It applies from the moment a medium is registered rather
        // than from the moment someone patches one, because by then the answer is
        // needed and finding it means walking every chain on the disk (issue #24).
        return media.length > 0
          ? { applies: true, why: "a medium exists that something could write to" }
          : { applies: false, why: "no medium registered (S2)" };
      default:
        return { applies: true, why: "" };
    }
  };

  // ---- assemble -------------------------------------------------------------
  const states: SlotState[] = SLOTS.map((slot) => {
    if (owed && !owed.includes(slot.id)) {
      return { slot, status: "n/a" as const, detail: "the project contract does not ask for this one" };
    }
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
      // S15 is S11's twin one level out, and for the same reason: the claim is only
      // worth as much as the instrument behind it. A free list read off the BAM is a
      // hypothesis on any medium and a falsehood on a track/sector-addressed one, so
      // only a walk of the chains settles it.
      if (slot.id === "S15") {
        const byChains = findings.some((f) =>
          (f.tags ?? []).some((t) => /^slot:S15$/i.test(t)) && (f.tags ?? []).some((t) => /^method:chains$/i.test(t)));
        return byChains
          ? { slot, status: "filled", detail: `${explicit[0]}, established by walking the chains` }
          : { slot, status: "hypothesis", detail: `${explicit[0]} — not established by walking the chains; a BAM free list does not describe occupancy (issue #24)` };
      }
      // S5 says what the list actually READ out of it. The count decides whether
      // four other slots apply, and it used to be invisible: a claim that parsed
      // as nothing looked identical to one that parsed as five.
      if (slot.id === "S5") {
        const how = runtimeCount === undefined
          ? "no count could be read — pass count=N to slot_record so S6 is decided by arithmetic"
          : taggedRuntimeCount(runtimeClaim?.tags) !== undefined
            ? `count ${runtimeCount} (recorded as a field)`
            : `count ${runtimeCount} (read from the wording)`;
        return { slot, status: "filled", detail: `${explicit.join(", ")} — ${how}` };
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

  const naming: NamedReport = {
    named: memberNodes - machineNamed,
    members: memberNodes,
    ratio: memberNodes === 0 ? 0 : (memberNodes - machineNamed) / memberNodes,
    machineNamed,
  };

  return {
    states,
    naming,
    records: findings.length + entities.length + routines.length,
    missing: states.filter((s) => s.status === "empty" || s.status === "hypothesis"),
    coverage,
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * The count S5 states, taken from the RECORD when it is there.
 *
 * `slot_record(slot: "S5", count: N)` writes `count:N`. That is the answer to
 * "parse the answer properly or stop gating on prose": the number stops being a
 * thing a regex has to find in a sentence.
 */
function taggedRuntimeCount(tags: readonly string[] | undefined): number | undefined {
  for (const t of tags ?? []) {
    const m = /^count:(\d+)$/i.exec(t);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * The count a sentence states, when no field carries one.
 *
 * The first cut demanded the number IMMEDIATELY before the word "runtime", so
 * both of these were unreadable and S6 through S9 stayed permanently n/a:
 *
 *   "Two permanently resident images and twelve swappable windows"
 *   "4 resident runtimes and 14 swappable windows"
 *
 * — the first says nothing about "runtimes" at all and the second puts a word
 * between the number and the noun. A resident IMAGE is what S5 asks about; it
 * says so in its own question. So the noun set is the question's and up to three
 * words may sit in between.
 *
 * It refuses rather than guesses when the sentence carries two different counts
 * on the same noun ("one resident image per phase, five in all"), because a
 * wrong number here silently decides whether four other slots apply.
 */
function parseRuntimeCount(text: string): number | undefined {
  const noun = "(?:runtime(?:\\s+image)?s?|resident\\s+images?|resident\\s+programs?|images?|residents?)";
  const num = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const re = new RegExp(`\\b${num}\\b((?:\\s+[A-Za-z-]+){0,3}?)\\s+${noun}\\b`, "gi");
  const seen: number[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[1]!.toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (n !== undefined && !seen.includes(n)) seen.push(n);
  }
  if (seen.length === 1) return seen[0];
  return undefined;   // none found, or the sentence states two different ones
}

export function formatSlotReport(r: SlotReport): string {
  const mark = (s: SlotStatus) => s === "filled" ? "✓" : s === "hypothesis" ? "~" : s === "n/a" ? "·" : "✗";
  const lines = r.states.map((s) =>
    `${mark(s.status)} ${s.slot.id.padEnd(3)} ${s.slot.name.padEnd(20)} ${s.detail}`);
  const req = r.states.filter((s) => s.status !== "n/a").length;
  const done = r.states.filter((s) => s.status === "filled").length;
  const na = r.states.length - req;
  // The header states its own arithmetic. "1/12 filled, 11 open" on one run and
  // "10/14 filled, 4 open" on the next, over the same list of 15, read as a
  // contradiction: the denominator MOVES as conditional slots become applicable, and
  // nothing said so.
  const header = `Slots: ${done}/${req} filled, ${r.missing.length} open`
    + (na > 0 ? `, ${na} not applicable (· below) — ${r.states.length} defined in all` : ` — ${r.states.length} defined in all`);
  return [
    header,
    "",
    ...lines,
    "",
    r.coverage.total > 0
      ? `Coverage: ${r.coverage.covered} / ${r.coverage.total} bytes = ${(r.coverage.ratio * 100).toFixed(1)} % (threshold ${(r.coverage.threshold * 100).toFixed(0)} %)`
        + `\n  counted: bytes in a range that says what they ARE — a classification, or a human name`
        + (r.coverage.declaredUnknown > 0 ? `\n  not counted: ${r.coverage.declaredUnknown} byte(s) in ranges declared \`unknown\` — honest, and worth nothing here; classify them or name them` : "")
        + (r.coverage.machineOnly > 0 ? `\n  not counted: ${r.coverage.machineOnly} byte(s) in ranges carrying only a machine name (unknown_3E00, W0801) and no classification — naming them is what moves this number` : "")
        + `\n  denominator: ${r.coverage.artifacts} distinct loadable artifact(s)`
        + (r.coverage.duplicates > 0 ? `, ${r.coverage.duplicates} further cop${r.coverage.duplicates === 1 ? "y" : "ies"} of content already counted left out` : "")
      : "Coverage: nothing measurable registered yet",
    ...(r.coverage.unmeasured.length ? [`  unmeasured (no addressRange, no fileSize): ${r.coverage.unmeasured.join(", ")}`] : []),
  ].join("\n");
}
