# Spec 907 — A loader capture says where the bytes landed and which sector they came from

**Status:** C64RE D1+D4 built on spec/907 (2026-10-14); D3 waits on TRX64 (D2, the new record).
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
  Then  a landing's source is the block read that really preceded it (the reader uses a common clock or the recorded offset)

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
| S4 | P2 | clocks comparable | TRX64 test (emits the offset or a common clock) + C64RE `e2e:907-lens` reader case | both gates |
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
  - The capture header (or a record at each drive reset) carries the drive-to-C64 clock offset.
  - Tests per S3/S4; release as a TRX64 patch (additions), C64RE pins it.
- **D3 (P2, C64RE):** decode `0x37` and the clock offset (`src/trace/binary-format.ts`,
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
