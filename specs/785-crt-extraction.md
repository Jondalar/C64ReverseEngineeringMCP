# Spec 785 — Cartridge Extraction: coverage that tells the truth, + the cart read-set

**Status:** IN BUILD 2026-08-11 — Part B (B1–B4) and A4 built and measured on
copies of both proof projects. A1–A3 and Part C open.
**Repos:** cross-repo — Part C = TRX64 (`../TRX64`), Parts A/B/D = C64RE.
**Number:** 785 (shared board `specs/README.md`). **Pendant of** Spec 784.

---

## 1. What this is

784 built the medium-agnostic extraction tooling (manifest → register with full
spans + `derivedBy` → validate against the loader's own read-set) and proved it on
**disk**. 785 is the **cartridge** surface of that same tooling.

The original 785 assumed the cart side was mostly already there. Measured against
the tree on 2026-08-11, three of those assumptions are false:

| the old §1 claimed | actually |
|---|---|
| loader-lens landing-map source is a union `{track,sector} \| {bank,offset}` | `src/runtime/headless/trace/loader-lens.ts:48` — `source: { halftrack, track, sector } \| null`. Disk only. |
| `validate_extraction` is medium-agnostic | `src/server-tools/validate-extraction.ts:51` counts `skippedSlotSpans`. Cart spans are **skipped**, not validated. |
| the capture already carries a bank lane | TRX64 has `BLOCK_READ (0x35)` = `{cycle, halftrack, sector, bytes}`. No cart counterpart exists. |

What **is** real and reusable: the manifest schema already carries slot spans
(`loader-manifest.ts:59-61`), `cart-lut` and `cross-bank-packer` are already seeded
LoaderModel kinds, `register_payloads_from_manifest` claims to take slot spans
through the same path as sector spans, and `cartCoverage` already computes
byte-exact coverage inside a chip.

So 785 is smaller than a re-spec and larger than a lane addition. Its centre of
gravity turned out to be **not** the trace — it is that cartridge coverage currently
reports a number that cannot be wrong, because it never measures anything.

## 2. Model — three axes, one per layer

784 §2 defines the layers. Each one answers exactly one question about a byte range,
and today all three are collapsed into a single "attributed / unclaimed" flag:

```
Medium
  ↓ PHYSICS      per-medium                    →  Data / No Data
BLOCKS
  ↓ LoaderModel  reads its index, chains       →  Used / Unused
PAYLOADS
  ↓ meaning                                    →  Identified / Unknown
```

**Data / No Data** is a property of the bytes. On flash, `$ff` is erased and `$00`
is never-written; both are No Data. Derivable by scanning, no loader required.

**Used / Unused** is a property of the LoaderModel. Its sources, in order of
authority:

1. **The index** — a LUT, a chunk directory. Exact, static.
2. **The load chain** — where there is no index. Some cartridges simply chain:
   bank *n*'s code loads bank *n+1*, with no table anywhere. That is a third
   LoaderModel kind (`cart-chain`), and since `kind` is an open string (784 B3) it
   costs no code.
3. **The read-set** — where neither of the above resolves a range. §5 Part C.

**Identified / Unknown** is meaning: do we know what the bytes *are*.

The cells that matter, and why this is worth building:

| Data | Used | Ident. | means |
|:---:|:---:|:---:|---|
| ✓ | ✓ | ✓ | done |
| ✓ | ✓ | ✗ | **the work queue** |
| ✓ | ✗ | ✗ | dead weight — or hidden payload. Worth a look either way. |
| ✓ | ✗ | ✓ | a file the loader never fetches |
| ✗ | ✗ | — | **free space** — where a patch may go |
| ✗ | ✓ | — | model error, or padding reads |

The last two rows are not academic. Both proof projects (§4) are patch projects: a
production fix and a trainer set. "Where is there room" is a question the workbench
cannot answer today.

### 2.1 What the read-set can and cannot prove

The read-set proves **Used**. It never proves **Unused** — a run that did not reach
level 90 says nothing about the bank level 90 needs. It is a lower bound, and every
surface that shows it must say **"used in run X"**, never "used". Presenting a lower
bound as a fact is the Pawn 168/1329 failure in a new costume.

Symmetrically, static analysis can prove a range *is* referenced and can never prove
it is not: indirect jumps and computed bank numbers defeat any scan. One of the proof
projects records exactly that mistake in its own handover — *"an addressing-mode scan
that missed indirect reads"*. Hence: neither source alone settles Unused. The honest
rendering is three states, not two — `used` / `not seen used` / `proven unreachable`,
where the third is only ever reached by an argument, never by a scan or a run.

## 3. Cart specifics (blocks + physics)

- **Blocks = bank-slices:** ROML (`$8000–9FFF`), ROMH (`$A000–BFFF`, ultimax
  `$E000–FFFF`), per bank. Banks exist physically including erased `$ff` flash —
  `.crt` images drop empty banks to save space; model them as empty, not absent
  (`MediumLayout.empty[]`, reason `flash-empty-ff`).
- **Physics = chip/flash read**, already faithful in TRX64 (Spec 713 cart families).
  There is no tolerant-CRC problem as on GCR. The delta is bank/slot addressing,
  ultimax, and the banking register.
- **Banking register.** Two 1 MB images of the same game in two mappers, diffed
  2026-08-11: 128 banks each, 21 occupied, only 335 bytes differ across 2 banks —
  the payload is identical, only the banking code moves. `$de00` carries the bank
  number in both; the second register is what separates the mappers. The container
  therefore separates from the content by diff. Those samples are third-party
  property: analysed locally, never committed, never in an artifact.

## 4. Ground truth — two projects, two LoaderModel kinds

Both are user-local, neither is committed here. Between them they cover both cart
index shapes, and both have their extraction already derived statically and
verified — so this spec is a registration and measurement problem, not an RE problem.

| | `cart-lut` | `cross-bank-packer` |
|---|---|---|
| project | Lykia (MegaByter, hw 86) | an EasyFlash title, project-local, unreleased — not named here |
| geometry | 128 banks · 1 MB | 64 banks · 520 KB · ROML+ROMH |
| index | 5 LUTs in one bank, 552 entries | 135-entry chunk directory, flat byte stream across banks 1–46 |
| state | table decoded to project JSON | directory format confirmed by recomputing all 134 successor addresses; 101 of 101 packed chunks depacked |
| boots in TRX64 | yes | yes |
| registered as payloads | no — see below | no — `payloadChunks: 0` |
| LoaderModel record | none | none |

Both projects report **"Loader model not identified"** while holding a complete,
verified loader description in a JSON file. That is the gap this spec closes.

### 4.1 What the two projects exposed

**The coverage number cannot be wrong.** The EasyFlash project reports *"65/65 data
blocks attributed"* with **zero payloads registered**. `medium-layout.json` shows
`files: 0`, `resident: 494`. The 494 are disassembly-derived code islands; unioned
they happen to cover every chip, and `cartCoverage` reports per-chip booleans, so the
view says complete. Byte-exact coverage is computed at `medium-coverage.ts:112` and
thrown away one line later.

**Two cart view paths, and coverage reads the wrong one.**
`views/cartridge-layout.json` carries the index (`lutChunks: 552` in one project,
`payloadChunks: 0` in the other — two names for one idea), while
`views/medium-layout.json` is what feeds coverage. The `cart-lut` project has **no
`medium-layout.json` at all**: its 552 decoded entries live in a view that the
coverage path never opens.

**A manifest can describe a different image than the one that boots.** In the
`cart-lut` project, `analysis/crt/manifest.json` describes hw 19 / 124 banks /
1017856 B — a second cartridge in the same project — while the finding that imported
it names the hw 86 / 128 bank / 1050688 B image. The cart is registered twice, both
times the other image. The manifest is not wrong; its label is. Registering an image
identity (hash, hardware type, bank count) alongside the layout would have caught it,
and must, before either project is used to validate anything against a running
machine.

## 5. Deliverables

Ordered. **A → B → C**, with D landing alongside whatever it describes (rule 9).
A is visible payoff with no Rust and no new concepts. C is worth building only once
A and B have narrowed what is still Unknown.

### Part A — C64RE: the registration bridge

**A1 — Per-project cart manifest emitters.** Project artifacts, not repo code (784
§3: the extractor lives in the project). Each turns the project's existing decoded
index into a 784 manifest with slot spans and `derivedBy`. Both are JSON-to-JSON;
the reverse engineering is already done and verified.
*AC:* each emitter's output passes the B1 validator unchanged; span count equals
index entry count; cross-bank entries emit one span per bank touched, in order.

**A2 — Prove `register_payloads_from_manifest` on slot spans.** The tool claims one
path for sector and slot spans. It has never been run on a cartridge. Run it on a
**copy** of each project.
*AC:* every payload registers with its full ordered slot spans and `derivedBy`;
re-run is idempotent; a payload spanning banks keeps its spans in order; no code
path branched on medium.

**A3 — LoaderModel records.** One per project: `cart-lut`, `cross-bank-packer`.
Reserve `cart-chain` for the index-less case (no code — `kind` is an open string).
The record names where the index lives and cites the backing disassembly artifact.
The *format* of a project's index stays in that project; this repo records that
there is one, of which kind, and where.
*AC:* "Loader model not identified" is gone in both projects; each payload's
`derivedBy` resolves to a record.

**A4 — Cartridge identity on the layout.** Persist hash + hardware type + bank count
+ image size with the imported layout, and surface a mismatch against the artifact
the finding names.
*AC:* the `cart-lut` project's double registration is visible as a mismatch rather
than as two identical-looking cartridges.
*BUILT 2026-08-11* — `src/project-knowledge/cartridge-identity.ts`. sha256 +
hardware type + bank/chip count + ROM bytes + image size ride on
`CartridgeLayoutCartridge.identity` and on `MediumLayout.identity`; the .crt
header supplies the hardware type and name for the comparison. Four mismatch
classes: image size, hardware type, name, and "N manifests registered at one
path" (the overwrite that produced the double registration). Surfaced in the
Cartridge grid and as a high-severity `cartridge-identity-mismatch` audit
finding. Measured: the two `cart-lut` registrations now report 4 and 1
mismatches respectively — 1017856 B vs 1050688 B, hw 19 vs 86 — where before
they were byte-identical view entries. Gate: `npm run e2e:785-identity`.

### Part B — C64RE: three axes instead of one flag

**B1 — Coverage reports bytes.** Keep the byte-exact `coveredLen` that
`cartCoverage` already computes instead of collapsing it to a per-chip boolean at
`medium-coverage.ts:113`.
*AC:* a chip 1 % covered and one 99 % covered no longer report the same thing;
the disk path's numbers are unchanged.
*BUILT 2026-08-11* — `dataBytes / emptyBytes / usedBytes / unclaimedBytes /
identifiedBytes / unidentifiedBytes` ride alongside the block counts. Each grid
reader emits one neutral `BlockCoverage` per physical block and a single shared
aggregator produces `MediumBlockCoverage`, so the disk/cart branch is confined
below the block layer. Disk numbers verified unchanged on four real D64s
(741/597/144, 757/170/587, 756/114/642, 759/674/85).

**B2 — Separate the claim classes.** `files` (payloads, from a LoaderModel) and
`resident` (disassembly-derived regions) are unioned into one `claimSpans` today.
Data / Used / Identified needs them apart: a code island is evidence of *meaning*,
never evidence that the loader fetched anything.
*AC:* a project with 0 payloads and full disassembly coverage no longer reports
complete attribution.
*BUILT 2026-08-11* — `attributedBlocks` counts payload claims only; resident
regions feed `identifiedBytes` on their own axis. This matches what the disk
reader always did (a sector is attributed when the directory claims it, not when
somebody disassembled it). Measured: EasyFlash 65/65/0 -> 65/4/61 (used 69 % of
its data bytes, identified 100 %); `cart-lut` 124/124/0 -> 124/121/3.
Consequence, intended: both proof projects now fail `discoveryCoverageComplete`
and the lifecycle gate holds them in Discovery.

**B3 — `empty` derived from the bytes.** `$ff` and `$00` runs are a byte scan, exact
and cheap, and must not depend on an extractor having reported them: one proof
project reports a single empty region across 520 KB, the other none at all.
*AC:* No-Data regions are found on both proof cartridges without either project
changing; a fully-erased bank is No Data, not unclaimed.
*BUILT 2026-08-11* — both fill bytes scanned, on every cartridge regardless of
`canFlash`, and the loader's index is no longer subtracted from the result (that
is the Used axis, not the Data axis). The resident-segment scan reuses the same
runs so the two layers cannot contradict each other. Measured, no project
changed: EasyFlash 1 region / 260 B -> 11 / 26731 B; the masked-ROM `cart-lut`
image 0 -> 7 regions / 18063 B, including 6875 B free in bank 0 and a 7428 B
$00 tail in bank 123. "Where is there room for a patch" is answerable on both.

