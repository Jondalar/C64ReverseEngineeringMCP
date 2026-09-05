# Spec 824 — Graph UI

**Status:** PROPOSED (2026-09-05)
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Graph UI" — GitNexus-like
exploration, the eight node filters, click-to-listing. §"Phase 5 — Cross-Project RE" is
**named** here as what comes after, and not designed.
**Anchor:** Spec 818 (the library the routes and Spec 823's tools both wrap) · Spec 823
(the formatter and the JSON shape) · `DOCTRINE.md` rule 6 (API first) · Spec 757 / 724B
(one UI) · memory "One UI shell — integrate, not delete"
**Touches:** `src/workspace-ui/server.ts` (routes) · `ui/src/App.tsx` (tab, jump) ·
`ui/src/components/GraphPanel.tsx` (new) · `ui/src/types.ts` · `ui/src/index.css` ·
`scripts/smoke-824-graph-routes.mjs` (new) · `scripts/smoke-824-graph-ui.mjs` (new)

## 1. What exists today, measured

**One shell, one server.** `src/workspace-ui/server.ts` is a raw `node:http` server
(`createServer`, `:298`) dispatching on `requestUrl.pathname` in an if-chain (`:311`
onward): 49 distinct `/api/*` paths — 48 exact plus the `/api/marks/` prefix. Errors are
`{ error, projectDir }` with a 4xx/5xx (`:346-350`); the project comes from `?projectDir=`
or the server's `--project`, never a silent cwd (the 724A resolver, `:337-339`). Vite
proxies `/api` to `:4310` (`ui/vite.config.ts:59-61`). Spec 757 retired the second entry:
`/v3.html` is 404 and `smoke-product-ui.mjs:80-81` asserts it.

**Routes already wrap the tool's library.** The trace routes read "the same info /
top-pcs / events readers the MCP tools expose" (`server.ts:352-364`, Spec 724B/802). That
is the shape 824 repeats: a route is the tool's library call in an HTTP envelope.

**A graph is already drawn, by hand.** `FlowPanel` (`ui/src/components/workspace-panels.tsx:1110`)
renders `views/flow-graph.json` as inline SVG: lanes by node kind (`modeLayout`,
`:1150-1200`), straight edges with one arrow marker (`:1256-1290`), hover/active node
states in `ui/src/index.css:1258-1311`. Its data is `buildFlowGraphView`
(`view-builders.ts:2475`): entities, relations, flows — the knowledge layer. It cannot draw
`UpdateScreen CALLS CopyCharset` because no view carries a call.

**No graph library.** Root `package.json` dependencies: `react`, `react-dom`, `ws`, `zod`,
`pngjs`, `@duckdb/node-api`, the MCP SDK. There is no `ui/package.json`.

**Tabs and selection.** `allTabs` (`App.tsx:146-160`): 13 tabs with `phases[]`;
`cockpitToolAvailable` (`:200-208`) hides a tab whose view is empty. Selection is
entity-keyed: `handleSelectEntity(entityId, tabId)` (`:5576-5583`) sets `selectedEntityId`
and `tabSelections[tab]`. `ListingPanel` (`:3805-3868`) is a table of
`views.annotatedListing.entries` — `{ id, start, end, title, kind, entityId?, findingIds,
comment?, confidence, status }` (`ui/src/types.ts:469-481`); a row highlights when
`entry.entityId === selectedEntityId` (`:3856`) and **nothing scrolls it into view**.
`entityId` is optional: an entry without one cannot be selected at all.

**The raw source has no addresses.** `AsmView` fetches `/api/document?path=` and renders
one row per text line by index (`AsmView.tsx:82, 144-155`). No address→line map exists.

**Smoke precedents.** `smoke-product-ui.mjs` boots the workspace on a port and asserts
bundle markers + `/api/*`; `smoke-bug019-best-asm-version.mjs` asserts at source level.
`fixtures/ui-smoke-project` exists (`npm run ui:fixture`).

## 2. The gap

After 823 the LLM asks "who writes `$D018`" in one call. The human co-driving the same
project has the Flow Graph (knowledge-layer relations) and the listing (a table): no
neighbourhood of a routine, no hardware or runtime edge, no generated-vs-human name. The
swimlane doctrine has the two looking at the same facts; here they do not.

## 3. Decisions

**D1 — Routes first, five of them, smoke-covered before a line of TSX.** Rule 6.

| route | args | wraps |
|---|---|---|
| `GET /api/graph/find` | `q`, `kind?`, `origin?`, `bank?`, `limit?` | `find` (+ annotation text) |
| `GET /api/graph/node` | `ref`, `bank?` | the node card |
| `GET /api/graph/edges` | `ref`, `direction?`, `kind?`, `origin?`, `depth?`, `limit?`, `bank?` | the edge walk |
| `GET /api/graph/path` | `from`, `to`, `via?`, `max_depth?`, `bank?` | `path` |
| `GET /api/graph/overview` | `focus?`, `bank?` | the overview aggregate |

One route per 823 tool, the same argument names, and the body **is** the tool's JSON
block — 823 D7's formatter, called once more. `?projectDir=` through the 724A resolver; a
bad ref is `400 { error }`, a missing graph `404 { error, next }` with `next` naming the
product step (`analyze_prg` / `project_inventory_sync`). GET only.

**D2 — One shell.** `{ id: "graph", label: "Graph", phases: ["discovery", "re"] }` in
`allTabs`, next to Flow Graph; `cockpitToolAvailable` gains `case "graph"`: true when the
overview reports any node. No new HTML entry, no second bundle; `smoke-product-ui.mjs`
check 9 (`/v3.html` → 404) stays as the tripwire. The Flow Graph tab is **not** replaced:
it draws flows and relations, which the graph does not carry; they are siblings until
818's model absorbs flows, which is not this spec.

**D3 — A neighbourhood, not the graph.** One focus node and its 1- or 2-hop
surroundings, capped at 60 rendered nodes with "+n more" per edge group; a whole project
is ~20 k nodes and unreadable at any zoom, and the draft's own picture is one focus node
with three edge groups. The renderer is `FlowPanel`'s: inline SVG, lanes, straight edges,
the existing `.flow-node-*` / `.flow-edge-line` classes with per-kind modifiers. **No new
dependency**: at 60 nodes a force layout buys nothing a four-lane layout (callers · focus
· callees · memory/hardware/ROM targets) does not, and d3-force (~30 kB) or cytoscape
(~400 kB) is cost without measured benefit. A whole-project explorer is a new spec.

**D4 — The eight filters, mapped.** Chips above the canvas, each a predicate on the 823
JSON the routes already return — no second classification in the browser:

| chip | shows |
|---|---|
| Code | nodes of kind `routine`, `label`, `data_block` |
| Memory | `address`, `region`, ZP nodes |
| Hardware | `register` nodes and `uses_hardware` edges |
| ROM | `rom_routine` nodes and `calls_rom` edges |
| Runtime | edges with `origin: runtime` (dashed) |
| Annotations | nodes with a human annotation (accent border; human name shown **beside** the generated label, never instead of it) |
| Bank | a **selector**, not a toggle — the draft's rule that bank context is never lost; default = the focus node's bank |
| Subsystem | colour by membership; a subsystem node as focus draws its `contains` set |

Filtered-out elements dim like `.memory-cell.dimmed` (`index.css:1449`); they are not
removed, so the neighbourhood keeps its shape.

**D5 — Click node → jump, by the mechanism that exists.** Three cases:

1. The node's range lies inside a listing entry with an `entityId` →
   `handleSelectEntity(entityId, "listing")` + `setActiveTab("listing")`, and
   `ListingPanel` gains the one thing it lacks: a `useEffect` calling `scrollIntoView` on
   the `active-row` when `selectedEntityId` changes. That is the whole listing change.
2. No entity (a raw address, a register, a ROM routine) → the node stays the focus; the
   useful jump for a register/ROM node is its writers/callers, already on screen. A
   listing entry without `entityId` is a listing defect (`types.ts:476`), reported in the
   card as "not in the listing", not papered over with a synthetic selection.
3. Jump **into the source line** in `AsmView` is **824.2**: it needs an address→line map
   nothing provides today (`AsmView.tsx:144-155` renders by index). Named, not built.

Selection is bidirectional through the same state: a `selectedEntityId` set elsewhere
refocuses the graph when the tab opens (`tabSelections`, `App.tsx:5579`).

**D6 — Read-only.** Naming a routine or assigning a subsystem goes through `save_*`,
which 818 ingests as human origin; a write from the panel would be a second path to the
same record. `/api/annotations/save` is the precedent for adding one later, deliberately.

**D7 — Not in the snapshot.** `/api/workspace` is unchanged; the graph is queried per
focus, not shipped whole — 20 k nodes per workspace load for a panel that shows 60.

**D8 — Phase 5 is after this, and not here.** Cross-project questions ("which projects
write `$D018` from an IRQ") become *possible* once 817's shared platform ids make a join
between project graphs meaningful; they need a project selector, two graphs open at once
and the pattern layer the draft only sketches. None of it is designed here. What 824 must
not do is close the door: node ids stay the library's opaque strings (823 D3), so a later
cross-project view addresses `VIC.$D018` the same way in every project.

## 4. Panel spec

```
┌ Graph ──────────────────────────────────────────────────────────────────────┐
│ [find: ____________]  Code Memory Hardware ROM Runtime Annotations Subsystem│
│ bank: [07 ▾]   hops: (1) 2                                                  │
├────────────────────────────────────────┬────────────────────────────────────┤
│ callers     │ focus        │ callees   │ $8430 DrawInventory   (human)      │
│ $8102 ▸     │ $8430        │ $8600 ▸   │ generated: sub_8430 · UI · bank 07 │
│ $9F40 ▸     │ DrawInventory│ CHROUT ◆  │ calls 2 · called-by 2 · writes 1   │
│             │              │ VIC.$D018■│ runtime: executed 41× in run r3    │
│  — — runtime (r3)   —— static   ══ human│ annotations: F-0412, F-0417        │
│                                        │ [Open in listing]  [Path to…]      │
└────────────────────────────────────────┴────────────────────────────────────┘
```

- **Search** → `/api/graph/find`; one hit focuses immediately, several list.
- **Canvas** → `/api/graph/edges?ref=&direction=both&depth=<hops>`; lanes per D3; edge
  kind by colour class, origin by stroke (static solid, runtime dashed, human accent);
  the edge's evidence (`$8421 STA $D018`) in its tooltip.
- **Card** → `/api/graph/node`; generated label and human name on separate lines; the
  runtime line only when observations exist; finding ids link into Triage.
- **Path to…** → `/api/graph/path` from the focus to a typed ref, drawn as a highlighted
  chain over the current lanes.
- **Empty state** — "Run `analyze_prg` on a payload, then `project_inventory_sync`": a
  concrete next action (Spec 773's cockpit rule). Esc clears focus. Static and recorded
  facts only; a paused session's PC is Spec 767's business.

## 5. Gates

**`scripts/smoke-824-graph-routes.mjs`** (`npm run smoke:824-routes`) — first, green
before the panel exists. Boots the workspace on its own port (precedent
`smoke-product-ui.mjs:56-64`, port 4327) on a tmp copy of the 823 fixture (the synthesized
PRG with ground truth, analysed), then: each route returns 200 and the body equals
`c64re graph <verb> --json` on the same fixture — one formatter, three consumers;
`edges?ref=$D018&direction=in&kind=writes` is exactly the fixture's writer; a bad ref →
`400 { error }`; no graph → `404 { error, next }` with `next` naming a product tool, never
one on the `e2e-mcp-no-internal-recommendations` list; `?projectDir=` honoured, fallback
to `--project`, never cwd; POST → 405.

**`scripts/smoke-824-graph-ui.mjs`** (`npm run smoke:824`, after `ui:build`) — second.
Bundle-level (`smoke-product-ui.mjs:24-35` pattern): `wb-graph` and `graph-svg` markers in
`ui/dist/assets/index-*.js`; `/v3.html` still 404. Source-level (`smoke-bug019` pattern):
`allTabs` carries `id: "graph"`; `GraphPanel.tsx` fetches only `/api/graph/*`; the jump
handler calls `handleSelectEntity(…, "listing")`; `ListingPanel` contains `scrollIntoView`;
`package.json` dependencies equal the frozen list in §1 (D3 — the same shape as check 4's
"no global resets").

**`npm run smoke:product-ui`** stays green — the one-UI tripwire.

## 6. Acceptance

- Five `/api/graph/*` routes, `smoke:824-routes` green, before any TSX is committed.
- A `Graph` tab in the existing shell; `smoke:824` and `smoke:product-ui` green.
- Focusing a routine shows callers, callees, memory/hardware/ROM targets and runtime edges
  distinctly; the eight filters and the bank selector work on the 823 JSON alone.
- Clicking a routine node opens the Listing tab with that entry selected **and scrolled
  into view**.
- The generated label and the human name are never merged into one string on screen.
- `git diff package.json` shows no dependency change.

## 7. Non-goals

- No whole-project rendering, no force layout, no graph library (D3).
- No writes from the panel (D6); no `AsmView` line jump (824.2).
- No new view in `views/`, no change to `/api/workspace` (D7).
- No cross-project view (D8, Phase 5); no live-session coupling (Spec 767).
- No change to Flow Graph, Memory Map or the listing beyond `scrollIntoView`.

## 8. Open questions

- **OQ1 — Two-hop lanes.** Callers-of-callers need a fifth lane or a collapsed group;
  decided on a real project. Ships with hops = 1, toggle present.
- **OQ2 — Fan-in monsters.** `CHROUT` with hundreds of callers: the card pages, the
  canvas shows the first `limit` by the library's ranking — 823 OQ2 decides what "first" is.
- **OQ3 — A cockpit number.** "graph: 412 routines, 37 unknown indirect targets" on the
  Overview costs one `/api/graph/overview` call on load versus D7. Try it, measure it.
- **OQ4 — Where the address→line map lives (824.2).** Listing route parsing the
  disassembler's address column, or a pipeline side file — belongs with 720.
