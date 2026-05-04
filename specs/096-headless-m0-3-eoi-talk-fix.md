# Spec 096 — Headless M0.3: EOI/TALK Fix

Status: refined, candidate fix identified via Spec 094 synthetic trace + code review (2026-05-04). Smoking gun: `src/runtime/headless/iec/iec-bus.ts:257-259` Sprint 66 hack pokes drive RAM `$7C=$80` on every C64 IEC write while ATN is low (level-trigger, not edge). Drive dispatch reads `$7C` and jumps to ATN-handler / command-parser, abandoning TALK byte-send before EOI emitted. Fix candidate: convert to edge-trigger (only on ATN high→low transition). Documented in BUGREPORT.md Bug 40 "Sprint 98 / Spec 094-097 finding". VICE-side compare (M0.2) skipped for this hypothesis — direct fix + verify via re-run of synthetic + MM traces. Hypothesis matrix below pre-existed; H1 dropped, H_NEW added.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 0, story M0.3
Depth: deep
Predecessors: Spec 094 (M0.1 EOF trace harness), Spec 095 (M0.2 VICE
EOF compare)
Successor: Spec 097 (M0.4 LOAD acceptance smoke)

## Motivation

Bug 40 closes only when the C64 returns cleanly to BASIC after a real
KERNAL `LOAD`. Sprint 96/97 work proved that the data transfer is
byte-perfect (38658 bytes match the original MM file) and that the drive
exits cleanly via the ATN handler, yet the C64 stays in the ACPTR/EOI
retry loop at `$EE13`/`$F4F3`. The root cause is unidentified at spec
write time; M0.2 produces the diff that names it.

This spec is the **fix sprint**. It must be written before M0.2 lands so
the team has a clear acceptance contract, but the actual fix
direction is decided from the M0.2 artifact, not from speculation.

The discipline rule is hard: touch exactly one subsystem.

## Acceptance

- Bug 40 closed: `LOAD"MM",8,1` returns to BASIC ready, no retry loop,
  `$90` ends in EOI-clean state (`0x40` only or `0x00` per KERNAL
  convention; both are valid end states depending on path).
- C64 PC leaves `$EE00..$EE2F` retry area within 5000 cycles after the
  last data byte received.
- Drive returns to idle (`$EBE7..$EC2D`) and stays there until the next
  ATN.
- Synthetic 1-byte file LOAD also passes (no regression on the simple
  case).
- All previously-passing smoke tests stay green: cold boot, typing,
  BASIC RUN with traps, drive directory walk, `LOAD"*",8,1` from a
  synthetic D64.
- The M0.2 diff tool, re-run after the fix, reports zero divergence in
  the EOF window.

## Hypothesis matrix

These are the candidate root causes ranked by current evidence. The fix
sprint picks one based on the M0.2 diff artifact.

| # | Side  | Subsystem            | Hypothesis                                                                                       | Evidence required (from M0.2)                     |
|---|-------|----------------------|--------------------------------------------------------------------------------------------------|--------------------------------------------------|
| H1 | C64  | KERNAL `LDA $90` retry | Earlier ACPTR set TIMEOUT bit; LOAD retry at `$F4F3-$F509` triggers on stale flag                | `$A5 ≥ 1` rising before EOI rising              |
| H2 | Drive| TALK FRMBYT           | Drive sends EOI byte without proper handshake; C64 reads valid byte but flags TIMEOUT             | drive PC at `$E933` mismatches VICE              |
| H3 | IEC  | DATA-line race        | C64 releases CLK after last byte but drive hasn't pulled DATA in time → C64 sees timeout          | IEC DATA edge timing diverged                    |
| H4 | C64  | UNTALK                | C64 doesn't send UNTALK, drive stays in TALK, channel state inconsistent                         | UNTALK PC `$EDFE-$EE0E` never reached on headless |
| H5 | Drive| ATN ACK               | Drive's ATN ACK released too late, C64 sees pending ATN as new transaction                       | ATN line state mismatch                          |
| H6 | Drive| Channel cleanup       | Drive `$77/$79/$85` not cleaned after TALK end                                                   | drive RAM mismatch                               |

If M0.2 produces ambiguous evidence (no clear single channel diverged
first), do not proceed with the fix. Kick back to M0.2 with a refined
sampling configuration.

## Sub-stories

### M0.3a — Hypothesis confirmation
Read M0.2 diff. Pick the winning hypothesis. Write
`docs/bug40-fix-hypothesis.md` (1 page) with:
- chosen hypothesis number and why
- evidence cycles + values from the diff artifact
- expected behavior post-fix
- rejected hypotheses with one-line "ruled out by..." note

