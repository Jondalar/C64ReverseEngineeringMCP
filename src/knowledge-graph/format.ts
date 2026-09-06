// Spec 823 D3/D7 — ONE formatter for the CLI and the MCP tools. Text for a
// human, a JSON document for a machine; the JSON the tool embeds in its
// ```json block is byte-identical to what `c64re graph … --json` prints, and
// the gate asserts it. Compact hits, stable ids, never a listing excerpt.

import type { ArgsDomain, NodeCard, OverviewSection, PathResult, SignatureCard, Walk, WalkEdge } from "./cards.js";
import type { ResolvedNode } from "./query.js";

const hex = (a: number) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

export interface Formatted {
  text: string;
  json: unknown;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hitLine(n: ResolvedNode): string {
  const why = [n.platform ? "platform" : "", n.layers.includes("human") ? "human" : "", n.orphaned ? "orphaned" : "", n.dangling ? "DANGLING" : ""].filter(Boolean).join(",");
  const bank = n.bank !== null ? ` bank:${n.bank.toString(16).padStart(2, "0")}` : "";
  return `[${n.kind}] ${hex(n.address)}${bank} ${n.name ?? ""} | id=${n.id}${why ? ` | ${why}` : ""}`;
}

export function formatFind(query: string, nodes: ResolvedNode[], limit: number): Formatted {
  const hits = nodes.slice(0, limit).map((n) => ({
    id: n.id, kind: n.kind, address: hex(n.address), bank: n.bank, name: n.name, origin: n.layers.includes("human") ? "human" : n.platform ? "platform" : "generated",
    orphaned: n.orphaned, dangling: n.dangling, owner: n.owner,
  }));
  const json = { query, hits, truncated: nodes.length > limit, next: hits.slice(0, 1).map((h) => ({ tool: "graph_node", args: { ref: h.id } })) };
  const text = hits.length === 0 ? `no node matches "${query}"` : nodes.slice(0, limit).map(hitLine).join("\n") + (nodes.length > limit ? `\n… ${nodes.length - limit} more (raise limit)` : "");
  return { text, json };
}

/** A ∈ … order: the registers first, then the carry, then every other location alphabetically. */
const REG_ORDER: Record<string, number> = { A: 0, X: 1, Y: 2, C: 3 };
const byReg = (a: string, b: string) => (REG_ORDER[a] ?? 9) - (REG_ORDER[b] ?? 9) || a.localeCompare(b);

/** 826 D6 — the static call-site arguments on a CALLS line: `A=#$01 X←$27E1 Y←op:$2805 C=1`. */
function argsSuffix(args: Record<string, { source: string; label: string }> | undefined): string {
  if (!args) return "";
  const parts = Object.keys(args).sort(byReg).map((reg) => { const a = args[reg]!; return a.source === "imm" || a.source === "flag" ? `${reg}=${a.label}` : `${reg}←${a.label}`; });
  return parts.length ? ` args: ${parts.join(" ")}` : "";
}

/** 826 D6 — the observed values on a runtime CALLS line: `observed: A∈{$01,$02} C∈{0}` (up to 6 values per register, then …). */
function observedSuffix(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const parts: string[] = [];
  for (const reg of Object.keys(raw as Record<string, unknown>).sort(byReg)) {
    const vals = (raw as Record<string, unknown>)[reg];
    if (!vals || typeof vals !== "object") continue;
    const keys = Object.keys(vals as Record<string, unknown>);
    if (!keys.length) continue;
    parts.push(`${reg}∈{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}}`);
  }
  return parts.length ? ` observed: ${parts.join(" ")}` : "";
}

function edgeLine(e: WalkEdge): string {
  const ev = e.evidence;
  const where = typeof ev.source_address === "number" ? hex(ev.source_address as number) : typeof ev.pc === "number" ? hex(ev.pc as number) : "";
  const instr = typeof ev.instruction === "string" ? ev.instruction : "";
  const rt = e.origin === "runtime" ? ` ×${String(ev.count ?? 1)} run=${String(ev.run_id ?? "?")}` : "";
  const amb = ev.ambiguity ? ` [${String(ev.ambiguity)}]` : "";
  const unk = ev.target === "unknown" ? ` [target unknown, pointer ${hex(Number(ev.pointer_zp ?? 0))}]` : "";
  const dang = e.toNode.dangling ? " [DANGLING]" : "";
  const args = e.type === "CALLS" ? `${argsSuffix(e.args)}${e.origin === "runtime" ? observedSuffix(ev.args_observed) : ""}` : "";
  const name = (n: ResolvedNode) => (n.name ? ` ${n.name}` : "");
  return `${e.type.padEnd(15)} ${hex(e.fromNode.address)}${name(e.fromNode)} → ${hex(e.toNode.address)}${name(e.toNode)} | ${e.origin}/${e.confidence} | ${where} ${instr}${rt}${amb}${unk}${dang}${args}\n    from=${e.from}\n    to=${e.to}`;
}

/** 826 D7 — `in: A X zp:$F3 · out: zp:$FC C · clobbers: A X Y · preserves: — · stack: balanced`. */
export function signatureLine(s: SignatureCard): string {
  const list = (xs: string[]) => (xs.length ? xs.join(" ") : "—");
  return `in: ${list(s.in)} · out: ${list(s.out)} · clobbers: ${list(s.clobbers)} · preserves: ${list(s.preserves)} · stack: ${s.stack}`;
}

/** 826 D6 — `A ∈ {$01 ×2, $02 ×1} (observed $01 ×40, $02 ×2) · X ← $27E1 ×1`. */
export function argsLine(domain: ArgsDomain): string {
  const parts: string[] = [];
  for (const reg of Object.keys(domain).sort(byReg)) {
    const d = domain[reg]!;
    const imm = Object.entries(d.static).filter(([k]) => /^\$[0-9A-F]{2}$/u.test(k) || (reg === "C" && /^[01]$/u.test(k)));
    const other = Object.entries(d.static).filter(([k]) => !imm.some(([i]) => i === k));
    const segs: string[] = [];
    if (imm.length) segs.push(`${reg} ∈ {${imm.map(([k, n]) => `${k} ×${n}`).join(", ")}}`);
    for (const [k, n] of other) segs.push(`${reg} ← ${k} ×${n}`);
    const obs = Object.entries(d.observed);
    if (obs.length) {
      const o = `observed ${obs.map(([k, n]) => `${k} ×${n}`).join(", ")}`;
      if (segs.length) segs[segs.length - 1] += ` (${o})`; else segs.push(`${reg} ${o}`);
    }
    if (segs.length) parts.push(segs.join(" · "));
  }
  return parts.join(" · ");
}

export function formatEdges(walk: Walk): Formatted {
  const json = {
    ref: walk.ref, roots: walk.roots, direction: walk.direction, kind: walk.kind, origin: walk.origin, depth: walk.depth,
    edges: walk.edges.map((e) => ({
      type: e.type, from: { id: e.from, address: hex(e.fromNode.address), name: e.fromNode.name }, to: { id: e.to, address: hex(e.toNode.address), name: e.toNode.name, dangling: e.toNode.dangling },
      origin: e.origin, confidence: e.confidence, layer: e.layer, evidence: e.evidence, ...(e.args ? { args: e.args } : {}),
    })),
    total: walk.total, truncated: walk.truncated,
  };
  const text = walk.edges.length === 0 ? `no ${walk.kind} edges ${walk.direction === "in" ? "into" : walk.direction === "out" ? "out of" : "around"} ${walk.ref}` : `${walk.edges.map(edgeLine).join("\n")}${walk.truncated ? `\n… ${walk.total - walk.edges.length} more (raise limit)` : ""}`;
  return { text, json };
}

export function formatNode(card: NodeCard): Formatted {
  const lines = [
    `${card.id}`,
    `  ${card.kind} ${card.range ?? card.address}${card.bank !== null ? ` bank:${card.bank.toString(16).padStart(2, "0")}` : ""}${card.owner ? ` owner=${card.owner}` : ""}${card.platform ? " (platform)" : ""}${card.dangling ? " (DANGLING)" : ""}${card.orphaned ? " (orphaned human row)" : ""}`,
    `  generated label: ${card.generatedLabel ?? "—"}    human name: ${card.humanName ?? "—"}`,
  ];
  if (card.subsystems.length) lines.push(`  subsystems: ${card.subsystems.join(", ")}`);
  const fmt = (c: Record<string, number>) => Object.entries(c).sort().map(([k, v]) => `${k}:${v}`).join(" ") || "—";
  lines.push(`  edges in: ${fmt(card.edgeCounts.in)}`);
  lines.push(`  edges out: ${fmt(card.edgeCounts.out)}`);
  if (card.hardware.length) lines.push(`  hardware: ${card.hardware.join(", ")}`);
  if (card.rom.length) lines.push(`  rom: ${card.rom.join(", ")}`);
  if (card.zeroPage.length) lines.push(`  zero page: ${card.zeroPage.slice(0, 16).join(", ")}${card.zeroPage.length > 16 ? " …" : ""}`);
  // 826 D7/D8 — the computed signature, then the human abi on its OWN line, never merged
  if (card.signature) {
    const s = card.signature;
    if (s.in.length || s.out.length || s.clobbers.length || s.preserves.length || s.stack !== "unknown" || s.partial) lines.push(`  signature: ${signatureLine(s)}`);
    if (s.partial) lines.push(`  partial: ${s.partial}`);
    if (s.humanAbi) lines.push(`  human abi: ${s.humanAbi}`);
  }
  if (card.argsDomain) {
    const a = argsLine(card.argsDomain);
    if (a) lines.push(`  args: ${a}`);
  }
  lines.push(`  runtime: ${card.runtime.observed ? `observed in ${card.runtime.runs.length} run(s) ${card.runtime.runs.join(",")} (${card.runtime.edges} edges)` : "not observed in any trace run"}`);
  return { text: lines.join("\n"), json: card };
}

export function formatPath(result: PathResult): Formatted {
  const json = {
    from: result.from, to: result.to, via: result.via,
    paths: result.path ? [result.path.map((e) => ({ type: e.type, from: e.from, to: e.to, evidence: e.evidence }))] : [],
    frontier: result.frontier,
  };
  const text = result.path
    ? result.path.map((e, i) => `${i + 1}. ${e.type} ${hex(e.fromNode.address)}${e.fromNode.name ? ` ${e.fromNode.name}` : ""} → ${hex(e.toNode.address)}${e.toNode.name ? ` ${e.toNode.name}` : ""} ${typeof e.evidence.instruction === "string" ? `(${e.evidence.instruction})` : ""}`).join("\n")
    : `no path from ${result.from} to ${result.to} via ${result.via} (${result.frontier} nodes reachable)`;
  return { text, json };
}

export function formatOverview(sections: OverviewSection[]): Formatted {
  const text = sections.map((s) => `## ${s.label} — ${s.count}\n${s.top.length ? s.top.map((t) => `  ${String(t.count).padStart(4)}  ${t.id}${t.name ? `  ${t.name}` : ""}`).join("\n") : "  (none)"}`).join("\n");
  return { text, json: { sections } };
}
