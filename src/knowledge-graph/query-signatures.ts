// Spec 826 D6/D7 — the read side of the signatures: the signature of one
// routine (the SIGNATURE self-edge's evidence), the argument domain of one
// callee across every PASSES edge into it, and the two printers the CLI verbs
// `signature <ref>` and `args <ref>` use. Library code; the MCP card (823
// `nodeCard`) reads the same edge.

import type { Graph } from "./query.js";
import { locRank, type ArgEvidence, type Signature } from "./producers/signatures.js";

export type { ArgEvidence, Signature } from "./producers/signatures.js";

export interface ArgsDomainEntry {
  /** `$01` for an immediate, `←<cell>` for a load, `←op:$XXXX`, `←A` for a register copy, `←callee`, `flag=1`, `?` */
  key: string;
  source: string;
  value?: number;
  from?: string;
  sites: string[];
}
export interface ArgsDomain {
  callee: string;
  /** PASSES edges counted */
  sites: number;
  domain: Record<string, ArgsDomainEntry[]>;
}

const hex2 = (v: number) => `$${(v & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
const hex4 = (a: number) => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/** The D7 signature of a routine, or undefined when the 826 producer has not signed it. */
export function signatureOf(graph: Graph, routineId: string): Signature | undefined {
  const e = graph.edgesOutOf(routineId, ["SIGNATURE"]).find((h) => h.to === routineId) ?? graph.edgesOutOf(routineId, ["SIGNATURE"])[0];
  if (!e) return undefined;
  const ev = e.evidence as unknown as Signature;
  return ev && Array.isArray(ev.in) ? ev : undefined;
}

/** The label of one argument source in the domain: the value for an immediate, the cell for a load, the kind otherwise. */
export function argKey(graph: Graph | undefined, a: ArgEvidence): string {
  switch (a.source) {
    case "imm": return typeof a.value === "number" ? hex2(a.value) : "imm";
    case "flag": return typeof a.value === "number" ? `flag=${a.value}` : "flag";
    case "zp":
    case "mem": {
      if (!a.from) return "←mem";
      const n = graph?.resolve(a.from);
      const cell = n && !n.dangling ? hex4(n.address) : a.from;
      return `←${cell}${a.indexed ? `,${a.indexed.toLowerCase()}` : ""}${a.indirect ? " (indirect)" : ""}`;
    }
    case "op": return `←${a.from ?? "op"}`;
    case "reg": return `←${a.from ?? "reg"}`;
    case "callee": return `←callee${a.from ? ` ${a.from}` : ""}`;
    default: return "?";
  }
}

/**
 * For each `in` location of a callee: the values (immediates as `$XX`), the
 * source cells, and the unknowns — across every PASSES edge into the callee,
 * aliases followed (826.0 T2). `calleeRef` is a node id.
 */
export function argsDomain(graph: Graph, calleeRef: string): ArgsDomain {
  const edges = graph.edgesInto(calleeRef, ["PASSES"]);
  const domain: Record<string, Map<string, ArgsDomainEntry>> = {};
  for (const e of edges) {
    const args = e.evidence.args as Record<string, ArgEvidence> | undefined;
    if (!args || typeof args !== "object") continue;
    const site = typeof e.evidence.site === "string" ? e.evidence.site : e.evidenceKey;
    for (const [loc, a] of Object.entries(args)) {
      if (!a || typeof a !== "object") continue;
      const key = argKey(graph, a);
      const bucket = (domain[loc] ??= new Map());
      const cur = bucket.get(key) ?? { key, source: a.source, value: a.value, from: a.from, sites: [] };
      cur.sites.push(site);
      bucket.set(key, cur);
    }
  }
  const out: Record<string, ArgsDomainEntry[]> = {};
  for (const loc of Object.keys(domain).sort((a, b) => locRank(a) - locRank(b) || a.localeCompare(b))) {
    out[loc] = [...domain[loc]!.values()].sort((a, b) => b.sites.length - a.sites.length || a.key.localeCompare(b.key));
  }
  return { callee: calleeRef, sites: edges.length, domain: out };
}

/** `in: A X zp:$F3 · out: zp:$FC C · clobbers: A X Y · preserves: — · stack: balanced` (+ ` · partial: <because> @<site>`). */
export function formatSignature(sig: Signature): string {
  const list = (xs: string[]) => (xs.length ? xs.join(" ") : "—");
  const st = sig.stack;
  let stack: string;
  if (st.unknown) stack = "unknown";
  else if (st.balanced) stack = "balanced";
  else if (st.returns_to) stack = `delta ${st.delta ?? "?"} (returns to ${st.returns_to})`;
  else if (st.unbalanced_at) stack = `unbalanced @${st.unbalanced_at.split(" ")[0]}`;
  else stack = st.delta === null ? "unbalanced" : `delta ${st.delta}`;
  const tricks = st.tricks.filter((t) => !(st.returns_to && t === "returns-to-callers-caller"));
  if (tricks.length) stack += ` [${tricks.join(", ")}]`;
  const line = `in: ${list(sig.in.map((i) => i.loc))} · out: ${list(sig.out.map((o) => o.loc))} · clobbers: ${list(sig.clobbers)} · preserves: ${list(sig.preserves)} · stack: ${stack}`;
  return sig.partial ? `${line} · partial: ${sig.partial.because} @${sig.partial.site.split(" ")[0]}` : line;
}

/** One line per location: `A ∈ {$01 ×2, $02 ×1, $03 ×1}` when every site passes an immediate, `X ← $27E1 (1), imm $12 (1)` otherwise. */
export function formatArgs(domain: ArgsDomain): string {
  const lines: string[] = [];
  for (const [loc, entries] of Object.entries(domain.domain)) {
    const allImm = entries.every((e) => e.source === "imm" && typeof e.value === "number");
    if (allImm) lines.push(`${loc} ∈ {${entries.map((e) => `${e.key} ×${e.sites.length}`).join(", ")}}`);
    else {
      lines.push(`${loc} ← ${entries.map((e) => {
        const label = e.source === "imm" && typeof e.value === "number" ? `imm ${e.key}` : e.key.startsWith("←") ? e.key.slice(1) : e.key;
        return `${label} (${e.sites.length})`;
      }).join(", ")}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n(${domain.sites} call site${domain.sites === 1 ? "" : "s"})` : `no PASSES edges into ${domain.callee}`;
}
