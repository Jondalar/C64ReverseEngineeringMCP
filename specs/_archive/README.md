# Archive

Specs that are finished, decided against, or retired. **Nothing here is open work** —
`../README.md` holds that, and it holds only that.

Kept rather than deleted for two reasons. A **WON'T-DO** is a decision: without the
record, the same idea gets proposed again in a month. And a retired rule explains code
that still exists — delete the rule and the code looks arbitrary.

Verdicts: **DONE** shipped · **WON'T-DO** decided against, with the reason · **RETIRED**
was binding doctrine, no longer is (the surviving rules live in `../../DOCTRINE.md`).

## Recorded

The 9966 specs below carry the decision that closed them.

| # | Verdict | Spec | Decision / what shipped |
|---|---|---|---|
| 422 | **WON'T-DO** | [IEC Burst mode](422-iec-phase-g-burst-mode.md) | **dead** — JiffyDOS/burst; no game in scope needs it. Rebuild on demand or accept an external MR. |
| 424 | **WON'T-DO** | [Drive + Cartridge LED + Inspector UX](424-drive-cart-led-and-inspector-ux.md) | Closed 2026-08-11, both axes obsolete. **A (LED/status):** targeted the TypeScript runtime's `session/drive_status` and the vice1541 probe — the deprecated oracle, not the product. TRX64 owns the runtime and surfaces the drive LED from VIA2 PB3 directly. The four approximations still in the TS handler (no PWM curve, `ledFlashing` hardcoded false, motor inferred from the LED, R/W fixed to read) are noted in the code and stay as oracle-only gaps. **B (Inspector UX):** described moving a media strip into a right inspector column of the v3 shell — a layout the workbench no longer has. |
| 428 | **WON'T-DO** | [Split C64 + 1541 CPU contracts](428-split-c64-and-1541-cpu-contracts.md) | **dead** — TS CPU; settled by Spec 723 single-path. |
| 610 | **RETIRED** | [1541 Parity Rebuild Charter](610-1541-parity-rebuild-charter.md) | dormant (TS oracle only) |
| 612 | **RETIRED** | [1541 Port Fidelity Rules + TODO](612-1541-port-fidelity-rules.md) | retired as a mandate 2026-07-15; CI gate `check:1541-fidelity` still runs |
| 613 | **WON'T-DO** | [c64 IEC `LOAD"$",8` regression](613-c64-iec-load-regression.md) | **dead** — TS drive; downstream KERNAL-load fidelity long landed. |
| 614 | **WON'T-DO** | [Drive per-cycle scheduling](614-drive-per-cycle-scheduling.md) | **dead** — TS drive; vice1541 bridge + 622 §4.0 shipped. |
| 615 | **WON'T-DO** | [GCR decode fidelity](615-gcr-decode-fidelity.md) | **dead** — TS drive; 616/617 byte-fidelity DONE + post-mortem recorded. |
| 619 | **WON'T-DO** | [VICE / Headless KPI Trace Contract](619-vice-headless-kpi-trace-contract.md) | **dead** — TS-trace KPI; absorbed by the shipped trace stack / TRX64. |
| 620 | **RETIRED** | [Port-Bug Forensic Doctrine](620-port-bug-forensic-doctrine.md) | retired 2026-07-15; its technique = `CLAUDE.md` rule 5 |
| 621 | **WON'T-DO** | [1541 Port Hygiene Enforcement Backlog](621-port-hygiene-backlog.md) | **dead** — TS `vice1541/**` cleanup; no more TS-drive work. |
| 622 | **WON'T-DO** | [vice-mode Headless Performance](622-vice-mode-performance.md) | §4.0 shipped and measured (`2d9e4de`): 0.50× → 0.82× realtime. Closed 2026-08-11 — its premise and a third of its work no longer exist. The `drive1541Implementation="vice"` mode the problem statement compares against was removed by 723 (VICE1541 is the only drive). §4.3's suspected double dispatch is between `cycle-lockstep-scheduler` and `cycle-wrappers`, and 723 deleted the former. §4.1/§4.2 are unscoped V8 micro-optimisation candidates from a May profile, against the TypeScript runtime — the parity oracle since 2026-07-15, not the product. An oracle is run to compare, not to play; TRX64 is the product runtime. |
| 623 | **WON'T-DO** | [VICE-compat monitor / debugger](623-vice-monitor-debugger.md) | **→ TRX64 (already there)** — monitor + reverse-debug in TRX64 (`MONITOR.md`); C64RE-facing part via Spec 754 (archived) done. |
| 700 | **WON'T-DO** | [Runtime Optimization](700-runtime-optimization.md) | **dead** — TS perf, TS is fallback; TRX64 owns perf (~8–10× faster). |
| 703 | **DONE** | [SID reSID Audio](703-sid-resid-wasm-audio.md) | Live reSID audio + SID inspector shipped (`fb27a7d`). The one deferred slice, **703.5 WAV export**, was closed 2026-08-11 rather than built: the audio leaves the daemon as a stream, and capturing a stream to a file is what ffmpeg is for. Writing a second encoder inside the emulator buys nothing. |
| 704 | **DONE** | [Runtime Codebase Cleanup](704-runtime-codebase-cleanup.md) | §11 legacy-1541 retirement shipped (`0411295`). Closed 2026-08-11 with the other four phases resolved rather than built: **704.2** generated-output cleanup — `session/` and `snapshots/` are no longer in the tree at all; **704.7** spec hygiene — done wholesale on 2026-08-11 (this folder holds open work only, closed specs carry a decision here); **704.5** v3 transport and **704.6** SID cleanup both target the TypeScript runtime, the parity oracle since 2026-07-15, and `resid.ts` no longer exists — reSID is Rust in TRX64. |
| 705 | **WON'T-DO** | [Interactive Runtime Evidence / Intervention / Replay (contract)](705-interactive-runtime-evidence-intervention-replay-contract.md) | **→ TRX64** — the whole evidence/intervention/replay domain is TRX64-owned; children 711/712 folded below. |
| 711 | **WON'T-DO** | [Code/Data Overlay + Controlled Intervention Branches](711-code-overlay-intervention-branches.md) | **→ merged into TRX64** `docs/776-overlay-intervention-diff.md`. |
| 712 | **WON'T-DO** | [Rewind, Replay and Branch Diff](712-rewind-replay-branch-diff.md) | **→ merged into TRX64** `docs/776-overlay-intervention-diff.md` (rewind/snapshot-diff already in `spec-time-travel-tooling.md`; the new part = overlay-intervention + outcome-diff). |
| 713 | **WON'T-DO** | [VICE Cartridge Fidelity (CRT mapping/banking/writable)](713-vice-cartridge-fidelity.md) | **dropped** — TS-runtime cart-fidelity; TS deprecating + TRX64 already has faithful cart families (Normal/MagicDesk/Ocean read-only + flash-writable EasyFlash/GMOD/MegaCart, proven vs VICE). Branch `spec-713… |
| 715 | **RETIRED** | [Runtime Product Proof Baseline](715-runtime-product-proof-baseline.md) | retired as the authority → **783** |
| 721 | **DONE** | [Visual-Origin Join (runtime-informed annotation)](721-runtime-informed-annotation.md) | **DONE** — core join shipped, probe green. Provides the `mediumRef`/`MediaRegion` medium model + the trace→origin chain **Spec 750** consumes; the layout-placement slice 721.J5 shipped as **Spec 750.1**. The… |
| 723 | **RETIRED** | [Single-Path Runtime](723-single-path-runtime.md) | **BINDING** — `CLAUDE.md` rule 1 |
| 726 | **DONE** | [Headless Trace Sink + Marks](726-mcp-headless-trace-sink.md) | DuckDB sink + marks shipped; **726.B slice 1 shipped 2026-05-30** — the binary `.c64retrace` log IS the timeline authority, as the spec itself records at line 25. The board carried it as open work for ten weeks anyway. TRX64 then built the native Rust reader for that format (802), so the remaining slice exists twice. Closed 2026-08-11. |
| 742 | **DONE** | [Media Ownership + VICE-Faithful Write-Through](742-media-ownership-write-through-refactor.md) | **DONE** — write-through (D64/G64 + EasyFlash CRT → host file) fixed + gated (BUG-023, `smoke:742` 9/9). The "7 divergent mount paths" concern is resolved by the single Runtime-Daemon API (744.4c: UI/MCP/CLI… |
| 744 | **WON'T-DO** | [Runtime Session Authority + Drive-to-State](744-runtime-session-authority-drive-to-state.md) | **→ TRX64 (already there)** — daemon authority + `media/*` (mount/swap) + drive write-back shipped; session-orchestration is normal daemon-client work. |
| 746 | **DONE** | [Live Trace + Scrub Workbench (charter)](746-live-trace-scrub-workbench-charter.md) | Charter, not a slice — the anchor + firehose model it defined is built. Trace core, checkpoints and rewind are TRX64-owned and shipped; the scrub UI it called for (§4.2 checkpoint/scrub tools) shipped under 765 and 769 (filmstrip scrub in `workspace-panels.tsx`). Closed 2026-08-11: a charter whose parts all landed elsewhere is not open work. |
| 747 | **WON'T-DO** | [Bun Runtime Investigation](747-bun-runtime-investigation.md) | **dead** — Bun host was for the TS runtime; Node stays baseline, TS deprecating. |
| 771 | **DONE** | [TRX64 Runtime Backend + VICE Deprecation](771-trx64-runtime-backend.md) | **DONE 2026-08-11** — the goal is the state of the world: TRX64 is the default backend (`resolveDaemonSpawn`; the TS runtime is reachable only via `C64RE_RUNTIME_TS=1` and explicitly never a silent fallback)… |
| 772 | **WON'T-DO** | [Checkpoint-Ring: Cadence + Retention](772-checkpoint-ring-retention.md) | **→ TRX64 (already there)** — checkpoint-ring done (TRX64 CHECKLIST 705.B); cadence is a config value, not a spec. |
| 787 | **ARCHIVED** | [**BUILT**](787-scoped-trx64-instances.md) | `787-scoped-trx64-instances.md` | **Scoped TRX64 instances** (foundation) — one live machine under the C64RE UI (shared-attach) + N throwaway **scratch** instances (sandbox/oracle/targeted runs). The "one ma… |
| 788 | **ARCHIVED** | [**BUILT**](788-real-core-execution-sandbox.md) | `788-real-core-execution-sandbox.md` | **Real-core execution sandbox** (consumer of 787) — retire the standalone TS `Cpu6502` (orphaned 3rd 6502: flat 64K, no IO/banking, refs the deleted `cpu6510.ts`); run … |
| 799 | **ARCHIVED** | [**BUILT**](799-trx64-docker.md) | `799-trx64-docker.md` | **TRX64 Docker image** (containerized emulator sidecar) — official OCI packaging of `trx64-daemon` (multi-stage Rust build, ROMs baked, one WS port, amd64 first) + a consumer contract… |

## Historical

The remaining ~150 files here predate this register. They are kept for archaeology —
searchable, referenced from commit messages and code comments — but carry no per-file
decision record, and reading one is not evidence that anything in it still holds.
Check `../README.md` and `../../DOCTRINE.md` first; if a rule is not in either, it does
not bind.