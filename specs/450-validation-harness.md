# Spec 450 — Full read+write+verify validation harness (1541 V1)

**Status:** OPEN (charter signed off 2026-05-15; Phase 2 mapping + build in progress)
**Priority:** HIGH (V1 silikon-equivalent gate)
**Parent:** Epic 440
**Depends on:** Specs 441-449 (all DONE)
**Doctrine:** 1541-only V1, PAL-first, D64+G64 (P64 stubs only).
Claude-self, no subagents. Bilateral-bug defense
([[feedback_1541_port_workflow]]) = bilateral validation against
VICE for every workflow.

## Mandate

This is the **V1 silikon-equivalent gate** ([[feedback_truedrive_101]]).
Until Spec 450 is green, 1541 V1 is not shippable. After Spec 450:
- read+write+verify functionally identical to VICE
- both deterministic (cycle-exact via Spec 444 baseline) AND
  byte-exact on disk image (this spec adds)
- corpus-driven coverage including write-protect, cross-track, G64
  extended tracks, sector re-write

## Scope (per user kick-off 2026-05-15)

| Dim | Choice |
|---|---|
| **Validation depth** | (D) All 3 layers stacked: sector + drive-CPU microcode + KERNAL |
| **Corpus** | (B+C) Synthetic SAVE/LOAD-roundtrip + Lorenz/cadaver disk write tests |
| **Cross-check** | (C-revised 2026-05-15) Post-state byte-image-compare (TS-written D64/G64 sha256 == VICE-written sha256) + self-consistency (TS write → read → match). CPU-trace bilateral = **debug-escalation only**, NOT primary gate. Rationale: if final disk image matches VICE byte-for-byte, the path that produced it is correct enough. CPU traces captured on demand when image-compare diverges. |
| **Failure modes** | All in one spec — write-protect, read-unwritten, re-write, cross-track, G64 extended tracks |

### Out of scope

- 1571 / 1581 / IEEE drives (per 1541-only mandate)
- Parallel cable / burst mode
- NTSC validation (deferred to Spec 451)
- P64 image format (stubs OK per [[feedback_p64_stubs_ok]])
- DOS command channel (channel-15, dir-listing, OPEN with filename
  filter — covered by deferred post-V1 DOS-channel spec from Spec 449)

## Layer breakdown

### Layer A — Sector-level (mostly covered, gap-fill)

GCR encode/decode + sector R/W roundtrip. Spec 445
`gcr-write-sector.test.ts` covers ~80%. Gap-fill:
- write-protect honored at gcr.ts boundary
- read-of-never-written sector returns expected (CBMDOS_FDC_ERR_SYNC or NOBLOCK per VICE)
- re-write same sector preserves OTHER sectors on track
- cross-track stepping during R-modify-W

### Layer B — Drive-CPU microcode level

Run 1541 6502 microcode through VIA1+VIA2 → GCR shifter → bytes on
disk image. Workflow: drive CPU executes ROM SAVE-to-sector routine,
TS captures pre/post disk image bytes, asserts changes match VICE.

Inputs:
- empty `samples/synthetic/blank.d64`
- write-sector job via $0006 job queue
- verify post-image byte-identical to VICE running same job

Coverage corpus:
- `samples/vice-testprogs/drive/format/format.prg` — full disk format
- `samples/vice-testprogs/drive/diskid/diskid.d64` — diskID read
- Synthetic single-sector R/W from track 18 BAM

### Layer C — KERNAL-level (full silikon stack)

C64 KERNAL OPEN/CHKIN/CHRIN + drive ROM serial bus protocol.
Workflow: C64 BASIC `SAVE "X",8` → drive RECEIVE-and-SAVE microcode
→ disk image updated → re-`LOAD "X",8` → bytes match input.

Corpus:
- Synthetic mini-program SAVE/LOAD roundtrip on blank.d64
- Re-LOAD must match SAVEd payload byte-for-byte
- Cross-check vs VICE: same SAVE on VICE produces identical D64 image

### Layer D — Bilateral cross-check (image-compare primary)

**Primary gate** (per user 2026-05-15): post-state byte-image hash.

For each Layer A/B/C scenario:
1. Run TS workflow against pre-state .d64/.g64
2. Hash TS-written post-state image (sha256 of full image bytes)
3. Run same workflow on VICE against identical pre-state
4. Hash VICE-written post-state image
5. Assert hashes match → workflow correct

**Captured baselines** stored as `samples/baselines/spec-450-write/<scenario>/{pre.d64,post-vice.d64,post-vice.sha256}`.
NOT cycle-traces (smaller, faster, sufficient for image-level
verification).

**Debug escalation** (only when image-compare diverges):
- Capture CPU-cycle trace via `vice_trace_runtime_start` against
  same workflow
- Diff vs TS trace to localise divergence point
- Per [[feedback_trace_into_duckdb]]: ALWAYS use trace-store +
  DuckDB, NEVER one-off scripts

VICE-baseline policy:
- Pre-existing read-only baselines in `samples/traces/v2-baseline/`
  unchanged ([[reference_vice_baseline_traces]] DO NOT re-run).
- NEW write-scenario baselines captured live for Spec 450.

## Workflow (7-step per [[feedback_1541_port_workflow]])

1. **Charter** (this doc) — corpus list, scenario matrix, gates.
2. **Mapping doc** `docs/spec-450-validation-mapping.md` —
   per-scenario row: VICE workflow → TS workflow → bilateral
   assertion. Pin every expected disk-image hash.
