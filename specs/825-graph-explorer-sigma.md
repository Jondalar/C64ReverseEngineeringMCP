# Spec 825 — Graph explorer: the whole project, four projections, sigma.js

**Status:** BUILT 2026-09-06 on branch `spec-825-graph-explorer` — gates `smoke:825-routes` 32/0, `smoke:825` 59/0; `smoke:824` 16/0, `smoke:824-2` 24/0, `smoke:824-routes` 11/0, `e2e:823` 28/0, `smoke:product-ui` 14/0 (§9) — written after looking at both UIs side by side on
Wasteland_EF (the 824 tab) and on this repo (GitNexus `serve`, the C64RE index)
**Origin:** Spec 824 D3 — "A whole-project explorer is a new spec." This is it. The
question that produced it: *what is missing to build a UI as good as GitNexus's, with
its three visualised representations?*
**Anchor:** Spec 818 (ids, banking in identity) · Spec 819/820/821 (the edges) · Spec 822
(the human layer, `assign-subsystem`) · Spec 823 (one formatter, three consumers) · Spec
824 (routes first, one shell, read-only, jumps) · `DOCTRINE.md` rule 6 (API first)
**Touches:** `src/knowledge-graph/cards.ts` (+`subgraph`) · `src/knowledge-graph/format.ts`
(+`formatSubgraph`) · `src/knowledge-graph/cli.ts` (+verb `subgraph`) ·
`src/workspace-ui/server.ts` (+`GET /api/graph/subgraph`) · `ui/src/components/graph-panel.tsx`
(rewired) · `ui/src/components/graph-canvas.tsx` (new, the one sigma wrapper) ·
`ui/src/lib/graph-layouts.ts` (new, pure) · `ui/src/lib/graph-communities.ts` (new, pure) ·
`ui/src/index.css` · `package.json` (five dependencies, pinned) ·
`scripts/smoke-824-graph-ui.mjs` (amended: six routes, the frozen list grows by exactly
these) · `scripts/smoke-825-subgraph-route.mjs` (new) · `scripts/smoke-825-graph-explorer.mjs`
(new) · `scripts/measure-825-explorer.mjs` (new)

## 1. What exists today, measured

**The 824 tab, on Wasteland_EF (2026-09-06).** The overview is usable: 520 entry points,
13 banking sites, 55 hardware-register users, 97 KERNAL dependencies, 229 zero-page
addresses, hottest first, every row a click to focus. The neighbourhood is not: focusing
`fastload_main` (`…:ram/reloc_fc00:routine:ff00`) draws **1 incoming and 80 outgoing**
edges as one SVG with 80 rows of 30 px in a 900-unit viewBox scaled to the panel — text
below 4 px, no zoom, no pan, the only readable thing on screen is the card above it. 824
D3 capped the lanes at 60 rendered nodes and said "a whole project is unreadable at any
zoom"; the first real routine broke the cap and the lanes were unreadable **below** it.
The four-lane layout was the wrong bet for this fan-out, and that is measured now, not
argued.

**The graph, on Wasteland_EF.** `knowledge/graph.sqlite` today:

| nodes (generated + human) | | edges | |
|---|---|---|---|
| entry 2 684 | segment 1 565 + 238 | USES_ZP 4 409 | CONTAINS 2 071 + 128 imported |
| label 1 837 + 1 341 | routine 1 054 + 317 | CALLS 3 020 + 5 | READS_INDIRECT 751 |
| addr 1 575 + 1 | payload 185 + 11 | WRITES 2 741 | JUMPS_TO 518 |
| chip 128 · bank 64 | data_block 2 · stage 2 · region 1 | READS 2 528 + 3 | CALLS_ROM 328 |
| | | MAPS_TO 2 457 | WRITES_INDIRECT 257 |
| | | BRANCHES_TO 2 376 | REFERENCES_DATA 174 + 1 · USES_HARDWARE 130 |

**11 005 nodes, 21 910 edges.** Subsystem nodes: **0**. `BELONGS_TO`: **0**. The 818 door
`assign-subsystem` exists and nobody has walked through it, so the graph has no
community axis of its own yet. Platform ids (`c64:zp:0001`, `c64:io:dd00`, `c64:rom:ffd2`)
are edge endpoints **without a row** in the project store — `Graph.resolve` answers them
from the platform KB (`ResolvedNode.platform`). Any bulk export has to synthesise them or
ship dangling edges.