**B4 — One cart view path.** Fold `lutChunks` / `payloadChunks` into one concept and
make `medium-layout.json` the coverage source for cartridges in every project, not
only where an extractor happened to write one.
*AC:* both proof projects have a `medium-layout.json` carrying their index; the
Cartridge view labels what a span *is* (payload / code island / empty), which it
does not today.
*BUILT 2026-08-11* — every layout build refreshes `medium-layout.json`
(`buildDiskLayoutView` and `buildCartridgeLayoutView` each persist it;
`buildAllViews` builds disk + cart once and hands them straight over), and the
audit counts it as a view so a project missing it reads as stale. `lutChunks`
and `payloadChunks` are folded into one class with two sources: `spanClasses`
enumerates every span as payload / code-island / empty with count + bytes, the
grid renders it as a legend, and each span tooltip names its class. Measured:
with `medium-layout.json` deleted, `build_cartridge_layout_view` alone rewrote
it (2528956 B) carrying all 552 index entries.

**Correction to §4.1.** "its 552 decoded entries live in a view that the
coverage path never opens" is not right. `buildWorkspaceUiSnapshot` composes the
medium layout in memory from the cartridge layout, so the 552 entries did reach
coverage; what was missing was only the persisted file (and with it any external
reader of `views/medium-layout.json`). The 124/124/0 reading came from B1+B2,
not from the missing file.

