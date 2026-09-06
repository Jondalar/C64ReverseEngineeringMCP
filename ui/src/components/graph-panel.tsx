// Spec 824 — the Graph tab. Spec 825 turns it into an EXPLORER: the whole
// scope, fetched once as `/api/graph/subgraph`, drawn by the one sigma canvas,
// projected four ways (Force · Layers · Radial · Address). The lane SVG is
// retired — it failed at 80 edges, measured (825 §1), and Radial at depth 1 is
// the same neighbourhood, readable.
//
// What 824 built stays exactly as it was: the card, the eight edge-family
// chips, the search, the depth control and BOTH jumps (Annotated Listing and
// source). 825 adds the view switcher, the scope selector, the node-kind
// lenses, the community legend and the docked source pane (D8).
//
// Reads the six /api/graph/* routes (one per 823 tool, plus 825's bulk
// projection) and nothing else; no graph logic lives here. Read-only (D9):
// naming a node or a community goes through save_* / assign-subsystem.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AsmView, type AsmViewSource } from "./AsmView.js";
import { DEFAULT_HIDDEN_EDGE_TYPES, DEFAULT_HIDDEN_KINDS, GraphCanvas, type CanvasEdge, type CanvasNode } from "./graph-canvas.js";
import type { CommunityGroup } from "../lib/graph-communities.js";
import type { ViewId } from "../lib/graph-layouts.js";

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
/** Spec 825 D1 — the bulk projection: one body, every view a projection of it */
type SubgraphNode = { id: string; kind: string; address: string; end: string | null; bank: number | null; owner: string | null; label: string | null; name: string | null; layers: string[]; platform: boolean; dangling: boolean; degree: number };
type SubgraphEdge = { from: string; to: string; type: string; origin: string; layer: string; confidence: string; n: number };
type Subgraph = {
  scope: string; nodes: SubgraphNode[]; edges: SubgraphEdge[];
  subsystems: Array<{ id: string; name: string | null; members: number }>;
  truncated: boolean; next: string[]; counts: { nodes: number; edges: number; rows: number };
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

/** the CALLS suffix: static `A=#$01 X←$27E1`, runtime `A∈{$01,$02}` */
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

/** Spec 824 D5 — the eight edge-family chips. 825 keeps them exactly; the type→family map lives in the canvas. */
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

const VIEWS: Array<{ id: ViewId; label: string; hint: string }> = [
  { id: "force", label: "Force", hint: "ForceAtlas2 in its worker, seeded so two runs draw the same picture" },
  { id: "layers", label: "Layers", hint: "entries · routines · labels · addresses · zero page · I/O · ROM, calls reading downward" },
  { id: "radial", label: "Radial", hint: "rings by hop distance from the focus — depth 1 is 824's neighbourhood" },
  { id: "address", label: "Address", hint: "x = $0000–$FFFF, one lane per bank" },
];

const parseAddr = (a: string) => parseInt(a.replace("$", ""), 16);

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
  const [depth, setDepth] = useState<number>(1);
  // ---- 825
  const [view, setView] = useState<ViewId>("force");
  const [scope, setScope] = useState<string>("all");
  const [sub, setSub] = useState<Subgraph | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set(DEFAULT_HIDDEN_KINDS));
  const [bank, setBank] = useState<number | null>(null);
  const [origin, setOrigin] = useState<string>("any");
  const [groups, setGroups] = useState<CommunityGroup[]>([]);
  const [modularity, setModularity] = useState<number | null>(null);
  const [isolate, setIsolate] = useState<string | null>(null);
  const [docked, setDocked] = useState<{ title: string; sources: AsmViewSource[]; address: number } | null>(null);
  /** D7 — one fetch per (projectDir, scope), kept for the session */
  const cache = useRef<Map<string, Subgraph>>(new Map());
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

  // Spec 825 D7 — the bulk projection, once per (projectDir, scope)
  useEffect(() => {
    let alive = true;
    const key = `${projectDir}|${scope}|${depth}`;
    const hit = cache.current.get(key);
    if (hit) { setSub(hit); return; }
    setSubLoading(true);
    getJson<Subgraph & { error?: string; next?: string[] }>(`/api/graph/subgraph?${pd}&scope=${encodeURIComponent(scope)}&depth=${depth}`)
      .then(({ status, body }) => {
        if (!alive) return;
        setSubLoading(false);
        if (status !== 200) { setError(body.error ?? "subgraph unavailable"); setNext(body.next ?? null); setSub(null); return; }
        cache.current.set(key, body);
        setSub(body);
      })
      .catch((e) => { if (alive) { setSubLoading(false); setError(String(e)); } });
    return () => { alive = false; };
  }, [pd, projectDir, scope, depth]);

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

  // ⌘K focuses the search box (D6)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); document.querySelector<HTMLInputElement>(".graph-search")?.focus(); }
      else if (e.key === "Escape") { onFocus(null); setIsolate(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFocus]);

  const toggle = (id: string) => setDimmed((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleKind = (k: string) => setHiddenKinds((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // ---- the in-memory model, built ONCE per body. Every view is a projection of it.
  const canvasNodes = useMemo<CanvasNode[]>(
    () => (sub?.nodes ?? []).map((n) => ({ ...n, address: parseAddr(n.address), end: n.end ? parseAddr(n.end) : null })),
    [sub],
  );
  const canvasEdges = useMemo<CanvasEdge[]>(() => (sub?.edges ?? []) as CanvasEdge[], [sub]);

  const lens = useMemo(() => ({
    hiddenKinds,
    hiddenFamilies: dimmed,
    hiddenEdgeTypes: new Set(DEFAULT_HIDDEN_EDGE_TYPES),
    origin,
    bank,
  }), [hiddenKinds, dimmed, origin, bank]);

  const onCommunities = useCallback((g: CommunityGroup[], m: number | null) => { setGroups(g); setModularity(m); }, []);

  const kinds = useMemo(() => [...new Set((sub?.nodes ?? []).map((n) => n.kind))].sort(), [sub]);
  const owners = useMemo(() => [...new Set((sub?.nodes ?? []).map((n) => n.owner).filter((o): o is string => Boolean(o)))].sort(), [sub]);
  const banks = useMemo(() => [...new Set((sub?.nodes ?? []).map((n) => n.bank).filter((b): b is number => b !== null))].sort((a, b) => a - b), [sub]);

  const humanGroups = groups.filter((g) => g.kind === "human");
  const computedGroups = groups.filter((g) => g.kind === "computed").slice(0, 12);

  const dockSource = () => {
    if (!card) return;
    const src = card.platform ? { reason: "a platform node has no project source" } : sourceJump(card.owner);
    if ("sources" in src) setDocked({ title: src.title, sources: src.sources, address: parseAddr(card.address) });
  };

  return (
    <div className={`graph-panel${docked ? " docked" : ""}`}>
      <div className="graph-toolbar">
        <input className="graph-search" placeholder="⌘K — $D018, CHROUT, a routine name, or an id" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(query); }} />
        <button type="button" onClick={() => void search(query)}>Find</button>
        <button type="button" onClick={() => { onFocus(null); setHits(null); }}>Overview</button>
        <label className="graph-depth">depth <select value={depth} onChange={(e) => setDepth(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label>
        <div className="graph-views">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={`graph-view${view === v.id ? " on" : ""}`} title={v.hint} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        <label className="graph-depth">scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">all</option>
            {focusRef ? <option value={`focus:${focusRef}`}>focus: {focusRef}</option> : null}
            {owners.map((o) => <option key={o} value={`owner:${o}`}>owner: {o}</option>)}
            {banks.map((b) => <option key={b} value={`bank:${b}`}>bank: {b}</option>)}
            {(sub?.subsystems ?? []).map((s) => <option key={s.id} value={`subsystem:${s.id}`}>subsystem: {s.name ?? s.id}</option>)}
          </select>
        </label>
        <label className="graph-depth">bank
          <select value={bank === null ? "" : String(bank)} onChange={(e) => setBank(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">all</option>
            {banks.map((b) => <option key={b} value={b}>{b.toString(16).padStart(2, "0")}</option>)}
          </select>
        </label>
        <label className="graph-depth">origin
          <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
            <option value="any">any</option>
            <option value="static">static</option>
            <option value="runtime">runtime</option>
            <option value="human">human</option>
          </select>
        </label>
        <div className="graph-chips">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`graph-chip${dimmed.has(f.id) ? " off" : ""}`} onClick={() => toggle(f.id)} title={f.types.length ? f.types.join(", ") : "no edges of this family yet"}>{f.label}</button>
          ))}
        </div>
      </div>

      {kinds.length ? (
        <div className="graph-chips graph-kind-chips">
          <span className="graph-muted">kinds:</span>
          {kinds.map((k) => (
            <button key={k} type="button" className={`graph-chip${hiddenKinds.has(k) ? " off" : ""}`} onClick={() => toggleKind(k)} title={`${(sub?.nodes ?? []).filter((n) => n.kind === k).length} nodes`}>{k}</button>
          ))}
        </div>
      ) : null}

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

      {/* Spec 825 D7 — the threshold, in our words, with the scopes as buttons */}
      {sub?.truncated ? (
        <div className="graph-empty">
          <p>{sub.counts.nodes} nodes — too many to draw at once. Pick a bank or an owner scope:</p>
          <div className="graph-chips">
            {sub.next.map((s) => <button key={s} type="button" className="graph-chip" onClick={() => setScope(s)}>{s}</button>)}
          </div>
        </div>
      ) : null}

      <div className="graph-explorer">
        {sub && !sub.truncated ? (
          <GraphCanvas
            nodes={canvasNodes}
            edges={canvasEdges}
            view={view}
            focus={focusRef}
            lens={lens}
            onSelect={(id) => onFocus(id)}
            onCommunities={onCommunities}
            isolate={isolate}
          />
        ) : (
          <div className="graph-empty graph-canvas-placeholder">{subLoading ? "loading the scope…" : error ? "" : "no graph in this scope yet"}</div>
        )}

        <aside className="graph-inspector">
          {card ? (
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
              {walk ? <div className="graph-card-row">in {walk.edges.filter((e) => e.to.id === card.id).length} · out {walk.edges.filter((e) => e.from.id === card.id).length}{walk.truncated ? ` · ${walk.total - walk.edges.length} more` : ""}{walk.edges.filter((e) => e.type === "CALLS").slice(0, 1).map(edgeArgsText).join("")}</div> : null}
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
                  ? <>
                      <button type="button" className="graph-jump graph-jump-source" onClick={() => onJumpToSource(src.title, src.sources, parseAddr(card.address))}>Open in source</button>
                      {/* Spec 825 D8 — the same AsmView, docked beside the canvas instead of over the tab */}
                      <button type="button" className="graph-jump graph-jump-dock" onClick={dockSource}>Dock source ▸</button>
                    </>
                  : <span className="graph-card-row graph-muted">{src.reason}</span>;
              })()}
            </div>
          ) : overview ? (
            <div className="graph-overview">
              {overview.sections.map((s) => (
                <section key={s.id}>
                  <h4>{s.label} — {s.count}</h4>
                  <ul>{s.top.map((t) => <li key={t.id}><button type="button" onClick={() => onFocus(t.id)}>{t.count} × {t.name ?? t.id}</button></li>)}{s.top.length === 0 ? <li>(none)</li> : null}</ul>
                </section>
              ))}
            </div>
          ) : null}

          {/* Spec 825 D4 — the community legend: human subsystems first, computed after, and the honest empty list when nobody has used assign-subsystem */}
          {sub && !sub.truncated ? (
            <div className="graph-legend">
              <h4>communities{modularity !== null ? <span className="graph-muted"> · modularity {modularity.toFixed(3)}</span> : null}</h4>
              <div className="graph-legend-group">
                <span className="graph-muted">human subsystems:</span>
                {humanGroups.length === 0 ? <span className="graph-muted"> (none yet — assign-subsystem is the door)</span> : null}
                <ul>
                  {humanGroups.map((g) => (
                    <li key={g.id}><button type="button" className={isolate === g.id ? "on" : ""} onClick={() => setIsolate(isolate === g.id ? null : g.id)}>{g.label} · {g.size}</button></li>
                  ))}
                </ul>
              </div>
              <div className="graph-legend-group">
                <span className="graph-muted">computed:</span>
                <ul>
                  {computedGroups.map((g) => (
                    <li key={g.id}><button type="button" className={isolate === g.id ? "on" : ""} onClick={() => setIsolate(isolate === g.id ? null : g.id)}>{g.label}{g.top.length ? ` · top: ${g.top.join(", ")}` : ""}</button></li>
                  ))}
                  {computedGroups.length === 0 ? <li className="graph-muted">(nothing to partition)</li> : null}
                </ul>
              </div>
              <p className="graph-muted">{sub.counts.nodes} nodes · {sub.counts.edges} edges ({sub.counts.rows} rows) · scope {sub.scope}</p>
            </div>
          ) : null}

          {docked ? (
            <div className="graph-dock">
              <AsmView title={docked.title} projectDir={projectDir} sources={docked.sources} jumpToAddress={docked.address} onClose={() => setDocked(null)} />
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
