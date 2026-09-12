# Spec 822 — Human knowledge integration + migration of the existing store

**Status:** BUILT 2026-09-06 — 822.1 (migration, human door, query extensions) and 822.2 (the cut: the graph is the authority for findings, entities, relations, annotations, open questions and user labels; the JSON store for them is neither read nor written; §11). Gates `npm run e2e:822` GREEN (111/0 on a tmp copy of Wasteland_EF) and `npm run check:822-no-json-readers` GREEN.
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Human Annotations",
§"Subsystems", §"Generated vs Persistent Knowledge" ("Reanalyse darf generierte
Informationen löschen … aber niemals Human Knowledge ungefragt überschreiben"),
§"Guardrails". §"Pattern Knowledge" and §"Cross-Project Knowledge": named, not built.
**Anchor:** Spec 817 (store, derived identity) · Spec 818 (`nodes`/`edges`, id grammar,
`layer`/`origin`/`producer`) · Spec 823 (the MCP doors over `graph.*`) · Spec 055
(`emitAnnotationFindings`) · Spec 740.1 (`project-search.ts`) · Spec 748.2
(`question-triage.ts`) · Spec 754 §3.3f (user labels)
**Touches:** `src/knowledge-graph/` (818), `src/project-knowledge/{storage,service,mcp-tools,project-search,question-triage}.ts`,
`scripts/e2e-822-migrate-wasteland.mjs`

## 1. What exists today, measured

The project knowledge store is one JSON array per record type under
`<project>/knowledge/` (`storage.ts:770-793`), each written whole: `writeJsonAtomically`
(`storage.ts:217-222`) serialises the entire store to `<file>.tmp` and renames. Every
`save_*` is load → `upsertRecord` (filter and re-sort the full array, `service.ts:416-419`)
→ save. There is no lock anywhere in `storage.ts` or `service.ts` (0 matches for
`flock|lockfile|.lock`).

Measured on the real Wasteland_EF store, read-only, 2026-09-05:

| file | size | records | one RMW costs (read + parse + zod + stringify) |
|---|---|---|---|
| `entities.json` | 28.7 MB | 22,848 | 26 + 49 + 118 + 48 ms ≈ **240 ms** |
| `findings.json` | 13.5 MB | 9,680 | 11 + 18 + 55 + 19 ms ≈ **100 ms** |
| `flows.json` | 13.7 MB | 69 (9,693 nodes, 7,398 edges) | — |
| `relations.json` | 8.3 MB | 7,671 | ≈ 50 ms |
| `open-questions.json` | 5.3 MB | 3,652 | ≈ 35 ms |
| `labels.user.json` | 83 B | **0** | — |

A `save_entity` therefore holds a 240 ms window in which a second writer's rename
silently wins. Two agents saving into one project — a worker and a judge — lose updates
today, and nothing reports it. That is the blocker, not the size.

**Where the rows come from.** Three producers, distinguishable only by convention:

- `analysis-import.ts` tags its output `analysis-import` (lines 332–576) and mints
  entity ids **per analysis run** (`entity-artifact-<analysis-run-id>-entry-02d6`).
  Wasteland_EF has 267 analysis runs over 30 programs, so the `$0031` hypothesis exists
  **58 times** (56 with the identical title "RAM region 0031 behaves like pointer_pair";
  confidences 0.88 ×27, 0.8 ×16, 0.7999999999999999 ×11) and "Segment 7E00 classified as
  code" 52 times. Tagged: **9,421** of 9,680 findings (4,747 RAM hypotheses over **363**
  addresses, none with two hypothesis kinds), **22,246** of 22,848 entities, **7,654** of
  7,671 relations (maps-to 7,238 / contains 256 / precedes 160); **3,640** of 3,652
  questions are heuristic by `question-triage.ts:16-20` (`source=heuristic-phase1` or
  `kind=validation`). All 69 flows are `analysis-control-flow`. All 267 analysis
  artifacts still exist on disk.
- `emitAnnotationFindings` (`service.ts:2611`, Spec 055) mirrors `_annotations.json`
  routines and segment reclasses into findings tagged `annotation`, purging by id prefix
  on every run: **204** (112 routine, 92 segment), no evidence, all 204 fold back into
  the 16 annotation files they came from.
- The `save_*` doors. `save_finding` (`mcp-tools.ts:1901`) accepts no provenance field;
  `save_open_question` has `source`, default `human-review`. No finding carries `source`,
  `origin` or `author` (0 of 9,680). Relations have no `tags` field (`types.ts:1003`).

