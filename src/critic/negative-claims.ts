// Spec 846 D1 — the negative-claim detector.
//
// The corpus law from 844 §4.2 is "a scan proves presence, never absence", and it cuts
// both ways. A negative claim is hard to ESTABLISH by scanning; it is cheap to REFUTE,
// because one counter-example is enough. Ultima VI's four rebuild-costing false negatives
// are every one of them refutable against that project's own graph:
//
//   "$F3 is read by nothing, exhaustive scan"  -> USES_ZP edges land on $F3
//   "$4800-$53FF is unreferenced"              -> edges land inside the range
//   "only $3E83 writes to disk"                -> other routines write the same target
//   "create.prg writes nothing"                -> the store the grep missed
//
// What this checks is NOT "is the claim true" — that is judgement. It is "this claim is
// universal-negative AND the graph holds a counter-example", which is decidable and
// carries its own proof: the edge.
//
// The limitation is stated rather than hidden. The claim is recognised by PHRASING, the
// same way 844's coverage vocabulary gate works, so unusual wording escapes it. A check that
// catches four confident false negatives out of five at zero cost is worth having; one
// that pretends to catch the fifth is not.

import { parseId } from "../knowledge-graph/ids.js";

/**
 * Edge types, grouped by the verb a claim would use about them. These are the ONLY edge
 * types that can refute a claim: a type not listed for the verb is either structure or
 * identity (STRUCTURAL_EDGES) or unknown, and an unknown type never refutes — a scan proves
 * presence, never absence, and an edge nobody classified proves nothing about this claim.
 *
 *   read    READS, USES_ZP, READS_INDIRECT (reads the pointer bytes), REFERENCES_DATA
 *   write   WRITES
 *   call    the control-flow edges: CALLS, CALLS_ROM, JUMPS_TO (also the rts-dispatch jump),
 *           BRANCHES_TO
 *   caller  "has no caller" / "nothing calls it" / "not reachable": control flow, plus the
 *           ways a 6502 reaches code without a jsr — REFERENCES_DATA (a pointer / table /
 *           copy-source reference to the address) and HANDLES_IRQ / HANDLES_NMI (an
 *           interrupt entry)
 *   any     "unreferenced" / "unused": anything that really touches the address — every
 *           type above plus USES_HARDWARE, EXECUTES (a traced run executed it) and the
 *           human REFERENCES relation (a `link_entities` "references" link)
 */
