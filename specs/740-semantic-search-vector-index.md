# Spec 740 — Project Wiki + Knowledge Retrieval MVP

**Status:** 740.1 DONE (2026-05-31) — search/reindex/find-related + wiki skeleton.
740.2 ANSWERED by Spec 847 D6 (2026-09) — not built, not needed. **740.3 READY
(2026-09-19) — the search sees the graph**; that is the open work.
**Owner:** Knowledge layer / MCP product search  
**Depends on:** Specs 730, 711, 721  

## 740.1 — shipped (this slice)

Default tools: `project_search`, `project_find_related`, `project_reindex_search`,
`project_wiki_lint`. Wiki skeleton (`docs/index.md`, `knowledge/activity-log.md`)
scaffolded by `project_init` and `project_reindex_search`. Deterministic index at
`knowledge/.cache/project-search-index.json` (cache, not authority) — NO
embeddings, NO vector DB, NO network. Indexes small records (markdown sections,
one record per structured item, ASM/TASS section headers, selected view records);
never whole large files, never raw bytes, never wholesale `*_analysis.json`.
Ranking is deterministic + explainable with a `why[]` per hit (§9). Gate:
`scripts/smoke-740-project-search.mjs` (28/28) against a tmp copy of Wasteland_EF
covering every §12 query + the MCP-stdio default-surface check.

## 740.2 — answered by Spec 847, not built

`project_wiki_update` was meant to write the curated wiki pages. In four months nothing
did — Ultima VI and Neuromancer both still showed `docs/index.md` at 880 bytes with every
category empty — while the sessions wrote their synthesis anyway, as documents nobody
indexed. Spec 847 D6 answered the need instead: documents declare themselves in
frontmatter, each becomes a `document` node, and `wiki_index` DERIVES the index from those
declarations. A tool that authors the wiki is not needed, so 740.2 is closed unbuilt.
Embeddings remain a later `740.B` option (§11), not planned.

## 740.3 — the search sees the graph (READY, 2026-09-19)

740.1 was built in May against JSON stores. Since then the knowledge moved into the graph
(822.2) and grew three kinds of node the index has never heard of, and the index does not
know when it is out of date. Measured against `src/project-knowledge/project-search.ts`
on 2026-09-19:

1. **Graph kinds.** The index reads findings, open questions, entities and relations
   (822 D10). It does not read the human-layer `routine` and `label` nodes that
   annotation files become (822.2; `listRoutineNodes`), the model's `container` nodes
   (845), the `document` nodes (847; `listDocNodes`) or the user labels
   (`listUserLabels`). A routine the session named is not found by its name unless the
   name also appears in a finding or a Markdown section.
2. **Document depth.** It reads `docs/*.md` at the top level only. 847's scanner finds
   `docs/` at any depth, so Ultima VI's nine model documents under `docs/model/` are
   counted by the critic and invisible to the search.
3. **Renders rank as curated.** A document `render_docs` wrote carries
   `generated: {at, counts}` in its frontmatter (847 D4), and the index files it as a
   curated `doc_section` (+100) beside the live records it copies. 847 made the drift a
   critic check (`stale-render`); the search still serves the old copy at the same rank.
4. **The cache never notices it is old.** `loadOrBuildIndex` returns whatever
   `project-search-index.json` holds; only `project_reindex_search` rebuilds it. A
   finding saved a minute ago is not found, and the answer does not say the index
   predates it — only a zero-hit answer mentions reindexing.
5. **Listings by dialect.** `walkAsm` matches `.asm|.tass`: a project rendered before
   2026-09-06 indexes every listing twice (both dialects), a current one indexes `.asm`
   and skips `.tas`. Harmless today only by accident.

### Decisions

- **D1 — index the human layer of the graph.** `routine` and `label` records (name,
  address range, owner artifact; user labels fold into `label`), `model` records (name,
  level, range), `document` records (title, doc kind, status, `covers` → address range,
  `placeholder`). The generated layer is NOT indexed: those are the thousands of
  mechanical nodes `graph_find` already serves, and this index holds what someone
  learned, in small records. Kind bonus: `document` beside `doc_section`, `model` above
  `entity`, `routine`/`label` below `finding`.
- **D2 — one document set.** The index finds Markdown through 847's scanner
  (`src/docs/scan.ts`), so the search and the critic read the same files. A document with
  frontmatter indexes its sections under its declared title and its `covers`.
