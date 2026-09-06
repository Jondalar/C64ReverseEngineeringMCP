// Spec 824 — the Graph tab: a NEIGHBOURHOOD, not the graph. One focus node,
// its incoming edges in the left lane, its outgoing edges in the right lane,
// filter chips per edge family, the project overview when nothing is focused.
// Reads the five /api/graph/* routes (one per 823 tool) and nothing else;
// no graph logic lives here. Read-only: naming goes through save_*.

import { useEffect, useMemo, useState } from "react";
import type { AsmViewSource } from "./AsmView.js";

type Hit = { id: string; kind: string; address: string; bank: number | null; name: string | null; origin: string; orphaned: boolean; dangling: boolean; owner: string | null };
type EdgeEnd = { id: string; address: string; name: string | null; dangling?: boolean };
/** Spec 826 D6 — the static call-site arguments joined onto a CALLS edge (`A=#$01 X←$27E1`) */
type WalkArg = { source: string; label: string; site?: string };
type Edge = { type: string; from: EdgeEnd; to: EdgeEnd; origin: string; confidence: string; layer: string; evidence: Record<string, unknown>; args?: Record<string, WalkArg> };
type Walk = { ref: string; roots: string[]; direction: string; kind: string; origin: string; depth: number; edges: Edge[]; total: number; truncated: boolean };
/** Spec 826 D7 — the routine's computed interface; `humanAbi` is the human's line, shown beside it, never merged (D8) */
type Signature = { in: string[]; out: string[]; clobbers: string[]; preserves: string[]; stack: string; partial: string | null; humanAbi: string | null };
/** Spec 826 D6 — per register: the static domain at the call sites and what the runs passed */
type ArgsDomain = Record<string, { static: Record<string, number>; observed: Record<string, number> }>;
type Card = {
  id: string; kind: string; address: string; range: string | null; bank: number | null; owner: string | null; platform: boolean; dangling: boolean;
  generatedLabel: string | null; humanName: string | null; layers: string[]; orphaned: boolean; confidence?: string;
  subsystems: string[]; edgeCounts: { in: Record<string, number>; out: Record<string, number> };
  hardware: string[]; rom: string[]; zeroPage: string[]; runtime: { observed: boolean; edges: number; runs: string[] };
  signature?: Signature | null; argsDomain?: ArgsDomain | null;
};

const REG_ORDER: Record<string, number> = { A: 0, X: 1, Y: 2, C: 3 };
const byReg = (a: string, b: string) => (REG_ORDER[a] ?? 9) - (REG_ORDER[b] ?? 9) || a.localeCompare(b);
const list = (xs: string[]) => (xs.length ? xs.join(" ") : "—");

/** `in: A X · out: zp:$FC C · clobbers: A X Y · preserves: — · stack: balanced` — the same line the CLI prints */
function signatureText(s: Signature): string {
  return `in: ${list(s.in)} · out: ${list(s.out)} · clobbers: ${list(s.clobbers)} · preserves: ${list(s.preserves)} · stack: ${s.stack}`;
}

