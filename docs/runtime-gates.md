# Runtime Gates — Truth Source for C64RE Headless

Created 2026-05-16 under the **runtime reset** directive.

This document is the **canonical source of truth** for what counts as a
green runtime. Unit tests, mapping checks, "1:1 VICE port DONE" markers
in old specs, and PC-only smoke runs do NOT make a runtime green.

## Doctrine (mandatory)

```
Unit green     != runtime green.
Mapping green  != runtime green.
Smoke green    != runtime green
               unless it asserts a real game / screen / PC / disk
               outcome against a pre-existing oracle.
```

A runtime gate MUST check at least:

1. **Screenshot / framebuffer** match against the project's reference
   PNG for that game + scene.
2. **Screen-RAM** SHA-256 matches the golden screen-RAM blob, OR the
   screen-RAM contains the expected non-zero glyph signature.
3. **C64 PC** is not stuck in a KERNAL READY / LOAD / IEC wait loop.
4. **Drive PC** is not in an obvious idle / error stall, when the
   scenario depends on drive activity.
5. **For SAVE / FORMAT**: the disk image hash (or per-track / per-sector
   CRC) changes in the expected way. A pure "no-crash" run is NOT a
   SAVE gate.

A gate that asserts fewer than its applicable items from that list is
a **smoke probe**, not a gate. Smoke probes may stay in `scripts/` but
they MUST NOT be cited as acceptance for any 4xx spec.

## Branch + Tag Policy

| Ref                              | Role                                      |
|----------------------------------|-------------------------------------------|
| `runtime-green-2026-05-16` (tag) | Frozen runtime baseline. **DO NOT MOVE.** |
| `codex/1541-runtime-gates`       | Active branch. Gate work only. No emu changes without explicit user approval. |
| `1541-literal-vice`              | **QUARANTINE.** Material lager. Do not advance. Do not merge. |
| `master`                         | Older stable; pre-Epic 440. Reference only. |
| `stash@{0}`                      | WIP rotation hook experiments from 2026-05-16. Quarantined. |

Cherry-picking from `1541-literal-vice` into `codex/1541-runtime-gates`
is permitted **only** with `-n` (no-commit) and **only** if each
imported change is then validated against the runtime gates before
committing.

## Reference Oracle Inventory (state @ runtime-green-2026-05-16)

### Tier 1 — Named gold per-game (user-confirmed scenes)

Primary visual oracle for the **7-game** gate set. Refreshed
2026-05-16 with new captures from VICE under
`samples/screenshots/proof/`.

| Game      | Oracle PNG(s)                                                                                                                            | Expected scene                                          | Disk image                                                          |
|-----------|------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------|---------------------------------------------------------------------|
| motm      | `motm-title-45s.png` + `motm-credits.png` + `motm-ingame.png`                                                                            | Title (45s, ship + 3 rows), credits, in-game            | `samples/motm.g64`                                                  |
| MM s1     | `mm-character-select.png`                                                                                                                | Character select                                        | `samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64` |
| IM2       | `im2-title.png` + `im2-ingame.png`                                                                                                       | Loader title → elevator man                             | `samples/impossible_mission_ii[epyx_1987](!).g64`                   |
| LNR s1    | `LNR_System3.png`                                                                                                                        | Last Ninja Remix System 3 title / "PRESS FIRE!"         | `samples/last_ninja_remix_s1[system3_1991].g64`                     |
| Scramble  | `scramble-loadscreen.png` + `scramble-title.png` + `scramble-menu.png` (+ VICE VSF stages under `samples/vice-reference/scramble/`)      | Loadscreen → title → highscore menu                     | `samples/scramble_infinity.d64`                                     |
| Pawn s1   | `thepawn1.png` + `thepawn2.png`                                                                                                          | Intro text "On The Path" → mountains picture            | `samples/the_pawn_s1.g64`                                           |
| Polarbear | `polarbear-load.png` + `polarbear-text1_menu.png` + `polarbear-scores_menu.png`                                                          | Bear loader → photosensitive warning → TOP SCORES menu  | `samples/POLARBEAR.d64`                                             |

All paths above relative to `samples/screenshots/proof/`.

### Tier 2 — VICE-grounded golden schema (oracle JSON + PNG + screen-RAM)

`samples/golden-master/spec-423/` contains the only existing oracle
artifacts that match the doctrinal gate-schema (1) + (2) + (3). They
were authored for Spec 423 and use this JSON shape:

