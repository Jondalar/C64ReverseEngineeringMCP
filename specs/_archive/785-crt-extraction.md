# Spec 785 — Cartridge Extraction: coverage that tells the truth, + the cart read-set

**Status:** DONE 2026-08-11 — every deliverable A1–A4, B1–B4, C1–C3 built and every §6
bullet met, measured on the two proof projects: A on copies of both, C1 in TRX64, C2/C3
in C64RE against `cart-read` captures of both proof cartridges.
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
   bank *n*'s code loads bank *n+1*, with no table anywhere. See §2.2 — this is one
   of exactly three values on the loading axis, and since `kind` is an open string
   (784 B3) a new one costs no code.
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

### 2.2 The loading axis has exactly three values

A cartridge's **hardware type** says what the container is. Orthogonal to it, and the
thing that actually produces *Used*, is how content is found inside it — and that has
three values, not a growing list:

| | how a payload is located | what it costs to recover |
|---|---|---|
| `singleload` | nothing to locate — the cart *is* the payload | free; the answer is the geometry |
| `chainload` | each blob carries the code that fetches the next; no table anywhere | expensive — every link must be read, or watched |
| `structured` | a table maps logical file → `(bank, offset, length, dest)` | read the table once |

The seeded LoaderModel kinds mix this axis with **storage layout** (`in-bank` vs
`cross-bank`): `cart-lut` names an index, `cross-bank-packer` names a layout. They are
not alternatives, and a project is one value from each.

`chainload` is the only value that *needs* a runtime. For the other two the answer is
in the image; for a chain it is scattered through the code of every link, and the
`CART_READ` lane is what recovers it — a run walks the chain the loader itself walks.

**Corpus status 2026-08-11.** `singleload` — one title, verified by bytes: 16 KB in one
bank with **zero** writes to `$de00`/`$de02`, so there is no bank register in play at
all. `structured` — three, and structurally different indices: 8-byte entries, a 3-byte
directory, and 7-byte entries whose memcopy increments the bank itself. That spread is
why `kind` is an open string (784 B3). **`chainload`: no example yet** — the one value
the read-set exists for is the one with nothing to test it against.

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

## 4. Ground truth — two projects, both `structured`

Both are user-local, neither is committed here. Both have their extraction already
derived statically and verified — so this spec was a registration and measurement
problem, not an RE problem.

**Correction, 2026-08-11:** this section originally claimed the two "cover both cart
index shapes". They do not — **both are `structured`** (§2.2). Their LoaderModel kinds
(`cart-lut`, `cross-bank-packer`) name *different axes*: one the index, the other the
storage layout. Read as alternatives they suggested a breadth the corpus did not have.

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

**BUILT 2026-08-11.** `cross-bank-packer`: 135 entries → 135 payloads / 180 spans,
42 cross a bank boundary, banks 1–46. `cart-lut`: 554 → 554 payloads / 675 spans, 98
cross a boundary, banks 1–123. Both validate clean.

*The lesson this deliverable taught, kept because it will recur:* the chunk-stream
spans were first derived at the index's recorded source address and **verified by
reproducing all 134 successor addresses**. They were wrong by four bytes — covering
the record header and stopping four bytes short of the payload. Successor arithmetic
is invariant to a constant offset, so that check could not possibly have caught it.
The byte comparison could, and did: **0 of 135 blobs matched at `src`, 135 of 135 at
`src+4`**. Both emitters now re-run a byte identity check against the project's own
carved blobs on every invocation, and the chunk emitter additionally reads the record
header back out of the cartridge and asserts it yields the index's destination and a
length field of `len+2`. **A derivation is proven against the bytes it claims to
describe, never against its own arithmetic.**

**A2 — Prove `register_payloads_from_manifest` on slot spans.** The tool claims one
path for sector and slot spans. It has never been run on a cartridge. Run it on a
**copy** of each project.
*AC:* every payload registers with its full ordered slot spans and `derivedBy`;
re-run is idempotent; a payload spanning banks keeps its spans in order; no code
path branched on medium.

