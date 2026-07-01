# Runtime Product Proof — small canary baseline + tiered gates

Active authority: **Spec 715** (`specs/715-runtime-product-proof-baseline.md`).

The product regression baseline is **not** a completeness or release-certification
apparatus. This is a hobby project with an already thoroughly validated runtime.
The baseline answers one question, fast, in minutes:

> **"Does the central runtime still work like yesterday?"**

It supersedes the Spec 600/601 "seven disk games = whole runtime proof" framing.
The seven-game gate (and every other big suite) is now a **focused** gate, run
only when its subsystem changes.

This baseline runs against the TypeScript integrated-session **parity oracle**
(Spec 771), and TRX64 — now the default runtime backend — is validated against
this baseline; so "vice1541" / "integrated session" here denotes the oracle path,
not the default product runtime.

## Commands

```bash
npm run proof:product                  # the small BASELINE canary set = merge barrier
npm run proof:capability -- cartridge  # baseline + focused gates for one capability
npm run proof:list                     # full manifest, grouped (baseline/focused/historical)
npm run proof:freeze                   # baseline run + write the frozen record
```

Manifest: `scripts/runtime-proof-manifest.mjs` · Runner: `scripts/runtime-product-proof.mjs`.
Frozen record: `docs/runtime-product-baseline-2026-05-24.md` (`runtime-product-green-2026-05-24`).

`npm run runtime:proof` / `proof:seven-game` remain compatibility aliases for the
seven-game canary alone — **not** the full product proof.

## The baseline (7 canaries, minutes)

Each canary is cut to its **earliest stable PASS milestone** — no cosmetic
screenshot sequences. All run the current UI-identical integrated session (vice1541).

| # | capability | gate | PASS condition |
|---|---|---|---|
| 1 | kernal-loadsave | `kernal-directory` | boot → mount → `LOAD"$",8` → `LIST`: directory content (quoted header + `BLOCKS FREE`) |
| 2 | kernal-loadsave | `kernal-program-load` | `LOAD"*",8,1` of a small PRG: clean completion + expected loaded byte-count |
| 3 | fastloader | `fastloader-scramble` | Scramble Infinity — KRILL fastloader reaches running game code |
| 4 | fastloader | `fastloader-polarbear` | Polar Bear — KERNAL autoload → custom loader reaches running game code |
| 5 | cartridge | `crt-easyflash` | real EasyFlash sample cold-boots into a drawn intro (not a crash loop) |
| 6 | cartridge | `crt-gmod2` | real GMOD2 sample cold-boots into a drawn intro/menu |
| 7 | checkpoint | `checkpoint-canary` | native checkpoint capture → restore → continue |

`LOAD"$",8` is its **own** capability — it is not covered by `LOAD"*",8,1` and must
not be argued away by it.

## Three gate groups

- **baseline** — the table above. `proof:product`. The merge barrier.
- **focused** — the big subsystem suites (616/617, 713/714.5, seven-game, 705/707,
  706, 708, 709). NOT in the baseline. Run via `proof:capability -- <cap>` when the
  owning subsystem changes.
- **historical** — old bring-up/oracle smokes (Spec 097/415/611) with drifted
  harness/golden contracts. Diagnostic only; **never** gate merges on them.

## Gate policy — what to run when (Spec 715 §4/§5)

| Change surface | Run |
|---|---|
| docs / specs / README only | nothing (no emulator gate) |
| UI-only / monitor view | UI / monitor gates only |
| `vice1541` / IEC / GCR / drive | `proof:capability -- kernal-loadsave` + `-- fastloader` (incl. spec-616/617 + seven-game focused) |
| cartridge / memory-bus cart routing | `proof:capability -- cartridge` (713/714.5 focused) |
| checkpoint / ring / `.c64re` | `proof:capability -- checkpoint` (705/707/714 focused) |
| SID / audio | audio (706) focused suite |
| trace / TraceDB | declarative-trace (708) focused suite |
| media ingress | media-ingress (709) focused suite |
| **any runtime-affecting DONE / merge** | `npm run proof:product` (the small baseline) once at the boundary |
| global CPU/VIC/SID/IEC/1541/scheduler | baseline **+** the relevant focused suites before sharing/merge |

The big suites stay rigorous when their subsystem changes; they just don't run as a
permanent product baseline. The baseline must stay minutes-overseeable — if a
scenario needs several minutes, reduce it to the earliest stable PASS milestone.

## Adding a baseline canary

Add a `group:"baseline"` entry to `runtime-proof-manifest.mjs` (stable `id`,
`capability`, `command`, `tier`, `fixtures`, `triggers`, `note`), keep it cut to the
earliest stable PASS, re-freeze (`npm run proof:freeze`), bump `MANIFEST_VERSION`.
No doc may claim a capability proven unless its baseline/focused gate was actually
run and recorded.