- **D3 — a render is a copy.** A file whose frontmatter says `kind: generated` ranks
  `generated` (−40), never curated. If its recorded counts differ from the graph it is
  also `stale` (−150), and the hit's `why` says so with both numbers. The comparison is
  the critic's, moved into one function both call — two implementations of "is this
  render stale" would drift the way the renders do.
- **D4 — the cache knows when it is old.** The cache records a fingerprint of what it
  read: `graph.sqlite` and its `-wal` (size + mtime), each `docs/` directory, each indexed
  listing (mtime). `project_search` and `project_find_related` compare before answering;
  on a mismatch they rebuild, write the cache, and say so in one line (`index rebuilt:
  the graph changed since <builtAt>`). The check sits at the read, where staleness
  costs something — not a hook in every `save_*`. Rebuild is full; measure it on the
  largest real project first, and only split it if that number says to.
- **D5 — one listing per disassembly.** Index `.asm` when present, else `.tas`, else
  `.tass`.
- **D6 — related follows.** `project_find_related` groups routines, labels, model and
  documents, and address overlap uses container ranges and document `covers`: a seed of
  `$C000` returns the container around it, the routine at it and the document that
  declares it.

### Acceptance

1. **`smoke:740-graph`**, new, builds its own project in a temp directory through the
   product's doors — `save_finding`, `disasm_prg` with an annotations file (routines +
   labels), `model_assert`, `doc_register`, `render_docs` — so it depends on no fixture
   and runs in CI (`gates.yml`). It asserts:
   - a routine name, a label, a container name and a document title are each found;
   - an address query returns the container, the routine and the document;
   - a document under `docs/model/` is found;
   - a finding saved after the last search is found by the next one, which says the index
     was rebuilt;
   - after another finding, the render ranks below the live record and its `why` names
     the drift;
   - a legacy `.asm` + `.tass` pair is indexed once.
2. `smoke-740-project-search` (the Wasteland 28) stays green.
3. `PROJECT_SEARCH_INDEX_VERSION` → 2, so every old cache rebuilds on first use.

### Files

`src/project-knowledge/project-search.ts` (D1–D6) · `src/docs/scan.ts` (reused) ·
`src/critic/run.ts` → the render-drift comparison moves to one shared function ·
`src/server-tools/project-search-tools.ts` (the rebuild line, the new kinds in the
`kind` filter) · `scripts/smoke-740-graph.mjs` · `package.json` ·
`.github/workflows/gates.yml`.

### Not in 740.3

- Embeddings (`740.B`) — still not planned.
- The generated layer of the graph — `graph_find` serves it.
- Writing documents — 847 D6.

---

*§1–§13 below are the 740.1 design as written in May 2026.*

## 1. Purpose

Give an external LLM a small, reliable way to understand and navigate a C64RE
project without rediscovering the same facts from raw `.md`, `.json`, ASM, TASS,
view, and trace files on every question.

The product need is **project knowledge compilation + retrieval**, not a full
vector/RAG system:

- maintain a compact, curated wiki layer over the raw sources;
- keep the wiki connected to structured facts, artifacts, addresses, traces, and
  evidence;
- find the right artifact / finding / entity / doc section quickly;
- return short snippets + stable IDs;
- let the LLM then call existing tools (`read_artifact`, `list_artifact_versions`,
  `read_finding`, trace readers, etc.) for the exact source.

This is motivated by real Wasteland usage: the project has a manageable number of
files, but the knowledge is spread across curated Markdown, structured JSON records,
views, analysis runs, ASM/TASS sources, and trace summaries.

## 2. Architecture

Spec 740 adopts a project-local "LLM Wiki" pattern:

1. **Raw / structured sources** — immutable or tool-owned project data:
   `input/`, `analysis/`, `knowledge/*.json`, `views/*.json`, ASM/TASS sources,
   traces, screenshots, evidence records.
2. **Wiki layer** — LLM-maintained Markdown synthesis:
   `docs/*.md`, plus a generated/maintained project index and activity log.
   This layer is the human/LLM reading surface. It summarizes, cross-links, and
   reconciles the raw facts.
3. **Retrieval index** — small project-local cache over wiki + structured records:
   used by MCP tools to find relevant pages, records, artifacts, and source spans.

The raw sources remain authoritative for bytes and machine facts. The wiki is the
compiled understanding. The search index is a cache/navigation aid.

## 3. Product Rule

Do not make the LLM load the whole project into context.