```jsonc
{
  "spec": "423",
  "test": "motm-canary",
  "doc": "docs/vice-iec-arc42.md §15 Phase H step 20",
  "vice_cite": "src/serial/iecbus.c:191, src/drive/iec/via1d1541.c:212/337",
  "c64Pc": "$b7bf",
  "cpu_port": "$c0",
  "drv_port": "$85",
  "screenRamSha256": "b352dc7687a81d0ea8849cc3bbbea92d6332cca20dfed8ad61942dee2c470a08",
  "observedPcs": ["$43c1", "$43ed", "$b7bf", "$b7bd", "$b7bd", "$b7bd", "$b7bd", "$b7bf"]
}
```

Existing oracles:

| Oracle JSON                                                | PNG                                                  | Screen-RAM                                                   |
|------------------------------------------------------------|------------------------------------------------------|--------------------------------------------------------------|
| `samples/golden-master/spec-423/motm-canary.golden.json`   | `samples/golden-master/spec-423/motm-canary.png`     | `samples/golden-master/spec-423/motm-canary.screenram.bin`   |
| `samples/golden-master/spec-423/krill-loader.golden.json`  | `samples/golden-master/spec-423/krill-loader.png`    | `samples/golden-master/spec-423/krill-loader.screenram.bin`  |
| `samples/golden-master/spec-423/load-directory.golden.json`| `samples/golden-master/spec-423/load-directory.png`  | `samples/golden-master/spec-423/load-directory.screenram.bin`|
| `samples/golden-master/spec-423/bare-boot.golden.json`     | `samples/golden-master/spec-423/bare-boot.png`       | `samples/golden-master/spec-423/bare-boot.screenram.bin`     |

### Tier 3 — Other VICE-grounded references

| Asset                                                      | Use                                                      |
|------------------------------------------------------------|----------------------------------------------------------|
| `samples/vice-reference/scramble/stage-A-Loader.vsf` + `.png`        | Scramble loader stage, VICE snapshot + PNG  |
| `samples/vice-reference/scramble/stage-B-title.vsf` + `.png`         | Scramble title stage                         |
| `samples/vice-reference/scramble/stage-C-ingame.vsf` + `.png`        | Scramble in-game stage                       |
| `samples/vic-corpus/motm/ingame1-vice-reference.png`                 | motm in-game (VICE baseline)                 |
| `samples/screenshots/spec-280-gate/motm-ingame-90s-vice-rasterized.png`| Spec 280 motm 90s rasterized reference     |
| `samples/screenshots/spec-280-gate/mm-character-60s-vice-rasterized.png`| Spec 280 MM character-select 60s rasterized|
| `samples/screenshots/spec-280-gate/lnr-s1-90s-vice-rasterized.png`     | Spec 280 LNR s1 90s rasterized              |
| `samples/golden-master/c64-boot-mm-title.png` + `.screenram.bin`     | C64-boot MM title (with screen-RAM oracle)   |
| `samples/golden-master/c64-boot-scramble-title.png` + `.screenram.bin`| C64-boot Scramble title (with screen-RAM oracle)|
| `samples/golden-master/c64-boot-ready.png` + `.screenram.bin`        | KERNAL READY (with screen-RAM oracle)        |
| `samples/golden-master/c64-boot-load-dollar.png` + `.screenram.bin`  | LOAD"$",8 directory (with screen-RAM oracle) |

### Tier 4 — Frame sequences (NOT oracles)

`samples/screenshots/{motm,mm-s1,im2,lnr-s1}/*.png` contain per-second
frame sweeps from older smoke runs. They were produced **by our
emulator** — they are NOT oracles. Do not assert against them.

## Gap List

Missing references that need to be captured (either from VICE or
authored from a known-green run on a frozen emulator commit) before the
corresponding gate can graduate from smoke to real:

| Gap                                                        | Why it matters                                                       |
|------------------------------------------------------------|----------------------------------------------------------------------|
| ~~Pawn s1 — mountains scene oracle PNG~~                   | ✅ Closed 2026-05-16 (`thepawn1.png` + `thepawn2.png`).             |
| ~~LNR s1 — System 3 / title oracle PNG~~                   | ✅ Closed 2026-05-16 (`LNR_System3.png`).                            |
| Pawn s1 — screen-RAM SHA + observed-PC bundle              | Promote Pawn from smoke to Tier-2 gate.                              |
| LNR s1 — screen-RAM SHA + observed-PC bundle               | Promote LNR from smoke to Tier-2 gate.                               |
| IM2 — screen-RAM SHA + observed-PC bundle                  | Existing PNGs in `proof/` not yet paired with screen-RAM oracle.     |
| MM s1 — screen-RAM SHA + observed-PC bundle                | `golden-master/c64-boot-mm-title.png` is the splash, not character-select. Character-select gate needs its own oracle bundle. |
| motm — screen-RAM SHA + observed-PC bundle for 45s title   | `spec-423/motm-canary.*` is a different observation point (210s). The 45s title scene needs its own bundle. |
| Scramble — screen-RAM SHA + observed-PC bundle for B-title | VSF available but not yet hashed into a `.golden.json`.              |
| Polarbear — Tier-2 oracle bundle                           | New oracle PNGs exist (load + warning + scores menu); needs `.screenram.bin` + `.golden.json` paired bundle. |
| SAVE — disk-image-hash diff oracle                         | No oracle for a specific scenario's expected post-SAVE disk state.   |
| FORMAT — track/sector diff oracle                          | No oracle for what a freshly-formatted G64 image must look like.     |

