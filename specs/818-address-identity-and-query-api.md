# Spec 818 — Address identity, banking, and the minimal query API

**Status:** BUILT 2026-09-05 — gate `npm run e2e:818` GREEN (24/0)
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Memory-Nodes" (Address),
§"Banking", §"Edge-Typen" (edge metadata), §"Offene Designfrage" (instructions as
nodes), §"Storage", §"Generated vs Persistent Knowledge", §"CLI", §"Guardrails",
§"MVP Phase 1" (the CLI verb list). Second slice of the draft; keys on Spec 817.
**Anchor:** Spec 817 (store, derived id, `node:sqlite` — OQ2 decided) · Spec 023
(`loadContexts[]`) · Spec 759 (`src/project-knowledge/address-index.ts`) · Spec 741
(`.pseudopc`, relocated artifacts) · Spec 813 (`RegionLens`, `src/project-knowledge/region.ts:14`)
**Touches:** new `src/knowledge-graph/{ids,schema,sqlite,store,query,cli}.ts` (ESM),
`scripts/e2e-818-address-identity.mjs`, `package.json` (`e2e:818`), `src/cli.ts`
(one subcommand), `src/run-cli.ts` (one child flag). **Not touched:**
`src/project-knowledge/storage.ts` and every `knowledge/*.json` — D10.

## 1. What identity is today, measured

**Ids are assigned, per artifact.** `createId(prefix, title)` appends `Date.now()`
in base 36 plus four random characters (`src/project-knowledge/service.ts:97-105`);
artifact records dedupe by path, then content hash (`service.ts:921-932`);
everything analysis-import mints is `stableId(prefix, artifact.id, suffix)`
(`analysis-import.ts:185-187`) — stable, but stable *per artifact*, so a fact about
an address is stated once per file that touches it. Wasteland_EF: 9 680 findings,
9 421 tagged `analysis-import`. The two most repeated titles:

```
'RAM region 0031 behaves like pointer_pair'   56×   from 56 artifacts (55 file names)
'Segment 7E00 classified as code'             52×   from 52 overlay artifacts
```

These are two different things. The first is ONE address (`$31/$32`) used by 56
programs — one node, 56 edges. The second is 52 different routines that load at
`$7E00` — 52 nodes. A key that cannot tell them apart cannot be fixed by
deduplication; it has to carry the *context* of the address.

**Address knowledge is three JSON caches** keyed by artifact stem and 16-bit
masked (`address-index.ts:32,126,181`; `owner` at 56; mask at 61).
`resolveCrossArtifact` returns every covering owner — *"more than one = an
overlap/banking ambiguity the caller surfaces"* (101-105). Known, and pushed to
every caller.

**Banking is a field, not an identity.** `AddressRangeSchema.bank` is optional
(`types.ts:46-51`); `LoadContextSchema` is `{as-stored|runtime|after-decompression,
address, bank}` (`types.ts:111-120`). Wasteland_EF: 727 artifact records, **0** with
a `loadContexts[]` entry. Cart chunks are analysed at their CPU-space load address;
flash offsets are flattened to ≥ `$10000` (`types.ts:39-45`).

**The case that decides the design** — `samples/lnr_boot_02a7_fff7.prg`, image
`$02A7-$FFF7`, analysis under `analysis/tmp/spec-816/`: 330 `call` xrefs; 14
target the KERNAL jump table, 129 more `$E000-$FFFF`, 162 `$A000-$BFFF`.
**14/14, 129/129 and 157/162 of those targets are also decoded instructions inside
the image.** The file's bytes at `$FFD2` are `6C 26 03` — `JMP ($0326)`, the
KERNAL's own CHROUT dispatch — and at `$EA31` they are `20 EA FF`. The image
carries a RAM copy of the KERNAL under the ROM; three of its six entry points
(`$EA31 $FE47 $FE66`, all `vector`) were seeded from it. `$FFD2` in this project
is two things: the ROM routine, and a RAM copy that may be patched. Today it is
one address.

**The store rewrites whole files** — `JSON.stringify` → `.tmp` → `renameSync`
(`storage.ts:217-222`); on Wasteland_EF `findings.json` is 13.5 MB and
`entities.json` 28.7 MB, serialised on every save.

