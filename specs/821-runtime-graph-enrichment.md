# Spec 821 — Runtime graph enrichment

**Status:** PROPOSED (2026-09-05)
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Runtime Graph Enrichment" /
§"Confidence und Unsicherheit" / MVP Phase 3 / Guardrail "Runtime-Beobachtungen dürfen
nicht automatisch als statische Wahrheit gelten" — the fourth slice; fills the NULL 820 D3
leaves on purpose.
**Anchor:** `DOCTRINE.md` rules 4 (traces go into the store) and 5 (static-first: runtime
verifies what was read) · 726.B (`.c64retrace` = authority, DuckDB = index) · 753 (exact
EA + `old_value`) · 785 §2.1 (used-in-this-run, never unused) · 802 (one DuckDB read path)
**Touches:** `src/knowledge-graph/` (importer + queries), `src/trace/capture-stream.ts` +
`src/analysis/flow-focus.ts` (consumed, unchanged), one MCP tool, `scripts/e2e-821-*.mjs`.

## 1. What exists today

The runtime observation is already captured, exactly, at the source.

**The record.** `src/trace/binary-format.ts:37-55` — `TraceOp.RAM_WRITE (0x11)` and
`IO_WRITE (0x12)` carry `cycle f64 · addr u16 · value u8 · pc u16 · access` (bit 0
read/write, bit 7 old_value present) `· old_value u8` (`encodeMemAccess`, lines 170-190,
Spec 753). `CPU_STEP (0x10)`: `cycle · pc · opcode · a x y sp p · b1 b2` (lines 150-168).
`MARK (0x01)`: `cycle · label` (line 262). `CART_READ (0x36)`: `cycle · bank · slot ·
offLo offHi · bytes` (Spec 785). The header (`TraceFileMeta`, lines 92-104): `runId ·
defId · domains · cycleStart · mediaSha · createdAt`. `addr` is the **effective address**
— the CPU computed it to perform the access — so `sta ($12),y` arrives as the byte it
hit: 115 000 such writes from one pointer, invisible to any decode of the instruction row.

**Two readers, deliberately.**
- `src/trace/capture-stream.ts:105` `streamCaptureEvents(path, onEvent)` — the ONE
  streaming reader of a `.c64retrace`: bounded windows, nothing materialized (BUG-052; one
  real firehose was 2 136 107 703 bytes / 118 496 006 events). Used by
  `loader-lens.ts:552-578` for the 784/785 lanes. **In this process, no daemon.**
- `src/server-tools/trace-read.ts` — Spec 802: every DuckDB read goes to the daemon
  (`trace/read`: `index · store_fn · map · swimlane · taint`); C64RE keeps no second
  DuckDB reader. `query_events` / `follow_path` have "no native reader yet" (lines 20-24).

**The derivations.** `src/analysis/flow-focus.ts:78` `deriveFlow(steps)` classifies each
retired instruction as `main | irq | nmi` from the SP delta (`delta === 3 && op !== BRK`
→ hardware interrupt entry; header lines 10-31) — derive-at-read, no format change.
`trace_memory_map` (Spec 753 P3) groups accesses per page — CODE / DATA-W / DATA-R /
untouched, writer-PC count, `old ≠ new` mutations — under a mandatory banner "COVERAGE =
THIS RUN ONLY" (`traces/e2e746.memorymap.md`: 161 pages `data-w-mut`, 178 writer PCs,
123 827 mutations in one run). It is a sidecar `.md`, "deliberately NOT a registered
knowledge artifact" (753 §10): a trace is behaviour, not grounding (Spec 752).

**The precedent for the asymmetry.** `scripts/e2e-785-cart-readset.mjs:4-8`: *"the
read-set proves USED-IN-THIS-RUN and NEVER UNUSED. A span the run did not touch is 'not
seen in this run' and must not fail a verdict."* 821 carries that rule to memory access.

**What is missing.** Nothing about a run reaches the project's knowledge. The memory map
is a loose file; `runtime_resolve_pc` (`runtime.ts:336-350`) answers a PC and forgets;
the discipline gate demands a read-derived hypothesis from every runtime tool and has
nowhere to record whether the run confirmed it. After 820 the graph holds 203 INDIRECT
edges on lnr_boot with `to_id IS NULL`, next to a trace that knows every target.

## 2. The gap

"What did `$20/$21` actually point at?" is answerable today by hand — `trace_store_query`
over `bus_events` filtered on `pc`, then reading rows — not by the graph, not across runs,
not as a fact with a home. And the guardrail the draft states in bold, runtime never
becomes static truth on its own, is enforced today by banner text.

## 3. Decisions