const CONTROL_FLOW = ["CALLS", "CALLS_ROM", "JUMPS_TO", "BRANCHES_TO"] as const;
const VERB_EDGES = {
  read: ["READS", "USES_ZP", "READS_INDIRECT", "REFERENCES_DATA"],
  write: ["WRITES"],
  call: [...CONTROL_FLOW],
  caller: [...CONTROL_FLOW, "REFERENCES_DATA", "HANDLES_IRQ", "HANDLES_NMI"],
  any: [...CONTROL_FLOW, "READS", "WRITES", "USES_ZP", "READS_INDIRECT", "WRITES_INDIRECT", "REFERENCES_DATA", "REFERENCES", "USES_HARDWARE", "HANDLES_IRQ", "HANDLES_NMI", "EXECUTES"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Edges that say how the graph is built, not that anything uses an address: RESOLVES_TO
 * (an address node and the routine at that address are one thing), CONTAINS (a routine
 * and its labels), SIGNATURE (a routine's own derived signature, a self-edge), PASSES
 * (which argument a call passes — rides on a CALLS edge that is judged itself). Never a
 * counter-example, and not worth a "not checked" note either.
 */
const STRUCTURAL_EDGES = ["RESOLVES_TO", "CONTAINS", "SIGNATURE", "PASSES"] as const;

type Verb = keyof typeof VERB_EDGES;

/** The edge types that can refute a claim with this verb — named in every answer. */
export function consideredEdgeTypes(verb: Verb): readonly string[] {
  return VERB_EDGES[verb];
}

/**
 * Source and target are the same place, so the edge is no evidence of use "from elsewhere":
 * a flow edge whose source routine spans the target (an internal branch, recursion), and any
 * edge but a data access whose source sits at the target's own address. Data accesses
 * (READS / WRITES / USES_*) are exempt from the second rule: a routine that reads or
 * patches its own bytes did read or write them.
 */
function selfClause(verb: Verb): string {
  const flow: string[] = [...CONTROL_FLOW];
  if (verb === "caller") flow.push("REFERENCES_DATA");
  const spans = verb === "call" || verb === "caller" || verb === "any"
    ? `(e.type IN (${flow.map((t) => `'${t}'`).join(",")}) AND n.address BETWEEN f.address AND COALESCE(f.end_address, f.address)) OR `
    : "";
  // NOT EXISTS, not a join: a node can have a generated and a human row, and only one of
  // them may carry the span (the human row has no end_address).
  return `AND NOT EXISTS (SELECT 1 FROM nodes f WHERE f.id = e.from_id AND (f.owner IS n.owner OR f.owner IS NULL OR n.owner IS NULL) AND (${spans}`
    + `(e.type NOT IN ('READS','WRITES','READS_INDIRECT','WRITES_INDIRECT','USES_ZP','USES_HARDWARE') AND f.address = n.address)))`;
}

export interface NegativeClaim {
  /** The phrase that made this a negative claim. */
  phrase: string;
  verb: Verb;
  /** "only $XXXX writes" — everything OTHER than this address is claimed not to. */
  onlyAddress?: number;
  addresses: number[];
}

const ADDR_G = /\$([0-9A-Fa-f]{2,4})\b/g;

/**
 * Patterns for a universal negative. Ordered: the first match decides the verb.
 *
 * Each entry is [regex, verb]. They are deliberately phrase-shaped rather than clever —
 * a looser pattern would fire on "nothing to do with the loader" and the whole value of
 * this check is that when it fires, it is right.
 */
const NEGATIVE_PATTERNS: ReadonlyArray<readonly [RegExp, Verb]> = [
  [/\bread by (?:nothing|no one|nobody)\b/iu, "read"],
  [/\b(?:nothing|no one|nobody|no code|no routine)\s+(?:ever\s+)?reads?\b/iu, "read"],
  [/\bnever\s+read\b/iu, "read"],
  // Object position. Ultima VI's actual claim was "create.prg writes nothing", and the
  // first cut only matched "nothing writes" — a real miss on a real project.
  [/\b(?:reads?)\s+nothing\b/iu, "read"],
  [/\b(?:writes?)\s+nothing\b/iu, "write"],
  [/\b(?:calls?)\s+nothing\b/iu, "call"],
  [/\b(?:nothing|no one|nobody|no code|no routine)\s+(?:ever\s+)?writes?\b/iu, "write"],
  [/\bnever\s+written\b/iu, "write"],
  [/\bwritten by (?:nothing|no one|nobody)\b/iu, "write"],
  [/\b(?:nothing|no one|nobody)\s+(?:ever\s+)?calls?\b/iu, "caller"],
  [/\bnever\s+called\b/iu, "caller"],
  [/\bnot\s+(?:reachable|called)\b/iu, "caller"],
  [/\bunreferenced\b/iu, "any"],
  [/\bnot\s+referenced\b/iu, "any"],
  [/\b(?:is|are)\s+(?:completely\s+)?unused\b/iu, "any"],
  [/\bnever\s+(?:used|touched|accessed)\b/iu, "any"],
  [/\bno\s+callers?\b/iu, "caller"],
  [/\bno\s+readers?\b/iu, "read"],
  [/\bno\s+writers?\b/iu, "write"],
  [/\bno\s+references?\b/iu, "any"],
];

/** "only $3E83 writes" / "only $3E83 reads" — an ONLY is a negative about all the rest. */
const ONLY_PATTERNS: ReadonlyArray<readonly [RegExp, Verb]> = [
  [/\bonly\s+\$([0-9A-Fa-f]{2,4})\b[^.]{0,40}?\bwrites?\b/iu, "write"],
  [/\bonly\s+\$([0-9A-Fa-f]{2,4})\b[^.]{0,40}?\breads?\b/iu, "read"],
  [/\bonly\s+\$([0-9A-Fa-f]{2,4})\b[^.]{0,40}?\bcalls?\b/iu, "call"],
];

export function parseNegativeClaim(text: string): NegativeClaim | undefined {
  if (!text) return undefined;

  for (const [re, verb] of ONLY_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      return {
        phrase: m[0].trim(),
        verb,
        onlyAddress: parseInt(m[1], 16),
        addresses: allAddresses(text),
      };
    }
  }
  for (const [re, verb] of NEGATIVE_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // Addresses come from the SENTENCE the claim is in, never from the whole text.
      //
      // The first cut took every $address in the record. On the synthetic fixtures that
      // was harmless — each finding was one short sentence — and on the first real
      // session it produced a bad false positive: "Nothing reads a DOS sector link",
      // buried in a 400-character summary, was checked against 38 addresses collected
      // from the rest of that summary and "refuted" by an unrelated READS edge. The
      // check answered a different question than the one the sentence asked.
      //
      // A negative with no address of its own is not actionable, and the branch below
      // drops it — which is the right answer for that sentence.
      const addresses = allAddresses(sentenceAround(text, m.index));
      if (addresses.length === 0) return undefined;
      return { phrase: m[0].trim(), verb, addresses };
    }
  }
  return undefined;
}

/** The sentence containing `index`. Sentence-ending punctuation, newlines, or the ends. */
function sentenceAround(text: string, index: number): string {
  let start = 0;
  for (let i = index; i > 0; i--) {
    const ch = text[i];
    if (ch === "\n" || ((ch === "." || ch === ";" || ch === "!" || ch === "?") && /\s/.test(text[i + 1] ?? " "))) {
      start = i + 1; break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ((ch === "." || ch === ";" || ch === "!" || ch === "?") && /\s|$/.test(text[i + 1] ?? " "))) {
      end = i; break;
    }
  }
  return text.slice(start, end);
}

function allAddresses(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(ADDR_G)) {
    const n = parseInt(m[1], 16);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export interface CounterExample {
  edgeType: string;
  from: string;
  to: string;
  /** The address the claim was about. */
  address: number;
  /** Whose edge it is: the owner of the node it lands on (or of its source, for "only $A writes"). Absent for platform / ownerless nodes. */
  owner?: string;
  /**
   * Set only when the finding named no owner AND the edge cannot be pinned on the claim's
   * subject: the claimed address is covered by several owners (several images loaded into
   * one window), so this edge may belong to some other image's code. The owners involved.
   * The edge is then a lead, not a refutation.
   */
  ambiguousOwners?: string[];
}

/** The owner a project-form node id carries (`slug:ram/<owner>:kind:addr`); a platform id has none. */
function ownerOfId(id: string): string | undefined {
  try {
    const p = parseId(id);
    return p.form === "project" ? p.ctx.owner ?? undefined : undefined;
  } catch { return undefined; }
}

/**
 * Find ONE counter-example to a negative claim, or nothing.
 *
 * One is enough — the point is refutation, not a census — and stopping at the first keeps
 * this cheap enough to run over every finding in a project.
 *
 * `owners` is the subject the finding names (normStem keys, as `nodes.owner` holds them).
 * Several files can load into one window, so numeric address equality across owners is not
 * a contradiction: with a subject, only nodes of those owners count. Ownerless nodes
 * (`addr`, cart banks) and platform ids (`c64:zp:00f3`) are shared by every owner and
 * always count. Without a subject the first edge of any owner is returned, but when the
 * claimed address is covered by more than one owner the result carries `ambiguousOwners`:
 * with several images at the same addresses, an edge of another image says nothing about
 * this claim, and the caller must not present it as a refutation.
 */
export function findCounterExample(
  db: GraphDb,
  claim: NegativeClaim,
  range?: { start: number; end: number },
  owners?: ReadonlySet<string>,
): CounterExample | undefined {
  const hit = firstCounterExample(db, claim, range, owners);
  if (!hit || (owners && owners.size > 0) || hit.owner === undefined) return hit;
  // No subject, and the edge belongs to a named owner: is the claim's address shared?
  const spans = claim.onlyAddress !== undefined
    ? [{ start: claim.onlyAddress, end: claim.onlyAddress }]
    : range ? [range] : claim.addresses.map((a) => ({ start: a, end: a }));
  const involved = new Set<string>([hit.owner]);
  for (const span of spans) {
    const rows = db.prepare(
      "SELECT DISTINCT owner FROM nodes WHERE address BETWEEN ? AND ? AND owner IS NOT NULL",
    ).all(span.start, span.end) as Array<{ owner: string }>;
    for (const r of rows) involved.add(r.owner);
  }
  return involved.size > 1 ? { ...hit, ambiguousOwners: [...involved].sort() } : hit;
}

type GraphDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

function firstCounterExample(
  db: GraphDb,
  claim: NegativeClaim,
  range?: { start: number; end: number },
  owners?: ReadonlySet<string>,
): CounterExample | undefined {
  const types: readonly string[] = VERB_EDGES[claim.verb];
  const typeClause = `AND e.type IN (${types.map(() => "?").join(",")})`;
  const subject = owners && owners.size > 0 ? [...owners] : undefined;
  const ownerClause = (col: string) => subject ? `AND (${col} IS NULL OR ${col} IN (${subject.map(() => "?").join(",")}))` : "";
  const ownerArgs = subject ?? [];

  // "only $A writes T": a counter-example is another source writing something $A writes.
  if (claim.onlyAddress !== undefined) {
    const targets = db.prepare(
      `SELECT DISTINCT e.to_id FROM edges e JOIN nodes n ON n.id = e.from_id
       WHERE n.address = ? ${ownerClause("n.owner")} ${typeClause} LIMIT 50`,
    ).all(claim.onlyAddress, ...ownerArgs, ...types) as Array<{ to_id: string }>;
    if (targets.length === 0) return undefined;
    const placeholders = targets.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT e.type, e.from_id, e.to_id FROM edges e JOIN nodes n ON n.id = e.from_id
       WHERE e.to_id IN (${placeholders}) AND n.address <> ? ${ownerClause("n.owner")} ${typeClause} LIMIT 1`,
    ).all(...targets.map((t) => t.to_id), claim.onlyAddress, ...ownerArgs, ...types) as Array<{ type: string; from_id: string; to_id: string }>;
    const hit = rows[0];
    return hit ? { edgeType: hit.type, from: hit.from_id, to: hit.to_id, address: claim.onlyAddress, owner: ownerOfId(hit.from_id) } : undefined;
  }

  // Plain negative: anything landing on the claimed address (or inside the claimed range).
  const spans: Array<{ start: number; end: number }> = range
    ? [range]
    : claim.addresses.map((a) => ({ start: a, end: a }));

  for (const span of spans) {
    const rows = db.prepare(
      `SELECT e.type, e.from_id, e.to_id, n.address, n.owner FROM edges e JOIN nodes n ON n.id = e.to_id
       WHERE n.address BETWEEN ? AND ? ${ownerClause("n.owner")} ${typeClause} ${selfClause(claim.verb)} LIMIT 1`,
    ).all(span.start, span.end, ...ownerArgs, ...types) as Array<{ type: string; from_id: string; to_id: string; address: number; owner: string | null }>;
    const hit = rows[0];
    if (hit) return { edgeType: hit.type, from: hit.from_id, to: hit.to_id, address: hit.address, owner: hit.owner ?? undefined };

    // A to_id may point into the PLATFORM file rather than this project's nodes table —
    // the graph schema says so outright, and USES_ZP is exactly that case: every one of
    // Ultima VI's 4970 zero-page edges targets `c64:zp:xxxx`, which the join above cannot
    // see. That is why "$F3 is read by nothing" survived the first version of this check
    // against the very project whose rebuild it cost. Every id form ends in four hex
    // digits, so a suffix match finds them; it is an unindexed scan, which is why it is
    // only done for single addresses and not for a range of thousands. The suffix also
    // matches project ids, so with a subject the target's own owner is read off the id. Only
    // targets that are NOT a row in `nodes`: those the join above has already judged, with the
    // self-edge rule, and must not be admitted again through this door.
    if (span.start === span.end) {
      const suffix = span.start.toString(16).padStart(4, "0");
      const dangling = db.prepare(
        `SELECT e.type, e.from_id, e.to_id FROM edges e
         WHERE substr(e.to_id, -4) = ? ${typeClause} AND NOT EXISTS (SELECT 1 FROM nodes t WHERE t.id = e.to_id) LIMIT ${subject ? 200 : 1}`,
      ).all(suffix, ...types) as Array<{ type: string; from_id: string; to_id: string }>;
      const d = dangling.find((x) => !subject || ownerOfId(x.to_id) === undefined || subject.includes(ownerOfId(x.to_id)!));
      if (d) return { edgeType: d.type, from: d.from_id, to: d.to_id, address: span.start, owner: ownerOfId(d.to_id) };
    }
  }
  return undefined;
}

/**
 * Edge types that land on the claimed address and that nobody has classified — neither a
 * use of an address (any verb) nor structure: human relation kinds such as DOCUMENTS /
 * DEPENDS_ON / LOADS / STORES / MAPS_TO. The claim was NOT checked against them. The caller
 * reports them as "not checked" — they neither refute the claim nor clear it.
 */
export function uncheckedEdgeTypes(
  db: GraphDb,
  claim: NegativeClaim,
  range?: { start: number; end: number },
  owners?: ReadonlySet<string>,
): string[] {
  // Known kinds are classified: the verb's own (judged), the other verbs' (a jump is no read),
  // structure. Only a kind outside all of those is unchecked.
  const skip = [...VERB_EDGES.any, ...STRUCTURAL_EDGES];
  const notIn = `AND e.type NOT IN (${skip.map(() => "?").join(",")})`;
  const subject = owners && owners.size > 0 ? [...owners] : undefined;
  const ownerClause = subject ? `AND (n.owner IS NULL OR n.owner IN (${subject.map(() => "?").join(",")}))` : "";
  const spans = claim.onlyAddress !== undefined
    ? [{ start: claim.onlyAddress, end: claim.onlyAddress }]
    : range && claim.onlyAddress === undefined ? [range] : claim.addresses.map((a) => ({ start: a, end: a }));
  const out = new Set<string>();
  for (const span of spans) {
    const rows = db.prepare(
      `SELECT DISTINCT e.type FROM edges e JOIN nodes n ON n.id = e.to_id
       WHERE n.address BETWEEN ? AND ? ${ownerClause} ${notIn}`,
    ).all(span.start, span.end, ...(subject ?? []), ...skip) as Array<{ type: string }>;
    for (const r of rows) out.add(r.type);
  }
  return [...out].sort();
}
