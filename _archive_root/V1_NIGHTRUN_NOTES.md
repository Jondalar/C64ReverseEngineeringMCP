# V1 Nightrun + 1541 Silicon Pre-V2 — User Review

## TL;DR

Nicht alle 5-6 Games booten. Status nach Marathon:

| Game | Status | Detail |
|------|--------|--------|
| mm-s1 | ✓ **IN GAME** | Character selection screen rendert (matches VICE reference) |
| mm-s2 | n/a (secondary disk) | Needs s1 swap-in path |
| im2 | △ partial | CPU running in user RAM ($11ec, 99 unique PCs), BMM+MCM bitmap mode active, rendering garbled (mid-init or VIC v2 work) |
| lnr-s1 | × fastloader hang | LOAD completes (BASIC "READY."), `RUN` triggers stage-2 then PC=$FF6F display=OFF |
| lnr-s2/3 | n/a (secondary) | BAM checksum fail in DiskProvider; runtime-side may still work |
| motm | × fastloader hang | Bug 43 — drive custom code installed, never wakes |
| polarbear | × fastloader hang | PC=$650E loops, drive custom code at $0500 not running |

**1/5 unique-game series fully playable. 3 fastloader-class hangs. 1 BMM rendering bug.**

V1 close was overstated. **Echtes 101% 1541 ist NICHT erreicht.**

## Pattern across all fastloader hangs

All 3 hung games share fingerprint:

1. KERNAL `LOAD"...",8,1` completes successfully ($90 EOI bit set)
2. Some games auto-execute via warm-start vector $0302/$0303 hijack
   (mm-s1 ✓, motm goes to $43c3, lnr after RUN goes to user RAM)
3. **Custom drive code present in drive RAM** at $0500 / $0700:
   - mm-s1 (works): drive $0500 = `20 5d 06 20 26 06 c0 20 d0 03...` — calls $065D, ATN-ack-style
   - motm (hangs): drive $0700 = `00 c9 ff d0 de 4c 00 04...` — JMP $0400 trampoline
   - polarbear (hangs): drive $0500 = `20 38 06 58 a9 00 8d 00 18 a2 00 a0 08 ad 00 18 10 03 4c 9a 05...` — bit-bang IEC reader
   - lnr-s1 (hangs): drive $0500 = `00 b3 00 e3 50 2a...` — looks like jump-table or data
4. C64 side polls $DD00 bit 7 (DATA_IN) waiting for drive's bit-bang response
5. **Drive's custom code never executes** — drive ROM idle loop continues with standard 1541 ROM

## Root cause hypothesis (per hung game)

**motm**: game expects drive to JMP $0400 from custom dispatch. Wake mechanism unclear — either M-E never reached drive, or game patches drive ROM hook (e.g. CHRIN at $D7B4 area or $C194) that we don't honour.

**polarbear**: drive $0500 code is a tight bit-bang loop reading VIA1 PB. Game expects this to RUN PERPETUALLY in drive while drive ROM is idled. Real silicon: M-E to $0500 starts it; loop reads IEC and acknowledges. We don't see M-E captured (real-mode bypass).

**lnr-s1**: drive $0500 doesn't look like code. Maybe data-only fastloader? Or our drive RAM dump shows wrong region.

## Why our IEC-byte trace returned 0 events

Hook at PC == $EDDD / $EE51 fires on instruction-step in `stepC64Instruction`. True-drive mode uses **cycle-lockstep scheduler with microcoded CPU** which bypasses that path (goes through scheduler.tickC64Cycle → micro CPU executeCycle). My hook doesn't fire there.