**D1 — Same edge types, `origin='runtime'`. No `*_RUNTIME` family.** The draft's
`READS_RUNTIME` is the same fact with a different provenance, and provenance is already a
column on every row (`origin ∈ {static, runtime, user, imported}`). A second type family
makes `writers($D018)` two queries and every consumer filter twice. The consequence,
stated: **a query returns both by default, each row labelled** — `writers('c64/$D018/
register')` lists the static `sta $D018` at `$8421` (`origin=static · certain`) and the
observation at `$8421` (`origin=runtime · observed · run=…`) as two rows; `--origin
static|runtime` narrows. `readers`/`writers` gain an `origin` column, nothing else.

**D2 — One runtime row per `(pc, effective address, run)`; the row is the observation.**
Columns: `pc`, `to` = `ea`, `run_id` (`TraceFileMeta.runId`), `first_cycle`, `last_cycle`,
`count`, `mutations` (`old_value` present and `≠ value`; 753 excludes `$00/$01` and I/O
from the pre-read), `values_json` (first 8 distinct), `flow` (`deriveFlow`), `bank_ctx`
(D5). `from` is the routine containing `pc` in 818's partition — a static
attribution of a runtime pc, correct while the code at `pc` is the code the static side
knows. **When `CPU_STEP.opcode` at that pc disagrees with the static instruction, `from`
is an Address node and `note='opcode mismatch'`** — a relocation, depack or self-mod the
static side missed, said rather than guessed.

**D3 — A runtime observation CONFIRMS; it never promotes.** Confirmation is a new row,
never an update:
- static `READS_INDIRECT(pointer_zp=$20, to=NULL, heuristic)` at `pc` + runtime accesses
  at that `pc` → runtime `READS(to=$A734, origin=runtime, observed, via_zp=$20, run_id)`,
  one per distinct `ea`. The static row **stays**, `to_id` stays NULL;
  `indirectAccesses(routine)` shows the unknown *and* the observed targets beneath it.
- static `WRITES($D018, certain)` at `pc` + runtime rows at `pc` → a runtime WRITES row
  with `count` and `values_json`. Two rows, one fact seen from two sides.
- a static edge with **no** runtime rows at its `pc` → nothing. Not "unused", not "dead"
  — not seen in this run (785 §2.1).
- a runtime row at a `pc` with **no static edge** → edge from an Address node,
  `note='no static edge'`: the list of what the static pass missed.

No importer path writes `origin='static'`, and no path changes `confidence` on an
existing row. The gate proves both (§6).

**D4 — The importer reads the `.c64retrace`, never the DuckDB.** Rule 4 and 726.B: the
binary log is the authority, the index a query aid. `streamCaptureEvents` is in-process,
bounded and daemon-free — so `graph import-trace <run.c64retrace>` works on a checkout
with no runtime and on a 2 GB log. The fold: per `(pc, addr, access)` → counts, first/last
cycle, mutations, a bounded value set; per CPU_STEP → the flow lane in force, carried
forward, so an access at cycle *c* takes the lane at *c* without collecting 118 M steps.
The DuckDB is not opened; `trace/read` is not called. This mirrors 802 rather than
excepting it: 802 removed a *second* DuckDB reader; the binary reader was never
duplicated and already serves 784/785.

**D5 — Bank context is reconstructed, and marked as such.** The trace has no bank-state
record. The importer tracks the last write to `$01`, `$DD00` and the cart bank register
the project's cart type names (EasyFlash `$DE00`; Spec 795 knows the family) and stamps
every runtime edge with `bank_ctx` — 818's `ctx` token when the values map to one, else
the raw triple `01=xx dd00=xx cart=xx`. `CART_READ` records, when present (785 lane
armed), are authoritative for `$8000-$BFFF`. `bank_ctx_conf` is `observed` for a value
the run wrote, `inferred` for the pre-run default (`$01=$37`, `$DD00=$97`). This is what
"Welche Routinen laufen nur in Cartridge Bank 7" needs, labelled a reconstruction so
nobody reads it as a captured fact.

**D6 — A run is a node; import is idempotent.** A `Run` node (`kind=run`; `run_id`,
`media_sha`, `def_id`, `cycle_start`, `cycle_end`, the `.c64retrace` path and byte size)
owns its edges: derived identity `(from_id, type, to_id, pc, run_id)`. The same file
twice → zero new rows; a different file with the same `runId` → that run's rows replaced;
removing the run removes its edges. Runtime rows are `layer=generated`, `producer='821'`;
a human confirming one writes a `human` row (`user_asserted`) and keeps the runtime row.

**D7 — IRQ paths are runtime-origin edges, not a new lane.** For each handler-entry pc
`deriveFlow` classifies, the importer writes `HANDLES_IRQ(from=routine, origin=runtime,
count, run_id)`, `HANDLES_NMI` likewise — with the A-limitation `flow-focus.ts:24-28`
states (an NMI taken from main flow with no vector hint reads as `irq`); `nmiVector` is
passed from the static `$FFFA/$FFFB` contents when the image has them. Runtime-origin
only: a static HANDLES_IRQ from `$0314`/`$FFFE` vector writes is 818's.