**BUILT 2026-08-11**, on copies. 135 and 554 payloads, full ordered spans identical
to the manifest in every case, `derivedBy` on all, idempotent re-run (entity, model
and relation stores byte-identical modulo timestamps). No medium branch:
`manifest-register.ts:87-89` switches on `span.kind` and nothing else.

*Two store defects this surfaced — both outside 785, neither worked around:*
1. **Content-hash dedup overwrites a caller-supplied name.** `service.ts:4048`
   consults the hash lookup even when an explicit `id` was supplied and did not
   match, then takes `name: existing?.name ?? input.name`. Payloads with identical
   content therefore display a twin's name: 1 of 135 and **77 of 554**. Ids, spans,
   hashes and `derivedBy` are all correct; the intended name survives in `aliases[]`.
   Display only, and still wrong.
2. **Re-running grows `tool-run-record` artifacts** by one per payload per run
   (+136 / +555). The payload-source artifacts are properly idempotent.

**A3 — LoaderModel records.** One per project: `cart-lut`, `cross-bank-packer`.
Reserve `cart-chain` for the index-less case (no code — `kind` is an open string).
The record names where the index lives and cites the backing disassembly artifact.
The *format* of a project's index stays in that project; this repo records that
there is one, of which kind, and where.
*AC:* `list_loader_models` reports one model per project and every payload's
`derivedBy` resolves to it. **Both projects reached this 2026-08-11** (0 → 1 model,
135 and 554 payloads resolving).

*AC correction, 2026-08-11:* this originally read *"'Loader model not identified' is
gone in both projects"*, which A3 cannot deliver. That banner (`ui/src/App.tsx:359`)
renders `projectProfile.loaderModel` — a free-text profile field with no connection to
the LoaderModel store, and not writable from the default MCP surface
(`save_project_profile` is not in `DEFAULT_TOOLS`). Two records of one fact with
nothing reconciling them, which is the failure mode this spec exists to attack. Making
the banner read the store is **B4/D work**, not A3.

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

**C1 — `CART_READ` lane (TRX64). BUILT 2026-08-11.** The bank analogue of
`BLOCK_READ (0x35)`: while armed, count reads served out of cart space and flush one
record per bank residency on a bank switch — `{cycle, bank, slot, off_lo, off_hi,
bytes}`. Cart-side truth at the chip read, independent of when or whether the C64
copied anything, and loader-agnostic. Armed-only, on its own channel, never in a
parity trace. Mirrors the existing per-sector delta at the head-sample boundary.
*AC:* on a multi-bank cartridge the lane records the banks the title actually read,
with the active bank tracked correctly across a `$de00` switch.

*As built:* `TraceOp::CartRead = 0x36`, 20 bytes — op(1) cycle(f64) bank(u16)
slot(u8) off_lo(u16) off_hi(u16) bytes(**u32**). Own domain `cart-read` → own
channel → own `cart-read-row` capture kind; `Machine::arm_cart_reads` /
`drain_cart_reads`; the accumulator is `cart::CartReadSet`, fed from the ONE bus
chokepoint `FullBus::cart_read`. Four things the build learned that this section had
assumed away:

1. **One residency per SLOT, not per bank.** A title reading ROML and ROMH of the
   same bank alternately would ping-pong a single residency into thousands of
   records. Each window closes only when its OWN bank changes.
2. **`bytes` is 32-bit.** A sector caps at ~300 latched bytes; a bank being
   EXECUTED out of serves millions of reads in one residency (measured: 1.84 M in a
   30 s boot). A u16 would have reported a wrong number, not a big one.
3. **There is no `current_bank` to read.** MegaByter keeps its bank in
   `register00`, C64MegaCart assembles 14 bits from `$DE00`+`$DF00`, GMod4 keeps a
   separate bank per window per banking context with `$E000` unbanked — and
   `get_state()`, the one place a bank was already exposed, CLONES the whole flash
   array to produce it. Hence `CartMapper::active_bank(addr)`, a field read, taking
   the ADDRESS so each family answers the way its own `read()` resolves it.
4. **A store must not fabricate a read.** The store path reads the pre-write byte
   for the trace/undo old value, and `$8000-$BFFF` is inside that window — so a
   write to RAM *under* a banked-in ROM looked like a cart read. Accounting is
   suspended around that instrumentation read.

