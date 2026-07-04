# Spec 784 — Abstract Loader-Lens Extraction Tooling

**Status:** PROPOSED (ready for build)
**Repos:** cross-repo — Part A = TRX64 (`../TRX64`), Parts B/C = C64RE.
**Number:** 784 (shared board `specs/README.md`).
**Doctrine anchors:** `docs/agent-doctrine.md §0.7` (boot-chain crawl),
`docs/redesign/keystone-schema.md` (Payload / Representation / LoaderModel /
ProvenanceEdge / Evidence types), `TRX64/docs/capability-cut-decisions.md`
(media capability → TRX64, meaning → C64RE), `project_re_workflow_model`
(trace-validate recurs).

---

## 0. What this spec IS (and is NOT)

784 delivers **one abstract, medium-agnostic, index-agnostic extraction
tooling** — a uniform pipeline that turns *however a loader finds its data* into
registered C64RE payloads with full provenance, **without branching on
disk-vs-cart or on the loader's index scheme above the block layer.**

**IS:** the tooling (A1–A2 / B1–B4 / C1) + a single end-to-end proof it works.

**IS NOT** a corpus completion gate. Running the real corpus (Pawn, Murder, LNR,
Accolade, Wasteland; Lykia → 785) through the tooling is a **separate track** —
autonomous, sequential agents, which also road-tests the agent-doctrine. Folding
that campaign into 784 makes it *unscharf*; it is explicitly out (§4). The corpus
survey (`project_corpus_extraction_readiness`) is **design input** — it proves the
loader shapes are genuinely diverse (7-layer custom sector-stream / cart cross-bank
LUT / multi-stage CIA2-serial / DOS+fastloader / physics-custom-GCR), which is
exactly what forces the tooling to stay abstract.

## 1. Problem

The Pawn session ended at **coverage 168/1329 (12%)**: payloads were registered
with only their **start sector**, not the full chain. Root cause chain:

- `extract_disk` is a **single hard-wired DOS LoaderModel** (link-byte T/S chain)
  over the **strict** `parser.getSector` (`disk-extractor.ts:115/154`).
- On a custom-framed disk it fails two ways (`disk/base.ts`): `parseDirectory`
  throws `"Cannot read BAM sector (18/0)"`, and `traceFileSectorChain` breaks at
  the first custom-CRC sector → truncated chain.
- So the agent hand-followed the chain and hand-passed spans → human error
  (start-sector-only). Accolade / Wasteland had the same class of extract bug —
  **wrong interpretation of the loader code**, never caught.