**GitNexus, `gitnexus serve` on this repo.** 24 440 nodes / 42 980 edges, downloaded whole
(2.9 MB) after a "graph skipped to keep the browser responsive — Load graph anyway"
threshold. Renderer: **sigma.js 3 on graphology** — seven stacked canvases
(`sigma-edges`, `-edgeLabels`, `-nodes`, `-labels`, `-hovers`, `-hoverNodes`, `-mouse`),
WebGL. Three "Graph view modes", all projections of the one loaded graph: **Force** (a
force layout running in a worker, "Layout optimizing…", Stop / Run again; colour =
community), **Sequential** (nodes banded by type top to bottom — folder, file, class,
function — x spread within the band; edges read downward), **Radial** (concentric rings by
type). Around them: node-type toggles (13) and edge-type toggles, ⌘K search that selects
and centres, "Focus on selected node" that dims everything outside the neighbourhood, a
docked **Code Inspector** showing the selected symbol's source, a file explorer, a chat.
The thing to copy is not the look; it is that one in-memory graph feeds every view and a
filter is a lens over it, never a re-fetch.

**What we already have that GitNexus needs a chat for.** ⌘K = `/api/graph/find`; the code
inspector = `AsmView` with `jumpToAddress` (824.2); the selection bridge = `handleSelectEntity`
(824 D5.1). The card, the jumps and the routes stay. What is missing is a bulk projection
of the graph and a renderer that survives 80 edges.

**Dependencies.** Root `package.json` runtime: `react`, `react-dom`, `ws`, `zod`, `pngjs`,
`@duckdb/node-api`, the MCP SDK. No `ui/package.json`; vite builds from the root tree and
code-splits dynamic `import()`s into their own chunks (`ui/vite.config.ts`, default
rollup behaviour). `smoke-824-graph-ui.mjs` line 38–39 asserts the list is frozen and
contains no graph-rendering package — the tripwire this spec deliberately moves.

On npm today (all MIT): `sigma` 3.0.3, `graphology` 0.26.0,
`graphology-layout-forceatlas2` 0.10.1 (ships a worker), `graphology-communities-louvain`
2.0.2, `graphology-layout` 0.6.1 (circular seed), `graphology-types` 0.24.8 (types only).

## 2. The gap

The LLM sees the project one card at a time and that is right for it. The human co-driving
sees the same one card, and the picture around it is unreadable the moment a routine has
real fan-out. There is no view in which "this is the loader, this is the game, this is
the intro, and these six routines are the only ones that touch `$DD00`" is visible at
once — the question a person asks before choosing where to read next. GitNexus answers
that question in three layouts; C64RE has the data to answer it in four, because it has
one axis GitNexus does not have: the address.

## 3. Decisions

**D1 — One bulk route, one CLI verb, one formatter, no sixth MCP tool.**
`GET /api/graph/subgraph` and `c64re graph subgraph --json`, the body byte-identical
(823 D7, once more). 823 stays five tools by design: an LLM does not want 11 000 nodes.

| arg | meaning |
|---|---|
| `scope` | `all` (default) · `owner:<analysis stem>` · `bank:<n>` · `subsystem:<id>` · `focus:<ref>` |
| `depth` | with `focus:` — BFS hops, 1–4, default 2 |
| `kinds` | comma list of node kinds to include; default all |
| `origin` | `static` · `runtime` · `human` · `any` (default) — edge origin |
| `bank` | 824's bank selector, forwarded to `resolveRef` |

Body:

```
{ scope, nodes: [{ id, kind, address, end, bank, owner, label, name, layers,
                   platform, dangling, degree }],
  edges: [{ from, to, type, origin, layer, confidence, n }],
  subsystems: [{ id, name, members: n }],
  truncated: bool, counts: { nodes, edges, rows } }
```

- `label` is the generated label, `name` the human name — two fields, never merged
  (824 acceptance holds).
- Edges are **collapsed** per `(from, to, type, origin, layer)` with `n` = store rows;
  evidence is not shipped (the `edges` route carries it per edge when a node is focused).
  `counts.rows` equals the store's row count for the scope so the gate can reconcile.