*Evidence (2026-08-11, both proof cartridges, isolated process — `trx64cli boot
--trace` and the `--ignored` `cart_read_set` integration test; neither image
committed, path from the environment):*

**`cross-bank-packer` title, EasyFlash hw 32.** From cold reset: bank 0 ROMH, then
an ordered ascending walk `1L 2L 3L 4L` reading banks 1, 2 and 3 whole
(`$0000-$1FFF`, 8192 reads each) and bank 4 to `$1DB2` — the boot stream across the
low ROML banks — then `45L 46L 52L`, then a descending single-byte probe at
`$A000+0` of every ODD bank 63 → 1, then the title screen resident code. Driving it
into level 1 adds bank 17 `$163A-$1FFF` followed by bank 18 `$0000-$0C67`: one
gapless 5678-byte stream crossing the bank boundary. 536 records over a 38 M-cycle
capture, 45 distinct (bank, slot).

**`cart-lut` title, MegaByter hw 86.** 15 records for a whole 40 M-cycle boot:
resident execution in bank 0, a 256-byte read at `$0000` of banks 124 and 126, a
sparse 266-read scatter across bank 1 `$00D8-$1F4A` (an index lookup, not a stream),
then TWO cross-bank chunks — 13 `$19BD-$1FFF` → 14 `$0000-$173F` (7555 bytes) and 15
`$1777-$1FFF` → 16 `$0000-$1FFF` → 17 `$0000-$1FFF` → 18 `$0000-$0047` (18641
bytes). In both chunks every record's `off_lo` is exactly the previous record's
`off_hi + 1`, the bank rolls at exactly `$1FFF` → `$0000`, and each record's byte
count equals its span length — a single gapless pass, no re-reads. The chunks
reconstruct byte-exactly from the lane alone.

*Note for C2:* the C64RE reader now knows the opcode (`binary-format.ts` — enum,
size, decode), so a capture containing the lane is readable; it previously threw
`cannot skip opcode 0x36`. The `loader-lens` / `validate-extraction` widening is
still C2's work.

**C2 — Widen the C64RE side. BUILT 2026-08-11.** `source` in `loader-lens.ts` becomes
`{halftrack,track,sector} | {bank,slot,offset}`; `validate-extraction.ts` gains the
cart branch that today increments `skippedSlotSpans`; the MCP tool description stops
claiming cart spans are validated when they are skipped.
*AC:* a manifest claiming a bank range the title never read is flagged; a correct
manifest passes; the finding carries the capture reference.

*As built:* `CartReadSetEntry` + `buildCartReadSet` + `cartReadSetFromCaptureFile`, and
`cartBankUsage` to aggregate by (bank, slot). `LandingMapEntry.source` is now a **tagged
union** — `{medium:"disk",…} | {medium:"cart",…}` — rather than the bare `{bank,slot,
offset}` this section proposed: a consumer must be able to tell the media apart without
sniffing fields, and the disk variant keeps exactly the fields it had. Disk attribution
is unchanged and the cart residency is only a fallback, for a reason worth keeping: on
disk, "$DD00 was read in this window" separates a transfer from a memory-copy; on a
cartridge the equivalent question — "was a bank being read while this run filled" — is
YES for every cycle of a title that EXECUTES out of a bank, so it separates nothing.
There is no cart dataflow gate, and a byte-accurate cart landing map is not derivable
from a lane that aggregates per residency. The cart READ-SET, not the landing map, is
the cart authority. `runtime_trace_start` also gained the `cart-read` domain (daemon-
only, exactly like `drive-mechanism`) so a capture can be minted from the workbench and
not only from `trx64cli boot`.

*Two producer facts this section had assumed away, both found on real captures:*

