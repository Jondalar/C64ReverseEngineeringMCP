# Spec 823 — MCP surface over the graph query API

**Status:** BUILT 2026-09-06 — gate `npm run e2e:823` GREEN (28/0)
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"MCP" · §"CLI" · §"Phase 4 —
Agent Integration". The graph exists after Specs 818–822 as a library; 823 is the door.
**Anchor:** Spec 818 (`src/knowledge-graph/`) · Spec 740.1 (the current retrieval tools)
· `DOCTRINE.md` rule 6 (API first) · `src/server-tools/tier-tools.ts` (the surface gate)
**Touches:** `src/server-tools/graph-tools.ts` (new) · `src/server-tools/tier-tools.ts`
· `src/server.ts` · `src/cli.ts` + `src/graph-cli.ts` (new) · `src/server-instructions.ts`
· `docs/agent-doctrine.md` · `scripts/gen-mcp-tool-usecase-matrix.mjs` ·
`scripts/gen-mcp-llm-playbooks.mjs` · `scripts/e2e-823-graph-mcp.mjs` (new)

## 1. What exists today, measured

**The surface is full.** `docs/tool-surface-inventory.json`: 261 tools, 151 default,
110 advanced. `DEFAULT_TOOLS` has 151 entries and `DEFAULT_TIER_CAP = 151`
(`tier-tools.ts:256`) — probe check 1 (`probe-tool-surface.mjs:25`) passes with zero
headroom. A tool not in `DEFAULT_TOOLS` is never registered: `server.ts:110-112` returns
before `server.tool()` unless `C64RE_FULL_TOOLS` is set, and an untagged name resolves to
`advanced` by design (`tier-tools.ts:18-21`). Three tools were lost this way in one day
(memory: "DEFAULT_TOOLS invisibility"); registering is the first deliverable, not the last.

**Retrieval today has no edges.** `project_search` (740.1) indexes knowledge records and
documents — kinds `finding | entity | relation | flow | open_question | artifact |
artifact_version | doc_section | wiki_page | activity_log_entry | asm_section | view |
trace_mark` (`project-search.ts:16-19`); of an ASM file it indexes **section headers only**
(`indexAsm`, `:189`). It answers "where is the loader described", never "who writes
`$D018`". `project_find_related` groups the same records by artifact / finding / entity /
doc / view / address overlap (`project-search-tools.ts:90`). The one structural lookup in
the repo is `resolveXrefs(projectDir, addr)` → `{ into, outof }` (`address-index.ts:162`,
Spec 759): per-artifact `codeAnalysis.xrefs` with a `type` string and an operand, reached
through `inspect_address_range` ("code xrefs into the range") and the monitor `xref`
verb. No ROM semantics, no read/write split beyond the type string, no runtime origin, no
human/generated distinction, no bank. "Which routine writes `$D018`" is therefore
`read_artifact` on a ~1 700-line `_disasm.asm` and a grep in the LLM's head — the
draft's `grep → read 5000 lines → guess`, verbatim.