**`node:sqlite` on v22.21.1:** `DatabaseSync` present; prints
`ExperimentalWarning: SQLite is an experimental feature` on first load. Two leak
paths: `src/server.ts:73` appends the pipeline child's stderr to tool output, and
`src/cli.ts` (header comment) records that the host logs every stderr line of the
MCP process as an error. Measured: open a 20 000-row file, one indexed query,
close, ×1 000 = 47 ms — 0.05 ms per open.

## 2. The gap

- No identity survives a re-analysis: a new artifact record is a new id family.
- No identity carries the memory an address lives in — `$FFD2` ROM and `$FFD2`
  RAM, and 52 overlays at `$7E00`, collapse to one key.
- Nothing separates what a producer may regenerate from what a human wrote; the
  six human `routine` entities on Wasteland_EF sit in the same `items[]` as 9 421
  generated findings.
- There is no query. `resolveXrefs` filters a flat list by 16-bit address; no
  caller/callee, no path, no "who uses CHROUT" without knowing that CHROUT is
  `$FFD2` and that this image also has a `$FFD2`.

## 3. Decisions

**D1 — The id is derived from the memory, not from the CPU address.** Nothing
assigns an id. Two files, one grammar:

```
id           = platform-id | project-id
platform-id  = platform ":" pkind ":" addr
platform     = "c64" | "c1541"                     ; PlatformTag, src/platform-kb/schema.ts
pkind        = "zp" | "ram" | "io" | "rom"         ; Spec 817's kinds — zp and io are hardware distinctions the renderer keys on
project-id   = project ":" ctx ":" kind ":" addr
subsystem-id = project ":sub:" name               ; Spec 822 — a subsystem has no address
project      = slug                                ; knowledge/project.json "slug" (storage.ts:811)
ctx          = "ram" [ "/" owner ] | "crt/" bank | "drv" [ "/" owner ]
owner        = 1*( "a"-"z" | "0"-"9" | "_" | "." | "-" )   ; artifact stem (address-index.ts:56), lowercased
bank         = 2*4 hexdigit                        ; cart bank; no leading zeros beyond two digits
kind         = "routine" | "label" | "addr"        ; 818/819 — later slices append, never rename
addr         = 4*4 hexdigit                        ; 16-bit CPU-space address, lowercase
hexdigit     = "0"-"9" | "a"-"f"
```

The library refuses a row that breaks a rule and names the rule: `addr` is
exactly four lowercase hex digits (never a flattened cart offset); `routine` and
`label` under `ram`/`drv` require an owner; `addr` under `ram`/`drv` forbids one
(an address is an address, whoever is there); `crt` always carries the bank; a
slug equal to a platform tag is refused. `space`, `owner`, `bank`, `address`,
`kind` are stored denormalised for indexing and the store asserts
`deriveId(columns) === id` on every write — there is no second key to drift.

| id | what it is |
|---|---|
| `c64:rom:ffd2` · `c64:io:d018` · `c64:zp:0031` | CHROUT · VMCSB · ZP `$31`, the node the 56 findings collapse to (platform, Spec 817) |
| `lnr:ram/lnr_boot_02a7_fff7:routine:ffd2` | the RAM copy of CHROUT inside lnr_boot's image — a different node |
| `wasteland-easyflash-crack:ram/block2_engine_0200:routine:1dd2` | `print_string` in the resident engine |
| `…:ram/main_ovl_7e00:routine:7e00` · `…:ram/char_ranger_overlay_7e00:routine:7e00` | two of the 52 overlays at `$7E00`, kept apart |
| `…:ram/reloc_fc00:routine:fc00` | the relocated fastloader at the address it RUNS (Spec 741) |
| `…:crt/07:routine:8000` · `…:drv/t18s11_0700:routine:0700` | EasyFlash bank 7 code · 1541-resident drive code |
| `…:ram:addr:c000` | RAM `$C000`, referenced, nobody known to be there |

**D2 — The context token names WHERE THE BYTES ARE, not which `$01` the CPU
had.** `ram/<owner>` is main RAM as loaded by one artifact — the artifact is the
overlay, and an overlay is the disk world's bank. `crt/<bank>` is a cartridge bank
at the CPU-space mapping its chip header declares; the bank number comes from the
CRT manifest / `loadContexts[].bank`, never from a file name. `drv` is 1541 RAM.
ROM is never a project context: the ROM is the platform's. **RAM under ROM needs
no token of its own** — it is `ram` at an address ≥ `$A000`, a second node next
to `c64:rom:…` because it is a second memory. Which of the two a `jsr $FFD2`
reaches depends on `$01` at that instant: a property of the EDGE (evidence carries
the bank/config when known) and of the runtime slice that observes it (821), not
of either node. A relocated block is keyed at
its runtime address under the artifact that runs there — already a separate
artifact today (`reloc_FC00_analysis.json`, Spec 741 §6); the file position is an
attribute (`stored_at`).