- Every endpoint without a store row is **synthesised**: a platform id from the platform
  KB (`platform: true`, kind `zp` | `io` | `rom`), anything else `dangling: true`. No edge
  points at a node that is not in `nodes`.
- Nodes and edges sorted by id — the body hashes stably; a re-seed that is content-identical
  (817/818 gates) yields a byte-identical subgraph.
- `truncated` at 50 000 nodes with `next` naming the scopes that fit (GitNexus's threshold,
  our wording). Wasteland at 11 k never trips it.
- 404 / 400 / 405 rules exactly as 824 D1; `smoke-824-graph-ui`'s "no route outside the
  five" becomes six.

**D2 — sigma.js + graphology, pinned, lazily loaded. This revises 824 D3.** 824 D3 declined
a library at 60 nodes; 825 is 11 000 nodes, and the lane SVG failed at 80 (§1). Five
runtime dependencies and one types package, pinned exactly: `sigma`, `graphology`,
`graphology-layout`, `graphology-layout-forceatlas2`, `graphology-communities-louvain`,
`graphology-types` (dev). **Not** `@react-sigma/core`: sigma is imperative and one
component owns one `Sigma` instance for its lifetime (`useEffect` create / `kill`); a
React binding is a second lifecycle for nothing. No sigma node-program packages
(`@sigma/node-border`, `@sigma/node-square`): colour, size and label carry the kinds
(OQ3). The sigma + graphology code is behind a dynamic `import()` in `graph-canvas.tsx`
so vite emits it as its own chunk: a workspace that never opens the Graph tab downloads
exactly what it downloads today. The frozen list in `smoke-824-graph-ui` grows by these
names and nothing else, and 825's smoke owns it from here.

**D3 — Four projections of one in-memory graph.** The panel fetches the scope once,
builds one graphology `Graph` (node attributes = the D1 fields, edge attributes `type`,
`origin`, `layer`, `n`), and every view is a **pure layout function** `(graph, options) →
{ id → {x, y} }` in `ui/src/lib/graph-layouts.ts` — no DOM, testable in node. Switching
views re-positions; it never re-fetches and never rebuilds the model.

| view | position rule | GitNexus twin |
|---|---|---|
| **Force** | ForceAtlas2 in the shipped worker, seeded by `graphology-layout`'s circular layout so the start is deterministic; runs until Stop or 300 iterations; colour = community (D4), size = log degree | Force Graph |
| **Layers** | y = band by role — entry points · routines · labels/data blocks · project addresses · zero page · I/O · ROM — in that fixed order top to bottom; x = address within the band. Calls and accesses read downward. No simulation. | Sequential Layout |
| **Radial** | rings by BFS hop distance from the focus over the edge families currently on (depth ≤ 4); focus at the centre; angle = address order, so a routine keeps its bearing when the focus changes. No focus → rings by kind. | Radial Layout |
| **Address** | x = address `$0000`–`$FFFF`, linear; y = lane by space and bank — one RAM lane per bank in the scope, then ROM, I/O, zero page; a node with a range is a bar from `address` to `end`; edges are arcs above the lanes. Platform nodes sit in their lane at their address. | — (needs banking in identity; 818 has it) |

Radial at depth 1 **is** 824's neighbourhood, readable: the lane SVG is retired and
`graph-panel.tsx` keeps its card, chips, search, depth and both jumps unchanged above
the canvas. One renderer, not two.

**D4 — Communities: human first, computed second, never written back.** Colour is the
community axis in every view. A node's community is its human subsystem when
`BELONGS_TO` / the subsystem's `CONTAINS` says so (818 `assign-subsystem`, 822 door);
otherwise the Louvain community computed in the browser
(`graphology-communities-louvain`, fixed `resolution` and `rng` seed so the same graph
colours the same way twice) over the **code edges only** — CALLS, JUMPS_TO, BRANCHES_TO,
CONTAINS. Memory edges are excluded on purpose: `USES_ZP` (4 409 rows onto ~229 addresses)
and the KERNAL nodes are hubs that glue every routine into one blob. Computed communities
are labelled `computed · 37 nodes · top: fastload_main, serial_send_2bit` in the legend and
**never persisted** — naming one is the human door (`save_entity` / `assign-subsystem`), and
the next load shows it as human. Read-only stands (824 D6). Legend click = focus the
community (its members lit, the rest dimmed); the legend also lists the human
subsystems' names with their member counts, which on Wasteland today is an empty list
next to a full computed one — the honest picture.

