# Spec 613 — c64 IEC `LOAD"$",8` Regression in True-Drive Mode

**Status:** OPEN — diagnosis complete, fix scope multi-session.
**Created:** 2026-05-18 (Spec 612 session sidequest discovery).
**Branch:** TBD (off `master`; do NOT merge with Spec 612 work).

---

## Bottom line

In `mode: "true-drive"` (KERNAL FILEIO / SERIAL / IO traps disabled), `LOAD"$",8` does NOT produce a valid directory result on either `drive1541="legacy"` or `drive1541="vice"`. The drive 6502 lands at `$1848` (VIA1 mirror) and stays there forever. c64 KERNAL stalls at `$ED5A/$EEAC` (CIOUT debpia loop) waiting for drive's DATA-pull ack that never arrives.

This is NOT a Spec 612 regression. It reproduces on:

- branch `codex/612-vice-side-by-side` (with Spec 612 ports)
- `origin/master` (= `db8a435`)
- tag `runtime-green-2026-05-16` (= `87b4957`) — the "frozen green" baseline

The "runtime green" tag's claim refers to the 7-game visual screenshot gates (motm, MM, IM2, LNR, Scramble, Pawn, Polarbear). Those gates use a DIFFERENT code path — likely autostart + FILEIO trap — not real-IEC `LOAD"$",8` directory load through CIOUT/ACPTR. The real IEC path has been broken at least since the tag.

## Evidence

### Empty session — no disk, no commands — drive idle

```
$ node -e "..." (Spec 612 branch, true-drive, legacy)
LEGACY no-disk: drv.PC=$1848
```

### Mounted disk, typed `LOAD"$",8`, ran 12 PAL frames (master HEAD)

```
MASTER legacy true-drive:
  c64.PC=$eeac  DD00 writes=2
  $0801..: 00 00 ff ff ff ...
  | LOAD"$",8                |
  | SEARCHING FOR $          |
```

### Same on runtime-green-2026-05-16 tag

```
TAG legacy idle:    drv.PC=$1848
TAG legacy LOAD:    c64.PC=$ed5d  drv.PC=$1848
  $0801 = 00 00 ...  (empty)
  screen: SEARCHING FOR $  (then stuck)
```

### Counterexample — kernel.runCycles + drive1541.attachDisk WITHOUT mount.ts helper

Earlier Spec 612 probe (`probe_load.mjs`) reached `c64.PC=$E5CF` — but via a SYNTAX-ERROR false-positive (80K typing dropped the leading "L", BASIC error-returned to a PC coincidentally adjacent to LOAD-completion PC). Slow typing (250K hold) reproduces the same `$ED5A` stall.

## Why "runtime green" still passes the 7-game gates

The 7-game gates set is run via:
- `mode: "fast-trap"` or `mode: "real-kernal"` (KERNAL FILEIO traps ENABLED), OR
- autostart path that bypasses `LOAD` entirely

Both bypass the real IEC CIOUT/ACPTR + drive ATN-handler protocol. So "runtime green" verifies the renderer + KERNAL stub serves the disk, not that the drive 6502 + IEC handshake produce valid directory bytes.

## What `drv.PC = $1848` means

- `$1848` is in the VIA1 register mirror ($1800-$1BFF). Address `$1848 & $0F = $08` = T1L-L (T1 low latch).
- CPU opcode-fetches at `$1848` read the T1 latch byte (which is 0 unless drive writes it). Opcode 0 = BRK.
- BRK pushes PC+2, jumps to IRQ vector `$FFFE = $FE67`. IRQ handler PHA-sequence, then RTI pulls PCL/PCH. RTI restores to PC+2 = `$184A` next iteration... but stack gets shuffled and PC ends back at `$1848` in the cycle.
- Drive is in an infinite IRQ-vector cycle, never reaching any 1541 ROM code that responds to IEC commands.

## Spec 612 partial fixes that improved but did not cure this

On branch `codex/612-vice-side-by-side`:

- **T3.6** (commit 2649525): per-instruction vice drive tick via EventCatchupStrategy.additionalCatchUp. Drive now runs 1:1 with c64 (was 1:60 starvation). Vice drive PC reaches `$F2B0` job dispatcher instead of `$1848`.
- **T3.7** (commit 8025092): inverted iecLineDrive polarity in vice1541-facade. CA1 IRQ now fires on c64 ATN-assert edges in vice mode (via1.ifr=$02 confirmed).
- **T3.8** (commit 9094310): documented remaining vice-mode drive crash via spurious M-E job dispatch to `$0800`.

These fixes are vice-mode-only. Legacy mode still has drive at `$1848` because the per-instruction tick + polarity fixes did NOT land for the legacy drive code path.

## Diagnostic path (next session)

### Step 1 — Bisect when drive first started crashing to $1848

`git log --oneline runtime-green-2026-05-16..origin/master -- src/runtime/headless/drive/ src/runtime/headless/iec/` to find the commit window. The drive `$1848` crash is older than `runtime-green-2026-05-16` tag, so bisect may need to go further back to find when REAL IEC `LOAD"$",8` last worked.

### Step 2 — Verify the 6-game gate path actually exercises IEC

Run `scripts/runtime-proof-gate.mjs` with verbose tracing on one game (e.g. motm). Count `setC64Output` calls + `iecBus` `setDriveOutput` calls. If both > 100, real IEC works in some scenario. If only one is high, that side is the broken end.

### Step 3 — c64 KERNAL trap path comparison

In `mode: "fast-trap"` (traps ON), `LOAD"$",8` works because FILEIO trap intercepts at PC=$F4A5 and serves directory from `diskProvider` directly. The drive 6502 is never engaged. Confirm this matches by running same test in fast-trap mode and verifying `$0801` populates correctly.

### Step 4 — VICE binmon side-by-side trace

Required per `feedback_read_vice_first` rule. Run VICE with same blank.d64 + `LOAD"$",8`. Capture drive PC + bus trail for first 100ms. Compare against headless. First divergence → fix candidate.

### Step 5 — Possible candidate areas (DO NOT modify until trace evidence)

- `src/runtime/headless/drive/drive-cpu.ts` — 6510 opcode core (does it match VICE drive_6510core init?)
- `src/runtime/headless/drive/drive-rom.ts` — driverom_initialize_traps order
- `src/runtime/headless/cia/cia6526-vice.ts` — CIA2 PA store inversion before iecbus callback
- `src/runtime/headless/iec/iec-bus.ts` — `_performC64Write` step sequence
- `src/runtime/headless/iec/iec-bus-core.ts` — `c64_store_dd00` ATN-edge callback gate

## Scope rules for Spec 613

- New branch off `master` (NOT off `codex/612-vice-side-by-side`).
- c64-kern changes ALLOWED under this spec (user has explicitly authorized via "ja fix 613").
- All other CLAUDE.md / memory rules apply: read VICE source first, trace before patching, no speculation without first-divergence evidence.
- 6-game screenshot gate test set MUST stay green throughout (per `feedback_game_screenshot_test_set`). Adding LOAD"$",8 directory-load smoke joins the gate set.

## Cross-link

- `specs/612-1541-port-fidelity-todo.md` T3.4, T3.5, T3.7, T3.8 — Spec 612 partial diagnostic threads that converge here.
- `specs/600-runtime-proof-gates.md` — VICE binmon side-by-side doctrine.
- `docs/vice-iec-arc42.md` — IEC handshake reference + ADR-1 push-flush.
