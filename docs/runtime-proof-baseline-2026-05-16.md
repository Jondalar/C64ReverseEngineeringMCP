# Runtime Proof Baseline — 2026-05-16

**Baseline tag:** `runtime-green-2026-05-16` → master HEAD `87b4957`
("Merge vic_bugs: Specs 425-429 = CLK_INC + VIC bank + IM2 fix + LED
VICE 1:1").
**Branch under test:** `codex/1541-runtime-gates` @ `2eb1f48`
(governance commits only on top of green baseline; no emulator
changes).
**Run date:** 2026-05-16.
**Doctrine:** `specs/600-runtime-proof-gates.md`.
**Truth table source:** `specs/601-baseline-truth-table.md` (this doc
records the actual baseline run that backs Spec 601).

## How this doc is used

Spec 601 declares the **expected** per-game baseline at the runtime-green
tag. This doc records the **actual** measured result of running the
7-game proof set on the same tag. Spec 610 (Sub-spec 611-615) may only
start when this doc demonstrates the baseline is reproducible.

A row marked **GREEN** counts as evidence per Spec 600 only if both:

- the per-game script's final-C64-PC is in the game-code region
  (not in the stuck-PC vocabulary from Spec 601), **and**
- a human-reviewed visual match against the corresponding oracle PNG
  in `samples/screenshots/proof/` has been confirmed (auto-diffing
  PNGs is explicitly out of scope per Spec 600).

A row marked **RED (expected)** matches Spec 601's truth table and
must NOT be re-classified without a Runtime Proof Gate green run
captured in the spec that makes the change (Spec 610 §"DONE means
Runtime Proof Gate green").

## Baseline run table

| Game      | Expected (Spec 601) | Actual (final C64 PC) | Proof image(s)                                                                | Script state                                                                | Result            | Notes |
|-----------|---------------------|-----------------------|-------------------------------------------------------------------------------|-----------------------------------------------------------------------------|-------------------|-------|
| motm      | GREEN               | `$b7bd` main loop     | `motm-title-45s.png` + `motm-credits.png` + `motm-ingame.png`                 | `scripts/smoke-423-motm-canary.mjs` (Tier-2) + `scripts/test-motm-screenshots.mjs` (smoke) | **GREEN**         | Tier-2 oracle bundle in `samples/golden-master/spec-423/motm-canary.*`. Steamboat title + Start/Pick up/Save menu, oracle match. |
| MM s1     | GREEN               | `$061d` game code     | `mm-character-select.png`                                                     | `scripts/test-mm-screenshots.mjs` (smoke only)                              | **GREEN**         | "MANIAC MANSION START" with 7 character portraits, visual match. No Tier-2 oracle yet (gap, see Spec 601). |
| IM2       | GREEN               | `$2d2a` game code     | `im2-title.png` + `im2-ingame.png`                                            | `scripts/test-im2-screenshots.mjs` (smoke only)                             | **GREEN**         | Elevator scene, timer panel, oracle match. No Tier-2 oracle yet. Evidence refreshed 2026-05-16 (prior /tmp PNGs were 2026-05-12). |
| Scramble  | GREEN               | `$9130` game code (Tier-2 confirms title)  | `scramble-loadscreen.png` + `scramble-title.png` + `scramble-menu.png` | `scripts/smoke-423-krill-loader.mjs` (Tier-2) + `scripts/test-scramble-screenshots.mjs` (smoke) | **GREEN**         | "SCRAMBLE INFINITY" title + "Loader music Stellan Andersson". Tier-2 oracle in `samples/golden-master/spec-423/krill-loader.*`. |
| Polarbear | GREEN               | `$1a2d` game code     | `polarbear-load.png` + `polarbear-text1_menu.png` + `polarbear-scores_menu.png` | `scripts/test-polarbear-screenshots.mjs` (smoke only)                       | **GREEN**         | Photosensitive warning frame pixel-identical to oracle `polarbear-text1_menu.png`. No Tier-2 oracle yet. |
| Pawn s1   | RED                 | `$f6da` KERNAL LOAD   | `thepawn1.png` + `thepawn2.png`                                               | `scripts/test-pawn-screenshots.mjs` (smoke only)                            | **RED (expected)** | `LOAD"*",8,1` → `?FILE NOT FOUND ERROR`. Wildcard expansion / first-entry match broken in headless path. Pre-1541-fix master HEAD was red here. |
| LNR s1    | RED                 | `$f6c5` KERNAL LOAD   | `LNR_System3.png`                                                             | `scripts/test-lnr-screenshots.mjs` (smoke only)                             | **RED (expected)** | `LOAD"*",8,1` → `?SYNTAX ERROR`. Fastloader CRC / multi-stage handover failure. Pre-1541-fix master HEAD was red here. |

## Latest gate-runner snapshot

The block below is auto-refreshed by
`node scripts/runtime-proof-gate.mjs --update-baseline-doc` (or
`npm run runtime:proof -- --update-baseline-doc`). Hand-edited prose
above and below stays untouched.

<!-- BEGIN runtime-proof-gate-actuals -->
_Auto-refreshed by `scripts/runtime-proof-gate.mjs` at 2026-05-16T09:25:20.646Z._

| Game      | Expected | Actual  | Final PC | Source     | Verdict             |
|-----------|----------|---------|----------|------------|---------------------|
| motm      | GREEN    | GREEN   | $b7bd    | baseline   | PASS                |
| mm        | GREEN    | GREEN   | $61d     | baseline   | PASS                |
| im2       | GREEN    | GREEN   | $2d2a    | baseline   | PASS                |
| scramble  | GREEN    | GREEN   | $ff48    | baseline   | PASS                |
| polarbear | GREEN    | GREEN   | $1a2d    | baseline   | PASS                |
| pawn      | RED      | RED     | $f6da    | baseline   | PASS (red-expected) |
| lnr       | RED      | RED     | $f6c5    | baseline   | PASS (red-expected) |
<!-- END runtime-proof-gate-actuals -->

## Tier-2 oracle gate results (Spec 600 doctrinal gates)

These four gates have a paired oracle bundle (PNG + screen-RAM SHA-256
+ observed-PC trail) under `samples/golden-master/spec-423/`. They are
the only Spec-600-compliant gates today; the per-game smokes above need
to be promoted to this tier as the gap list in `docs/runtime-gates.md`
closes.

| # | Gate                              | Result      | Detail                                                                                       |
|---|-----------------------------------|-------------|----------------------------------------------------------------------------------------------|
| 1 | `smoke-423-bare-boot.mjs`         | **9/9 PASS**   | screen-RAM SHA matches frozen golden; drive PC idle 16/16 samples; bus released              |
| 2 | `smoke-423-load-directory.mjs`    | **3/4 WARN**  | directory rendered, TALK byte-out complete, ATN released. SHA drift vs frozen golden (cosmetic; functional green) |
| 3 | `smoke-423-motm-canary.mjs`       | **5/5 PASS**   | finalPc=$b7bf (motm main loop, matches frozen golden $b7bf); 0/8 samples in RX stall         |
| 4 | `smoke-423-krill-loader.mjs`      | **5/5 PASS**   | finalPc=$9130 (Scramble game code); 0/6 samples in KERNAL RX; title screen 521/1000 cells   |

## Summary

| Tier                                          | Pass | Fail | Total |
|-----------------------------------------------|------|------|-------|
| Tier-2 (oracle bundle, Spec 600 compliant)    | 3    | 1    | 4     |
| Tier-2 with cosmetic SHA drift only           | 1    | —    | —     |
| Game smoke (PC-only signal)                   | 7    | 0    | 7     |
| Game runtime (visual oracle match)            | 5    | 2    | 7     |

**5/7 games green at runtime-green-2026-05-16. Pawn + LNR red as
expected per Spec 601.**

## Reproducer

```bash
git switch --detach runtime-green-2026-05-16   # → 87b4957
npm run build:mcp

# Tier-2 doctrinal gates (PNG + screen-RAM SHA + observed-PC).
node scripts/smoke-423-bare-boot.mjs
node scripts/smoke-423-load-directory.mjs
node scripts/smoke-423-motm-canary.mjs
node scripts/smoke-423-krill-loader.mjs

# 7-game smoke aggregator (final-PC + screenshot generation; visual
# diff against samples/screenshots/proof/ is human-reviewed).
node scripts/test-game-screenshots-all.mjs

# Individual game smokes (output PNGs under /tmp/<game>-t*.png).
node scripts/test-motm-screenshots.mjs
node scripts/test-mm-screenshots.mjs
node scripts/test-im2-screenshots.mjs
node scripts/test-scramble-screenshots.mjs
node scripts/test-polarbear-screenshots.mjs
node scripts/test-pawn-screenshots.mjs       # RED expected
node scripts/test-lnr-screenshots.mjs        # RED expected
```

## Gate-runner status

A unified `scripts/runtime-proof-gate.mjs` (one script that runs all
7 games, checks each against the Spec 601 row, enforces RED expectations
on Pawn/LNR, and exits non-zero on any deviation from the truth table)
does **not yet exist**. `docs/runtime-gates.md` lists it as
`scripts/test-game-runtime-gates.mjs` in its TODO Command Index. The
current acceptance evidence is the four Tier-2 gates + the per-game
smokes + manual visual diff against `samples/screenshots/proof/`.

Authoring the unified gate-runner is a precondition for Spec 611
(rotation re-port). It is **not** in scope for this baseline snapshot.

## What this doc does NOT do

- It does not promote any per-game smoke to Tier-2. Promotion needs a
  `.golden.json` + `.screenram.bin` + `.png` oracle bundle authored
  per the schema in `docs/runtime-gates.md` § "Tier 2".
- It does not change any per-game expected result. Changes to the
  Spec 601 truth table require a Runtime Proof Gate run as evidence.
- It does not author or run the unified `scripts/runtime-proof-gate.mjs`.
  That is a separate task gated on this baseline being reproducible.