## Existing Scripts — Substance Audit

| Script                                       | What it asserts                              | Doctrine score | Action                          |
|----------------------------------------------|----------------------------------------------|----------------|---------------------------------|
| `scripts/test-motm-screenshots.mjs`          | Renders PNG sequence, logs PC + VIC regs     | Smoke          | Promote: add oracle compare     |
| `scripts/test-mm-screenshots.mjs`            | Renders PNG sequence, logs PC                | Smoke          | Promote                         |
| `scripts/test-im2-screenshots.mjs`           | Renders PNG sequence, asserts PC != $E5CD    | Smoke          | Promote                         |
| `scripts/test-lnr-screenshots.mjs`           | Renders PNG sequence, asserts PC != $E5CD    | Smoke          | Promote (acknowledge known red) |
| `scripts/test-scramble-screenshots.mjs`      | Renders PNG sequence, no PC assertion        | Smoke          | Promote (use VSF stages)        |
| `scripts/test-pawn-screenshots.mjs`          | Renders PNG sequence, asserts PC != $E5CD    | Smoke          | Promote                         |
| `scripts/test-game-screenshots-all.mjs`      | Runs all 6 sequentially, summary PASS/FAIL on KERNAL-stuck PCs | Smoke aggregator | Wrap promoted gates instead |
| `scripts/smoke-423-motm-canary.mjs`          | Full Tier-2 gate (PC + cpu_port + drv_port + screenRamSha256 + observedPcs) vs `motm-canary.golden.json` | **Gate** | Reference implementation; clone for the other 5 games |
| `scripts/smoke-423-bare-boot.mjs`            | Tier-2 gate vs `bare-boot.golden.json`       | **Gate**       | Keep                            |
| `scripts/smoke-423-krill-loader.mjs`         | Tier-2 gate vs `krill-loader.golden.json`    | **Gate**       | Keep                            |
| `scripts/smoke-423-load-directory.mjs`       | Tier-2 gate vs `load-directory.golden.json`  | **Gate**       | Keep                            |
| `scripts/smoke-423-fastloader-corpus.mjs`    | Runs corpus of fastloader scenarios          | Aggregator     | Audit individually              |

## Untrusted DONE / PASS Claims in 440ff Specs

The following 440-series specs are marked DONE or PASS in their charter
but were never validated against a runtime gate matching the doctrine
above. Treat their conclusions as **provisional** until each one is
re-verified by a runtime gate that includes screenshot + screen-RAM +
PC assertions for at least one of the 6 games whose runtime behaviour
that spec affects.

- 441, 442, 443, 444, 444.x, 445, 446, 447, 447.5, 448, 448.1, 448.2, 449, 450
- All "Phase X cycle-diff" or "9999/9999 cycle-diff" results
- All "all unit tests PASS" markers without a paired game-screenshot
  run on the same commit
- All canary "smoke 5/5 PASS" results unless those smokes match Tier-2

Spec 444 v2 (commit 9e2edd8) is the cautionary tale: 9999/9999
cycle-diff PASS, all unit tests green, broke LOAD on all 6 disks.

## Command Index (provisional — implemented in next commit)

```bash
# 1. Build everything required for a runtime gate.
npm run build:mcp

# 2. Run a single Tier-2 gate.
node scripts/smoke-423-motm-canary.mjs

# 3. Run the full 6-game runtime gate set (promoted scripts only).
node scripts/test-game-runtime-gates.mjs           # TODO: to be authored

# 4. Run all Tier-2 oracles in sequence.
node scripts/smoke-423-fastloader-corpus.mjs
```

`scripts/test-game-runtime-gates.mjs` does not yet exist. It will be
the canonical runner for the 6-game gate set once each per-game gate
has been promoted to Tier-2 (i.e. each has a `.golden.json` oracle).