A tolerant `getSector` patch was considered and **dropped**: it keeps the DOS
chaining rule wired in and does not address that Pawn is not link-chained at all
(the grouping lives in the custom loader's own table).

## 2. Model (converged, normative)

```
Medium
  ↓ bits/bytes → BLOCKS        PHYSICS, per-medium (GCR decode / chip read)
BLOCKS  (disk sector / cart bank-slice / page — plaintext, addressable)
  ↓ LoaderModel: reads its INDEX, applies its chaining rule → per-payload block-list
PAYLOADS (files / assets / engine)
  ↓ meaning
```

- The **INDEX** (DOS directory+link-bytes / custom loader table / CRT LUT) is
  **data on the medium**, not code. A **LoaderModel** is the adapter that reads +
  interprets *its* index and emits, per payload, an ordered block-list.
- **The chaining rule IS the LoaderModel.** 1541-DOS (byte0/1 = next T/S,
  terminator $00/XX) is *one* variant. Pawn's `T01/S02` 4-byte records, Accolade's
  `EXTENDED_TRACK_TABLE`, Wasteland's per-kind T35 directory, a cart cross-bank
  packer — each its own. The axis is **which LoaderModel**, never disk-vs-cart.
- **One medium hosts N LoaderModels at once.** Murder: DOS link-chain (16 files) +
  `ab.prg` boot-fastloader + riv4 runtime-fastloader = 3. Each payload records
  `derivedBy` = which LoaderModel produced it.
- **Everything above BLOCKS is uniform.** No code path branches on medium or index
  scheme above the block layer — that is the whole point and the acceptance test.

## 3. Decision (the approach)

Custom LoaderModels are **not** reimplemented as generic built-in resolvers
(fragile — that is exactly the Accolade/Wasteland bug class) and are **not** bulk-
extracted by running the emulator (correct but slow over N disks). Instead:

- **Bulk extraction = a per-project, LLM-authored extractor** — written from the
  loader disassembly (the boot-chain crawl), living **in the project**, fast. It
  emits a **manifest** (§B1). Language is per-project free (the real corpus already
  has Python *and* mjs extractors); the manifest is the only contract.
- **Validation = a loader-lens TRX64 trace** — boot the title, capture
  loader-scoped, derive the **ground-truth block→payload landing map** (which
  medium block's bytes came to rest at which C64 address). Diff the manifest
  against it. The real loader is ground truth → a wrong interpretation is caught,
  without a full-bulk emulation run. The landing map inherently carries
  decoded-bytes↔source, so for a physics-blocked title (undecoded custom-GCR) the
  same map can *be* the extraction source — a per-title choice in the campaign,
  **not** a 784 fork.
- **Registration = C64RE** — payloads + **full** `medium_spans` + `derivedBy`
  (the LoaderModel) + an evidence link to the validation trace.

**Split (Leitregel):**
- **TRX64 = capability:** boot + loader-scoped capture + the landing-map read.
- **C64RE = meaning:** manifest bulk-register, the diff/verdict, the LoaderModel
  record, the doctrine.
- **Project artifact:** the per-project extractor (one per title).

## 4. Non-goals / explicit drops

- **No corpus completion gate in 784** — the N-title campaign is a separate,
  autonomous, sequential-agent track (§0). 784 = tooling + one proof.
- No generic built-in multi-LoaderModel resolver.
- No `tolerant-getSector` patch to `extract_disk`. `extract_disk` stays for the
  **standard DOS bootstrap files only** (the few KERNAL-loaded files).
- No full-emulation *bulk* extraction as the default — emulation is the
  **validation oracle** / physics-blocked fallback, never the default bulk path.
- The diff/verdict is **meaning** → C64RE, not TRX64.
- Cart proof lives in **785** (same tooling, `+$DE00` banking lane in capture +
  real-sample harness). 784 proves the medium-agnostic core on **disk**.

---

## 5. Deliverables (ordered, buildable)

Each task: build → test (on a **copy** of a fixture, never live project data) →
commit citing `Spec 784 <task>`. **Build order (payoff-first, risk-late):**
**B1 → B2 → B3 → A1 → A2 → B4 → C1** (A3 only if A2 is ambiguous). B*/C1 land in
C64RE, A* in `../TRX64`. B-side (register+coverage) is pure C64RE and gives the
visible payoff immediately; the **A-side is the net-new risk** (drive-sector→C64-
dest landing-map correlation) — spike it early against a title that already boots
in TRX64 (Pawn: `traces/pawn-boot-01.c64retrace` exists) before B4 builds on it.

### Part B — C64RE (meaning): manifest, register, LoaderModel, diff

**B1 — Extractor manifest contract.** Document + a validator for the JSON a
per-project extractor emits. **Ground the schema in the 3 existing extractors**
(`Accolade comics/analysis/bughunting/scripts/extract_all_files.py`,
`Lykia/tools/extract_lut_streams.py` + `depack_all_lut_files.mjs`,
`Wasteland_EF/tools/wl_extract_side.py`) — reverse-derive the shape they already
produce, add a thin adapter, don't invent clean-slate.
```json
{
  "loaderModels": [{ "id": "pawn-serial", "kind": "sector-stream",
                     "indexLocation": "T01/S02 4-byte records",
                     "disasmArtifactId": "…", "notes": "…" }],
  "payloads": [{ "name": "PAWN.PRG", "derivedBy": "pawn-serial",
                 "dest": "$0800", "sha256": "…", "bytesPath": "analysis/…/pawn.bin",
                 "mediumSpans": [{ "track": 33, "sector": 0, "length": 254 }, …] }]
}
```
`mediumSpans` is the medium-agnostic union `{track,sector,length}` |
`{bank,slot,offsetInBank,length}`. *AC:* validator accepts a well-formed manifest,
rejects one missing spans/derivedBy; accepts BOTH a disk-span and a slot-span
manifest through the same validator (no medium branch).

**B2 — Bulk register from manifest.** (a) Let `register_payload` accept a
caller-supplied `derivedBy` per span (today hard-coded `"registered"` at
`payloads.ts:145-146`; the `mediumSpan` type already carries it). (b) New tool
`register_payloads_from_manifest(manifest_path)` → registers **every** payload
with its **full** `medium_spans` + `derivedBy` + evidence, medium-agnostically.
*AC:* idempotent re-run (no dup); on a **copy** of Accolade, its existing 4658
extracted blobs register with full spans → that medium's block-coverage goes from
~0 registered to attributed; a slot-span manifest registers through the same path.

**B3 — LoaderModel record.** Persist/list the recovered LoaderModel (`id`, `kind`,
index location, backing disasm artifact, notes) as the keystone-schema
LoaderModel/Representation type. `kind` = **open string**, seeded
`dos | custom-fastloader | sector-stream | cart-lut | cross-bank-packer`. Payload
`derivedBy` references it.
*AC:* a medium with N loaders records N LoaderModels; each payload's `derivedBy`
resolves to one; a new `kind` string is accepted without a code change.

### Part A — TRX64 (capability): the loader-lens trace

**A1 — Callable loader-scoped capture.** New daemon command `loaderTrace
<seconds>` (+ MCP tool, e.g. `runtime_trace_loader`). With a title mounted, runs
for X seconds from boot (or until a supplied anchor), `trace on` with the
loader-relevant domains **{c64-cpu, drive8-cpu, iec, mem-write, drive
GCR/sector}** into DuckDB, returns `run_id`. Reuse existing `trace on` /
`capture_all_def_json` / domain plumbing — a scoped capture profile, not a new
engine.
*AC:* returns a `run_id`; the DuckDB store for that run contains drive
sector-read events, C64 `mem-write` events, and IEC/$dd00 bus events for the
window (verified on Pawn, which already boots in TRX64).

**A2 — Landing-map read op.** New sidecar read `loaderLens <run_id>` (or extend
`profileLoader`) → records `{ source: {track,sector} | {bank,offset}, c64_dest:
$addr, len, sha256 }` by correlating each drive **sector-read**'s decoded bytes
with the C64 **mem-write** range they land in. **The net-new linkage** (no
drive-sector→C64-dest event exists today) — the spike target.
*AC:* on Pawn, the landing map for ≥1 stream matches Pawn's known `T01/S02`
file-table chain (self-check against the 36/36 chain-continuity fact).

**A3 — (only if A2 is ambiguous) sector-source provenance tag.** If value/time
correlation is not unique, tag each drive-decoded block with its `(track,sector)`
/ `(bank,offset)` at GCR/chip decode and carry it to the store (extend the
existing provenance mechanism, today used for VIC). *AC:* landing map is exact on
Pawn (custom-CRC) where correlation alone was ambiguous.

### Part C — Doctrine

**C1 — Extend the boot-chain crawl.** Add to `docs/agent-doctrine.md §0.7` +
`steering-defaults.ts` (idempotent block): after disassembling the loader →
**author a per-project extractor** → **run `loaderTrace` + `validate_extraction`**
→ **bulk-register** the validated payloads with `derivedBy`. State the physics/
meaning split and that emulation is validation-only / physics-blocked-fallback,
never the default bulk path.
*AC:* steering block injected idempotently; a fresh project agent receives the
full crawl (author → validate → register).

### B4 — Validation diff (C64RE; depends on A2)

**B4 — Validation diff.** New tool `validate_extraction(run_id, manifest_path)` →
reads the TRX64 landing map (A2) and diffs the manifest's spans/dest → a
validation **finding** (matched vs mismatched blocks) + evidence link (`run_id`).
*AC:* a deliberately wrong span in the manifest is flagged mismatched; a correct
manifest passes; the finding carries the trace evidence ref.

---

## 6. Whole-spec acceptance (tooling proof, NOT a corpus gate)

The tooling is abstract + works end-to-end, proven **de-risked across two titles**
(each used where it is strongest), all on **copies**:

- **B-side proof — Accolade** (extraction already complete + byte-identical, no
  emulation needed): its existing extractor's output registers via
  `register_payloads_from_manifest` with **full** medium_spans + `derivedBy` →
  that medium's blocks become attributed; LoaderModels recorded.
- **A-side proof — Pawn** (already boots + traces in TRX64): `loaderTrace` +
  `loaderLens` produce a landing map matching Pawn's known `T01/S02` chain;
  `validate_extraction` passes a correct manifest and flags a deliberately wrong
  span.
- **Medium-agnosticism** proven structurally: the same B1 validator + B2 register
  + coverage path accept BOTH a disk-span and a slot-span manifest with **no
  branch above the block layer**.
- No corpus completion obligation in 784; the N-title campaign is a separate track.
- No live project data touched (all tests on fixture copies).
- `derivedBy` provenance present on every registered payload.
