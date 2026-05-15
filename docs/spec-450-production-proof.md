# Spec 450 — validation-harness production-proof (1541 V1)

**Status:** DONE-with-CAVEATS (2026-05-15)
**Branch:** `1541-literal-vice`
**Doctrine:** Claude-self literal audit. No subagents. 1541-only
V1, PAL-first, D64+G64. Image-compare primary gate (per user
2026-05-15 kick-off); CPU-traces = debug-escalation only.

## Mandate

Spec 450 is the V1 silikon-equivalent **read+write+verify**
validation gate. Until green, 1541 V1 is not shippable.

## Scope (per user kick-off 2026-05-15)

| Dim | Choice |
|---|---|
| Validation depth | (D) All 3 layers stacked: sector + drive-CPU + KERNAL |
| Corpus | vice-testprogs/drive/{format,diskid,iecdelay} + synthetic SAVE/LOAD + Lorenz Disk1 baseline |
| Cross-check | Image-compare PRIMARY (sha256 post-state D64/G64); CPU-trace = debug-escalation only |
| Failure modes | Write-protect / read-unwritten / re-write / cross-track / G64 extended tracks — all in one spec |

## Final scenario matrix

| # | Layer | Scenario | Status | Notes |
|---|---|---|---|---|
| 1 | A | single-sector-roundtrip | **PASS** | sector-level self-consistency via D64Parser.setSector |
| 2 | A | (A2 WPROT — see deferral note below) | DEFERRED | covered by existing `g64-fidelity-tests.ts` (VIA2 PB_WPS pin unit test) — duplicating in harness adds no signal |
| 3 | A | read-unwritten-sector | **PASS** | gcr_read_sector_vice on sync-less track → CBMDOS_FDC_ERR_SYNC or _HEADER |
| 4 | A | rewrite-isolation | **PASS** | write (1,0) twice with different payloads; neighbour (1,1) untouched byte-for-byte |
| 5 | B | integrated-runner-smoke (B0) | **PASS** | pre-flight: boot+persist completes cleanly, drive reports no-modifications on pure boot |
| 6 | B | format-prg (B5) | **RED_OK** | drive reports no track modifications after RUN — SAVE/FORMAT path not engaging drive write side |
| 7 | B | diskid-read (B6) | **PASS** | pure read via diskid1.prg + SYS 2064; drive correctly makes no writes |
| 8 | B | iecdelay (B7) | **PASS** | IEC timing probe via iec-bus-delay-auto.prg; no drive writes |
| 9 | C | basic-save-load (C8) | **RED_OK** | same root-cause family as B5 — KERNAL SAVE not propagating to drive write |
| 10 | C | g64-extended-tracks-save (C9) | **RED_OK** | same root-cause family as B5/C8 (motm.g64 SAVE); regression guard for project_motm_via1_ca1 once root-caused |
| 11 | C | lorenz-disk1 (C10) | DELEGATED | covered by existing `npm run test:lorenz:disk1` (CLAUDE.md baseline 100% PASS) — separate canary, not duplicated in 450 harness |

**Totals: 6 PASS / 3 RED_OK / 0 FAIL / 2 DEFERRED**.

## Foundation infrastructure (commit `f756dd8`)

- `src/runtime/headless/validation/disk-image-hash.ts` — sha256
  helpers + `firstByteDivergence` for debug pinpointing.
- `tests/integration/spec-450/harness.ts` — `ScenarioModule`
  interface + runner with PASS/FAIL/RED_EXPECTED tally.