The MCP owns the project wiki conventions and search index. The LLM asks targeted
questions:

```text
project_search("where is $FC00 described?")
project_find_related("artifact-02-2-0-prg")
project_search("copy protection track 36")
project_search("which file contains prodos boot chain?")
```

The tool returns compact ranked hits, not full documents.

When a workflow step discovers new durable knowledge, the LLM must either:

- save it as structured knowledge (`save_finding`, `save_entity`, relation tools),
  and/or
- update the relevant wiki page / index entry through the 740 wiki tools.

Do not leave durable understanding only in chat.

## 4. MVP Shape

Add these default product tools:

- `project_search`
  - Query text plus optional filters (`kind`, `tag`, `address`, `artifact_id`,
    `entity_id`, `limit`).
  - Returns ranked hits with IDs, titles, short snippets, source paths, and why it
    matched.
- `project_find_related`
  - Starts from an artifact/entity/finding/address and walks existing relations,
    artifact versions, evidence links, address ranges, and tags.
  - Returns nearby records grouped by relation type.
- `project_wiki_update`
  - Updates or creates a wiki page from structured inputs: topic, summary, claims,
    linked artifact/entity/finding IDs, source paths, and tags.
  - Use after a meaningful analysis/runtime/disassembly step so the project
    synthesis compounds.
- `project_wiki_lint`
  - Reports stale wiki pages, missing backlinks, orphan records, contradictions
    between wiki claims and structured records, and important records not yet
    summarized in the wiki.
- `project_reindex_search`
  - Rebuilds the local project search index from current project files.
  - Full rebuild is acceptable; C64RE projects are normally small enough
    (<1000 relevant files) that incremental indexing is not required for the MVP.

Optional later diagnostic tool:

- `project_search_status`
  - Returns indexed counts and stale/missing source warnings.

## 5. Wiki Files

The MVP adds two wiki management files:

```text
docs/index.md
knowledge/activity-log.md
```

`docs/index.md` is content-oriented. It lists project wiki pages and key
structured records by category:

- boot / loader flow;
- disk / cartridge / media map;
- code regions / routines;
- assets / graphics / VIC evidence;
- runtime traces / marks;
- open questions / active hypotheses;
- patches / changes.

Each row should contain a title, one-line summary, tags, and source IDs/paths.

`knowledge/activity-log.md` is chronological and append-only. Each entry starts
with a parseable heading:

```md
## [2026-05-31T10:30:00Z] disasm | 02_2.0 relocated loader
```

It records ingests, analysis runs, trace captures, wiki updates, user decisions,
and unresolved contradictions. This gives future LLM sessions the project timeline
without reading terminal/chat history.

Existing curated docs such as `docs/LOADER.md`, `docs/CODE_CARTOGRAPHY.md`,
`docs/GLOSSARY.md`, `docs/SWIMLANES.md`, and `docs/ANTI_PATTERNS.md` are normal
wiki pages and should be indexed.

## 6. Wiki Update Rules

`project_wiki_update` must be conservative:

- update existing pages where possible instead of creating duplicate topic pages;
- preserve human-authored sections unless explicitly replacing stale facts;
- every non-trivial claim must reference a structured source ID or source path;
- when a claim conflicts with an older wiki statement, mark the older statement
  as superseded or add a contradiction note;
- maintain backlinks between wiki pages and structured records;
- append an activity-log entry for every update.

The tool does not invent facts. It compiles facts already present in structured
knowledge, artifacts, trace summaries, source files, or user-provided decisions.

## 7. Index Record Model

Build a simple local index over normalized wiki + structured records:

```ts
type ProjectSearchRecord = {
  id: string;
  kind:
    | "finding"
    | "open_question"
    | "entity"
    | "relation"
    | "artifact"
    | "artifact_version"
    | "doc_section"
    | "wiki_page"
    | "activity_log_entry"
    | "asm_section"
    | "view"
    | "trace_mark"
    | "visual_evidence";
  title: string;
  summary: string;
  snippet: string;
  tags: string[];
  addressRange?: { start: number; end: number };
  artifactIds: string[];
  entityIds: string[];
  relationIds: string[];
  sourcePath: string;
  sourceAnchor?: string;
  updatedAt?: string;
  rankHints?: {
    curated?: boolean;
    currentArtifactVersion?: boolean;
    manual?: boolean;
    generated?: boolean;
    internal?: boolean;
  };
};
```

The index should be rebuildable from project files. It is a cache, not the
authority.