**D3 — Instructions are evidence on edges, not nodes.** The draft leaves this
open; here it is closed, for a sharper reason than graph size. An instruction has
no identity that survives what C64RE works on: relocation moves it, depacking
creates it, self-modifying code rewrites it in place (`lda $FFFF,y` with the
operand patched at runtime — Spec 741 §2a). A routine and its target survive all
three; an edge hangs on those two and carries the instruction as evidence.

**D4 — Three provenance columns on every row, both tables.** `origin ∈ {static,
runtime, user, imported}`, `confidence ∈ {certain, inferred, observed, heuristic,
user_asserted}`, `layer ∈ {generated, human}` — CHECK constraints, not
conventions. Today's numeric confidences map by provenance, not by threshold:
`confirmed_code` → `certain`, `probable_code` → `heuristic`, a runtime
observation → `observed`, a human statement → `user_asserted`; `inferred` is a
producer's own deduction (D2's ambiguous ROM/RAM call).

**D5 — Generated rows are replaceable; human rows are untouchable.** `layer` is in
the primary key, so one id has at most one `generated` and one `human` row. A
producer replaces its own rows by `(producer, owner)` — delete, then insert — and
the store exposes no statement that can touch `layer = 'human'`. When a generated
row disappears, a human row at the same id is **orphaned, reported, kept**. Query
results merge the two: a human name or attribute overrides the generated one, and
each row still says which layer it is.

**D6 — Idempotence is proven, not assumed.** Running a producer twice on the same
input yields the same generated layer. "Same" is the canonical dump — `nodes`
where `layer='generated'` ordered by `id`, `edges` ordered by `(from_id, type,
to_id, evidence_key)`, as JSON lines — byte-identical. Generated rows carry no
timestamp; the SQLite file may differ in page layout, which is why the file is not
what is compared. Every spec from here on carries this line and its gate runs it.

