# Runtime Product Baseline — runtime-product-green-2026-05-24

Frozen by Spec 715. The active product-level "is the runtime green" authority:
a small, fast, real canary baseline ("does the central runtime still work like
yesterday?"). The big subsystem suites (616/617, 713/714.5, seven-game, 705/707,
706, 708, 709) are FOCUSED gates run only on subsystem change — not this baseline.

```text
baseline-id      : runtime-product-green-2026-05-24
master-commit    : 8896c53f003f9f261835c129ea8ef94ce902c4df
master-short     : 8896c53
manifest-version : 715-2.0.0 (2026-05-24, small-canary-baseline)
frozen-at        : 2026-05-24T18:35:11.318Z
drive1541        : vice
result           : GREEN (7/7 baseline gates)
```

## Baseline gate results

| capability | gate | tier | result | seconds |
|---|---|---|---|---|
| kernal-loadsave | `kernal-directory` | 2 | PASS | 7.8 |
| kernal-loadsave | `kernal-program-load` | 2 | PASS | 3.1 |
| fastloader | `fastloader-scramble` | 2 | PASS | 12.0 |
| fastloader | `fastloader-polarbear` | 2 | PASS | 29.3 |
| cartridge | `crt-easyflash` | 2 | PASS | 4.2 |
| cartridge | `crt-gmod2` | 2 | PASS | 4.3 |
| checkpoint | `checkpoint-canary` | 2 | PASS | 0.6 |

## Reproduce

```bash
npm run proof:product                  # the small baseline (this record)
npm run proof:capability -- cartridge  # baseline+focused for one capability
npm run proof:list                     # full manifest, grouped
```