**Where the human knowledge actually is.** Subtract the producers and the store holds
**49** hand-saved findings (confirmation 16, observation 13, disk-layout 9, refutation 3,
flow 3, classification 2, memory-map 2, hypothesis 1; 10 with an `addressRange`, 15 with
`entityIds`, evidence `note` ×15); **31** hand-made entities (payload 15, routine 6,
other 5, loader-stage 2, one each data-table / memory-region / lookup-table — the other
183 non-import entities are `inventory-import` area assets); **17** hand relations
(calls 5, reads 4, documents 4, one each depends-on / references / follows / loads) over
15 named routines and tables; **1** human-review question that is not a validation
prompt; **0** user labels. Outside the store: 16 `_annotations.json` files with **2,191
labels** (1,085 distinct addresses, 40 with a comment), **456 routines** (271 distinct
starts, 0 with a description), 369 segments (228 distinct) — the largest human corpus in
the project and the only one the disassembler reads. `docs/CODE_CARTOGRAPHY.md` (32 KB)
is a routine index of 158 table rows naming 240 addresses, **145 of which have no entity
in the store**. `docs/AREA_PROSE.md` (232 KB) is extracted in-game area text — game
content, not RE knowledge.

**One trap, recorded so nobody classifies by it:** the tag `user` on 8,165 entry-point
entities is `entryPoint.source` from `analyze_prg` (`analysis-import.ts:369`) — the load
address the analyzer was given — not a human assertion.

## 2. The gap

1. **No layer.** Human and generated rows share one array, told apart by a tag one
   producer sets, another sets differently (`annotation`), and one record type cannot
   carry (relations). `emitAnnotationFindings` deletes by id prefix; `archivePhase1Noise`
   (`service.ts:2838`) archives by address coverage; a re-import mints fresh ids next to
   the old. Whether re-analysis destroys human knowledge today depends on which tool ran
   last.
2. **Identity per run, not per thing.** 22,246 entities for 6,605 things (§5). The 740.1
   index, the views and the LLM all see the duplicates.
3. **No write discipline.** Whole-file RMW without a lock (§1).

818 gives the graph `layer` and `origin` columns and derived ids. 822 does not invent that
separation; it defines how human knowledge enters, what protects it, how the existing
store becomes the graph, and when the JSON stops being written.

## 3. Decisions

**D1 — The conflict rule is 818's primary key.** `nodes` is keyed `(id, layer)` and
`edges` `(from_id, type, to_id, layer, evidence_key)` (818 §4). The same derived id may
exist once as `generated` and once as `human`; a third copy cannot. Every query resolves an id `human` first and falls back to
`generated`; the generated row is returned alongside only when the caller asks for
`layer=generated` or `include_shadowed`. Evidence and claims attach to the **id**, not to
the layer, so re-analysis keeps adding evidence under a node the human has renamed. The
day a human row is deleted, the generated answer is visible again — nothing was
overwritten.

**D2 — Re-analysis replaces the generated layer of the payloads it touched and touches
nothing else.** An import is one transaction: delete `layer=generated` rows whose context
is the payload being re-analysed, insert the new ones, append evidence. It never issues a
statement against `layer=human`; the gate proves it by hashing the human layer before
and after (§7).