## 4. Schema

```sql
-- node: 818's table. 821 adds one kind, run, and its columns.
--   id = <project>/run/<runId>          (818 grammar, illustrative)
ALTER TABLE node ADD COLUMN run_id       TEXT;      -- kind=run only
ALTER TABLE node ADD COLUMN media_sha    TEXT;      -- TraceFileMeta.mediaSha
ALTER TABLE node ADD COLUMN def_id       TEXT;      -- TraceFileMeta.defId
ALTER TABLE node ADD COLUMN cycle_start  INTEGER;
ALTER TABLE node ADD COLUMN cycle_end    INTEGER;
ALTER TABLE node ADD COLUMN trace_path   TEXT;
ALTER TABLE node ADD COLUMN trace_bytes  INTEGER;

-- edge: 820's pc / addr_mode / pointer_zp / via_zp are reused. 821 adds:
ALTER TABLE edge ADD COLUMN run_id        TEXT;     -- → node.run_id
ALTER TABLE edge ADD COLUMN first_cycle   INTEGER;
ALTER TABLE edge ADD COLUMN last_cycle    INTEGER;
ALTER TABLE edge ADD COLUMN count         INTEGER;
ALTER TABLE edge ADD COLUMN mutations     INTEGER;  -- old_value present AND old_value != value
ALTER TABLE edge ADD COLUMN values_json   TEXT;     -- first 8 distinct values
ALTER TABLE edge ADD COLUMN flow          TEXT;     -- main | irq | nmi
ALTER TABLE edge ADD COLUMN bank_ctx      TEXT;     -- D5: 818 ctx token, or '01=37 dd00=97 cart=-'
ALTER TABLE edge ADD COLUMN bank_ctx_conf TEXT;     -- observed | inferred
ALTER TABLE edge ADD COLUMN note          TEXT;     -- 'opcode mismatch' | 'no static edge'

CREATE UNIQUE INDEX edge_821_identity
  ON edge(from_id, type, COALESCE(to_id,''), pc, run_id) WHERE producer = '821';
CREATE INDEX edge_run  ON edge(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX edge_flow ON edge(flow)   WHERE flow   IS NOT NULL;

-- invariant, enforced in the importer AND asserted by the gate:
--   producer='821'  ⇒  origin='runtime' AND confidence='observed' AND layer='generated'
```