1. **`off_lo..off_hi` is a BOUNDING range, not a coverage set.** Measured: a MegaByter
   title's LUT scan reports bank 1 `$00F0-$1F4A` with **133** served reads over a
   7771-offset hull. Classifying a span by containment alone therefore over-claims. The
   reader keeps two range sets per (bank, slot): the hull (outer bound — outside it, a
   span was definitely not read) and the merge of only those residencies that served at
   least as many reads as their range spans (lower bound — what a full sweep looks
   like). **The hull may confirm; only the lower bound may refute.** Getting this wrong
   was not theoretical: anchoring on the hull flagged the byte-verified EasyFlash
   manifest as WRONG, because four late scattered-read residencies in bank 45
   (62/194/242/72 reads over ~2200-offset hulls, 13 M cycles after the loader had
   finished) spanned a hull that happened to overlap an unrelated payload's span.
2. **The producer drains periodically**, closing live residencies, so one uninterrupted
   walk arrives as several abutting records for the same bank — the MegaByter walk
   through bank 16 is 4 records, not 1. Aggregate before comparing, or a contiguous read
   reads as a fragmented one. (C1 says this; C2 records it because it is the first thing
   a reader must implement, and because it inflates any "bank transition" count taken
   off the raw stream: 628 records on the EasyFlash title contain 319 adjacent
   bank changes, of which many are drain boundaries rather than `$DE00` writes.)

*What the branch may conclude — the §2.1 line, in code.* A slot span the run did not
touch is `not seen in this run` and **never** fails the verdict. What fails is the one
thing a run can actually contradict: **the run read payload P, and read PAST the
position span S claims, without ever reading S.** A cross-bank stream is consecutive by
construction, so a later span of the same payload being swept while an earlier one was
not is a real conflict. A not-seen span AFTER the last swept span is `truncated` — the
capture may simply have ended mid-payload — and does not fail either.

*Evidence (2026-08-11, isolated `trx64cli boot --trace-domains cart-read`, 30 M cycles,
no daemon, both proof cartridges):*

- **`cross-bank-packer` title, EasyFlash hw 32** — 628 residencies, 42 (bank, slot)
  pairs. Its own 180-span manifest **PASSES**: 21 spans read in that run (7 backed only
  by a hull), 2 partly read, 157 not seen in that run, **0 contradicted**. The run
  reaches the menu, so the confirmed spans are the menu's: a dense contiguous walk from
  bank 30 `$1C59` through 31 and 32 (8192 served reads each, exactly the bank width) to
  34 `$113F`. Moving one span of a fully-swept payload to a bank the run never touched
  is flagged — 1 conflict, verdict **FAIL**, and the 157 untouched spans stay "not
  seen".
- **`cart-lut` title, MegaByter hw 86** — 12 residencies: bank 1 (the LUT, sparse), then
  15 `$1777-$1FFF` → 16 `$0000-$1FFF` → 17 `$0000-$1FFF` → 18 `$0000-$0047`. Its
  675-span manifest **PASSES**, 7 spans read in that run. One payload's four spans match
  the lane **byte for byte**: 2185 + 8192 + 8192 + 72 = 18641 served reads = the
  manifest's declared payload length, span boundary for span boundary. Same wrong-span
  injection → flagged, **FAIL**.

*Image binding, checked rather than assumed (§4.1).* That capture booted the hw 86 /
1050688 B image, while the project's emitter binds its manifest to the **other**
cartridge in the same project (hw 19 / 1017856 B) and refuses to re-bind — the A4 guard
firing correctly. Diffing the two images: banks 0, 1 and 123 differ, 124-127 exist only
in the booted one, **and banks 15-18 are byte-identical**. So the confirmed walk is a sound
comparison and the two unclaimed sparse ranges in bank 1 are not, because bank 1 is one
of the three that differ. `validate_extraction` now warns on this class directly by
comparing the manifest's `imageIdentity.sha256` against the capture's media identity —
and reports honestly that a `trace/start_domains` capture carries **no** `mediaSha`, so
the check is currently a "cannot verify" note rather than a comparison. Giving the live
capture header its media identity is the follow-up that would close it.

*Gate:* `npm run e2e:785-cart-readset` — 23 synthetic assertions (round-trip, drain-split
merge, sparse/solid split, all six span classes, both no-lane paths). Set
`C64RE_785_CAPTURE` + `C64RE_785_MANIFEST` to run the same gate against a real capture:
28 assertions including the wrong-span injection. Neither cartridge nor capture may live
in this repo, hence the env-gated second half.

