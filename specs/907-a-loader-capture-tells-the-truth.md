# Spec 907 — A loader capture says where the bytes landed and which sector they came from

**Status:** BUILT and merged (2026-10-14): C64RE D1+D3+D4, TRX64 D2 on TRX64 main cd0a54f (`../TRX64/docs/internal/_archive/907-loader-capture-read-set.md`). TRX64 D2 is released in TRX64 0.13.1 and C64RE 0.9.1 pins it, so new captures are 0x37; older 0x35 captures stay report-only for read-past. The reporter's IM II retest (2026-10-15) failed on the C64RE side; fixed (see "D1 follow-up"); the stack pulls are recorded since TRX64 0.13.2, which C64RE 0.9.2 pins. S6 (the reporter's re-retest on #77) is by hand.
**Repo:** both. TRX64: which sector a drive read is credited to (P2). C64RE: the landing map (P1),
the verdict (P3), the decoder for what TRX64 adds. Leitregel: the drive's facts are a runtime
capability → TRX64; what they mean for an extraction → C64RE.
**Number:** 907 (registry: `specs/README.md`).
**Origin:** issue #77 (2026-10-14, the reporter's LLM on Impossible Mission II): `validate_extraction`
and `runtime_loader_lens` FAIL a correct extraction (`matched 130, mismatched 509, unclaimed reads 17`)
while the title and the game load from exactly those sectors in the same capture.
**Depends on:** nothing. The finalize timeout the issue also names is 906 D6.

---

## §1 The problem

**Who:** an LLM that derived a loader's sector map by reading the drive code, and verifies it.

**What it does:** captures the load with `drive-mechanism` + `memory`, then asks the loader lens
"where did the bytes land, from which sector?" and `validate_extraction` "does my manifest match
what the loader read?".

