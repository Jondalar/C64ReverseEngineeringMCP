# Runtime Product Baseline — runtime-product-green-2026-05-24

> **HISTORICAL (2026-08-12).** The proof system this describes is gone. Spec 715
> was retired as the authority in favour of TRX64's own gates (Spec 783), and Spec
> 806 deleted the TypeScript runtime it gated along with `runtime-product-proof.mjs`,
> `runtime-proof-manifest.mjs` and the `proof:*` npm entries. Kept because the gate
> SET it names still describes what "the runtime works" meant, and the oracle
> screenshots under `samples/screenshots/proof/` still show correct output.



> **Historical (Spec 806, 2026-08-12).** A frozen baseline record for the deleted
> TypeScript runtime. The scripts it names no longer exist.

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
