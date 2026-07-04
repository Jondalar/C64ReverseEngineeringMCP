# Spec 784 — Per-Project Extractor + Loader-Lens Trace Validation

**Status:** PROPOSED (ready for loop-build)
**Repos:** cross-repo — Part A = TRX64 (`../TRX64`), Parts B/C = C64RE.
**Number:** 784 (shared board `specs/README.md`).
**Doctrine anchors:** `docs/agent-doctrine.md §0.7` (boot-chain crawl),
`docs/redesign/keystone-schema.md` (Payload / Representation / LoaderModel /
ProvenanceEdge / Evidence types), `TRX64/docs/capability-cut-decisions.md`
(media capability → TRX64, meaning → C64RE), `project_re_workflow_model`
(trace-validate recurs).

---

## 1. Problem

The Pawn session ended at **coverage 168/1329 (12%)**: payloads were registered
with only their **start sector**, not the full chain (`PAWN.PRG` = 51-sector
chain, only T33/S00 registered → 50 unclaimed; 35 stream payloads = 1 start
each; loader payloads had **no** span). Root cause chain:

- `extract_disk` is a **single hard-wired DOS LoaderModel** (link-byte T/S chain)
  over the **strict** `parser.getSector` (`disk-extractor.ts:115/154`).
- On a custom-framed disk it fails two ways (`disk/base.ts`): `parseDirectory`
  throws `"Cannot read BAM sector (18/0)"`, and `traceFileSectorChain` breaks at
  the first custom-CRC sector → truncated chain.
- So the agent hand-followed the chain in Python and hand-passed spans →
  human error (start-sector-only). Accolade / Wasteland had the same class of
  extract bug — **wrong interpretation of the loader code**, never caught.

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
  terminator $00/XX) is *one* variant. Wasteland / Accolade / a cart cross-bank
  packer each have their own. The axis is **which LoaderModel**, never disk-vs-cart.
- **One medium hosts N LoaderModels at once.** Pawn: DOS for the 3 KERNAL-loaded
  files (the stub etc.) **and** the $dd00 custom loader (its own table) for the
  rest. Each payload records `derivedBy` = which LoaderModel produced it.

## 3. Decision (the approach)

Custom LoaderModels are **not** reimplemented as generic built-in resolvers
(fragile — that is exactly the Accolade/Wasteland bug class) and are **not** bulk-
extracted by running the emulator (correct but slow over 4 disks). Instead:

- **Bulk extraction = a per-project, LLM-authored Python extractor** — written
  from the loader disassembly (the boot-chain crawl), living **in the project**,
  fast over 4 disks. It emits a manifest (§B1).
