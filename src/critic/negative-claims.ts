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
// same way 844's S12 vocabulary gate works, so unusual wording escapes it. A check that
// catches four confident false negatives out of five at zero cost is worth having; one
// that pretends to catch the fifth is not.

/** Edge types, grouped by the verb a claim would use about them. */
const VERB_EDGES: Record<string, readonly string[]> = {
  read: ["READS", "USES_ZP", "READS_INDIRECT", "REFERENCES_DATA"],
  write: ["WRITES"],
  call: ["CALLS", "CALLS_ROM", "JUMPS_TO", "BRANCHES_TO"],
  // "unreferenced" / "unused" makes no distinction — anything touching it refutes it.
  any: [],
};

type Verb = keyof typeof VERB_EDGES;

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
  [/\b(?:nothing|no one|nobody)\s+(?:ever\s+)?calls?\b/iu, "call"],
  [/\bnever\s+called\b/iu, "call"],
  [/\bnot\s+(?:reachable|called)\b/iu, "call"],
  [/\bunreferenced\b/iu, "any"],
  [/\bnot\s+referenced\b/iu, "any"],
  [/\b(?:is|are)\s+(?:completely\s+)?unused\b/iu, "any"],
  [/\bnever\s+(?:used|touched|accessed)\b/iu, "any"],
  [/\bno\s+(?:references?|readers?|writers?|callers?)\b/iu, "any"],
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
      const addresses = allAddresses(text);
      if (addresses.length === 0) return undefined; // a negative about nothing nameable
      return { phrase: m[0].trim(), verb, addresses };
    }
  }
  return undefined;
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
}

/**
 * Find ONE counter-example to a negative claim, or nothing.
 *
 * One is enough — the point is refutation, not a census — and stopping at the first keeps
 * this cheap enough to run over every finding in a project.
 */
export function findCounterExample(
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } },
  claim: NegativeClaim,
  range?: { start: number; end: number },
): CounterExample | undefined {
  const types = VERB_EDGES[claim.verb];
  const typeClause = types.length > 0 ? `AND e.type IN (${types.map(() => "?").join(",")})` : "";

  // "only $A writes T": a counter-example is another source writing something $A writes.
  if (claim.onlyAddress !== undefined) {
    const targets = db.prepare(
      `SELECT DISTINCT e.to_id FROM edges e JOIN nodes n ON n.id = e.from_id
       WHERE n.address = ? ${typeClause} LIMIT 50`,
    ).all(claim.onlyAddress, ...types) as Array<{ to_id: string }>;
    if (targets.length === 0) return undefined;
    const placeholders = targets.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT e.type, e.from_id, e.to_id FROM edges e JOIN nodes n ON n.id = e.from_id
       WHERE e.to_id IN (${placeholders}) AND n.address <> ? ${typeClause} LIMIT 1`,
    ).all(...targets.map((t) => t.to_id), claim.onlyAddress, ...types) as Array<{ type: string; from_id: string; to_id: string }>;
    const hit = rows[0];
    return hit ? { edgeType: hit.type, from: hit.from_id, to: hit.to_id, address: claim.onlyAddress } : undefined;
  }

  // Plain negative: anything landing on the claimed address (or inside the claimed range).
  const spans: Array<{ start: number; end: number }> = range
    ? [range]
    : claim.addresses.map((a) => ({ start: a, end: a }));

  for (const span of spans) {
    const rows = db.prepare(
      `SELECT e.type, e.from_id, e.to_id, n.address FROM edges e JOIN nodes n ON n.id = e.to_id
       WHERE n.address BETWEEN ? AND ? ${typeClause} LIMIT 1`,
    ).all(span.start, span.end, ...types) as Array<{ type: string; from_id: string; to_id: string; address: number }>;
    const hit = rows[0];
    if (hit) return { edgeType: hit.type, from: hit.from_id, to: hit.to_id, address: hit.address };

    // A to_id may point into the PLATFORM file rather than this project's nodes table —
    // the graph schema says so outright, and USES_ZP is exactly that case: every one of
    // Ultima VI's 4970 zero-page edges targets `c64:zp:xxxx`, which the join above cannot
    // see. That is why "$F3 is read by nothing" survived the first version of this check
    // against the very project whose rebuild it cost. Every id form ends in four hex
    // digits, so a suffix match finds them; it is an unindexed scan, which is why it is
    // only done for single addresses and not for a range of thousands.
    if (span.start === span.end) {
      const suffix = span.start.toString(16).padStart(4, "0");
      const dangling = db.prepare(
        `SELECT e.type, e.from_id, e.to_id FROM edges e
         WHERE substr(e.to_id, -4) = ? ${typeClause} LIMIT 1`,
      ).all(suffix, ...types) as Array<{ type: string; from_id: string; to_id: string }>;
      const d = dangling[0];
      if (d) return { edgeType: d.type, from: d.from_id, to: d.to_id, address: span.start };
    }
  }
  return undefined;
}