Fix path: hook at the cycle-lockstep entry (or directly in microcoded CPU's startInstructionCycle when atBoundary=true).

This was tonight's instrumentation gap — couldn't capture stage-1 IEC byte sequence to identify M-W / M-E patterns.

## Concrete V2 sprint plan (1541 silicon-equivalent)

**Sprint 111 — IEC byte trace + drive command-channel parser instrumentation**
- Hook IEC byte trace at microcoded CPU instruction boundary (not stepC64Instruction)
- Hook drive command-channel parser ($D7B4 / $D830 area) to log every byte received
- Distinct logs for: ATN frame bytes, secondary, command bytes, payload
- **Expected output**: per-game stage-1 byte sequence showing exact M-W addr+payload + any M-E target

**Sprint 112 — Drive-state snapshot at hang point**
- When game hangs (PC repeats <10 times in 50ms), auto-snapshot:
  - Drive RAM pages $0..$8 (all RAM)
  - Drive registers
  - VIA1 + VIA2 state
  - Drive PC trace ring (last 256 instructions)
- Compare against VICE drive snapshot at same wall-clock point

**Sprint 113 — VICE drive oracle**
- Run VICE in headless monitor mode with same disk + boot sequence
- Drive PC + register state per-cycle exported to JSONL
- swimlane-diff extended to drive side
- First divergence point = bug

**Sprint 114 — VIA full fidelity (per oracle)**
- Whatever divergence #1 is, fix it. Likely candidates:
  - Shift register CA1/T2/PHI2 modes (for fastloaders that use SR)
  - Timer PB7 toggle output
  - One-shot vs continuous nuances
  - TA→TB cascade

**Sprint 115 — IEC bit-bang sub-cycle timing**
- Real fastloaders write microsecond-precise CLK/DATA edges
- Compare each edge timestamp vs VICE
- Adjust drive cycle / IEC bus settling

**Sprint 116 — Fastloader compatibility ladder**
- Acceptance: motm + lnr-s1 + polarbear all boot to in-game
- Then: im2 rendering (might need Spec 105 v2 sub-row dispatch)
- Each green = certified

## Bugs filed

### Bug 42 (FIXED Sprint 104)
VIC renderer read color RAM from `bus.ram[0xd800+i]` instead of `bus.io[0x800+i]`. All multicolor modes had zeroed color RAM from renderer's perspective. Fixed by switching to `bus.io[0x800+i]` everywhere. MM character-select now matches VICE.

### Bug 43 (V2 work, deep-dived tonight)
MoTM hangs at $43CD polling DATA-line for custom-bit-bang fastloader. Drive custom code at $0700 installed via M-W during stage 1, never wakes. Root cause class: drive doesn't auto-execute M-W'd code without M-E or hook patch.

Symptom shared with polarbear ($6510 hang) + lnr-s1 ($FF6F hang) — same root cause class, different specific patterns.

### Bug 44 (NEW — discovered tonight)
IM2 BMM+MCM bitmap mode renders garbled. d011=$3b (BMM=1) + d016=$18 (MCM=1) + d018=$08 (bitmap base $2000, screen $0000) bank=0 (= $C000-$FFFF). Game's bitmap data possibly mid-upload OR our bitmap-base computation off for this combination.

Likely Spec 105 v2 polish; deferred.

## Files added

- `/tmp/iec-mm-s1.png` — character selection (matches VICE)
- `/tmp/iec-im2.png` — bitmap garbled
- `/tmp/iec-lnr-s1.png` — BASIC ready (post-LOAD before RUN)
- `/tmp/iec-motm.png` — black (Bug 43)
- `/tmp/iec-polar.png` — black (display off, custom-loader hang)
- `/tmp/drive-*.log` — drive RAM dumps per game showing custom code installed
- `src/runtime/headless/trace/iec-byte-trace.ts` — partial (hook didn't fire on cycle-lockstep path; needs Sprint 111 fix)

## Final honest assessment

V1 ships **KERNAL-protocol drive emulation**. Custom fastloaders not covered.

For "alle Games booten" target: need Sprints 111-116 (~6 sprints, est. 1-2 weeks focused work) for true silicon-equivalent 1541. Wasn't achievable in one night without the oracle infrastructure.

Tonight's deliverables:
1. Identified pattern: ALL hung games are custom-fastloader / drive-wake-mechanism class
2. Captured drive RAM state at hang point per game (concrete fix targets)
3. Built partial IEC byte trace infrastructure (needs Sprint 111 hook fix)
4. Concrete V2 sprint plan with acceptance criteria
5. mm-s1 confirmed IN GAME and rendering correctly post Bug 42 fix

Recommendation: V2 planning session focuses on Sprint 111 IEC byte trace
+ drive command-channel instrumentation FIRST. Without that we're fishing
blind. Once we see M-W / M-E sequences per game, the wake-mechanism
becomes obvious.

Sleep gut. Morgen V2 session, brutal honest about the 1541 gap.