### M0.3b — Surgical fix
Implement the fix in **one** subsystem only. Candidate edit targets are
listed in the file-touch section. The "one subsystem" rule is hard.

### M0.3c — Invariant check
Add a determinism-style check to the smoke test layer:
- after a synthetic LOAD completes, assert `$90 & 0x02 == 0` (TIMEOUT
  cleared) and that C64 PC is no longer in `$EE00..$EE2F`.
- Run on synthetic fixtures every smoke run.

### M0.3d — Diff re-run
Re-run M0.2 against the fixed runtime. Acceptance: diff reports zero
divergence within tolerance for the EOF window. Commit the resulting
artifact as a golden file under `samples/traces/`.

### M0.3e — Bug closure
Update `BUGREPORT.md`:
- Bug 40 → FIXED with commit ref
- Add a one-paragraph root-cause summary (not a redo of the
  hypothesis doc; a project-history entry).

## Deliverables

- Code change in exactly one of these subsystems:
  - `src/runtime/headless/drive/*.ts`
  - `src/runtime/headless/iec/*.ts`
  - `src/runtime/headless/c64/kernal-traps.ts` (lower probability —
    we're explicitly on the real-KERNAL path, not the trap path)
  - `src/runtime/headless/scheduler/cycle-wrappers.ts`
- `docs/bug40-fix-hypothesis.md`
- New smoke test for synthetic LOAD with invariant check
- `BUGREPORT.md` edit
- Golden artifact `samples/traces/<fixture>-eof-fixed.jsonl`

## Test fixtures

- Synthetic 1-byte G64 (shared with M0.1 / M0.2)
- Synthetic 1-block (256 byte) G64 with varied GCR patterns (catches
  byte-edge cases the 1-byte fixture cannot)
- MM G64 (gitignored sample, manual run)

## Dependencies

- Spec 094 (M0.1) shipped: headless EOF trace.
- Spec 095 (M0.2) shipped: VICE compare + diff with named subsystem.
- No new emulator modules.

## Risks and mitigations

- **Wrong hypothesis**: fix breaks something else, MM still hangs.
  Mitigation: require M0.2 to show a single convincing channel
  divergence before proceeding. If ambiguous, return to M0.2.
- **Scope creep**: one path leads to another. Mitigation: hard rule —
  touch one subsystem. New issues become new bugs, not M0.3 extensions.
- **Regression in shared paths**: KERNAL serial code is shared with cold
  boot, BASIC RUN, directory walk. Mitigation: smoke matrix is full
  pre-existing set; any prior-green failure is a roll-back trigger.
- **Race-becomes-deterministic-but-wrong**: timing fix masks a logic
  bug. Mitigation: invariant check on synthetic fixture catches state
  errors that visual smoke can miss.
- **Misattribution to drive ROM**: drive ROM is canonical and cannot be
  "fixed". If H2/H5/H6 wins, the bug is in our drive emulation
  interpreting the ROM. The hypothesis doc must call this out
  explicitly.

## Fallback paths

- M0.2 diff inconclusive: do not fix blind. Re-run M0.2 with finer
  sampling, narrower window, or additional channels. If new channels are
  required, edit Spec 095, do not extend Spec 096.
- Fix lands but only synthetic passes: M0.3 acceptance not met. Treat
  remaining MM-only behavior as a new bug, document under a new
  BUGREPORT entry.
- Fix breaks unrelated smoke: revert, re-pick hypothesis, repeat.

## Exit criteria

1. M0.2 diff post-fix is clean.
2. MM `LOAD"MM",8,1` returns to ready. C64 PC leaves retry area.
3. Synthetic fixtures pass.
4. Pre-existing smoke matrix passes.
5. Bug 40 → FIXED with commit ref in `BUGREPORT.md`.

## File-touch list

- EDIT exactly one of:
  - `src/runtime/headless/drive/drive-cpu.ts`
  - `src/runtime/headless/drive/drive-bus.ts`
  - `src/runtime/headless/drive/head-position.ts`
  - `src/runtime/headless/iec/iec-bus.ts`
  - `src/runtime/headless/c64/kernal-traps.ts`
  - `src/runtime/headless/scheduler/cycle-wrappers.ts`
- NEW `docs/bug40-fix-hypothesis.md`
- EDIT `BUGREPORT.md`
- NEW smoke test (location follows existing pattern)
- NEW `samples/traces/<fixture>-eof-fixed.jsonl` golden file

## Out of scope

- LOAD acceptance matrix (M0.4).
- Multi-game testing beyond the synthetic fixtures + MM.
- Drive or KERNAL refactoring beyond the surgical fix.
- Performance work.
- Any new feature.