Types added: `HANDLES_IRQ`, `HANDLES_NMI`. Everything else reuses 820's `READS WRITES
USES_ZP USES_HARDWARE`; runtime USES_ZP / USES_HARDWARE derive from `ea` as 820 D2 does.

## 5. Query API

Extends `src/knowledge-graph/`:

- `runtimeObservations(routine | address, {run?})` — every runtime edge touching it,
  grouped by run: `pc · ea · count · mutations · flow · bank_ctx`.
- `pointerTargets(zp, {run?})` — "what did `$20/$21` actually point at": the D3
  confirmations for that `pointer_zp`, **distinct `ea`s collapsed into contiguous spans**,
  so 115 000 rows read as `$0400-$07E7 (1 000 writes, 38 distinct)`.
- `readers` / `writers(…, {origin})` — 820's, with D1's column and filter.
- `unconfirmed(routine)` — static edges with no runtime row in any imported run: "not
  seen", never "unused".
- `unexplained(run)` — runtime edges with `note` set: back to the code.
- `irqHandlers({run?})` — D7.

MCP: one tool, `graph_import_trace(path, project_dir)`; the queries ride 818's query
tool. Import is **not** wired into `runtime_trace_finalize` — it already returns the
`Timeline:` path (`headless.ts:283-330`); the LLM imports on purpose, or every idle trace
becomes a graph mutation.

## 6. Acceptance

Gates: `scripts/e2e-821-runtime-enrichment.mjs` (`npm run e2e:821`) and
`scripts/e2e-821-real-trace.mjs` (`npm run e2e:821-real`).

- **Synthetic capture, no daemon.** The gate encodes a `.c64retrace` with
  `encodeFileHeader` + `encodeCpuStep` + `encodeMemAccess` + `encodeMark` (precedent:
  `e2e-785-cart-readset.mjs:47-60`, `e2e-drive-head-decode.mjs:36-46`) whose stream
  matches 820's synthetic PRG: the `lda ($20),y` hits `$A734 $A735 $A736`; the `sta ($FB),y`
  hits `$0400`; `sta $D018` runs 3× with values `$15 $15 $1D`; one IRQ entry (SP delta 3
  into a handler pc) executing `inc $D019`; a write of `$35` to `$01` before an `$A000`
  read. Asserts:
  - three runtime READS to `$A734..$A736`, `via_zp=$20 · origin=runtime · observed`; the
    static READS_INDIRECT row **unchanged** — same rowid, `to_id IS NULL`, `heuristic`.
  - runtime `WRITES($D018)`: `count=3`, `values_json=[21,29]`; the static row still
    `certain`; `writers` returns both rows with their `origin`.
  - the `inc $D019` rows carry `flow='irq'`; `HANDLES_IRQ` for the handler pc, `count=1`.
  - the `$A000` read has `bank_ctx` for `$01=$35`, `bank_ctx_conf='observed'`; accesses
    before that write carry `inferred`.
  - the `sta ($FB),y` observation exists, `note IS NULL`; its static row still NULL.
- **Invariant.** `SELECT count(*) FROM edge WHERE producer='821' AND (origin<>'runtime'
  OR confidence<>'observed' OR layer<>'generated')` = 0 after import — and still 0 after
  the gate calls the importer with a forged `origin='static'` option, which must throw.
- **Idempotence.** Same file twice → row count and a dump of `producer='821'` rows
  byte-identical. A byte-different file with the same `runId` → previous rows replaced,
  no orphans, the `Run` node updated in place.
- **No daemon.** `e2e:821` runs with the runtime port pointed at a closed port and
  passes; a spy on `trace-read.ts` asserts `trace/read` was never called.
- **Real trace, skipping LOUDLY.** `e2e:821-real` needs a `.c64retrace` minted by TRX64
  (`trx64cli … --trace run.c64retrace --trace-domains c64-cpu,memory`, precedent
  `e2e-785-cart-readset.mjs:16-21`) and its `_analysis.json`, via `C64RE_821_CAPTURE` +
  `C64RE_821_ANALYSIS`. Absent, it prints the recipe and exits 0 with `GREEN 821
  real-trace: skipped (no capture)` (precedent `e2e-750-real.mjs:27-33`). **There is no
  checked-in `.c64retrace` fixture**: `traces/` is gitignored (`.gitignore:30`),
  `samples/traces/` is not whitelisted, `tests/spec-788/` holds no trace.
  `traces/cross.c64retrace` (628 B), `analysis/runs/idle-probe.c64retrace` (516 B) and
  `traces/e2e746.c64retrace` (42 MB) are local working files — OQ2.
- **Real-trace assertions (when present).** Every runtime edge's `pc` resolves to a
  routine or carries `note`; `unexplained(run)` is printed as the trend; `pointerTargets`
  on the busiest `pointer_zp` collapses to ≤ 64 spans; import wall-clock and peak RSS are
  printed, and RSS must not scale with file size — measured on the 42 MB log.
- Rebuild stays byte-identical (`cmp -l`) — 821 never touches bytes.

## 7. Non-goals

- No promotion of runtime rows to static (D3). No "dead code" or "free RAM" verdict from
  absence (785 §2.1, 753's banner). No DuckDB reading in this process (802), no new
  daemon op; `trace_memory_map` stays a sidecar.
- No automatic import on finalize. No `drive8` accesses (753b: only VIA1 is wired). No
  VIC/SID/IEC lanes — `VIC_REG_WRITE` / `SID_REG_WRITE` carry no `pc`
  (`binary-format.ts:203-225`) and cannot be attributed honestly; the CPU-side `IO_WRITE`
  to `$D0xx`/`$D4xx` carries the pc and is what gets imported.
- No taint / follow-path results as edges — daemon-side, per query (802).

## 8. Open questions

- **OQ1 — Row explosion on copy loops.** One row per distinct `ea` at a pc makes a
  `($zp),y` loop over 8 000 addresses 8 000 rows for one instruction. Collapse at import
  into contiguous spans (per-address `mutations` lost) or keep rows and collapse at query
  (§5)? Measured on the 42 MB e2e746 log first; the gate prints the row count either way.
- **OQ2 — A committed fixture.** Whether `analysis/runs/idle-probe.c64retrace` (516 B) is
  a legitimate fixture to whitelist under `samples/fixtures/`: its `TraceFileMeta` names
  the media (`mediaName`, `mediaSha`) and the definition, and if the media is third-party
  the header alone may be enough to exclude it. Read it first.
- **OQ3 — Frame numbers.** The draft speaks of `cycle/frame`; the record carries `cycle`.
  A PAL frame is `floor((cycle − cycleStart) / 19 656)` only if `cycleStart` is
  frame-aligned, which `TraceFileMeta` does not state. Evidence stores `cycle`; frame is
  a display derivation until the runtime stamps it — a TRX64 question, not a column here.
- **OQ4 — Which runs count.** `unconfirmed(routine)` is meaningful only relative to runs
  that could have reached the routine. A scenario name (812/814 `.feature`) on the `Run`
  node would let it say "not seen in the title scenario" — if the runtime writes one into
  `defJson` or a MARK, which was not checked here.