**D3 — Human means "came through a door", not "typed by a person".** `layer=human` is
every row written by `save_finding`, `save_entity`, `link_entities`,
`save_open_question`, `save_user_label`, annotation import and subsystem assignment —
whether a person or an agent held the door. `origin=user` for door writes;
`origin=imported` for rows whose author is a file (annotation files, cartography).
Deterministic importers (`analysis-import`, `manifest-import`, inventory sync, the
orchestrator's version questions) write `layer=generated`. The draft's "LLM is a consumer,
not the source of truth" governs the generated layer; it does not stop an agent from
asserting what it has read, and the confidence enum carries `user_asserted` for exactly
that.

**D4 — Migration classifies by the fields that exist, and the counts are asserted.**

| legacy signal | layer / origin | findings | entities | relations | questions |
|---|---|---|---|---|---|
| `tags ∋ analysis-import` | generated / static | 9,421 | 22,246 | — | — |
| `kind ∈ {maps-to, precedes}`, both endpoints generated | generated / static | — | — | 7,398 | — |
| `tags ∋ manifest-import` or `inventory-import`; `contains` from a manifest entity | generated / imported | 6 | 388 + 183 | 256 | — |
| `isHeuristicQuestion()` (`question-triage.ts:16`) | folded into the claim (§5) | — | — | — | 3,640 |
| `source=static-analysis` | generated / static | — | — | — | 11 |
| `tags ∋ annotation` (Spec 055 mirror) | folded into the annotation-file import | 204 | — | — | — |
| everything else | **human / user** | **49** | **31** | **17** | **1** |
| `_annotations.json`, 16 files | **human / imported** | 456 routines · 2,191 labels · 369 segments | | | |

**D5 — One node, one claim, N evidence rows.** The 58 `$0031` findings become one
Address node, one `claims` row (`behaves_like=pointer_pair`) and 58 `evidence` rows, each
carrying the analysis-run artifact, the legacy finding id and its `capturedAt`. Not one
row with 58 entries in 818's JSON `evidence` column: the gate counts evidence with
`SELECT count(*)`, re-analysis appends a row instead of rewriting a blob, "which run said
this" is a query, and the legacy id survives per row so nothing in `migration_log` is
unreachable. Migrated edges collapse the same way — one row per `(from_id, type, to_id,
layer)` with `evidence_key=''`, provenance in `evidence` rows; 820/821 keep their
per-instance `evidence_key` for the rows they produce. The
claim's score is the **newest** evidence's, not the maximum — the generated layer means
"what the latest analysis says", and a maximum would let a retracted guess from June
outlive what the current analyzer reports. (At `$0031` both are 0.88; the rule matters
where they differ.)

**D6 — Annotation files are a door, not a store.** `_annotations.json` is the pipeline's
input format and the cracker's working file (`docs/agent-doctrine.md:376`), and the
CommonJS child reads it; that does not change here. What changes: the graph's human layer
is the authority for names, routines and segment reclasses. `annotations_import(file)` is
idempotent by derived id (`(project, ctx, address, routine|label|segment)`); `disasm_prg`
imports the file it is handed when the file is newer than its last import
(`meta.annotations_imported.<stem>`); `propose_annotations` writes the graph and exports
the file. The 204 mirror findings are not migrated as rows; `emitAnnotationFindings` is
retired at cut-over (§6), because the graph row *is* the mirror.

**D7 — Subsystems, minimally.** A `subsystem` is a node (`layer=human`, kind
`subsystem`) with `CONTAINS` edges to routines, data blocks and addresses. It has no
address, so 822 appends a third id form to 818 D1 — `subsystem-id = project ":sub:" slug`
— under that grammar's own "later slices append, never rename" clause.
Membership comes from a door (`assign_subsystem`, or `subsystem:` on `save_entity`,
`origin=user`) or from an importer (`origin=static`, `confidence=heuristic`; call-graph
clustering is a later 818 importer, no LLM in the path). `graph.subsystem(name)` returns
the members and, derived at query time from their `reads`/`writes` edges, the registers
and zero-page ranges they touch — the draft's `USES` edges without storing them.
Migration seeds no subsystem: no legacy field means one.

**D8 — Prose stays prose.** `docs/*.md` is neither parsed nor migrated. The link from a
node to prose is computed, not stored: `annotations(id)` returns, after the stored
annotations, the 740.1 doc sections whose `addrTokens` contain the node's address
(`project-search.ts:66` extracts them already). `CODE_CARTOGRAPHY.md`'s 158 rows are the
first candidate for a hand-triggered import — fixed column shape, 145 addresses the
store has never seen — a later slice with its own parser gate. Importing them silently
would create 145 human rows nobody asserted through a door.

**D9 — Write discipline.** `graph.sqlite` opens with `journal_mode=WAL`,
`synchronous=NORMAL`, `busy_timeout=5000` (`DatabaseSync(path, {timeout})`; Node 22.21.1
/ SQLite 3.50.4, checked). One connection per process for its lifetime; every `save_*`,
import and migration runs inside one `BEGIN IMMEDIATE … COMMIT`. Readers never block
writers under WAL, and a second writer waits instead of losing. `saveFinding` becomes
`INSERT … ON CONFLICT(id, layer) DO UPDATE` — one statement, no 13.5 MB round trip.

**D10 — Query extensions are library functions on 818's `graph`; 823 exposes them.**
`graph.searchAnnotations(text, {layer})` (FTS5 over `annotations` — present in this
Node's SQLite, checked), `graph.subsystem(name)`, `graph.annotations(id)`, and a
`layer: 'human' | 'generated' | 'all'` option on every 818 query (default `all`, human
shadowing generated per D1). No new MCP tool: 823 folds them into `graph_find`
(`origin=human`) and `graph_node`. `project_search` is re-pointed, not re-built —
`buildProjectSearchIndex` (`project-search.ts:255`) swaps its `readJsonStore` calls for
findings, entities, relations and questions for graph queries (human rows ranked
`manual`, generated `generated`, the `rankHints` it already has); docs, views, ASM
headers and the cache stay, and it remains the "where is X described" door (823 D4).

## 4. Schema — what 822 adds

818 §4 owns `nodes` and `edges` — `layer`, `origin`, `confidence`, `producer` and the
composite keys are already there — and the id grammar `project:ctx:kind:addr`. 822 adds
no column to either table: the legacy 0–1 number lives in `attrs.score`, migrated rows
carry `producer='822'`, door rows `producer='human'` (818's value). 822 adds:

```sql
CREATE TABLE evidence (            -- one row per source that said it (D5)
  target_table TEXT NOT NULL, target_key TEXT NOT NULL,  -- 'nodes' id | 'edges' from|type|to | 'claims' node|claim
  artifact_id TEXT, legacy_id TEXT, excerpt TEXT, captured_at TEXT NOT NULL,
  PRIMARY KEY (target_table, target_key, legacy_id));
CREATE TABLE claims (              -- generated hypotheses about a node (D5)
  node_id TEXT NOT NULL, claim TEXT NOT NULL,    -- behaves_like | segment_kind | display_state
  value TEXT NOT NULL,                           -- pointer_pair, code, …
  layer TEXT NOT NULL, origin TEXT NOT NULL, confidence TEXT NOT NULL, score REAL,
  status TEXT NOT NULL DEFAULT 'active',         -- active | archived | rejected
  validation TEXT NOT NULL DEFAULT 'unvalidated',-- unvalidated | answered | invalidated (folded questions)
  validated_by TEXT, superseded_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, claim, layer));
CREATE TABLE annotations (         -- human prose on a node, or on the project (D3, D6)
  id TEXT PRIMARY KEY,                           -- ann:<sha1(node_id|kind|title)>
  node_id TEXT,                                  -- NULL = project-level
  kind TEXT NOT NULL,                            -- routine | label | segment | entity | finding:<legacy kind>
  title TEXT NOT NULL, body TEXT, name TEXT,     -- name = the routine/label name
  tags TEXT NOT NULL DEFAULT '[]', source_path TEXT, legacy_id TEXT,  -- 823 shows finding ids on the card
  origin TEXT NOT NULL, confidence TEXT NOT NULL, score REAL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE annotations_fts USING fts5(title, body, name, content='annotations', content_rowid='rowid');
CREATE TABLE questions (
  id TEXT PRIMARY KEY, node_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL, priority TEXT NOT NULL, layer TEXT NOT NULL, origin TEXT NOT NULL,
  answer TEXT, answered_by TEXT,                 -- protected like a human row whatever the question's layer
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE migration_log (       -- every legacy record, exactly once
  legacy_store TEXT NOT NULL, legacy_id TEXT NOT NULL,  -- findings|entities|relations|open-questions|labels|annotations:<stem>|flows
  action TEXT NOT NULL,                                 -- created|merged|folded|skipped-regenerable|ctx-by-stem
  target_table TEXT, target_id TEXT, PRIMARY KEY (legacy_store, legacy_id));
CREATE TABLE migration_runs (run_id INTEGER PRIMARY KEY, started_at TEXT, source_hash TEXT,
  created INT, merged INT, folded INT, skipped INT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: schema_version · cutover_at · human_layer_hash · annotations_imported.<stem>
```

The layer is a column with a CHECK and the separation is a primary key: an LLM cannot
interpret its way past either, which is what §"Guardrails" asks for.

## 5. Migration mapping

`project_graph_migrate` (an MCP tool, and the script the gate runs) reads
`knowledge/*.json` and every `*_annotations.json` under the project, writes
`knowledge/graph.sqlite` in one transaction, and is idempotent: a second run performs
zero `created|merged|folded` actions and leaves the canonical dump identical (§7).
The legacy row → 818 id resolver:

- RAM-behaviour kinds (`state-variable`, `memory-region`, display state, RAM
  hypotheses) → `ram:addr:<hex4>`, no owner — zero page is one address space whichever
  program's analysis noticed it.
- Payload-resident kinds → `ram/<owner>:<kind>:<hex4>` with `entry-point → label`,
  `code-segment` / `routine → routine`, `pointer-table` / `lookup-table` /
  `data-table → data_block` (appended kind, as 823 already names it). `owner` is the
  artifact stem (818 D1), taken from the analysis run's source PRG via
  `sourceArtifactIds` → payload (`payloadSourceArtifactId`) and normalised (`_analysis*`,
  `_r\d+`, `_re` stripped); a stem resolved without a payload is logged `ctx-by-stem`.
  "Segment 7E00 classified as code" from three overlays stays three nodes — three owners.
- Cartridge kinds (`chip`, `cartridge-bank`) → `crt/<bank>:…` from the flattened offset
  (`types.ts:39`, Bug 17/18).

| legacy record | → graph | Wasteland_EF |
|---|---|---|
| entity, `analysis-import` | `nodes` (generated); per-run duplicates merge by derived id; each legacy id → `evidence` row | 22,246 → **6,605** (RAM kinds 8,158 → 1,311; payload kinds 14,088 → 5,294) |
| entity, manifest / inventory import | `nodes` (generated / imported) | 571 → 571 |
| entity, hand-made | `nodes` (human / user); `summary` → `annotations` kind `entity` | 31 → 31 |
| finding, `analysis-import` | `claims` on the derived node + one `evidence` row per finding; `status=archived` + `archivedBy` → `claims.status='archived'`, `superseded_by` | 9,421 → **1,725** claims, 9,421 evidence |
| finding, `annotation` | folded — the annotation file is the source | 204 → 0 rows, 204 `folded` |
| finding, hand-saved | `annotations` (human / user, kind `finding:<kind>`); `node_id` = derived node of `addressRange` (10), else first of `entityIds` (15), else project-level | 49 → 49 |
| relation, generated | `edges` (generated); endpoints re-resolved by derived id | 7,654 → **3,369** |
| relation, hand | `edges` (human / user) | 17 → 17 |
| question, heuristic | folded into `claims.validation` (`answered` where `answeredByFindingId` is set — 51 here) | 3,640 → 0 rows |
| question, other | `questions` (11 generated / static, 1 human / user) | 12 → 12 |
| user label | `nodes` (human, kind from `targetKind`) carrying `name`; the monitor's label store (Spec 754 §3.3f) re-points here | 0 → 0 |
| `_annotations.json` routine / label / segment | `annotations` (human / imported) on the derived node, created in the human layer when absent | 271 / 1,085 / 228 distinct |
| flow | not migrated — 818's importer regenerates from the analysis artifacts (267/267 present); logged `skipped-regenerable` | 69 → 0 |
| artifacts, tasks, artifact-versions, loader-models, lut-descriptors, phase-plan, workflow-state, project-profile | **not knowledge — stay JSON**, referenced by id string, the same join 817 uses for platform ids | — |

## 6. Coexistence and cut-over — the window is one spec long

Through 818–821 the JSON store is untouched and authoritative and the graph is additive;
822 flips that, in two halves on one branch, with the board carrying 822 as PARTLY BUILT
between them.

1. **822.1 — migrate, dual-write.** `project_graph_migrate` exists. Once it has run in a
   project (`meta.cutover_at` set), every `save_*` door writes the graph first, inside
   its transaction, then mirrors to JSON exactly as today. Readers are unchanged.
   `check:822-drift` projects the graph back into the JSON record shape and diffs it
   against the files; red means a writer bypassed the graph. This is the window, and the
   only time two stores hold the same fact.
   *As built (§11): the window was skipped.* 822.2 went straight to the cut on the spec
   branch — the migration is idempotent and incremental by the ledger, so a project is
   cut over the first time the new code opens it, and there was never a day on which two
   stores held the same fact. `check:822-drift` was therefore not built; the gate that
   closes the window is `check:822-no-json-readers` alone.
2. **822.2 — read from the graph, stop writing JSON.** `list_*`, the view builders,
   `project_search` (D10), the monitor's labels, and `archivePhase1Noise` /
   `sweepQuestionResolutions` (now claim-status updates) read the graph. The JSON mirror
   write is deleted. `knowledge/{findings,entities,relations,open-questions,labels.user,flows}.json`
   move to `knowledge/_legacy-822/`, read-only, kept for one release for `git diff`
   archaeology, then deleted; `project_graph_export` writes the same JSON shape on
   demand. `emitAnnotationFindings` and the `import_annotations_as_findings` door are
   deleted (D6).

**What closes the window** is mechanical, not a date: `check:822-no-json-readers`, the
shape of `check:platform-kb`, fails while anything under `src/` reads one of the six
migrated files. It is red the day 822.1 lands, and 822 is not DONE until it is green. Two
stores for months is the drift 817 exists to kill; here the second store lives exactly
between 822.1 and 822.2, and the gate says on which day that ends.

## 7. Acceptance

`scripts/e2e-822-migrate-wasteland.mjs` (`npm run e2e:822`), against a tmp copy of
Wasteland_EF outside the repo, PENDING without the fixture — the
`smoke-740-project-search.mjs` shape:

- Migration produces the §5 numbers: 6,605 generated nodes from 22,246 entities; 1,725
  claims and 9,421 evidence rows from 9,421 findings; the `$0031` node has one
  `behaves_like=pointer_pair` claim with 58 evidence rows and the newest run's score;
  3,369 generated edges; 0 rows from 3,640 heuristic questions; 49 + 31 + 17 + 1 human
  rows from the store and 271 / 1,085 / 228 annotations from the files; 204 `folded`,
  69 `skipped-regenerable`; every legacy id in `migration_log` exactly once.
- **Idempotence:** a second run yields an identical canonical dump — 818 D6's dump
  extended to every 822 table except `migration_runs`, rows ordered by primary key — and
  zero `created|merged|folded` actions. "Byte-identical" is defined over the dump, not
  the file: SQLite page layout is not deterministic; the fixed decision's intent is the
  content.
- **Human invariant:** `sha256` over the ordered `layer=human` rows of `nodes`, `edges`,
  `annotations` plus `questions.answer*`, before and after a full `analyze_prg`
  re-import of all 30 programs — equal. Then one rename through the door, one more
  re-import — the rename survives and the generated row beneath it gained evidence.
- **Conflict rule:** a node with both layers answers with the human name in
  `graph.find`, the 823 node card and `project_search`; `layer=generated` returns the other.
- **Concurrency:** two processes issue 200 interleaved `save_finding` each — 400 rows,
  none lost. The same run against the JSON path is executed once and its loss count
  recorded: the number that justified D9.
- `check:822-drift` green after 822.1; `check:822-no-json-readers` green at 822.2;
  `smoke:740`, `e2e:758`, `e2e:751`, `smoke:741` green; rebuild byte-identical (`cmp -l`).

## 8. Non-goals

- No pattern layer (`MATCHES_PATTERN`), no cross-project query — named, not built. The
  platform-id join (817) and `project` in the id grammar (818) leave the door open.
- No parsing of `docs/*.md`; no import of the cartography tables (D8).
- No LLM in migration, classification or subsystem membership.
- No migration of artifacts, tasks, versions, loader models, LUT descriptors or workflow
  state (§5, last row).
- No new dependency: `node:sqlite` only, FTS5 as shipped.

## 9. Open questions

- **OQ1 — Which stem is the owner when a program was analysed under several names.**
  Wasteland_EF's combat overlay exists as `ovl_T31b9_7E00_combat_r1…r16` and
  `T31b9-combat` / `T31b9-combat_re`; the normaliser folds the first family, not the
  second. 14 entities have no artifact, one a dangling one. Whether the migration
  refuses above a `ctx-by-stem` ratio or accepts an alias table is decided against
  818's `owner` rules once its resolver exists.
- **OQ2 — `score` against the confidence enum.** Legacy rows carry 0–1 numbers, the
  draft's enum is categorical; 822 keeps both (static → `inferred`/`heuristic` by the
  importer's threshold, door → `user_asserted`, runtime evidence → `observed`). Whether
  anything still reads the number after 822.2 decides if it is dropped.
- **OQ3 — Does the 740.1 cache survive FTS5?** D10 keeps it because docs and ASM are not
  in the graph; a later slice that moves doc sections in makes it a second index.
- **OQ4 — Retention of `_legacy-822/`.** "One release" assumes 716; until then, one
  tagged commit after 822.2.

## 10. Built — what the gate found on the way

`src/knowledge-graph/migrate/{schema-822,classify,migrate,human}.ts`,
`src/knowledge-graph/query-human.ts`, gate `scripts/e2e-822-migrate-wasteland.mjs`
(`npm run e2e:822`). This is **822.1** only: the migration, the widened human door,
the query extensions, the gate. **822.2 is not built** — no reader moved off the
JSON, no JSON write deleted, no `check:822-drift`, no `check:822-no-json-readers`,
no dual-write hook in `service.ts`, no `c64re graph` verbs, no 823 tool. The board
carries 822 as PARTLY BUILT, as §6 said it would.

**The spec's §5 estimates were wrong where they were estimates; the gate asserts
what the resolver measures.** Re-measured 2026-09-06 on the real store (46 936
legacy records + 3 016 annotation-file entries, 942 ms, one transaction):

| legacy | → graph | spec said | measured |
|---|---|---|---|
| 22 246 `analysis-import` entities | generated nodes | 6 605 | **4 612** = 363 `addr` + 2 684 `entry` + 1 565 `segment` |
| 571 manifest / inventory entities | generated nodes | 571 | **377** = 128 `chip` + 64 `bank` + 185 `payload` |
| 31 hand entities | human nodes / prose | 31 | **18 nodes + 22 `entity` annotations + 5 prose** (4 traces, 1 save descriptor: no address) |
| 9 421 `analysis-import` findings | claims + evidence | 1 725 + 9 421 | **1 189 + 9 421** (363 `behaves_like`, 824 `segment_kind`, 2 `display_transfer`) |
| 204 `annotation` findings | folded | 204 | 204 |
| 49 hand findings + 6 manifest | annotations | 49 | 49 human + **3** generated (6 findings, 3 titles) + 55 evidence rows |
| 7 654 generated relations | generated edges | 3 369 | **2 595** (7 398 → 2 467, 256 `contains` → 128) |
| 17 hand relations | human edges | 17 | **12** + 5 folded to prose (an endpoint has no address) |
| 3 640 heuristic questions | `claims.validation` | 0 rows | 0 rows; **55** answered → **8** claims `answered` |
| 12 other questions | `questions` | 12 | 12 (11 generated / static, 1 human) |
| 69 flows | skipped-regenerable | 69 | 69 |
| 16 annotation files | human nodes | 271 / 1 085 / 228 | **317 / 1 341 / 238** by (owner, address) — the spec counted by address alone |
| `$0031` | one claim, 58 evidence | ✓ | ✓ — 56 `pointer_pair`, **2 `counter`**; the claim carries the newest run's value (D5) |
| ctx-by-stem | — | OQ1 | **1 097** entities under 11 rebuild-check / drive-code stems no payload claims |

**Legacy code-segments and entry points are not `routine` / `label` nodes.** §5 said
`entry-point → label`, `code-segment → routine`. The 819 producer INSERTs those ids
plainly inside `replaceGenerated`; a row 822 had put there first would make the next
seed throw on the primary key — and the gate re-seeds 819 after the migration (§7,
human invariant). So 822 writes `entry` and `segment` under the owner: the legacy
segment and the 819 routine at one address are two producers' views, side by side in
`graph find`, and 822's generated kinds (`entry`, `segment`, `payload`, `chip`,
`bank`) never meet 819/820/821's (`routine`, `label`, `addr`, `run`). `addr` is shared
by design (OR IGNORE). The other id decisions: `state_variable` segments, RAM
hypotheses and display states are `addr` (zero page is one space whoever noticed it);
every other segment kind, `unknown` included, stays payload-resident under its owner
(818 D2 — a text segment at `$7E00` in three overlays is three nodes, like code); two
cart images with the same bank layout share `crt/<bank>:chip:8000`, each image in
evidence; an area asset with no load address sits at `:payload:0000` with
`attrs.addressless` — the grammar has no address-less project form yet (818 D1
"later slices append"); a hand entity with no address at all is prose, `folded`.

**Migrated human rows carry `origin=imported`**, whatever the legacy door was, and
`attrs.legacy_origin=user` keeps the fact; door writes after the cut-over are
`origin=user`, `producer=human`. A door row is never overwritten by a re-run
(`kept-door-row` in the log). When a hand entity and an annotation file name the same
address, the file wins the node's name — it is the corpus the disassembler reads (D6)
— and the entity's name and summary survive as its `entity` annotation.

**Idempotence is the ledger, not delete-and-reinsert.** `migration_log` is keyed
`(legacy_store, legacy_id)`; a second run reports every id `already`, performs zero
`created|merged|folded|skipped` actions, and the canonical dump (818 generated + human
+ every 822 table but `migration_runs`, 40 MB) is byte-identical. The same ledger
makes the migration incremental: a record the JSON gains during the 822.1 window is
picked up by the next run, which is what the dual-write window needs.

**Schema deviations from §4**, all additive: `annotations.layer` (the six manifest
findings are generated prose with no node; the human-layer hash needs the column),
`producer` and `attrs` on every 822 table (a re-run and a door must tell their rows
apart), `annotations.seq INTEGER PRIMARY KEY` (FTS5 external content needs a rowid
that survives VACUUM; a TEXT key's does not), `migration_log.note` (`ctx-by-stem` is
a note on a `created` row — one row per legacy id is the invariant). FTS5 is present
in Node 22.21.1 / SQLite 3.50.4 and used; `meta.annotations_text_index` records it and
`searchAnnotations` falls back to LIKE on a build without it.

**The door found a defect in the store.** Two processes writing 200 findings each
through `recordFinding`: the second open failed with SQLITE_BUSY on
`PRAGMA journal_mode = WAL`, which `store.ts` runs *before* it sets `busy_timeout`.
`openStore()` in `human.ts` retries with back-off (400 of 400 rows, 80 ms); the
one-line fix is `new DatabaseSync(path, { timeout: 5000 })` in `store.ts` (D9 said so)
— 818's file, reported, not edited. The same 2 × 200 against the JSON path: **200 of
400 survive, one writer dies on `ENOENT rename findings.json.tmp`** — the number that
justified D9.

**822.2 needed** (2026-09-06, morning): the `service.ts` hooks, `disasm_prg` calling the
annotation-file import, `project_search` re-pointed, `list_*` and the view builders off
JSON, `emitAnnotationFindings` and `import_annotations_as_findings` deleted,
`check:822-no-json-readers`, the `_legacy-822/` move. Built the same day — §11.

## 11. 822.2 — the cut (built 2026-09-06)

**What moved.** `ProjectKnowledgeService` no longer has a JSON store for findings,
entities, relations, open questions or user labels: `storage.ts` lost their path keys,
loaders and savers, `ensureLayout` no longer creates the files, and the five
`*StoreSchema` types are gone. In their place `src/knowledge-graph/records.ts`
(`KnowledgeRecords`) projects the graph into the record shapes everything downstream
has always consumed — `EntityRecord`, `FindingRecord`, `RelationRecord`,
`OpenQuestionRecord`, `UserLabelOverride` — and routes every writer through the 822
doors or the 822 importer:

| the service method | writes | reads back from |
|---|---|---|
| `saveEntity` | human: `upsertHuman` node + `entity` annotation for the summary (payload identity by content hash / (source, load) is an indexed lookup, Bug 31); importer-tagged (`analysis-import`, `manifest-import`, `inventory-import`): the generated layer through `importRecords` | `nodes` (producer 822 \| human, both layers, human first) + folded `entity:*` prose |
| `saveFinding` | human: `recordFinding` → a `finding:<kind>` annotation, evidence rows per ref; importer-tagged → claims; a `claim:` id → that claim's `status` / `superseded_by` | `finding:*` annotations + `claims` (a claim is a generated `hypothesis` finding with one evidence ref per run — `$0031` projects as ONE finding with 58 refs) |
| `linkEntities` | human: `upsertLink` (a human edge, record fields in `evidence`); an endpoint that is prose or unresolved → a `relation:<kind>` annotation, never a throw | `edges` (producer 822 \| human) + `relation:*` prose |
| `saveOpenQuestion` | `upsertQuestion` — a door row is human whatever its `source` (D3) | `questions` |
| `saveUserLabel` | `upsertHuman` on the `addr` node (`attrs.legacy_kind = label-override`) | human nodes with that attr |
| `importAnalysisArtifact` / `importManifestArtifact` | `importRecords` with `purgeArtifactId` (D2: the artifact's evidence rows + ledger entries go, then every 822 generated row nothing backs); heuristic questions fold into `claims.validation` (D4) | — |
| `importAnnotations` (was `emitAnnotationFindings`) | `importAnnotationFile`: re-imported when the file's hash changed (`meta.annotations_imported.<stem>`); rows the door renamed since (producer `human`) are kept | — |

**Ids.** An entity id IS its graph node id; a finding is `ann:<sha1>` (prose) or
`claim:<node>|<claim>`; a relation `edge:<from>|<type>|<to>` (or `ann:` when prose); a
question keeps its id. Legacy ids (`entity-…`, `finding-…`) and caller aliases
(`aj:<ref>`, `entity-payload-<slug>`) resolve through `migration_log`, which is the alias
table: a door write with an unknown alias records it there. `getEntity(legacyId)` on the
cut-over Wasteland copy answers with the graph node (gate).

**What changed shape.** Nothing in the MCP tool output lines; the VALUES of ids did
(above). `list_open_questions` no longer has heuristic rows to hide — the importers'
validation prompts are `claims.validation` (D4), so `include_heuristic` only affects
questions saved through the door with `source=heuristic-phase1`. `list_entities` returns
the graph's 822 + human rows (819/820/821 routines and labels stay behind the `graph_*`
tools; they are not knowledge entities). `dedupe_payload_entities` reports zero groups:
payload identity is derived, the migration merged the legacy duplicates. Flows stay in
`flows.json` (regenerable, not knowledge; `list_flows` and the flow-graph view are
unchanged) — moving them is a later slice, as is anti-patterns (never in the migration).

**The closed loop on claims.** `archivePhase1Noise` runs the same algorithm over the
projections; its coverage is routine findings (tags `routine`/`annotation` + range) PLUS
the human `routine` nodes the annotation files produced (extent = next routine − 1 within
the owner, capped by the containing human segment). A covered hypothesis claim gets
`status=archived`, `superseded_by=<coverer>`; a covered claim's `validation` flips to
`answered` (`validated_by=<coverer>`) — that is the "paired question answered" of the
JSON era, and it is what the sweep footer counts. `sweepQuestionResolutions` is
unchanged (question rows). `emitAnnotationFindings`, `removeFindingsById`'s prefix purge,
`import_annotations_as_findings` (DEFAULT_TOOLS 156 → 155 used, cap unchanged) and
`remapEntityReferences` are deleted; `c64re graph annotations-import <file>` covers a
file `disasm_prg` never saw.

**The cut-over.** `ensureCutover(projectDir)` in `ProjectKnowledgeService`'s constructor
and in `buildProjectSearchIndex`: five `existsSync`; when a legacy file is live and
`knowledge/project.json` exists, `migrateProject` runs (idempotent, incremental), the
five files move to `knowledge/_legacy-822/` (with a README), and the timeline gets one
note. `migrateProject` reads `knowledge/_legacy-822/` when a file is no longer live, so
`c64re graph migrate` re-runs stay idempotent after the move. `meta.cutover_at` is also
stamped by the first door write into a fresh project. `c64re graph export [--out]` writes
the graph back into the five record shapes under `knowledge/export/` for humans.

**Two defects the cut found in 822.1 / 818 code, fixed.** (1) `JSON.stringify(v,
Object.keys(v).sort())` — used for `nodes.attrs`, `edges.evidence` and every 822 `attrs`
column — sorts the top-level keys but, as a replacer ARRAY, drops every nested key not
also a top-level name: a payload's `{format, content_hash}` was stored as `{}`, a medium
span as `[{}]`. `src/knowledge-graph/json.ts` (`canonicalJson`, recursive sort) replaces
it everywhere; the e2e-822 dump comparison is unaffected (both runs serialise the same
way). (2) `upsertHuman`'s conflict branch kept the old `producer`, so a door rename of a
file-imported row still said `822` and a re-import of the file would have overwritten it;
the branch now takes `producer` / `origin` / `confidence` too, and the file import
purges only `producer = '822'` rows for that file (`kept-door-row` holds).

**Gates.** `npm run check:822-no-json-readers` (`scripts/check-822-no-json-readers.mjs`):
every `.ts/.js/.mjs` under `src/` outside `src/knowledge-graph/migrate/**`, `cutover.ts`
and `export.ts` — no line names one of the five files, calls
`load|save(Entities|Findings|Relations|OpenQuestions|UserLabels)`, reaches a
`knowledge(...)` path key for them, or parses a `*StoreSchema`. GREEN. `npm run e2e:822`
grew a §5b: a second fresh copy of Wasteland_EF opened as a project cuts over in ~1 s
(files moved, ledger = 46 936, timeline event), `project_status` counts come from the
graph, `listFindings` = claims + prose with the `$0031` claim as one hypothesis finding
carrying 58 refs, a legacy entity id resolves through the ledger, a second open runs no
migration, and 2 × 200 concurrent `save_finding` THROUGH THE SERVICE land 400/400 in
9.8 s (the JSON path lost 200 of 400 here before the cut; a save projects one record, not
the store). Regression kept green: `test:project-knowledge`, `e2e:751`, `e2e:758`,
`e2e:024`, `smoke:740`, `e2e:748`, `e2e:bug033`, `smoke:bug033-label`, `e2e:759`,
`e2e:750-lut`, `smoke:741`, sprint 37/46/54, `e2e:818`–`823`, `check:platform-kb`,
`check:docs-current`, `e2e-mcp-no-internal-recommendations`, the surface probe (its two
pre-existing fails only), the inventory `--check`. Smoke assertions changed, minimally:
`project-knowledge-smoke` (a nested store is recognised by `artifacts.json`, the audit
cache is refreshed by touching `graph.sqlite`, the import's validation prompts are
asserted as claims), `e2e-751` (`importAnnotations` instead of `emitAnnotationFindings`),
`e2e-024` (the payload is read through the service, not `entities.json`), `e2e-750-lut`
(the payload id is taken from the write's own `ID:` line).