## 8. Data To Index

Index small, meaningful units:

- `docs/index.md`
- `knowledge/activity-log.md`
- `knowledge/findings.json`
- `knowledge/open-questions.json`
- `knowledge/entities.json`
- `knowledge/relations.json`
- `knowledge/flows.json`
- `knowledge/artifacts.json`
- `knowledge/artifact-versions.json`
- curated Markdown sections from `docs/*.md`, `CLAUDE.md`, `knowledge/notes.md`
- selected `views/*.json` records (memory map cells, flow nodes, disk files,
  cartridge banks, annotated listing sections)
- ASM/TASS section headers and labels, not whole source files as one blob
- trace marks and trace summaries, not raw trace rows
- visual evidence records from Spec 710/721 once present

Do not index raw disk/cart bytes.

Large analysis JSONs such as `*_analysis.json` must be summarized into selected
records (segments, entry points, high-confidence facts, relocation proposals) instead
of indexed wholesale.

## 9. Ranking

MVP ranking is deterministic and explainable:

1. Exact address match (`$FC00`, `$DD00`, `T18/S11`, `track 36`).
2. Exact ID/name/title/tag match.
3. Current/best artifact version beats stale versions.
4. Curated records beat generated records:
   wiki pages, `docs/*.md`, manual findings, semantic ASM/TASS > generated
   analysis JSON.
5. Text match over normalized `title + summary + snippet + tags`.
6. Related records with shared `artifactIds`, `entityIds`, address overlap, or
   relation edges.

The result must include a `why` field, e.g.:

```json
{
  "id": "finding-2-0-custom-iec-fastloader...",
  "kind": "finding",
  "title": "2.0 = custom IEC fastloader installer with drive-resident code",
  "snippet": "... copy $C300-$C6FF -> $FC00-$FFFF ...",
  "sourcePath": "knowledge/findings.json",
  "why": ["exact address $FC00", "tag: fastloader", "curated finding"]
}
```

## 10. Storage

Use a simple project-local cache:

```text
knowledge/.cache/project-search-index.json
```

or, if the implementation naturally fits the existing runtime dependency:

```text
knowledge/.cache/project-search.duckdb
```

The MVP must not require an external vector database or network service.

Full reindex is acceptable. The index is not committed by default unless the project
chooses to track caches.

The wiki files themselves are normal project artifacts and should be committed by
the project if the project is under version control.

## 11. Embeddings / Vector Search

Embeddings are explicitly a later `740.B` option, not the MVP.

Only add embeddings if the deterministic index proves insufficient for real project
questions. If added later:

- vectors are an extra ranking signal, not the source of truth;
- records still return stable IDs and snippets;
- exact address / artifact / relation matches must outrank fuzzy embedding matches;
- no cloud dependency may be required for normal product use.

## 12. Acceptance

Use Wasteland_EF as the real-project fixture.

Required queries:

- `project_search("$FC00")` finds the loader/fastloader records, including
  `LOADER.md`, `CODE_CARTOGRAPHY.md`, and the relevant finding/entity/source artifact.
- `project_search("track 36 copy protection")` finds the G64/protection facts.
- `project_search("prodos boot chain")` finds `01_prodos`, `LOADER.md`, and the
  boot sequence docs.
- `project_search("DD00 serial")` finds the custom IEC protocol records.
- `project_find_related("02_2.0")` returns the current/best source version,
  findings, entities, relocation facts, and disk-file artifact.
- Results include stable IDs, source paths, snippets, and `why`.
- No result dumps an entire large JSON or ASM file into the LLM context.
- Reindex works from an arbitrary project path outside the C64RE development repo.
- `project_wiki_update` can create/update a wiki entry for the `02_2.0` loader
  from existing findings/artifacts and records an activity-log entry.
- `docs/index.md` contains a loader/code-cartography entry that links to the
  relevant wiki page, source artifacts, findings, and entities.
- `project_wiki_lint` reports missing wiki coverage for important active findings
  instead of requiring the LLM to discover that gap manually.

## 13. Non-Goals

- No vector database in the MVP.
- No hidden dependency on the C64RE development repo path.
- No raw binary indexing.
- No replacing exact structured tools (`list_findings`, `list_artifact_versions`,
  `trace_store_*`, etc.).
- No “read all docs into prompt” workflow.
- No speculative Knowledge Graph rewrite.
- No automatic rewriting of all docs on every query. Wiki updates are explicit
  workflow actions.