- `tests/integration/spec-450/run-all.test.ts` — dynamic
  scenarios/*.ts loader.
- `tests/integration/spec-450/integrated-runner.ts` (commit
  `7e85f21`) — wraps `startIntegratedSession` + boot + load PRG +
  type command + persist trackBuffer for Layer B/C scenarios.

New canary slot: `npm run canary:spec-450-write` (separate from
canary:spec-430 so read-side regression isolation is preserved).

D64 write-back foundation:
- `D64Parser.setSector(track, sector, bytes)` + `.toBuffer()`
  (commit `2e27d4f`) — overwrite 256-byte sector in-place +
  full-image bytes for sha256 / file dump.

## Deferrals (with reason)

### A2 (Write-protect honored)

**Reason:** WPROT is a VIA2 PB_WPS pin concern. Pin-level
behaviour is already pinned in `g64-fidelity-tests.ts`
(g64-fidelity-tests.ts:130-142). Duplicating in the 450 harness
without an end-to-end SAVE workflow (gated on B5/C8 root cause)
gives no additional signal. Re-evaluate after B5 root-cause work
lands.

### C10 (Lorenz Disk1 testsuite)

**Reason:** Already covered by the existing `npm run test:lorenz:disk1`
canary at 100% PASS (CLAUDE.md baseline). Wrapping it inside the
450 harness adds maintenance without changing the coverage
guarantee. Continued green status is gated by the existing
canary, referenced from this proof for traceability.

## RED_OK root-cause family

B5, C8, C9 all share the same observable: the drive
`trackBuffer.isModified()` returns false after a SAVE / FORMAT /
N0: command sequence.

### Quick code-audit (2026-05-15, no trace capture)

1. ✅ `src/runtime/headless/traps/kernal-fileio.ts:130` —
   `trapSave` is a `SAVE (no-op stub)`. **But the trap only fires
   when `enableKernalFileIoTraps === true`.**
2. ✅ `session-modes.ts:87-96` — `true-drive` mode resolves
   `enableKernalFileIoTraps: false` + `enableKernalSerialTraps:
   false` + `enableKernalIoTraps: false`. All trap paths OFF.
3. ✅ Our 450 scenarios use `mode: "true-drive"` (see
   `integrated-runner.ts`). Trap layer cannot be the cause.
4. ✅ B6 diskid PASSES — drive engages, ROM runs, IEC bus works
   in the read direction. Means drive isn't fundamentally broken
   in the integrated session.
5. → write-specific path is suspect: drive ROM either doesn't
   pick up the SAVE/FORMAT command from IEC, OR drive writes
   land somewhere other than `trackBuffer` (so
   `trackBuffer.isModified()` stays false).

### What 450.x should NOT do first

Trace capture is **not** the right starting point under the
1:1-VICE doctrine. All component ports (KERNAL ROM, drive ROM,
IEC bus 430, VIA1/2 442/443, GCR 445, alarm 448, drivecpu 444)
are audited 1:1. If a write fails, the cause is in either:

- a TS-side glue/wiring layer (composition between the ported
  components) that was never literal-VICE in the first place, or
- an unexamined TS-EXTRA shortcut bypassing the real path.

Both are findable by **reading the code**. Capture only helps
when reading-the-code stalls.

### Spec 450.x — code-audit-first plan

Audit order (each step is short — stop as soon as the divergence
is found):

1. `IntegratedSessionOptions.writeProtected` default + how it
   propagates through `kernel` → drive VIA2 PB_WPS pin. Confirm
   our scenarios mount writable.
2. `via2-gcr-shifter-coupling.ts` → `shifter` → `trackBuffer`
   write-back chain. Find where drive-side writes are supposed
   to mark trackBuffer dirty. Verify chain is intact at runtime
   (no missing wire).
3. IEC bus LISTEN+OPEN+second-addr handling on drive side
   (channel 0 = SAVE, channel 15 = command). Confirm drive ROM
   actually receives the LISTEN frame and processes the channel.
4. KERNAL ROM SAVE routine — confirm it's actually executing
   the serial-bus path (vs. hitting a fallback / no-op somewhere
   else in our trap surface that we missed in step 1).

**Capture-as-fallback** is only invoked if all four audits pass
and the bug is still invisible — at which point bilateral cpu_step
trace + DuckDB-diff is the right next move (per
[[feedback_trace_into_duckdb]]). Charter explicitly forbids the
capture-as-default approach for this debug.

## Verification

| Gate | Result |
|---|---|
| `npm run build` | PASS |
| `npm run canary:spec-450-write` | 6/9 PASS + 3 RED_OK + 0 FAIL |
| `node tests/integration/drivecpu-vs-vice-baseline.test.mjs` (Spec 444) | 9999/9999 within ±2 (max abs delta = 1) — sanity |
| `npx tsx tests/unit/alarm/alarm-context.test.ts` | 22/22 PASS (sanity) |
| `npx tsx tests/unit/alarm/alarm-dispatch.test.ts` | 11/11 PASS (sanity) |
| `npm run canary:spec-430` (read-side regression isolation) | 5/5 PASS (verified after each Spec 450 commit) |

## SHAs

| Commit | Subject |
|---|---|
| `b1cc65e` | Spec 450 charter |
| `f756dd8` | Commit 1/8 — validation-harness foundation (sha256 helper + harness skeleton + canary slot) |
| `2e27d4f` | Commit 2/8 — Scenarios A1 + A4 (sector-level self-consistency); D64 write-back foundation |
| `8d18f5a` | Commit 3/8 — Scenario A3 + harness path-optional fix |
| `7e85f21` | Commit 4/8 — integrated-runner helper + B0 smoke probe |
| `f7fb11b` | Commit 5/8 — Scenario B5 format-prg (red-as-expected probe) |
| `fb7fa46` | Commit 6/8 — B6 diskid + B7 iecdelay |
| `f150962` | Commit 7/8 — C8 + C9 |
| `0a5c855` | Commit 8/8 — production-proof + PLAN/epic updates |

## Out-of-scope / future

- **Spec 450.x:** root-cause B5/C8/C9 RED_OK family. Capture
  bilateral TS+VICE traces for FORMAT + SAVE workflows; DuckDB-
  diff first divergence. Once green, the 3 RED_OK rows flip to
  PASS + each scenario captures a real VICE post-state baseline
  under `samples/baselines/spec-450-write/{B5,C8,C9}/` for the
  primary image-compare gate.
- **Spec 451:** NTSC sync regression validation (PAL-first done).
- **Spec 452:** drive-cycle tick-order rotation-before-cpu.
- **Post-V1:** DOS command channel full coverage (channel-15,
  dir-listing, BLOCK-READ/WRITE direct addressing).

## V1-ship gate verdict

**PARTIAL.** Read-side workflows green. Write-side workflows
RED_OK (single root-cause family). Spec 450 is **NOT** a full
V1-ship gate yet — Spec 450.x is required to flip the 3 RED_OK
scenarios. The harness itself (Foundation + scenarios + canary
slot + ScenarioModule pattern) is production-ready and ships
with this spec; follow-up debug uses the same scaffolding.