**How a tool is written here.** `server.tool(name, description, zodSchema,
safeHandler(name, async (args) => …))` (`project-search-tools.ts:38-62`); `safeHandler`
(`safe-handler.ts:43-55`) turns a throw into an error envelope. Descriptions carry a
register the gate enforces: *what* · "Use to …" · "Not for X (use Y)" · "Inputs:" ·
"Returns:" (`probe-tool-surface.mjs:100-108`, check 11), no `Spec NNN` (check 9), no
`[Phase` prefix (check 10); `inspect_address_range` and `save_finding` are the models.
Hits are compact: `renderHit` (`project-search-tools.ts:29`) prints `[kind] $addr title /
snippet / path#anchor | id= / why:`; `agent_next_step` appends a fenced ```` ```json ````
block the client parses instead of the prose (`agent-step.ts:528-562`, fence at `:630`).

**The gates every new default tool passes.** `npm run check:mcp-product-surface`
(`package.json:45`) = inventory `--check` → `probe-tool-surface` → usecase-matrix (a row
with `useWhen`/`notFor` per tool, ≥ 1 `e2eUseCases` per default tool,
`probe-mcp-tool-usecase-matrix.mjs:32-39`) → playbooks (every default tool in a playbook
or marked supporting, `probe-mcp-llm-playbooks.mjs:96`) → tool-boundaries (every default
tool in a product swimlane, `e2e-mcp-tool-boundaries.mjs:52-57`) → seven stdio e2e runs.
Plus `check:runtime-invisible` (scans `src/server-tools` for the backend brand) and
`check:wiki` (every tool name a wiki page cites must exist).

**CLI.** `cli.ts:25-35` is a subcommand router with one subcommand, `setup`, lazily
imported. The draft's `c64re graph …` has a slot.

**The doctrine sentence that changes.** `docs/agent-doctrine.md:165-167`: "`project_search`
/ `project_find_related` are the default way to find existing knowledge before
re-deriving it." True for described knowledge; silent on structure.

## 2. The gap

After 818–822 the graph answers callers, callees, readers, writers, references, path, ZP
usage, hardware usage, runtime observations, annotation search and subsystems — as
TypeScript calls. "A tool an agent cannot reach might as well not exist"
(`tier-tools.ts:248`). Without 823 the agent keeps reading listings.

## 3. Decisions

**D1 — Thin, and gated thin.** A handler is `parse args → one library call → format`.
The draft names the anti-pattern — "MCP contains graph logic" — and the reason is that
the graph has three consumers (CLI, UI, MCP); logic in one is a second answer for the
other two, the drift `DOCTRINE.md` was written to end. Corollary: an aggregate a tool
needs (a node card, an overview) is added to `src/knowledge-graph/`, never composed in
the handler. Enforced: the 823 gate reads `graph-tools.ts` and fails if it imports
anything but `../knowledge-graph/*`, `zod`, `./safe-handler.js`, `./types.js` — no
`node:fs`, no `node:sqlite`, no `project-knowledge/*`.

**D2 — Five tools, one namespace.** The draft lists twelve. Every default tool is context
the LLM carries on every turn, so they collapse where one argument does a name's work:

| draft | 823 | how |
|---|---|---|
| `find_symbol`, `search_annotations` | `graph_find` | one query over names, addresses **and** annotation text; `origin` filters human/generated |
| `get_routine`, `get_subsystem`, node-level `get_runtime_observations` | `graph_node` | a subsystem is a node with `contains` edges; "was it executed" is a node fact |
| `get_callers`, `get_callees`, `get_memory_reads`, `get_memory_writes`, `find_writers`, `find_readers`, edge-level runtime observations | `graph_edges` | `direction` × `kind` × `origin`; callers = in/calls, writers of `$D018` = node `$D018` in/writes |
| `find_path` | `graph_path` | unchanged |
| CLI `irq`, `banking`, `uses-kernal`, subsystems, entry points | `graph_overview` | CLI verbs the draft gives no tool; the *first* question on a new project |

Namespace `graph_`, not `find_`/`get_`: the inventory groups by first token
(`gen-tool-surface-inventory.mjs:43`), `get_` already holds `get_project_profile`, and
`graph_edges` next to `c64re graph edges` is one word in both doors. `probe-tool-surface.mjs:85`
needs no change — check 8 only reports *advanced* tools of unknown namespace.

**D3 — Compact hits, stable ids, a JSON block.** Precedent 740.1 §3: "compact ranked hits,
not full documents". A hit is one line — `[kind] $addr name | id=… | origin | why` — never a
listing excerpt. Every `id` is the string the library derives (817 D3 for platform nodes,
818 for project nodes), opaque to the tool, and **round-trips**: `graph_node(id)` resolves
anything any graph tool returned. An address (`$D018`, `bank:07:$8000`) or a name is always
accepted as a ref, so an id is needed only to disambiguate. Each response ends with a
```` ```json ```` block — `{ query, hits[], truncated, next[] }`, the card, or the paths —
the same object the CLI prints with `--json` (D7); `next[]` names follow-up calls
`{ tool, args }` the way `agent_next_step`'s `primary_action` does.

**D4 — 740.1 coexists, with the boundary written down.** Replacing `project_search` loses
document retrieval; wrapping it puts a second query language in front of the graph. They
index different sources and answer different questions: `project_search` = "where is X
*described*"; `graph_*` = "what does the machine *do* at X". Both descriptions gain the
cross-pointer in their "Not for" clause. `project_find_related` stays as is — its
artifact-version, doc and view groups are not graph content. The overlap is findings with
an address range, which the graph carries as human-origin annotations (818/822);
`graph_node` shows them with their finding ids, so either door lands on the same record.

**D5 — Default surface, cap 151 → 156, no phase entry.** All five default; a hidden graph
tool is the 740.1 lesson again. The cap rises by exactly five, with the reason in the
comment block where the others live (`tier-tools.ts:220-255`): the `runtime_scene_reel`
argument — a door that replaces a loop of `read_artifact` + `inspect_address_range` is
*less* surface to hold, not more. None of the five enters `phase-tools.ts`: read-only and
phase-agnostic in fact, and `project_search` set the precedent of staying out entirely
(`phaseForTool` → `undefined`: no prefix, no gate). That is also how 823 keeps out of
`src/agent-orchestrator/` — no `workflow-model.ts` step, no `agent_next_step` branch. The
graph is a lens on every phase, not a step in one.

**D6 — No rebuild tool.** Reproducing the generated graph is 818's job. If 818 rebuilds on
read (precedent `loadXrefIndex`, `address-index.ts:143-160`: cache invalidated when any
`_analysis.json` is newer), nothing is needed; if it lands with an explicit build step, it
joins `project_inventory_sync` — "the single product facade over register/import/
view-rebuild" (`tier-tools.ts:37-41`) — not a sixth tool.

**D7 — CLI, same verbs, one formatter.** `c64re graph <verb> [ref] [--json]` as a second
subcommand in `cli.ts` (lazy import, like `setup`). Verbs `find · node · edges · path ·
overview`, plus the draft's aliases as argument presets — `callers X` = `edges X --in
--kind calls`, likewise `callees`, `readers`, `writers`, `references`, `zp-usage`, `irq`,
`banking`. Text and `--json` come from **one** formatter module the MCP handler also uses,
so CLI JSON and tool JSON block are byte-identical; the gate asserts it.

**D8 — Doctrine text changes, named.** In the same commit as the tools:

1. `docs/agent-doctrine.md` §1 (`:165-167`) becomes: "For a *structural* question — who
   calls, who writes, what does this routine touch, is there a path — query the graph
   (`graph_find`, `graph_edges`, `graph_node`) **before reading a disassembly**. For where
   something is *described*, `project_search` / `project_find_related`." §2 step 4 gains
   `graph_overview` as the structural inventory.
2. `src/server-instructions.ts`, under STATIC-FIRST, one sentence: "The graph tools
   (`graph_*`) ARE the static analysis, indexed: query them before reading a full
   listing." The flight to runtime this text exists to stop starts with "the listing is
   too long".
3. `scripts/gen-mcp-llm-playbooks.mjs:38` gains the graph tools and a step "answer a
   structural question" (§5), so playbook check 9 is met by the playbook the agent reads,
   not a `supporting` flag.

## 4. Tool table

| tool | purpose | args | returns | library |
|---|---|---|---|---|
| `graph_find` | resolve a name, address, register, ROM entry or annotation text to nodes | `query`, `kind?` (routine·label·address·register·rom_routine·data_block·subsystem·region), `origin?` (human·generated·runtime·any), `bank?`, `limit?` (10, max 50) | ranked hits: id, kind, `$addr`(+bank), name, origin, in/out edge counts, `why` | `find` + `search_annotations` (union in the library, D1) |
| `graph_node` | the card for one node | `ref` (id·`$addr`·name), `bank?` | kind, range, generated label **and** human name (separately), subsystem, edge counts by kind/direction, hardware + ROM + ZP touched, runtime (executed? runs, run ids), ≤ 5 annotations with finding ids, `next[]` | node card (`get_routine` / `get_subsystem` + node-level observations) |
| `graph_edges` | the neighbourhood walk | `ref`, `direction?` (in·out·both; out), `kind?` (calls·jumps·branches·reads·writes·references·calls_rom·uses_zp·uses_hardware·changes_banking·handles_irq·contains·any), `origin?` (static·runtime·human·any), `depth?` (1·2), `bank?`, `limit?` (25, max 200) | per edge: from/to (id, name, `$addr`), kind, origin, confidence, evidence `$8421 STA $D018`; runtime edges add count + run id; `truncated` | `callers · callees · readers · writers · references · zp-usage · uses-hardware ·` runtime observations, dispatched by `kind`/`direction`; depth-2 walks in the library |
| `graph_path` | is there a path, and through what | `from`, `to`, `via?` (calls·calls+jumps·any), `max_depth?` (8), `bank?` | ≤ 3 shortest paths as node chains with per-hop evidence; on none: "no path" + frontier size | `path` |
| `graph_overview` | the project's structural map | `focus?` (entries·irq·banking·hardware·rom·zp·subsystems·unknown; all), `bank?` | per section top-N node ids with counts: IRQ/NMI handlers, banking sites, users per chip, KERNAL/BASIC dependencies, hot ZP, subsystems, and **unknown** — indirect accesses with no runtime resolution | `overview` over `uses-hardware`, `calls_rom`, `handles_irq`, `changes_banking`, `get_subsystem`, `zp-usage` |

Description register as `inspect_address_range`: *what* · "Use to …" · "Not for … (use
`project_search`)" · "Inputs:" · "Returns: … plus a machine-readable JSON block".
`check:runtime-invisible` applies: runtime edges are "observed in a trace run", never
attributed to a backend by name.

## 5. The agent walk (Phase 4)

> Investigate how the title switches between the map and the character UI.

```
graph_find     "character"  origin:human         → routine $8430 DrawInventory (id A)
graph_edges    A  direction:in kind:calls        → 2 callers: $8102 (id B), $9F40 (id C)
graph_edges    $D018 direction:in kind:writes    → $8421 in UpdateScreen (id D), $8455 in A
graph_node     D                                 → writes $D018, reads $02/$03, calls CopyCharset;
                                                   observed executed in run r3, 41 times
graph_edges    D  kind:reads origin:runtime      → LDA ($02),Y resolved to $A734..$AF33 (run r3)
graph_path     B  D                              → B → $8130 → D (calls, calls)
```

Six calls, no listing opened. The listing is opened last, at `$8421`, to read the eight
instructions that matter — which is what "read before you hypothesise" was always about.

## 6. Gates

**`scripts/e2e-823-graph-mcp.mjs`** (`npm run e2e:823`): stdio JSON-RPC against
`dist/cli.js`, `C64RE_FULL_TOOLS: ""`, project outside the repo — the
`e2e-mcp-step-loop.mjs:26-58` harness. Fixture: a **synthesized** PRG with ground truth
(the 816 method): routine A `JSR B`, `STA $D018`, `JSR $FFD2`; routine B `LDA ($20),Y`,
`INC $D020`; an IRQ vector at C. `analyze_prg` runs through the same session, then:

1. `tools/list` on the default surface contains exactly the five; probe green at cap 156.
2. `graph_edges B in calls` = `[A]`; `graph_edges $D018 in writes` = `[A @ STA $D018]`;
   `graph_edges A out calls_rom` = `[KERNAL CHROUT]`; `graph_overview irq` = `[C]`;
   `graph_edges B out reads` carries `uses_zp $20/$21` with confidence `unknown`, not an
   invented target (draft: explicit unknown beats a fabricated edge).
3. **Id round-trip:** every `id` in every response resolves through `graph_node`.
4. **No leak:** no response contains a filesystem path, `knowledge/.cache`, a SQLite rowid
   or a backend brand.
5. The ```` ```json ```` block parses and equals `c64re graph <verb> --json`, byte for byte.
6. D1 thinness: the import allow-list on `graph-tools.ts`.
7. A bad ref returns the `safeHandler` envelope, not a transport error.

**`npm run check:mcp-product-surface`** — the whole chain: matrix rows
(`gen-mcp-tool-usecase-matrix.mjs`, swimlane `disassembly-improve`, role `knowledge-read`),
the playbook step (D8.3), inventory regeneration, `DEFAULT_TOOLS` + cap are part of the
slice, not follow-ups. **`check:runtime-invisible`**, **`check:wiki`**.

## 7. Acceptance

- Five `graph_*` tools on the default surface; `e2e:823` green; `check:mcp-product-surface`
  green at `DEFAULT_TIER_CAP = 156` with the reason written where the others are.
- The walk in §5 runs on a real project without a `read_artifact` of a listing.
- `graph-tools.ts` imports nothing but the library, zod and the two helpers.
- The three doctrine texts in D8 changed in the same commit as the tools (`CLAUDE.md` rule 9).
- `c64re graph writers '$D018' --json` and the tool's JSON block are identical.

## 8. Non-goals

- No graph construction, storage or query logic — 818–822. A missing query grows the
  library, not the tool.
- No orchestrator change: no workflow step, no `agent_next_step` branch, no phase gate.
- No UI; the routes and the panel are Spec 824, on the same library and formatter.
- No write tool: naming a routine stays `save_finding` / `save_entity`, which the graph
  ingests as human origin — a `graph_annotate` would be a second write path.
- No cross-project query (Phase 5, after 824). Nothing existing is removed; 740.1 changes
  only in two "Not for" clauses.

## 9. Open questions

- **OQ1 — The five slots.** D5 raises the cap. If the owner would rather hold 151, the
  first demotion candidate by the 2026-08-12 argument (housekeeping, not an RE step) is
  `project_wiki_lint`. Decide before build.
- **OQ2 — Does `graph_find` rank annotation-text hits with name hits, or after?** 740.1
  ranks exact address/id/title above text and says so in `why`; same default here unless
  the library's `find` already ranks.
- **OQ3 — `depth:2` fan-out.** `CHROUT` has hundreds of callers in a large title; `limit` +
  `truncated` answers depth 1, depth 2 may need a per-hop cap the library owns. Measure
  on a real project before picking a number.
- **OQ4 — Bank as a ref.** `bank:07:$8000` is the draft's spelling; the tool accepts
  whatever grammar 818 derives its ids from.

## 10. Built — what the gate found on the way

`src/server-tools/graph-tools.ts` (five tools, thin by gate), the aggregates in
`src/knowledge-graph/cards.ts` (node card, neighbourhood walk, shortest path,
overview) and the ONE formatter `src/knowledge-graph/format.ts` that the CLI
and the tools share — `c64re graph find … --json` and `graph_find`'s JSON block
are byte-identical, asserted. `DEFAULT_TOOLS` + 5, cap 151 → 156 with the reason
in the comment block. D8's three doctrine-text changes landed in the same commit:
`docs/agent-doctrine.md` §1, `src/server-instructions.ts` under STATIC-FIRST,
and a playbook step in `gen-mcp-llm-playbooks.mjs`. Inventory, use-case matrix
and playbooks regenerated.

**Deviations, as built:**
- `graph_path` returns ONE shortest path (BFS), not "≤ 3"; on none it reports
  the reachable frontier size, as specified. Three alternative paths need a
  k-shortest walk the library does not have yet.
- `graph_find`'s `kind` values are the graph's own (`routine · label · addr ·
  zp · io · rom · ram · subsystem · run`), not the draft's
  (`register · rom_routine · data_block · region`) — the id grammar's kinds are
  the vocabulary, and a second one would be a second answer.
- Annotations on the node card (≤ 5 with finding ids) wait for 822's human
  layer; the card carries `humanName` and `subsystems` today.
- `changes_banking` / `handles_irq` edge kinds are accepted and answer empty
  until 821 writes `HANDLES_IRQ` rows; banking sites in `graph_overview` are
  derived from WRITES to `$01` / `$DD00` / `$DE00` / `$DE02` now, which is what a
  static producer can know.

**What the gate found.** The first round-trip failed on every call: the server's
`context.projectDir()` refuses a directory that is not an initialized project
(`knowledge/phase-plan.json` …), so the gate now creates its project through the
real door, `project_init`, before analyzing and seeding — a better gate. The D1
"no fs, no sqlite" check then failed on its own comment, which named the three
forbidden imports; it checks the import list now, not the prose.

**Pre-existing reds, not this spec's.** `probe-tool-surface` (check 9/11:
`validate_extraction`, the `runtime_candidate_*` descriptions),
`probe-mcp-llm-playbooks` (check 9: ten tools in no playbook) and
`e2e-mcp-tool-boundaries` (checks 4/6: `sandbox_*`,
`register_payloads_from_manifest`) were red on `master` before 823 and name no
`graph_*` tool. Recorded here so the next reader does not read them as 823's.