**C3 — Truthful labelling. BUILT 2026-08-11.** Every surface that shows read-set-derived
Used says "used in run X". §2.1.
*AC:* no view or tool output renders a read-set result as unqualified "used" or
"unused".

*As built:* the run is named on every line that reports a read-set fact —
`validate_extraction`'s output and its finding, `runtime_loader_lens`'s header (plus an
explicit "a block absent here was not read IN THIS RUN — that is not evidence it is
unused"), both tool descriptions, the extraction steering block, and
`docs/spec784-manifest-reference.md`. The counts are named for what they are:
`confirmedSpans` / `weakConfirmedSpans` / `partialSpans` / `notSeenSpans` /
`conflicts` / `truncated`, with no `used` or `unused` field anywhere in the result type.
Unclaimed cart reads carry their own caveat: cartridge code executes in place, so a bank
the loader never "loads" still shows up when the CPU ran out of it — they are leads, not
defects. Measured: 53 unclaimed ranges on the EasyFlash title, the largest being the
1.84 M-read residency in bank 63 that is simply the engine running.

*Not done, and why:* the steering block is appended to a project's `steering.md` only if
neither its token nor its marker is present, so the new §2.1 paragraph reaches **new**
projects only. Rewriting the two live projects' `steering.md` would be mutating live
project data from a build step, which §6 forbids.

### Part D — spec + docs (Doctrine rule 9)

784's status line reads `PROPOSED (ready for build)` while all its deliverables are
in the tree; correct it and move it. Correct this file's history as it is built.
Correct the `validate_extraction` tool description. Same commit as the change, or the
one after.

## 6. Whole-spec acceptance

Checked 2026-08-11, after C2/C3.

- ✅ Both proof cartridges register their full index as payloads with ordered slot
  spans and `derivedBy`, through the **same** call path as a disk manifest. — A2, on
  copies: 135 and 554 payloads, spans identical to the manifest, `manifest-register.ts`
  switching on `span.kind` and nothing else.
- ✅ Neither project reports "Loader model not identified". — closed 2026-08-11, last of
  the acceptance set. The banner rendered the free-text `projectProfile.loaderModel`,
  which nothing on the default MCP surface writes, so a project could hold a fully
  recovered loader and still read "not identified". The snapshot now carries the
  **store** (`loaderModels`, Spec 784 B3) and the banner answers from it, falling back
  to the profile string only when the store is empty. Measured on three states:
  `cross-bank-packer — 135 payloads` · `cart-lut — 554 payloads` · and, with nothing
  registered, still an honest `not identified`. The profile field is `undefined` in all
  three, which is the proof the banner no longer depends on it.
- ✅ Cartridge coverage reports the three axes in bytes; the "65/65 with zero payloads"
  reading is impossible to produce. — B1+B2: 65/65/0 → 65/4/61.
- ✅ The read-set records what a title read across bank switches, and a wrong manifest
  span is caught by it. — C1 records the walks; C2 catches an injected wrong span on
  **both** proof cartridges while both correct manifests pass, and — the part that took
  a second attempt — without failing the 157 / 668 spans the runs simply never reached.
- ✅ Nothing built here branches on disk-vs-cart above the block layer — 784 §2, and
  the acceptance test for both. — the media split lives inside `validateExtraction`
  under one signature and one verdict, and inside `buildReadSet` / `buildCartReadSet`
  over one capture file; `LandingSource` is a tagged union, so consumers switch on the
  tag instead of on a medium flag threaded down from above.
- ✅ All project work on **copies**. No live project data mutated by a build step. — the
  C2/C3 captures, manifests and validations all ran in a scratch directory; the two
  projects were read, never written. That is also why the C3 steering paragraph reaches
  new projects only.

## 7. Non-goals

- No generic built-in resolver for cart loaders. Per-project extractor, as 784.
- Emulation stays validation-only and the physics-blocked fallback, never the
  default bulk path.
- No cartridge *building*. This spec is read-direction only.
- No corpus campaign. Two titles prove the tooling; the rest is a separate track.