/** `A ∈ {$01 ×2, $02 ×1} (observed $01 ×40) · X ← $27E1 ×1` */
function argsText(domain: ArgsDomain): string {
  const parts: string[] = [];
  for (const reg of Object.keys(domain).sort(byReg)) {
    const d = domain[reg]!;
    const imm = Object.entries(d.static).filter(([k]) => /^\$[0-9A-F]{2}$/.test(k) || (reg === "C" && /^[01]$/.test(k)));
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

/** the CALLS lane suffix: static `A=#$01 X←$27E1`, runtime `A∈{$01,$02}` */
function edgeArgsText(e: Edge): string {
  if (e.type !== "CALLS") return "";
  const out: string[] = [];
  if (e.args) out.push(Object.keys(e.args).sort(byReg).map((r) => { const a = e.args![r]!; return a.source === "imm" || a.source === "flag" ? `${r}=${a.label}` : `${r}←${a.label}`; }).join(" "));
  const obs = e.evidence.args_observed;
  if (e.origin === "runtime" && obs && typeof obs === "object") {
    const regs = Object.keys(obs as Record<string, unknown>).sort(byReg).map((r) => { const v = (obs as Record<string, Record<string, number>>)[r] ?? {}; const ks = Object.keys(v); return ks.length ? `${r}∈{${ks.slice(0, 4).join(",")}${ks.length > 4 ? ",…" : ""}}` : ""; }).filter(Boolean);
    if (regs.length) out.push(regs.join(" "));
  }
  return out.length ? ` · ${out.join(" ")}` : "";
}
type Overview = { sections: Array<{ id: string; label: string; count: number; top: Array<{ id: string; name: string | null; count: number }> }> };

export type ListingJump = { entityId: string } | { reason: string };
/** Spec 824.2 — the ASM source(s) for a node's owner, or why there is none */
export type SourceJump = { title: string; sources: AsmViewSource[] } | { reason: string };

const FILTERS: Array<{ id: string; label: string; types: string[] }> = [
  { id: "code", label: "Code", types: ["CALLS", "JUMPS_TO", "BRANCHES_TO", "CONTAINS"] },
  { id: "memory", label: "Memory", types: ["READS", "WRITES", "READS_INDIRECT", "WRITES_INDIRECT", "REFERENCES_DATA", "USES_ZP"] },
  { id: "hardware", label: "Hardware", types: ["USES_HARDWARE"] },
  { id: "rom", label: "ROM", types: ["CALLS_ROM"] },
  { id: "runtime", label: "Runtime", types: [] },
  { id: "annotations", label: "Annotations", types: [] },
  { id: "bank", label: "Bank", types: [] },
  { id: "subsystem", label: "Subsystem", types: [] },
];

function familyOf(e: Edge): string {
  for (const f of FILTERS) if (f.types.includes(e.type)) return f.id;
  return "code";
}

export function GraphPanel({
  projectDir,
  focusRef,
  onFocus,
  listingJump,
  onJumpToListing,
  sourceJump,
  onJumpToSource,
}: {
  projectDir: string;
  focusRef: string | null;
  onFocus: (ref: string | null) => void;
  /** address → listing entity, decided by the caller (App owns the listing) */
  listingJump: (address: number) => ListingJump;
  onJumpToListing: (entityId: string) => void;
  /** Spec 824.2 — owner (analysis stem) → its ASM sources, decided by the caller (App owns the artifacts) */
  sourceJump: (owner: string | null) => SourceJump;
  /** open the AsmView overlay on these sources at the address */
  onJumpToSource: (title: string, sources: AsmViewSource[], address: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [walk, setWalk] = useState<Walk | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<string[] | null>(null);
  const [dimmed, setDimmed] = useState<Set<string>>(new Set());
  const [depth, setDepth] = useState<1 | 2>(1);
  const pd = `projectDir=${encodeURIComponent(projectDir)}`;

  async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
    const r = await fetch(path);
    const body = (await r.json()) as T;
    return { status: r.status, body };
  }

  // overview when nothing is focused
  useEffect(() => {
    let alive = true;
    if (focusRef) return;
    getJson<Overview & { error?: string; next?: string[] }>(`/api/graph/overview?${pd}`).then(({ status, body }) => {
      if (!alive) return;
      if (status === 404) { setNext(body.next ?? null); setError(body.error ?? "no graph yet"); setOverview(null); return; }
      setError(null); setNext(null); setOverview(body);
    }).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [pd, focusRef]);

  // card + walk for the focus
  useEffect(() => {
    let alive = true;
    if (!focusRef) { setCard(null); setWalk(null); return; }
    const ref = encodeURIComponent(focusRef);
    Promise.all([
      getJson<Card & { ambiguous?: boolean; hits?: Hit[]; error?: string }>(`/api/graph/node?${pd}&ref=${ref}`),
      getJson<Walk & { error?: string }>(`/api/graph/edges?${pd}&ref=${ref}&direction=both&depth=${depth}&limit=200`),
    ]).then(([n, w]) => {
      if (!alive) return;
      if (n.status !== 200) { setError(n.body.error ?? "node not found"); setCard(null); setWalk(null); return; }
      if (n.body.ambiguous) { setHits(n.body.hits ?? []); setCard(null); setWalk(null); setError(null); return; }
      setError(null); setCard(n.body); setWalk(w.status === 200 ? w.body : null);
    }).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [pd, focusRef, depth]);

  async function search(q: string) {
    if (!q.trim()) { setHits(null); return; }
    const { status, body } = await getJson<{ hits: Hit[]; error?: string }>(`/api/graph/find?${pd}&q=${encodeURIComponent(q.trim())}&limit=20`);
    if (status !== 200) { setError(body.error ?? "search failed"); return; }
    setError(null);
    if (body.hits.length === 1) { onFocus(body.hits[0]!.id); setHits(null); } else setHits(body.hits);
  }

  const lanes = useMemo(() => {
    if (!walk || !card) return { incoming: [] as Edge[], outgoing: [] as Edge[] };
    const isDimmed = (e: Edge) => dimmed.has(familyOf(e)) || (dimmed.has("runtime") && e.origin === "runtime");
    const incoming = walk.edges.filter((e) => e.to.id === card.id).map((e) => ({ ...e, dim: isDimmed(e) }));
    const outgoing = walk.edges.filter((e) => e.from.id === card.id).map((e) => ({ ...e, dim: isDimmed(e) }));
    return { incoming, outgoing };
  }, [walk, card, dimmed]);

  const toggle = (id: string) => setDimmed((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const parseAddr = (a: string) => parseInt(a.replace("$", ""), 16);

  // ---- render
  const W = 900, LANE = 280, ROW = 30, PAD = 12;
  const rows = Math.max(lanes.incoming.length, lanes.outgoing.length, 1);
  const H = Math.max(140, PAD * 2 + 30 + rows * ROW);

  const laneNode = (e: Edge & { dim?: boolean }, side: "in" | "out", i: number) => {
    const end = side === "in" ? e.from : e.to;
    const x = side === "in" ? PAD : W - PAD - LANE;
    const y = PAD + 30 + i * ROW;
    return (
      <g key={`${side}-${e.type}-${end.id}-${i}`} className={`flow-node-group graph-lane-node${e.dim ? " dimmed" : ""}${end.dangling ? " dangling" : ""}`} onClick={() => !end.dangling && onFocus(end.id)}>
        <rect className="flow-node-rect" x={x} y={y} width={LANE} height={ROW - 6} rx={4} />
        <text className="flow-node-kind" x={x + 6} y={y + 11}>{e.type}{e.origin === "runtime" ? " · runtime" : ""}</text>
        <text className="flow-node-title" x={x + 6} y={y + 21}>{end.address} {end.name ?? ""}{typeof e.evidence.instruction === "string" ? ` — ${String(e.evidence.instruction)}` : ""}{edgeArgsText(e)}</text>
        <line className="flow-edge-line" x1={side === "in" ? x + LANE : x} y1={y + (ROW - 6) / 2} x2={side === "in" ? W / 2 - 110 : W / 2 + 110} y2={H / 2} opacity={e.dim ? 0.15 : 1} />
      </g>
    );
  };

  return (
    <div className="graph-panel">
      <div className="graph-toolbar">
        <input className="graph-search" placeholder="Focus: $D018, CHROUT, a routine name, or an id" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(query); }} />
        <button type="button" onClick={() => void search(query)}>Find</button>
        <button type="button" onClick={() => { onFocus(null); setHits(null); }}>Overview</button>
        <label className="graph-depth">depth <select value={depth} onChange={(e) => setDepth(Number(e.target.value) === 2 ? 2 : 1)}><option value={1}>1</option><option value={2}>2</option></select></label>
        <div className="graph-chips">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`graph-chip${dimmed.has(f.id) ? " off" : ""}`} onClick={() => toggle(f.id)} title={f.types.length ? f.types.join(", ") : "no edges of this family yet"}>{f.label}</button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="graph-empty">
          <p>{error}</p>
          {next ? <p>Next: {next.join(" · ")}</p> : null}
        </div>
      ) : null}

      {hits ? (
        <ul className="graph-hits">
          {hits.map((h) => (
            <li key={h.id}><button type="button" onClick={() => { onFocus(h.id); setHits(null); }}>[{h.kind}] {h.address}{h.bank !== null ? ` bank:${h.bank}` : ""} {h.name ?? ""} <code>{h.id}</code></button></li>
          ))}
          {hits.length === 0 ? <li>no node matches</li> : null}
        </ul>
      ) : null}

      {!focusRef && overview ? (
        <div className="graph-overview">
          {overview.sections.map((s) => (
            <section key={s.id}>
              <h4>{s.label} — {s.count}</h4>
              <ul>{s.top.map((t) => <li key={t.id}><button type="button" onClick={() => onFocus(t.id)}>{t.count} × {t.name ?? t.id}</button></li>)}{s.top.length === 0 ? <li>(none)</li> : null}</ul>
            </section>
          ))}
        </div>
      ) : null}

      {card ? (
        <div className="graph-focus">
          <div className="graph-card">
            <div className="graph-card-head">
              <strong>{card.humanName ?? card.generatedLabel ?? card.id}</strong> <code>{card.id}</code>
              {card.humanName && card.generatedLabel ? <span className="graph-card-label"> (label {card.generatedLabel})</span> : null}
              {card.orphaned ? <span className="graph-flag">orphaned</span> : null}
              {card.dangling ? <span className="graph-flag">dangling</span> : null}
            </div>
            <div className="graph-card-meta">
              {card.kind} {card.range ?? card.address}{card.bank !== null ? ` · bank ${card.bank}` : ""}{card.owner ? ` · ${card.owner}` : ""}
              {card.subsystems.length ? ` · ${card.subsystems.join(", ")}` : ""}
              {" · "}{card.runtime.observed ? `observed in ${card.runtime.runs.length} run(s)` : "not observed in any trace run"}
            </div>
            {card.hardware.length ? <div className="graph-card-row">hardware: {card.hardware.join(", ")}</div> : null}
            {card.rom.length ? <div className="graph-card-row">rom: {card.rom.join(", ")}</div> : null}
            {card.zeroPage.length ? <div className="graph-card-row">zero page: {card.zeroPage.slice(0, 12).join(", ")}{card.zeroPage.length > 12 ? " …" : ""}</div> : null}
            {/* Spec 826 D7 — the computed signature; D8 — the human abi on its own row, never merged into it */}
            {card.signature && (card.signature.in.length || card.signature.out.length || card.signature.clobbers.length || card.signature.preserves.length || card.signature.stack !== "unknown" || card.signature.partial) ? (
              <div className="graph-card-row graph-card-signature">signature: {signatureText(card.signature)}{card.signature.partial ? <span className="graph-muted"> · partial: {card.signature.partial}</span> : null}</div>
            ) : null}
            {card.signature?.humanAbi ? <div className="graph-card-row graph-card-human-abi">human abi: {card.signature.humanAbi}</div> : null}
            {card.argsDomain && argsText(card.argsDomain) ? <div className="graph-card-row graph-card-args">args: {argsText(card.argsDomain)}</div> : null}
            {(() => {
              const jump = card.platform ? { reason: "a platform node — its writers and callers are the useful jump" } : listingJump(parseAddr(card.address));
              return "entityId" in jump
                ? <button type="button" className="graph-jump" onClick={() => onJumpToListing(jump.entityId)}>Open in Annotated Listing</button>
                : <span className="graph-card-row graph-muted">{jump.reason}</span>;
            })()}
            {(() => {
              // Spec 824.2 — jump INTO the source line: the owner's ASM, opened at the node's address
              const src = card.platform ? { reason: "a platform node has no project source" } : sourceJump(card.owner);
              return "sources" in src
                ? <button type="button" className="graph-jump graph-jump-source" onClick={() => onJumpToSource(src.title, src.sources, parseAddr(card.address))}>Open in source</button>
                : <span className="graph-card-row graph-muted">{src.reason}</span>;
            })()}
          </div>
          <svg className="flow-svg graph-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`neighbourhood of ${card.id}`}>
            <text className="flow-lane-title" x={PAD} y={PAD + 14}>incoming ({lanes.incoming.length})</text>
            <text className="flow-lane-title" x={W - PAD - LANE} y={PAD + 14}>outgoing ({lanes.outgoing.length})</text>
            <g className="flow-node-group active">
              <rect className="flow-node-rect" x={W / 2 - 110} y={H / 2 - 16} width={220} height={32} rx={5} />
              <text className="flow-node-kind" x={W / 2 - 104} y={H / 2 - 3}>{card.kind}{card.bank !== null ? ` · bank ${card.bank}` : ""}</text>
              <text className="flow-node-title" x={W / 2 - 104} y={H / 2 + 10}>{card.address} {card.humanName ?? card.generatedLabel ?? ""}</text>
            </g>
            {lanes.incoming.map((e, i) => laneNode(e, "in", i))}
            {lanes.outgoing.map((e, i) => laneNode(e, "out", i))}
          </svg>
          {walk?.truncated ? <p className="graph-muted">{walk.total - walk.edges.length} more edges not shown</p> : null}
        </div>
      ) : null}
    </div>
  );
}
