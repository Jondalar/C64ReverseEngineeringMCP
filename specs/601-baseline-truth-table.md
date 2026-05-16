# Spec 601 — Baseline Truth Table

**Status:** ACTIVE (2026-05-16)
**Baseline:** `runtime-green-2026-05-16` → commit `7bfba28`
("Spec 424 refined — Drive LED VICE 1:1 PWM model")
**Replaces:** `docs/runtime-gates-truth-table.md` informal snapshot.

## Goal

Inventory every Runtime Proof oracle and pin the expected baseline
result per game at `runtime-green-2026-05-16`.

## Proof-oracle inventory

All paths relative to `samples/screenshots/proof/`.

| #  | File                              | Belongs to       | Expected scene                                                |
|----|-----------------------------------|------------------|---------------------------------------------------------------|
| 1  | `c64-ready.png`                   | KERNAL boot      | C64 cold-boot READY screen                                    |
| 2  | `LNR_System3.png`                 | LNR s1           | "PRESS FIRE!" System 3 title with NINJA REMIX logo            |
| 3  | `im2-title.png`                   | IM2              | IM2 loader title                                              |
| 4  | `im2-ingame.png`                  | IM2              | Elevator scene with control panel + timer                     |
| 5  | `mm-character-select.png`         | MM s1            | "MANIAC MANSION START" with 7 character portraits             |
| 6  | `motm-title-45s.png`              | motm             | Steamboat title + Start/Pick up/Save menu                     |
| 7  | `motm-credits.png`                | motm             | motm credits scroller                                         |
| 8  | `motm-ingame.png`                 | motm             | motm in-game (post-credits)                                   |
| 9  | `polarbear-load.png`              | Polarbear        | Bear sprite + "CPU - 1MHz" loader                             |
| 10 | `polarbear-text1_menu.png`        | Polarbear        | Photosensitive warning text ("F1 REGULAR MODE F7 REDUCED")    |
| 11 | `polarbear-scores_menu.png`       | Polarbear        | "POLAR BEAR IN SPACE!" TOP SCORES menu, "FIRE TO START"       |
| 12 | `scramble-loadscreen.png`         | Scramble         | Scramble loader bar                                           |
| 13 | `scramble-title.png`              | Scramble         | "SCRAMBLE INFINITY" title with loader music credit            |
| 14 | `scramble-menu.png`               | Scramble         | Scramble highscore / menu                                     |
| 15 | `thepawn1.png`                    | Pawn s1          | "On The Path 0/0" intro text by Magnetic Scrolls               |
| 16 | `thepawn2.png`                    | Pawn s1          | Mountains picture with "You are on a gravel path..."          |

## Baseline truth table @ `runtime-green-2026-05-16`

Each row: game, proof-oracle, expected scene, required input,
gate script, expected baseline result.

| Game      | Proof image                                                                            | Expected state                  | Required input                | Existing script                                    | Gate status @ baseline |
|-----------|----------------------------------------------------------------------------------------|---------------------------------|-------------------------------|----------------------------------------------------|------------------------|
| motm      | `motm-title-45s.png` (+ `motm-credits.png`, `motm-ingame.png`)                          | Title + Start menu              | `LOAD"*",8,1` + `RUN`         | `scripts/test-motm-screenshots.mjs` + `scripts/smoke-423-motm-canary.mjs` | **GREEN** |
| MM s1     | `mm-character-select.png`                                                              | Character select                | `LOAD"*",8,1` + `RUN`         | `scripts/test-mm-screenshots.mjs`                  | **GREEN** |
| IM2       | `im2-title.png` + `im2-ingame.png`                                                     | Loader title → elevator         | `LOAD"*",8,1` + `RUN`         | `scripts/test-im2-screenshots.mjs`                 | **GREEN** |
| Scramble  | `scramble-loadscreen.png` + `scramble-title.png` + `scramble-menu.png`                 | Loader → title → menu           | `LOAD"*",8,1` + `RUN`         | `scripts/test-scramble-screenshots.mjs` + `scripts/smoke-423-krill-loader.mjs` | **GREEN** |
| Polarbear | `polarbear-load.png` + `polarbear-text1_menu.png` + `polarbear-scores_menu.png`        | Bear loader → warning → menu    | `LOAD"*",8,1` + `RUN`         | `scripts/test-polarbear-screenshots.mjs`           | **GREEN** |
| Pawn s1   | `thepawn1.png` + `thepawn2.png`                                                        | Intro text → mountains          | `LOAD"*",8,1` + `RUN`         | `scripts/test-pawn-screenshots.mjs`                | **RED** (LOAD"*" → `?FILE NOT FOUND`) |
| LNR s1    | `LNR_System3.png`                                                                      | System 3 title / "PRESS FIRE!"  | `LOAD"*",8,1` + `RUN`         | `scripts/test-lnr-screenshots.mjs`                 | **RED** (LOAD → `?SYNTAX ERROR`)     |

### Stuck-PC vocabulary

The aggregator treats these PC values as stuck (= not in game code):

- `$E5CD`, `$E5CF`, `$E5D4` — KERNAL BASIC READY main loop
- `$F6BF`, `$A483` — KERNAL LOAD / SAVE stalls
- `$F6C5`, `$F6DA` — KERNAL LOAD region (LNR / Pawn red)
- `$EEA9`, `$EEAF`, `$EEB2`, `$ED5A`, `$ED5D` — KERNAL serial RX
  (motm-class fastloader stall when red)

Any of these as the final-state PC = the game did not reach
its expected scene.

### "Why" notes for the two reds

- **Pawn s1 RED:** `LOAD"*",8,1` produces `?FILE NOT FOUND ERROR`
  on this baseline. The disk's first directory entry is not being
  matched by the `*` wildcard, or wildcard expansion is broken in
  the headless KERNAL/DOS path. Pre-1541-fix master HEAD was
  red here; Pawn was not on the green list.
- **LNR s1 RED:** `LOAD"*",8,1` produces `?SYNTAX ERROR` on this
  baseline. The LOAD path returns control to BASIC with non-program
  data — likely a fastloader CRC / multi-stage handover failure.
  Pre-1541-fix master HEAD was red here too.

Both reds are EXPECTED at this baseline and must NOT be re-classified
without a Runtime Proof Gate green to back the new classification.

## Reproducer

```bash
git switch --detach runtime-green-2026-05-16
npm run build:mcp
# All four Tier-2 oracle gates:
node scripts/smoke-423-bare-boot.mjs
node scripts/smoke-423-load-directory.mjs
node scripts/smoke-423-motm-canary.mjs
node scripts/smoke-423-krill-loader.mjs
# 7-game aggregator (smoke-tier; visual diff = human review):
node scripts/test-game-screenshots-all.mjs
```

## Out of scope

- Adding new oracle PNGs. New oracles are user-supplied (from VICE).
  Spec 601 ratifies the set; it does not author new captures.
- Changing the expected baseline by editing this table. A change of
  status (RED → GREEN or vice versa) requires a Runtime Proof Gate
  run as evidence, captured in the spec that makes the change.
