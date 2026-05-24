# Runtime Product Proof — manifest, runner, gate policy

Active authority: **Spec 715** (`specs/715-runtime-product-proof-baseline.md`).
This doc is the contributor-facing how-to. It supersedes the Spec 600/601
"seven-game gate is the whole proof" framing — that gate is now one capability
(`c64-1541-execution`) inside the manifest below.

## Commands

```bash
npm run proof:list                    # print the manifest (capabilities → gates)
npm run proof:capability -- cartridge # run one capability's gates (inner loop)
npm run proof:product                 # full manifest = merge boundary gate
npm run proof:freeze                  # full barrier run + write baseline record
npm run proof:seven-game              # the real-software canary alone (= old runtime:proof)
npm run runtime:proof                 # COMPAT alias: seven-game canary only (NOT full product proof)
```

Manifest source: `scripts/runtime-proof-manifest.mjs`.
Runner: `scripts/runtime-product-proof.mjs`.
Frozen baseline record: `docs/runtime-product-baseline-2026-05-24.md`
(`runtime-product-green-2026-05-24`).

`npm run runtime:proof` is **retained only** as a compatibility alias for the
seven-game canary (`scripts/runtime-proof-gate.mjs`). It no longer represents
the complete product proof — use `npm run proof:product` for that.

## Capabilities

| capability | what it proves | owning specs |
|---|---|---|
| `c64-1541-execution` | seven real-software games boot to expected state | 600/601 |
| `kernal-loadsave` | LOAD / directory / SAVE / FORMAT / fastloaders | 415/611/616-618 |
| `cartridge` | CRT mapper families + flash/EEPROM/SPI device cores | 713 |
| `mutable-media` | writable disk + cartridge snapshot/restore | 714 / 714.5 |
| `checkpoint` | native checkpoint, `.c64re`, checkpoint ring | 705 / 707 |
| `audio` | reSID synthesis restore + transport re-sync/latency | 703 / 706 |
| `media-ingress` | insert/eject/reset/restore + UI/WS control | 709 |
| `declarative-trace` | trace defs + TraceDB evidence | 708 |

## Tiered gate policy (Spec 715 §4/§5) — what to run when

Pick the smallest suite that actually covers the contract you changed. Full
product proof is a **boundary** gate, not an inner-loop gate.

| Change surface | Required during work | Full product proof |
|---|---|---|
| **Tier 0** — docs/specs/README/INSTALL, archive cleanup | format/link checks | no |
| **Tier 1** — one mapper/device core, one parser, UI-only wiring, an unconnected schema helper | `build:mcp` + the owning focused gate(s); VICE-differential where porting VICE-owned behavior | once before DONE/merge **iff** executable runtime behavior changed |
| **Tier 2** — mounted media lifecycle, checkpoint/ring/`.c64re`, writable persistence, audio synth/restore, monitor state commands, rewind/replay | `build:mcp` + the capability suite + ≥1 integrated scenario | required at final acceptance/merge |
| **Tier 3** — CPU/VIC/CIA/SID register behavior, PLA/global bus, IEC/1541/scheduler/GCR/KERNAL serial, clock/event ordering, reset/init/attach | `build:mcp` + source-owner/differential gates + selected real-software canaries | required before any shared checkpoint and always before merge; may run earlier when a broad change makes further work unsafe |

Changed-path → capability hints live in each manifest gate's `triggers` field
(`npm run proof:list` to inspect). Example:

- touched `src/runtime/headless/cartridge.ts` → run `proof:capability -- cartridge`
  (and `-- mutable-media` if writable state changed); full product proof before merge.
- touched only Markdown → no emulator gate.
- touched `src/runtime/headless/vice1541/**` or any CPU/VIC/SID/IEC core →
  Tier 3, full product proof before sharing or merging.

## Adding a capability / gate

When a feature becomes a product claim, add a gate entry to
`runtime-proof-manifest.mjs` (stable `id`, `capability`, `command`, `tier`,
`fixtures`, `triggers`, `barrier`) rather than appending an ad-hoc command to
prose. Re-freeze the baseline (`npm run proof:freeze`) on the merge commit and
bump `MANIFEST_VERSION`. No doc may assert a feature is proven unless its
manifest gate was actually run and recorded.