- **Validation = a loader-lens TRX64 trace** — boot the title for X seconds,
  capture loader-scoped, and derive the **ground-truth block→payload landing
  map** (which medium block's bytes came to rest at which C64 address). Diff the
  extractor manifest against it. The real loader is ground truth, so a wrong
  interpretation is caught — without a full-bulk emulation run.
- **Registration = C64RE** — payloads + **full** `medium_spans` + `derivedBy`
  (the LoaderModel) + an evidence link to the validation trace.

**Split (Leitregel):**
- **TRX64 = capability:** boot + loader-scoped capture + the landing-map read.
- **C64RE = meaning:** manifest bulk-register, the diff/verdict, the LoaderModel
  record, the doctrine.
- **Project artifact:** the Python extractor (one per title).

## 4. Non-goals / explicit drops

- No generic built-in multi-LoaderModel resolver.
- No `tolerant-getSector` patch to `extract_disk`. `extract_disk` stays for the
  **standard DOS bootstrap files only** (the few KERNAL-loaded files).
- No full-emulation *bulk* extraction — emulation is the **validation oracle**,
  spot-check, never the bulk path.
- The diff/verdict is **meaning** → C64RE, not TRX64.

---

## 5. Deliverables (ordered, loop-buildable)

Each task: build → test (on a **copy** of a fixture, never live project data) →
commit citing `Spec 784 <task>`. Build order: **A1 → A2 → B1 → B2 → B3 → B4 →
C1** (A3 only if A2 is ambiguous). A* land in `../TRX64`, B*/C1 in C64RE.

### Part A — TRX64 (capability): the loader-lens trace

**A1 — Callable loader-scoped capture.** New daemon command `loaderTrace
<seconds>` (+ MCP tool, e.g. `runtime_trace_loader`). With a title mounted, runs
for X seconds from boot (or until a supplied anchor), `trace on` with the
loader-relevant domains **{c64-cpu, drive8-cpu, iec, mem-write, drive
GCR/sector}** into DuckDB, returns `run_id`. Reuse existing `trace on` /
`capture_all_def_json` / domain plumbing — this is a scoped capture profile, not
a new engine.
*AC:* returns a `run_id`; the DuckDB store for that run contains drive
sector-read events, C64 `mem-write` events, and IEC/$dd00 bus events for the
window.

**A2 — Landing-map read op.** New sidecar read `loaderLens <run_id>` (or extend
`profileLoader`) → records `{ source: {track,sector} | {bank,offset}, c64_dest:
$addr, len, sha256 }` by correlating each drive **sector-read**'s decoded bytes
with the C64 **mem-write** range they land in. This is the net-new linkage (no
drive-sector→C64-dest event exists today).
*AC:* on a **standard DOS disk**, the landing map for ≥1 file matches that file's
known directory link-chain (self-check against `extract_disk`).

**A3 — (only if A2 is ambiguous) sector-source provenance tag.** If value/time
correlation is not unique, tag each drive-decoded block with its `(track,sector)`
/ `(bank,offset)` at GCR/chip decode and carry it to the store (extend the
existing provenance mechanism, today used for VIC). *AC:* landing map is exact
on Pawn (custom-CRC) where correlation alone was ambiguous.

### Part B — C64RE (meaning): manifest, register, LoaderModel, diff

**B1 — Extractor manifest contract.** Document + a validator for the JSON a
per-project Python extractor emits:
```json
{
  "loaderModels": [{ "id": "dd00-custom", "kind": "custom-fastloader",
                     "indexLocation": "T33/S00 table", "disasmArtifactId": "…",
                     "notes": "…" }],
  "payloads": [{ "name": "PAWN.PRG", "derivedBy": "dd00-custom",
                 "dest": "$0800", "sha256": "…", "bytesPath": "analysis/…/pawn.bin",
                 "mediumSpans": [{ "track": 33, "sector": 0, "length": 254 }, …] }]
}
```
*AC:* validator accepts a well-formed manifest, rejects one missing spans/derivedBy.

**B2 — Bulk register from manifest.** (a) Let `register_payload` accept a
caller-supplied `derivedBy` per span (today hard-coded `"registered"` at
`payloads.ts:145-146`; the `mediumSpan` type already carries it). (b) New tool
`register_payloads_from_manifest(manifest_path)` → registers **every** payload
with its **full** `medium_spans` + `derivedBy` + evidence.
*AC:* idempotent re-run (no dup); the Pawn manifest yields payloads with full
chains; block-coverage rises to ~**1300/1329** (from 168).

**B3 — LoaderModel record.** Persist/list the recovered LoaderModel (`id`, `kind`
∈ dos | custom-fastloader | cart-lut, index location, backing disasm artifact,
notes). Payload `derivedBy` references it.
*AC:* Pawn records **2** LoaderModels (`dos` + `dd00-custom`); each payload's
`derivedBy` resolves to one of them.

**B4 — Validation diff.** New tool `validate_extraction(run_id, manifest_path)` →
reads the TRX64 landing map (A2) and diffs the manifest's spans/dest → a
validation **finding** (matched vs mismatched blocks) + evidence link (`run_id`).
*AC:* a deliberately wrong span in the manifest is flagged mismatched; a correct
manifest passes; the finding carries the trace evidence ref.

### Part C — Doctrine

**C1 — Extend the boot-chain crawl.** Add to `docs/agent-doctrine.md §0.7` +
`steering-defaults.ts` (idempotent block): after disassembling the loader →
**author a per-project Python extractor** → **run `loaderTrace` + `validate_extraction`**
→ **bulk-register** the validated payloads with `derivedBy`. State the physics/
meaning split and that emulation is validation-only, never bulk.
*AC:* steering block injected idempotently; a fresh project agent receives the
full crawl (author → validate → register).

---

## 6. Whole-spec acceptance

- **Pawn** (on a copy): a validated manifest bulk-registers → coverage ~1300/1329;
  2 LoaderModels recorded; `validate_extraction` catches a wrong span.
- No generic resolver added; `extract_disk` unchanged except it is scoped to the
  DOS bootstrap files.
- No live project data touched (all tests on fixture copies).
- `derivedBy` provenance present on every custom-loader payload.