**D5 — Filters are lenses; positions never move.** Node-kind toggles (the D1 kinds plus
`zp` / `io` / `rom`), 824's eight edge-family chips, origin (static / runtime / human),
and the bank selector, all applied through sigma's `nodeReducer` / `edgeReducer` as
`hidden` — the graphology model and the layout positions are untouched, so toggling a
family is a lens, not a re-layout (GitNexus re-runs; ours must not). Default lenses:
`entry` and `segment` nodes hidden (4 487 nodes that are listing structure, not code —
OQ2), `MAPS_TO` hidden (2 457 edges from the 822 migration that connect records, not
addresses).

**D6 — Interaction, by the mechanisms that exist.** Hover → neighbours lit, the rest
dimmed (reducers). Click → focus: 824's card, listing jump, source jump, all unchanged.
Double-click → focus and re-centre (Radial re-rings; Address and Layers pan to it; Force
does not move). ⌘K → `/api/graph/find` (824's search) → focus. Fit / zoom ± / Stop-Run
layout in the corner, Esc clears focus. Focusing in the Graph selects the listing entity
and vice versa (824 D5.1's bidirectional state).

**D7 — Loading.** One `subgraph` fetch per `(projectDir, scope)`, cached in the panel for
the session; `/api/workspace` unchanged (824 D7 stands). Above the D1 threshold the panel
shows the GitNexus sentence in our words — "11 005 nodes — load, or pick a bank / owner
scope" — with the scopes as buttons. `measure:825` records bytes and ms for Wasteland
(§5); the target is under 3 MB and under one second on the wire, GitNexus's numbers at
twice our size.

**D8 — The inspector docks.** 824.2's "Open in source" opens `AsmView` as an overlay over
the tab. 825 adds **dock**: the same `AsmView`, the same `jumpToAddress`, mounted in a
resizable right pane beside the canvas, so a click on the canvas lands in the source
while the graph stays on screen — GitNexus's Code Inspector. Overlay stays for the other
tabs; nothing in `AsmView` changes but where it mounts.

**D9 — Read-only, still.** No write from the canvas: not a name, not a community, not a
position. `assign-subsystem` and `save_entity` are the doors (822).

## 4. Panel spec

```
┌ Graph ─────────────────────────────────────────────────────────────────────────────┐
│ [⌘K find: ____________]  Force · Layers · Radial · Address    scope [all ▾] bank [07 ▾] │
│ kinds: routine label addr payload zp io rom (entry) (segment)   edges: Code Memory … │
├──────────────────────────────────────────────────────┬─────────────────────────────┤
│                                                      │ fastload_main   (label WFF00)│
│        · · ·  ·   ●●●● loader (computed, 37)         │ routine $FF00–$FF8E · bank — │
│      ·  ●●●●●●●●  ·      ·                           │ in 1 · out 80 · rom 2 · zp 8 │
│    ·  ●●● game ●●●●  ·   ·  ▲▲ intro (computed, 12)  │ [Open in listing] [Open src] │
│      ·  ●●●●●●●●  ·  ·  ·                            │ [Dock source ▸]              │
│         · · ·   ■$DD00  ■$01  ◆CHROUT                │─────────────────────────────│
│                                                      │ legend                       │
│  [fit] [+] [−] [stop layout]                         │ ● loader 37 · ● game 412 …  │
│                                                      │ human subsystems: (none yet) │
└──────────────────────────────────────────────────────┴─────────────────────────────┘
```

- **Address view** replaces the field with lanes: `RAM bank 07 ─────`, `RAM ─────`,
  `ROM`, `I/O`, `ZP`, ticks every `$1000`, a bar per ranged node, arcs for edges; zoom is
  horizontal only.
- **Empty state** stays 824's: the product step, never a blank canvas.
- **Labels** render above sigma's size threshold and always for the focus, its
  neighbours and platform nodes with a human name (OQ1).

## 5. Gates

**`scripts/smoke-825-subgraph-route.mjs`** (`npm run smoke:825-routes`) — first, green
before any TSX. Real workspace server on a tmp copy of the 823 fixture: the route body
equals `c64re graph subgraph --json` byte for byte; nodes and edges sorted by id; every
edge endpoint is in `nodes`; every platform endpoint synthesised with `platform: true` and
the KB's name; `Σ n` over edges equals `counts.rows` and equals a direct `SELECT count(*)`
on the store for the scope; `scope=focus:<ref>&depth=1` yields exactly the node set of
`/api/graph/edges?ref=<ref>&direction=both&depth=1`; `scope=owner:` and `scope=bank:`
partition the `all` set; a second seed (818's idempotence) yields a byte-identical body;
400 / 404 / 405 as 824.

**`scripts/smoke-825-graph-explorer.mjs`** (`npm run smoke:825`, after `ui:build`) —
second. Bundle: the sigma/graphology code lives in a chunk that is **not**
`index-*.js` (lazy, D2), and `index-*.js` carries the six route strings; `package.json`
equals 824's frozen list plus exactly the D2 names, each pinned. Source:
`graph-canvas.tsx` is the only file importing `sigma`; `graph-layouts.ts` and
`graph-communities.ts` import graphology only and no DOM. Unit, in node on a fixture
graph (built from the 823 fixture's `subgraph --json`): Layers bands are in the D3 order
and every x is monotone in address inside a band; Address view x equals the address and
each bank has its own lane; Radial ring index equals BFS distance and the focus is at the
origin; Force's seeded start is identical across two runs; Louvain runs over code edges
only (a graph with one CALLS component and a shared `USES_ZP` hub yields the same
partition with and without the hub); applying every filter leaves every position
unchanged (D5).

**`scripts/measure-825-explorer.mjs`** (`npm run measure:825`) — on Wasteland_EF, skips
loudly without it: subgraph bytes and ms, nodes / edges / collapsed edges, community
count and modularity, ForceAtlas2 300 iterations in node (ms), Layers and Address layout
ms. Numbers go into §9, not into this section.

`smoke:824`, `smoke:824-2`, `smoke:product-ui` stay green (with 824's route regex and
frozen list amended as D1/D2 say). `ui:typecheck` stays at its 15 pre-existing errors
(824 §9) — 825 adds none.

## 6. Acceptance

- `smoke:825-routes` green before any TSX is committed (rule 6).
- On Wasteland_EF, all four views render the `all` scope; `fastload_main` at Radial depth 1
  shows its 1 caller and 80 callees legibly at fit, with labels on hover.
- Communities: the legend lists computed communities with counts; the human list is
  empty until `assign-subsystem` is used, then shows the name and colours the members.
- Toggling any lens changes nothing but visibility; switching views changes nothing but
  positions; neither re-fetches.
- ⌘K, card, listing jump and source jump behave exactly as in 824; docked source works.
- `git diff package.json` shows the D2 names and nothing else; the initial workspace
  bundle (`index-*.js`) is not larger than before 825 by more than the route strings.

## 7. Non-goals

- No sixth MCP tool; the LLM's surface stays 823's five.
- No write-back of communities, positions or names (D9).
- No chat in the panel — the MCP session is the chat.
- No file explorer — the Disk and Payloads tabs exist.
- No Flow Graph replacement; flows are not in 818's model yet (824 D2 stands).
- No cross-project view (824 D8, Phase 5) and no 3D.
- No custom sigma node programs (shapes, borders) in this slice (OQ3).

## 8. Open questions

- **OQ1 — Label density.** sigma's `labelRenderedSizeThreshold` versus forced labels for
  the focus set; the Address view wants the label beside the bar. Decided on Wasteland.
- **OQ2 — `entry` and `segment` nodes.** 4 487 nodes of listing structure hidden by
  default (D5). Whether they belong in the subgraph at all, or only under `kinds=`, is
  decided by what the Layers view looks like with them on.
- **OQ3 — Shapes.** Platform nodes as squares (`@sigma/node-square`) and human-named nodes
  with a border (`@sigma/node-border`) would each be a dependency; colour and label first,
  measure whether anyone misses the shapes.
- **OQ4 — Threshold.** 50 000 nodes is GitNexus's number for a repo; a G64 project with
  every payload analysed may sit near it. Revisit with the first project that trips it.
- **OQ5 — Louvain resolution.** One value for every project, or a slider with a default;
  a slider is cheap once the function is pure.

## 9. Built — measured, and where the spec was wrong

**Wasteland_EF, read-only:** 13 060 nodes, 28 761 collapsed edges over 35 837 store
rows (1.25 rows per edge), 579 synthesised platform endpoints, 0 dangling. The aggregate
runs in 95–206 ms plus 22 ms to serialise. Louvain finds **162 communities at modularity
0.845** in 40 ms — 0 human, because nobody has used `assign-subsystem` on that project
yet, which is exactly the honest picture D4 asked for. Layouts: seed 9.6 ms, Layers
4.0 ms, Address 9.1 ms across 68 lanes, Radial 5.7 ms. ForceAtlas2 ×300 is 9.8 s
synchronously in node — in the browser that is the worker, not the UI thread. The lazy
chunk holds sigma 89.9 kB + graphology 60.9 kB + communities 23.9 kB + layouts 10.8 kB +
FA2 5.8 kB; the initial bundle grows 492.3 → 505.0 kB raw (142.5 → 146.2 kB gzipped),
which is the route strings and the panel, as D2 intended.

**D7's byte target is missed and stays missed: 11.92 MB raw against "under 3 MB".**
Gzipped it is 374 kB and the time target is met with room. The cause is not the data but
823 D7: the route body is byte-identical to `graph subgraph --json`, and that shared
formatter pretty-prints. Compacting it would move every 823 and 824 route body at once,
so it was left alone rather than fixed quietly here. If the number matters later, the
honest fix is a `?pretty=0` on the route, not a different formatter for one caller.

**Four things the implementation found that the spec did not know:**

- **`type` is sigma's, not ours.** Sigma reads the edge attribute `type` to choose a
  render program, so a store type of `READS` in that field is a hard "could not find a
  suitable program" failure. Store types live in `edgeType`; sigma gets `type: "arrow"`.
- **Sigma's camera is y-up.** The layouts stay in D3's screen orientation — Layers bands
  read top to bottom as written — and `applyPositions` negates y at the render boundary.
  Keeping the flip out of the pure functions is what keeps them testable in node.
- **Louvain over code edges leaves most nodes without one.** Giving each a singleton
  community produced a legend of 8 028 entries. A node with no code edge now gets no
  community and draws grey; 162 real ones remain.
- **The Graph tab needed the full width.** Inside the shell's three-column layout the
  canvas was 411 px next to an inspector saying "select a memory region". It takes the
  single-column treatment now, at 962 px, which is what §4 draws.

**One pre-existing bug fixed on the way:** `smoke-product-ui.mjs` parsed every WebSocket
message as JSON, including the daemon's binary VIC frames, so it crashed whenever a live
session happened to be streaming. One `isBinary` guard.

**Still open:** the docked source pane could not be exercised end to end — the browser
fixture has no `_disasm.asm`, so the button sits behind the same `sourceJump` guard 824.2
already gates. And `assign-subsystem` remains unused in the field, so the human half of
D4's legend has never been seen with real data.

## 10. Open after the first look on screen (2026-09-06)

Seen by the owner and confirmed on a screenshot of Wasteland_EF, all four views:

- **The palette is wrong on the dark ground.** Nodes render near-black against
  the panel background, so 13 060 of them read as one blob rather than as
  communities. D4 says colour IS the community axis; right now it carries no
  information. Needs a palette chosen against this background — light, saturated,
  and distinct at 3 px — plus a visibly different treatment for the uncoloured
  nodes (the 7 868 without a code edge) instead of another dark grey.
- **Labels draw for far too many nodes.** They overlap into unreadable text soup
  at fit zoom. OQ1 left the threshold open; the answer from the screen is that
  labels belong to the focus set and to whatever survives a zoom, not to the
  whole graph.
- The Address view shows the shape is right — one dense band along the RAM lane
  plus the ROM/IO lanes — but the same two problems make it hard to read.

None of this is in the layouts or the data; it is the render pass in
`graph-canvas.tsx` (node colour, size and `labelRenderedSizeThreshold`). Cheap to
fix, and worth fixing before anyone judges the four projections.