**What happens today** (read from the code, 2026-10-14; the issue's own diagnosis is partly wrong):

- **Landing map** (`src/trace/loader-lens.ts:353-476`). Runs grow only UPWARD (keyed `addr+1`,
  `:410-433`) and a run is kept only if ≥ 4 `$DD00` reads fall inside its time window (`:456-460`).
  IM II pushes each received byte onto the stack (`lda $dd00 … pha`, downward from `$01EF`) and
  copies the sector afterwards (`pla / eor #$f9 / dey / sta ($fe),y`, downward, no `$DD00` reads).
  So: every sector's pushes extend ~240 junk runs by one byte each (each spans many sectors' time,
  passes the gate easily, all credited to the first sector — "200+ runs into `$0100-$01EF`, all
  T16/S1"); and the real stores at `$1000` / `$0880` never form a run (downward) and would fail the
  gate anyway (no `$DD00` in their window).
- **Read-set** (TRX64 `crates/trx64-core/src/lib.rs:4118-4146`). There is no DOS-job detection:
  every CPU read of `$1C01` is counted (`rotation.rs:961-969`), raw custom reads included. But the
  bytes are credited to `sector_under_head()` (`rotation.rs:502-544`), which looks FORWARD to the
  next header sync — over header N and data N it reports N+1, so a block is filed under the next
  sector (inferred from `gcr_find_sync`, `gcr.rs:530-562`; to be pinned by T1's test). DOS loaders
  hide this because the header search reads every passing header. Also: `arm_head_trace` runs at
  every `session/run` (`trx64-daemon/src/main.rs:1936`) and clears the open bucket
  (`lib.rs:3735-3746`); the last bucket is never flushed at stop; BLOCK_READ carries the drive
  clock, which a drive reset sets to 0 (`drive.rs:1187,1207`), while `nearestPrecedingRead`
  compares it with the C64 clock (`loader-lens.ts:484`). No test checks which sector is credited
  (`tests/loader_head_trace.rs:88-103` checks ranges only).
- **Verdict** (`src/server-tools/validate-extraction.ts:260-275,365`). A manifest sector absent
  from the read-set is a *mismatch* and fails the verdict — "the loader never read it". The cart
  branch already follows "a run proves use, never non-use" (`:311-337`); the disk branch does not.
  A run that loads the title and the game never reaches most of a 91-payload manifest, so most of
  the 509 are "not seen in this run", not wrong.

**Why it matters:** the one tool built to prove an extraction against the real loader calls a
correct extraction wrong, on the kind of loader (custom GCR, stack buffer) where proof matters most.
An LLM that trusts it "fixes" a correct manifest.

### Parts (MECE)

- **P1 Where the bytes landed.** Downward stores, a stack buffer, and a copy out of the buffer give
  the destination as the landing, the buffer as a buffer.
- **P2 Which sector the drive read.** A block read is credited to the sector whose header the head
  last passed; nothing is lost at run boundaries or at stop; drive and C64 cycles are comparable.
- **P3 What the verdict may claim.** A sector the run did not reach is "not seen", never a failure;
  a failure is a sector read that contradicts the manifest.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 a stack-buffered, downward copy lands at its destination
  Given a capture (synthetic events) where each sector's bytes are pushed to $01EF.. during $DD00 reads
  And   then pulled and stored downward to $1000 (eor #$f9) with no $DD00 reads
  When  the loader lens builds the landing map
  Then  it lists $1000-$10EF as a landing from that sector, and $0100-$01EF as a "buffer", not a landing
  And   the next sector's copy to $10F0.. is its own landing with its own source

Scenario: S2 a relocator after the load is not mistaken for a landing
  Given the same capture plus a copy of the already-landed $1000 block to $C000 a frame later
  Then  $C000 is not a landing (its source bytes were not buffered during a transfer window)

Scenario: S3 a block read is filed under its own sector
  Given (TRX64) a G64 built in the test, drive code that waits for header N, then reads 3+320+1 raw bytes from $1C01
  When  the head trace is armed and the read happens
  Then  BLOCK_READ credits header N's bytes and data N's bytes to sector N, with header and data bytes told apart
  And   a read in progress across two session/run calls and at trace stop is counted once, in full

Scenario: S4 drive and C64 cycles can be compared after a drive reset
  Given a capture with a drive reset before the load
  Then  a landing's source is the block read that really preceded it (the reader compares on the record's c64_clk; there is no offset)

Scenario: S5 the verdict says what the run proves
  Given a manifest of 91 payloads and a capture that loaded two of them
  When  validate_extraction runs
  Then  the two are matched, the rest are "not seen in this run", the verdict is not FAIL
  And   a manifest sector whose read bytes landed somewhere the manifest does not say is a mismatch, and FAILs

Scenario: S6 the reporter's case
  Given the IM II capture from #77 (third-party bytes — by hand, not in the repo)
  Then  validate_extraction no longer FAILs, and the landing map shows $1000 (title) and $0880 (game)
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | stack buffer + downward copy | `scripts/e2e-loader-lens.mjs` (synthetic events) → `e2e:907-lens` | `gates.yml` (hermetic) |
| S2 | P1 | relocator negative | same | `gates.yml` |
| S3 | P2 | block credited to own sector | TRX64 `crates/trx64-core/tests/loader_head_trace.rs` (new cases) | TRX64 gate |
| S4 | P2 | clocks comparable | TRX64 test (record carries c64_clk) + C64RE `e2e:907-lens` reader case (drive clock restarts, c64 clock monotonic) | both gates |
| S5 | P3 | verdict classes | `scripts/e2e-validate-extraction.mjs` → `e2e:907-validate` | `gates.yml` |
| S6 | P1–P3 | reporter's capture | by hand: the reporter retests on #77 | — |

The three existing loader-lens / validate scripts are in no `package.json` script and no workflow
today; they are wired in as part of this spec.

## §3 Decision

- **D1 (P1, C64RE) landing map:**
  - Runs grow both ways (a downward run keyed `addr-1`; reported by its lowest address, bytes in
    address order).
  - Page-1 runs are reported as `buffer`, never as landings, and never dropped silently (a loader
    that really lands in page 1 stays visible).
  - Provenance pass: a write to D passes the gate when, within 16 cycles before it, a read of
    buffer address B happened, B was written inside a `$DD00` window and not rewritten since; a run
    passes when ≥ 90 % of its bytes do and `value(W) XOR value(B)` is constant across the run (so a
    depacker does not pass). Time bound: the read lies before the next transfer window.
  - A buffer whose bytes were followed into a destination is listed once, as that destination's
    buffer.
- **D2 (P2, TRX64)** — delegated to the TRX64 session:
  - Credit a block to the sector of the header the head last passed (not the next one ahead).
  - Flush the open bucket at trace stop; arming at `session/run` does not clear an armed trace.
  - Header bytes and data bytes told apart: new record `BLOCK_READ2` (opcode `0x37`: drv_clk, ht,
    sector, header_bytes, data_bytes); `0x35` stays readable for old captures.
  - Clocks: decided in TRX64 (D1 there) — no offset. Each 0x37 record carries `drv_clk` and
    `c64_clk`; the drive runs at its own rate and restarts at 0 on a reset, so no constant relates them.
  - Tests per S3/S4; release as a TRX64 patch (additions), C64RE pins it.
- **D3 (P2, C64RE):** decode `0x37` and compare on its `c64_clk` (`src/trace/binary-format.ts`,
  `loader-lens.ts`); old captures still read, with a note that sector credit may be off by one.
- **D4 (P3, C64RE) verdict:** disk sectors get the cart branch's classes — matched / not seen in
  this run / read past it / mismatch. Only mismatch (bytes read from a sector landed where the
  manifest says otherwise, or the manifest claims a sector the run read past without taking) fails.
  The answer leads with what the run covered ("this run reached 2 of 91 payloads").

## §4 Out

- Following transfers through arbitrary computation (a full taint walk) — needs opcode rows and
  TRX64's taint walk has its own listed defects; the provenance pass covers buffered copies.
- The finalize timeout — 906 D6.
- A synthetic custom-GCR disk + 6502 loader end to end in the C64RE gate — the asm helper lacks
  half the opcodes and it would need ROMs; S3 pins the drive side in TRX64 instead.

## §5 Decisions taken while building

**D1 landing map** (`src/trace/loader-lens.ts`, tests `scripts/e2e-loader-lens.mjs`, `e2e-loader-lens-file.mjs`)

- Runs: a one-byte run sits in an ascending and a descending open map; its first extension fixes the
  direction. A run is reported at its LOWEST address, `len` in bytes, `sha256` over the bytes in
  address order. Entries gain `kind` (`landing` | `buffer`), `viaBuffer {addr,len}` (landings) and
  `repeats` (buffers).
- **Buffer = page 1 only** ($0100-$01FF, the stack): a run lying wholly in page 1 that passes the
  transfer gate is a `buffer`, never a landing. A page-1 run with no transfer reads is dropped like
  any gate failure (scratch). A loader that buffers in some other page is NOT followed: its buffer
  reads as a landing and the copy out of it as a relocation (same as before; a landing and a
  relocator copy are indistinguishable by bytes alone, S2 needs them apart).
- **Transfer window:** `$DD00` reads closer than 1000 cycles belong to one window. A page-1 byte is
  "transfer-written" when its write follows a `$DD00` read by at most 64 cycles; it carries the window
  id. It stays valid until rewritten.
- **Provenance** (copy out of the buffer): a write outside page 1 follows a buffer byte when a page-1
  read of an intact transfer-written byte (value equals what was written) came at most 16 cycles
  before it (latest such read wins) and no later transfer window had begun at the read (the time
  bound). A run is a copy when >= 90 % of its bytes follow and `value(write) XOR value(read)` is the
  same for every one of them (`xorBroken == 0`; a depacker or an add fails). A write that follows a
  buffer of a different window ends the run, so two sectors never fuse into one landing.
- A copy's source is looked up at the cycle its buffer bytes were first written, not at the copy; its
  `transferReads` are the buffer window's. The page-1 runs a landing was followed out of are listed
  only as that landing's `viaBuffer`; unfollowed buffer runs are deduplicated by (address, length)
  with a count.
- Limits: a copy overlapping the next sector's transfer window is not followed (the time bound); a
  buffer filled across a >1000-cycle stall inside one sector is split into windows. Both pinned in
  the code constants, not guessed per capture.
- Unchanged assertions: all pre-existing landing-map cases pass untouched. The only new field a
  caller sees is `kind`; `source`, `c64Dest`, `len`, `sha256` mean what they meant for ascending runs.

**D4 verdict** (`src/server-tools/validate-extraction.ts`, test `scripts/e2e-validate-extraction.mjs`)

- Classes per sector span of a payload, from the data a run provides (read-set order is not used):
  - *matched* — (track, sector) is in the read-set.
  - *not seen in this run* — absent, and NOT bracketed: no matched span of the same payload comes
    both before and after it in the manifest's span order. Leading/trailing gaps and wholly
    untouched payloads. Never fails.
  - *read past it* — absent, but an earlier AND a later span of the same payload are matched.
    Fails. (Spec text lists it inside "mismatch"; they are reported as two lines, both fail.)
  - *mismatch* — the capture's landing map has a disk landing whose source is a claimed, read
    sector but whose address range overlaps no claiming payload's extent
    `[loadAddress, loadAddress + sum of its sector-span lengths)`. Raw payloads with a
    `loadAddress` only (`payloadIsPacked` payloads land elsewhere by design). The whole payload
    extent, not the per-span offset, is the test: until D3 a block read may be credited to the
    NEXT sector, and an off-by-one credit inside one payload must not read as a contradiction.
    Not judged (and the answer says so) when no landing map exists.
- Changed existing assertion: `e2e-validate-extraction.mjs` "manifest with a wrong span -> FAIL" (a
  TRAILING span the run never read) is now "not seen -> pass"; that is the D4 behaviour. A FAIL case
  stays under "read past it" (the span sits between two read spans) and a landing mismatch.
- `readSetsFromCaptureFile` now also returns the landing map from the same pass (`null` + reason when
  the capture is a firehose over the run cap; the read-set lanes are unaffected).
- Risk until D3: with the next-sector credit, an interleaved chain can show interior holes that are
  credit skew, not contradictions. The reporter's capture (S6) is the check; D3 closes it.
- `validate_extraction` opens with `Coverage: run X reached N of M payload(s)` and the finding title
  carries it.

**Wiring:** `e2e:907-lens` (loader-lens + loader-lens-file) and `e2e:907-validate` are npm scripts and
`gates.yml` steps (hermetic, synthetic events).

**D3 decode and verdict rule** (`src/trace/binary-format.ts`, `loader-lens.ts`, `validate-extraction.ts`;
tests `e2e-loader-lens.mjs`, `e2e-loader-lens-file.mjs`, `e2e-validate-extraction.mjs`)

- **Clock: no offset.** `0x37` is 23 bytes, little endian: op, `drv_clk` f64, `c64_clk` f64, half-track,
  sector (`0xff` = half-track without a header, all bytes data), `header_bytes` u16, `data_bytes` u16.
  The decoded event keeps the record's first f64 in `cycle` (the drive clock, as for every record)
  and adds `c64Cycle`; the read-set entry's `cycle` is the C64 clock for `0x37` and `drvCycle` keeps
  the drive clock. `nearestPrecedingRead` therefore compares C64 against C64. No offset idea
  exists anywhere in the code path. `FORMAT_VERSION` unchanged (2).
- **Passed vs taken.** A `0x37` visit with `data_bytes == 0` is *passed*: `taken: false`. It is not in
  the matched set, not an unclaimed read, and not a landing source; the span it names reads as absent.
  A legacy `0x35` record cannot tell and is always `taken`.
- **Read past fails only on `0x37`.** `ValidationResult.readPastFails` is true when the capture holds
  at least one `0x37` record. Without one, read-past spans are listed (marked "reported only") and the
  verdict ignores them; a landing mismatch still fails. A mixed capture counts as `0x37`.
- **Legacy note.** Any `0x35` record in the read-set adds `readSetNote`: sector credit may be off by one
  and the drive clock may not be comparable after a drive reset. It is printed by `validate_extraction`
  and `runtime_loader_lens` and returned in the result. `0x35` captures are otherwise read as before,
  on the drive clock.
- **Sector `0xff`** is a taken visit with a source `T<n>/S255`; it matches no manifest span (a manifest
  cannot name a headerless sector) and so lists as an unclaimed read.
- **Not built:** no re-credit of old `0x35` captures (the skew is not recoverable from the record).
**D1 follow-up (#77 retest on the real IM II capture, 2026-10-15).** Three C64RE defects, one TRX64 gap:
- TRX64 up to 0.13.1 recorded no stack pulls (tagged dummy reads), so no copy-out of the page-1 buffer
  could be followed on a real capture. TRX64 main d3a54e7 (0.13.2) records them as ordinary data reads
  (`pla` at pc = opcode + 1). On a capture without them the answer now says so (`stackNote`:
  transfer-filled page-1 buffers exist, no page-1 read ever took one of their bytes) instead of
  silently listing buffers.
- A run no longer stays open forever: a store to its next address after `RUN_MAX_GAP` (two disk
  revolutions, 394100 cycles; the longest stall inside a genuine landing measured on IM II is 163596)
  starts a new run. Before, a title unpacker's output run absorbed one byte of the main-game copy, so
  `$4000` read 10003 B, `$1000` 5847 B, `$0860` 33 B, and the copy lost that byte.
- The direct-landing gate counts the run's OWN stores that followed a `$DD00` read within 64 cycles
  (>= 4 and >= half of the run), not `$DD00` reads anywhere in its lifespan. IM II: the title loads sit
  at 90-93 %, the unpacker output and the arithmetic scratch at 0 %.
- Verified on the IM II capture recorded with TRX64 d3a54e7: 168 main-game blocks of 240 B, each equal
  to the ripped `$0880` image, each credited to its own sector (the last full read before the buffer
  fill); the title blocks (6240 B at `$1000`, 10080 B at `$7000`) land; no unpacker output, no glued run.
- **Open:** S6 by the reporter with TRX64 0.13.2 (the real-capture check above was run by the
  maintainer on the reporter's project).