3. **Test harness build** —
   `tests/integration/disk-validation-harness.test.mjs` (new) +
   `scripts/spec-450-canary-gate.mjs` (new). NO subagent.
4. **Corpus capture** — run NEW VICE baselines for write scenarios
   not already in `v2-baseline/`. Store under
   `samples/traces/v2-baseline/spec-450-*/`.
5. **Bilateral verification** — all scenarios in matrix PASS
   (hash-identical) or RED-as-expected for known regressions.
6. **Production-proof doc** `docs/spec-450-production-proof.md`
   with SHAs + full scenario matrix table.
7. **Canary integration** — extend `canary:spec-430` to include
   write-roundtrip scenarios, OR new canary
   `canary:spec-450-write` callable from CI.

## Acceptance

1. `tests/integration/disk-validation-harness.test.mjs`: all
   bilateral scenarios PASS.
2. New write-corpus baselines committed under
   `samples/traces/v2-baseline/spec-450-*/`.
3. `npm run build` PASS.
4. Spec 444 cycle-diff unchanged (9999/9999 ±2 sanity gate).
5. Existing `canary:spec-430` 5/5 PASS (no read-side regression).
6. New `canary:spec-450-write` (or extended 430) green for all
   scenarios.
7. Failure-mode coverage: write-protect honored, read-unwritten
   matches VICE, re-write isolation, cross-track stepping, G64
   extended tracks (motm-anomaly regression test).
8. Production-proof + mapping docs committed.

## Scenario matrix (V1 corpus — locked 2026-05-15)

Image-compare primary gate. sha256 of post-state .d64/.g64 vs
VICE-produced .d64/.g64.

| # | Layer | Scenario | Input | Expected | VICE baseline |
|---|---|---|---|---|---|
| 1 | A | Single-sector write + read roundtrip | blank.d64 + 256 bytes random data | re-read = identical (self-consistency) | N/A (self-test) |
| 2 | A | Write-protect honored | scramble_infinity.d64 mounted RO, attempt write | returns CBMDOS_FDC_ERR_WPROT, image bytes unchanged | derivable |
| 3 | A | Read of never-written sector | blank.d64 + sector (1,0) | matches VICE error code | NEW capture |
| 4 | A | Re-write preserves other sectors | blank.d64, write (1,0) twice with different data | sector (1,1) unchanged | NEW capture |
| 5 | B | format.prg full disk format | blank.d64 + samples/vice-testprogs/drive/format/format.prg | post-format BAM/dir = VICE byte-identical | NEW capture |
| 6 | B | diskid1.prg diskID read | samples/vice-testprogs/drive/diskid/diskid.d64 + diskid1.prg | drive returns expected ID bytes; no image change | NEW capture |
| 7 | B | iec-bus-delay.prg | samples/vice-testprogs/drive/iecdelay/iec-bus-delay.prg | timing trace matches VICE; no image change | NEW capture |
| 8 | C | BASIC SAVE "X",8 + LOAD "X",8 | blank.d64 + synthetic 100-byte PRG | re-LOAD payload = input; post-SAVE D64 = VICE byte-identical | NEW capture |
| 9 | C | SAVE on G64 extended tracks | motm.g64 backup (writable copy) + synthetic PRG | post-SAVE G64 = VICE byte-identical | NEW capture |
| 10 | C | Lorenz Disk1 100% regression | samples/vice-testprogs/lorenz-2.15/Disk1.d64 | 100% PASS per CLAUDE.md baseline | EXISTING |

Note: vice-testprogs/drive/readtest/ has only readme.txt (no PRG —
points to external `bitnax.d64` not in corpus). SKIPPED. Three of
four drive testprogs usable.

## Charter open questions — RESOLVED (2026-05-15)

- **OQ-1** → vice-testprogs/drive/{format,readtest,diskid,iecdelay}
  reichen. **No cadaver / Lorenz extension corpus.**
- **OQ-2** → Image-compare primary; CPU-traces escalation-only.
  Final D64/G64 byte-identical == workflow correct enough.
- **OQ-3** → New canary `canary:spec-450-write`. Read-side
  isolation preserved.

## Risk

High effort, low individual-component risk. The component ports
(VIA1+VIA2, drive CPU, GCR encode, KERNAL ROM, IEC bus) all DONE +
audited. Spec 450 is the integration validation — failures here
indicate component-port bugs surfaced by full workflow stress, or
charter-level oversights (e.g. unknown G64 extended-track quirks
beyond motm).

Estimated workload: 4-8 commits, 2-3 sessions if no major
regressions surface. Each scenario row is ~1 commit (capture +
test + bilateral hash pin).

## Do Not

- Don't break existing 5/5 canary while building (read-side
  isolation).
- Don't extend P64 support (stubs only).
- Don't add 1571/1581 corpus scenarios (post-V1).
- Don't capture NEW VICE baselines for read-only workflows
  already in `v2-baseline/` — per [[reference_vice_baseline_traces]].
- Don't use subagent verdicts for scenario pass/fail —
  Claude-self full audit per [[feedback_1541_port_workflow]].

## Out of scope → future specs

- Spec 450.x (post-V1): full DOS command channel validation
  (channel-15, dir-listing, BLOCK-READ/WRITE direct addressing).
- Spec 450.y (parallel cable era): SAVE/LOAD via parallel
  fastloader.
- Spec 451: NTSC sync regression (PAL-first done).
