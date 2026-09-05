# Spec 816 — Sprite detection: the grid, the gate, and a number to judge it by

**Status:** BUILT 2026-09-05
**Origin:** issue #8 (@mrr19121970) — "align sprite block scan to $40 boundary within region"
**Touches:** `pipeline/src/analysis/analyzers/sprite-analyzer.ts`,
`scripts/measure-816-sprite-precision.mjs`

## 1. What the issue reported, and what was actually wrong

The issue is right about the hardware: a sprite block is `sprite pointer × 64`
inside a bank base that is itself a multiple of `$4000`, so sprite data always
begins at an absolute address ≡ 0 mod `$40`. Candidate regions are the gaps code
discovery left behind (`findUnclaimedRegions`) and open wherever the code
stopped, so scanning from `region.start` puts the whole 64-byte grid off-phase.

What the issue reads as a misdetection was **blindness**. Bug 27 already rejected
any candidate whose start address is not `$40`-aligned:

```ts
if ((start & 0x3f) !== 0) {
  return;
}
```

In an off-phase region *every* run found is off-phase, so every candidate was
discarded without a word. The reference fixture — eight textbook sprites at
`$2400`, region opening at `$200A` — produced **zero** candidates. Not a wrong
answer: no answer.

The second defect was the opposite one, and it is why the first was never
noticed. `scoreSpriteBlock` summed four banded terms with generous floors:

| term | pass | floor |
|---|---|---|
| density `[0.03, 0.55]` | 0.45 | 0.1 |
| rowVariance `[0.002, 0.08]` | 0.25 | 0.08 |
| transitions `[0.08, 0.6]` | 0.2 | 0.05 |
| entropy `[1.2, 5.8]` | 0.18 | 0.08 |
| not blank | 0.1 | 0 |
| padding byte `$3F` = 0 | 0.08 | −0.12 |

Floors alone sum to **0.49** against a **0.66** threshold: a block that failed
every single criterion was already three quarters of the way in, and failing two
of four still passed at 0.74. The bands also sit exactly where 6502 code lives
(measured: density ≈ 0.44, entropy ≈ 5, transitions ≈ 0.5). The decision rode on
0.17 of range.

Since Spec 019 the answer to each new false-positive class has been another
post-hoc demotion — jump-table detection (Bug 11), the charset-bank penalty, the
`longRunPenalty` that punishes runs longer than 8 blocks, which is backwards for
a real sprite set. Those are patches on a scorer that says yes to everything.

## 2. Decisions

**D1 — Align the scan, keep Bug 27 as the net.** The `$40` phase is computed
once per region and used for both the offset walk and the candidate start.
Bug 27 stays: it is now unreachable rather than load-bearing, which is what a
guard should be.

**D2 — A gate decides, the bands only grade.** A block that cannot be a sprite
scores 0, not 0.49. The graded terms keep their explanatory value without being
able to carry a decision on their own.

**D3 — Measure vertical structure, which is what a sprite actually is.** A
sprite is a contiguous FIGURE: row *n* and row *n+1* are nearly the same shape.
6502 code has no vertical relationship at all. Two metrics, because the naive
one is a trap:

- `rowCoherence` — mean bit agreement between adjacent rows. Reference sprites
  0.86–0.92, code averages 0.64. **But it is inflated by sparsity**: two nearly
  empty rows agree on 22 of 24 bits while sharing no shape, which is how a table
  of bit masks in a VICE CIA test scored 1.00 as a sprite.
- `shapeOverlap` — the same comparison divided by the *union* of the set bits,
  so agreement has to be about the figure. Reference sprites 0.60–0.86; that
  mask table sits at 0.31.

Both are gates. The upper bound on `rowCoherence` (0.985) rejects the other end:
a uniform fill, where all rows are identical, is a cleared buffer, not a shape.

**D4 — Widen density, do not tighten it.** The old ceiling of 0.55 punished
exactly the sprites it should find: the reference ball sits at 0.79. Real
sprites are often solid. Density is a weak grading term now, not a filter.

**D5 — Byte `$3F` is hardware, so use it at run level.** VIC never fetches byte
63 of a sprite block (21 rows × 3 bytes = 63), so sprite data conventionally
carries 0 there. A *run* in which fewer than half the blocks do is a data table
with vertical structure, not a sprite set — rejected. Measured: this alone
removed 43 of the 62 false candidates the aligned scan surfaced, and left both
reference fixtures untouched.

**D6 — The change is judged by a number, not by reading the diff.**
`scripts/measure-816-sprite-precision.mjs` (`npm run measure:816`) is the
instrument, and it is re-runnable on both sides of any future change.

## 3. The instrument

Three corpora, because they answer different questions:

- **negative** — VICE test programs (`cia/`, `drive/`). Pure 6502; no sprite
  exists in any of them, so every sprite byte reported is a false positive.
  This is the precision number.
- **field** — real game/loader PRGs. No ground truth; reported as a trend.
- **positive** — two synthesized PRGs with eight real sprite shapes (contiguous
  figures, padding byte 0) planted between blocks of real 6502 code taken from
  the VICE corpus. `positive_aligned` opens its unclaimed region on the grid,
  `positive_unaligned` opens it 24 bytes early with the sprites still on the
  grid. This is the recall guard: a precision fix that stops finding actual
  sprites is not a fix.

Both levels are measured — the analyzer's own candidates *and* the segments that
survive overlap resolution — because noise the resolver happens to bury is still
noise: it reaches the LLM through `analyzerResults`.

## 4. Result

```
| corpus   | metric                | before      | after       |
|----------|-----------------------|-------------|-------------|
| negative | files with candidates | 0/10        | 0/10        |
| negative | candidate bytes       | 0 (0.0 %)   | 0 (0.0 %)   |
| field    | files with candidates | 1/8         | 2/8         |
| field    | candidate bytes       | 64 (0.1 %)  | 128 (0.1 %) |
| positive | planted blocks found  | 0/2         | 2/2         |
| positive | survived into report  | 0/2         | 2/2         |
```

Recall 0 → 2/2, both at the exact planted range `$2400-$25FF`, with the false
positive rate on pure code unchanged at zero. The intermediate states are worth
recording because they show the two defects are independent: with the alignment
fix alone the negative corpus went to 3.3 % and lnr_boot to 46 candidates — the
aligned scan unlocks regions that used to be silent, so precision has to be
earned, not assumed. The padding gate (D5) took that to 1.1 %, and
`shapeOverlap` (D3) to 0.

Regression: `e2e:758`, `e2e:751`, `smoke:741`, `smoke:disasm-sync`,
`sprint37/46/54` all green.

## 5. Not built — the next slice

Shape heuristics cannot reach zero on their own, and they should not have to.
The real evidence is in memory: **sprite pointers live at `screenBase+$3F8..$3FF`**.
`VicEvidence` has no sprite addresses today — only a `spriteRegisterTouches`
counter — because pointers are not a register write. Reading them where
`vic.screenAddresses` gives a base, and anchoring the analyzer on the result,
is the same move `charset-analyzer` already makes with `$D018` (it seeds
`probeRegions` from the confirmed charset bases *in addition to* the candidate
regions). With that anchor, phase guessing largely stops mattering and the
post-hoc demotion chain from Spec 019 can shrink.

`bitmap-analyzer` carries the same off-phase defect (`offset += 0x2000` from an
unaligned start), reachable only on its heuristic fallback when VIC evidence
produced nothing. Same family, same fix: sprite `$40`, bitmap `$2000`,
screen `$400`.