**D7 — Two files, joined by a string.** `resources/platform-kb.sqlite` (Spec 817,
committed, its own two-table schema — `platform_node` / `platform_region` — read
through 817's reader) and `<project>/knowledge/graph.sqlite` (this schema). A project edge
names a platform node by its id string; the query layer opens both read-only and
resolves the string — no `ATTACH`, no cross-file SQL. A platform id the platform
file does not know is a **dangling reference**: returned as such, never dropped.
`meta` records the platform revision the generated layer was built against.

**D8 — The query API ships here and is the acceptance instrument of every later
slice.** `src/knowledge-graph/query.ts`, ESM, synchronous:

```ts
openGraph(projectDir, opts?: { platformDb?: string }): Graph
graph.callers(id): EdgeRow[]                       // CALLS | CALLS_ROM into id
graph.callees(id): EdgeRow[]                       // CALLS | CALLS_ROM out of id
graph.readers(addr: AddrSpec): EdgeRow[]           // READS into the node(s) at addr
graph.writers(addr: AddrSpec): EdgeRow[]           // WRITES into the node(s) at addr
graph.references(addr: AddrSpec): { into: EdgeRow[]; outof: EdgeRow[] }
graph.find(q: string): NodeRow[]                   // "$D018" | "d018" | exact id | name substring; both layers merged
graph.path(from: string, to: string, opts?: { types?: EdgeType[]; maxDepth?: number }): EdgeRow[] | undefined
```

`AddrSpec` is `"$1DD2"`, a number, or `{ address, space?, owner?, bank? }`; an
address alone returns rows for EVERY node at that address across contexts, each
naming its node — the ambiguity is visible, not resolved silently. At 818 the
functions answer over whatever nodes exist (the platform's, a fixture's);
`readers`/`writers` gain rows when Spec 820 (memory access) lands. Later specs
extend this module; none replaces it. CLI via the Spec 044 subcommand router in
`src/cli.ts`: `c64re graph callers|callees|readers|writers|references|find
<id|$addr|name> [--project <dir>] [--json]`, `c64re graph path <from> <to>`. Human
output is a table; `--json` is one document on stdout and nothing else. MCP tools
over this API are Spec 823.

**D9 — The experimental warning does not leak, and a gate proves it.**
`src/platform-kb/sqlite-quiet.ts` (Spec 817) is the ESM tree's one importer of
`node:sqlite` — the graph store reuses it — and installs a `warning` filter scoped
to the SQLite `ExperimentalWarning` before a `createRequire` of the module (a
static import would be hoisted above the filter). The CommonJS pipeline reader
(`pipeline/src/lib/platform-kb.ts`) is the other importer, by necessity of the
dual compilation, with the same filter.
`src/run-cli.ts` adds `--disable-warning=ExperimentalWarning` to the child's argv,
because `server.ts:73` forwards child stderr. The gate asserts `stderr === ""`.

**D10 — Additive, until 822.** The JSON store keeps working exactly as it does;
818–821 write only `knowledge/graph.sqlite`. Spec 822 migrates findings, entities
and relations; nothing before it deletes or rewrites a JSON file. The gate asserts
the mtimes of `knowledge/*.json` are unchanged by a seed.

## 4. Schema

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- schema_version · project_slug | platform · platform_kb_revision · producers (JSON)

CREATE TABLE nodes (
  id           TEXT    NOT NULL,          -- D1 grammar; deriveId(columns) === id asserted on write
  layer        TEXT    NOT NULL CHECK (layer IN ('generated','human')),
  kind         TEXT    NOT NULL,          -- routine | label | addr | reg | rom | mem | later slices
  space        TEXT    NOT NULL,          -- the lens: ram | io | rom | crt | drv  (RegionLens minus cpu; cart = crt)
  owner        TEXT,                      -- grammatical owner from the id; NULL for addr, crt and platform nodes
  bank         INTEGER,                   -- crt only
  run_owner    TEXT,                      -- the producing RUN's artifact stem: the replacement unit (D5); NULL for shared addr nodes
  address      INTEGER NOT NULL CHECK (address BETWEEN 0 AND 65535),
  end_address  INTEGER CHECK (end_address IS NULL OR end_address >= address),
  name         TEXT,
  attrs        TEXT    NOT NULL DEFAULT '{}',   -- JSON; per-kind keys owned by the producing spec
  origin       TEXT    NOT NULL CHECK (origin IN ('static','runtime','user','imported')),
  confidence   TEXT    NOT NULL CHECK (confidence IN ('certain','inferred','observed','heuristic','user_asserted')),
  producer     TEXT    NOT NULL,          -- '817' | '819' | 'human' | …  — the replacement unit (D5)
  evidence     TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (id, layer)
) STRICT;
CREATE INDEX nodes_address ON nodes (address, space);
CREATE INDEX nodes_owner   ON nodes (owner, kind);
CREATE INDEX nodes_name    ON nodes (name);

CREATE TABLE edges (
  from_id      TEXT    NOT NULL,
  type         TEXT    NOT NULL,          -- CALLS | CALLS_ROM | JUMPS_TO | BRANCHES_TO | CONTAINS | later slices
  to_id        TEXT    NOT NULL,          -- may name a platform node; resolved by string (D7)
  layer        TEXT    NOT NULL CHECK (layer IN ('generated','human')),
  evidence_key TEXT    NOT NULL DEFAULT '',   -- what makes this instance distinct; static: 'src:<hex4>'
  origin       TEXT    NOT NULL CHECK (origin IN ('static','runtime','user','imported')),
  confidence   TEXT    NOT NULL CHECK (confidence IN ('certain','inferred','observed','heuristic','user_asserted')),
  producer     TEXT    NOT NULL,
  owner        TEXT,                      -- owner of from_id — the replacement unit for edges
  evidence     TEXT    NOT NULL DEFAULT '{}',   -- JSON: source_address, instruction, operand, mnemonic, bank?, ambiguity?, candidates?
  PRIMARY KEY (from_id, type, to_id, layer, evidence_key)
) STRICT;
CREATE INDEX edges_to   ON edges (to_id, type);
CREATE INDEX edges_from ON edges (from_id, type);
```

No foreign keys: a `to_id` may live in the other file (D7) and a human edge may
outlive its generated endpoint (D5) — dangling is a query result, not a
constraint violation. `kind` and `type` carry no CHECK because later slices append
values; `schema_version` gates readers. The lens of a project id follows its ctx
(`ram`/`drv` → `ram`, `crt` → `crt`), of a platform id its pkind (`reg` → `io`,
`rom` → `rom`, `mem` → `ram`); a `drv` owner's platform is `c1541`.

## 5. Acceptance

- `deriveId`/`parseId` round-trip every id in the D1 table; malformed ids
  (uppercase hex, five digits, `routine` without owner, `addr` with owner, `crt`
  without bank, slug `c64`) are refused with the rule named.
- Seeding a fixture twice yields a byte-identical canonical dump (D6); the gate
  prints both hashes.
- A `human` row survives a re-seed unchanged; with its generated twin removed,
  `find` still returns it and flags it `orphaned`.
- A project edge to `c64:rom:ffd2` resolves through the platform file; one to
  `c64:rom:0000` comes back dangling, not dropped.
- `find("$7e00")` on a two-overlay fixture returns two routine rows with different
  owners; `find("$0031")` returns the platform node.
- `c64re graph find '$D018' --json` parses as JSON on stdout with empty stderr,
  under the Node binary the MCP server uses (D9); open + one query + close is
  printed and below 1 ms (measured 0.05 ms).
- After the gate, every `knowledge/*.json` in the fixture project keeps its
  original mtime (D10).
- Gate: `npm run e2e:818` → `scripts/e2e-818-address-identity.mjs`, hermetic
  temp project; brings its own three-node platform fixture when
  `resources/platform-kb.sqlite` is absent, so it does not wait on 817's parsers.

## 6. Non-goals

- No producer of project nodes — 819 is the first (control flow), 820 (memory
  access) the second. 818 seeds only what its gate needs.
- No migration of findings/entities/relations/annotations (822), no MCP tools
  (823), no UI, no `$01` configuration model in the id (D2).
- No second copy of anything: no `BELONGS_TO` row next to `CONTAINS`, no name
  table next to `nodes.name`.

## 7. Open questions

- **OQ1 — A cart bank seen in two modes.** EasyFlash ROMH bank *n* is `$A000` in
  16k mode and `$E000` in ultimax mode: the same bytes, two ids under D2.
  Wasteland_EF uses one mode per bank. If a project switches mode on one bank,
  either the chip-relative offset joins the grammar (`crt/07h:…`) or the pair is
  linked by an edge. Deferred until a project needs it.
- **OQ2 — Owner rename.** Renaming an artifact file renames every id under it and
  orphans every human row: either a `renameOwner` that rewrites both layers, or
  the stem is pinned in the artifact record.
- **OQ3 — RESOLVED with 817's kinds.** 817 was built first, with `zp`, `ram`,
  `io`, `rom`; this spec's first draft had `reg`/`rom`/`mem`. `zp` and `io` are
  hardware distinctions the renderer keys on (a zero-page comment and a register
  comment have different shapes), and folding them away loses information the
  address alone does not give back. The grammar above carries 817's four; the
  separator and address form (`:`, four lowercase hex) are this spec's, and 817's
  ids were moved onto them (`c64:io:d018`).
- **OQ4 — Probable-code routines.** A `probable_code` run's start moves when
  coverage changes, so a routine keyed on it is unstable; 819 decides the key.

## 8. Built — what the gate found on the way

`src/knowledge-graph/{ids,schema,store,query,cli}.ts`, `c64re graph <verb>`
wired into `src/cli.ts`, `--disable-warning=ExperimentalWarning` on the
pipeline child in `src/run-cli.ts`, gate `scripts/e2e-818-address-identity.mjs`.

**The replacement unit is not the grammatical owner.** D5 said "replace by
`(producer, owner)`". The first gate run failed on the primary key: an `addr`
node has no owner by grammar, so a re-seed could not delete it and re-inserted
it. `crt/<bank>` nodes have the same shape — no owner, a bank. The store now
carries `run_owner` (the producing run's artifact stem) as its own column, and
that is what a run replaces. `addr` nodes are "an address, whoever is there":
shared by every run that references them, inserted OR IGNORE, deleted by no run.
The DDL in §4 and D5 say so now; the lesson is the same as 817 §9 — the gate
found the defect the day it existed.

Measured: open + query + close 0.63 ms in-process; `c64re graph find '$D018'
--json` 117 ms including Node start, stderr empty. Grammar refusals name their
rule (`routine-needs-owner`, `addr-no-owner`, `crt-needs-bank`,
`slug-is-platform`, `addr`, `pkind`). Human row survives a re-seed and is
reported `orphaned` when its generated twin is gone; `c64:rom:0000` comes back
dangling, `c64:rom:ffd2` resolves to CHROUT through the platform file.