### Part C — TRX64 + C64RE: the cart read-set

**C1 — `CART_READ` lane (TRX64).** The bank analogue of `BLOCK_READ (0x35)`: while
armed, count reads served out of cart space and flush one record per bank residency
on a bank switch — `{cycle, bank, slot, off_lo, off_hi, bytes}`. Cart-side truth at
the chip read, independent of when or whether the C64 copied anything, and
loader-agnostic. Armed-only, on its own channel, never in a parity trace. Mirrors the
existing per-sector delta at the head-sample boundary.
*AC:* on a multi-bank cartridge the lane records the banks the title actually read,
with the active bank tracked correctly across a `$de00` switch.

**C2 — Widen the C64RE side.** `source` in `loader-lens.ts` becomes
`{halftrack,track,sector} | {bank,slot,offset}`; `validate-extraction.ts` gains the
cart branch that today increments `skippedSlotSpans`; the MCP tool description stops
claiming cart spans are validated when they are skipped.
*AC:* a manifest claiming a bank range the title never read is flagged; a correct
manifest passes; the finding carries the capture reference.

**C3 — Truthful labelling.** Every surface that shows read-set-derived Used says
"used in run X". §2.1.
*AC:* no view or tool output renders a read-set result as unqualified "used" or
"unused".

### Part D — spec + docs (Doctrine rule 9)

784's status line reads `PROPOSED (ready for build)` while all its deliverables are
in the tree; correct it and move it. Correct this file's history as it is built.
Correct the `validate_extraction` tool description. Same commit as the change, or the
one after.

## 6. Whole-spec acceptance

- Both proof cartridges register their full index as payloads with ordered slot
  spans and `derivedBy`, through the **same** call path as a disk manifest.
- Neither project reports "Loader model not identified".
- Cartridge coverage reports the three axes in bytes; the "65/65 with zero payloads"
  reading is impossible to produce.
- The read-set records what a title read across bank switches, and a wrong manifest
  span is caught by it.
- Nothing built here branches on disk-vs-cart above the block layer — 784 §2, and
  the acceptance test for both.
- All project work on **copies**. No live project data mutated by a build step.

## 7. Non-goals

- No generic built-in resolver for cart loaders. Per-project extractor, as 784.
- Emulation stays validation-only and the physics-blocked fallback, never the
  default bulk path.
- No cartridge *building*. This spec is read-direction only.
- No corpus campaign. Two titles prove the tooling; the rest is a separate track.
