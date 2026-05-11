# EPIC ROADMAP — C64RE V1 / V2 / V3

**Source of truth.** Replaces the historical `PLAN.md` (archived in
`docs/archive/PLAN-2026-05-06.md`). All emulator-core architecture
authority lives in `docs/adr-headless-machine-kernel.md` (Accepted
2026-05-06).

`PLAN.md` is now a slim pointer; `BUGREPORT.md` and `REQUIREMENTS.md`
remain as-is for project-wide bug and refinement tracking.

---

## Product Versions

### V1.0 — Full Headless C64 + 1541 TrueDrive Emulator

Real emulator, not loader harness. Excluding only audible sound output.

- Full C64 software-visible behavior: CPU, CIA, VIC (B-level rendering
  acceptable), PLA, input, reset, snapshots, traces.
- Full 1541 TrueDrive: real drive ROM, drive CPU/VIA timing, IEC, GCR
  rotation, head movement, read/write behavior, D64/G64 media.
- VICE-compatible cross-domain bus semantics.
- No KERNAL serial/file traps as acceptance path.
- Commercial games with custom IEC fastloaders boot through the same core.
- E2E acceptance: Maniac Mansion, motm, Last Ninja, Impossible Mission II.

### V2.0 — LLM Reverse-Engineering Workbench

Emulator queryable by agents:

- Deterministic replay.
- Structured snapshots.
- Event-indexed traces with canonical event families.
- Follow-a-path tracing.
- Transaction-by-transaction trace analysis: C64 CPU, IO write/read,
  resolved bus state, drive IO read/write, and drive CPU side by side
  on a shared clock.
- Runtime evidence linked to disassembly and project knowledge.
- First-divergence comparison against VICE while VICE remains oracle.

### V3.0 — Human C64RE UI

Same kernel drives the human UI:

- Live C64 screen (pixel-perfect VIC, sprite/bg collisions, revisions).
- Keyboard and joystick emulation.
- Media selection.
- Monitor / debugger.
- SID playback (resid or fastsid 1:1) and audio export.
- Screenshot / video / audio export.

V3 must not fork a second emulator path. UI is a kernel client.

---

## Architecture Authority

`docs/adr-headless-machine-kernel.md` is binding. Key decisions:

- **A** — One `MachineKernel` owns time. `IntegratedSession` becomes
  facade.
- **B** — Production sync = VICE-style event/catch-up. Lockstep is
  diagnostic only.
- **C** — Lockstep, push-only, hybrid are `debug-*` modes, not
  acceptance.
- **D** — Chips are pure components. No peer-ticking, no
  cross-domain pokes, no hidden traps.
- **E** — Cross-domain bus access goes through `KernelBus` with a
  `BusAccessContext`.
- **F** — Event order is part of the emulator contract. Ordering must
  be documented, traceable, and owned by the kernel.

The ADR also records Pi1541 as a GPLv3 reference-only source for 1541
timing, IEC line direction, ATNA/CA1 behavior, VIA execution,
GCR/motor/head coupling, and reset ordering. VICE remains the
compatibility oracle.

Production modes (ADR §7): `fast-trap`, `real-kernal`, `true-drive`,
`debug-vice-compare`. Diagnostic: `debug-lockstep`, `debug-push-only`,
`debug-hybrid`.

Non-negotiable acceptance: ADR §10.

One-sentence rule (ADR §15): _If a change makes a game progress but
cannot explain the exact VICE/headless event it now matches, it is not
a core fix. It is a probe._

---

## Spec Cut (200-series)

All prior specs ≥137 are superseded. Sprint 112 abandoned. Sprint 113
aborted. Sprint 114 / Spec 153 reframed as 213 below.

### Kernel core (sequential, single integrator, no parallel agents)

| Spec | Title                          | Maps from        | Depends |
|------|--------------------------------|------------------|---------|
| 200  | Kernel facade + status         | new (ADR §8.1)   | —       |
| 201  | IEC behind KernelBus           | 140 (remap)      | 200     |
| 202  | Drive catch-up private         | new (ADR §8.3)   | 201     |
| 203  | Alarms + IRQ timestamps        | 141, 149 (remap) | 202     |
| 204  | TrueDrive hook hygiene         | 144 (remap)      | 203     |
| 205  | Trace contract                 | 142, 143, 152    | 200     |
| 206  | V2/V3 client API               | new (ADR §8.6)   | 204,205 |
| 207  | Public modes + test profiles   | new (ADR §7,§11) | 200     |

200 must land first. 201-204 are strict-sequential (timing-write-scope).
205 may run alongside 200-204 (trace surface, not timing). 207 follows
200. 206 closes the kernel core.

### Chip ports (parallel-eligible after kernel dependency lands)

ADR §12.4: parallel agents OK when write scopes do not overlap. Chip
ports touch local chip state, not kernel timing.

| Spec | Title                          | Maps from | Depends |
|------|--------------------------------|-----------|---------|
| 210  | CIA 1:1 VICE port              | 145       | 203     |
| 211  | VIA 1:1 VICE port              | 147       | 201     |
| 212  | Drive 6502 cycle audit         | 146       | 202     |
| 213  | Drive GCR / motor / head full  | 153       | 202     |
| 214  | VIC bus stealing + IRQ timing  | 150       | 203     |
| 215  | Reset state byte-exact         | 148       | 200     |
| 216  | SID 1:1 register state         | 151       | 200     |

V3 follow-ups (deferred): VIC pixel-perfect renderer (vicii*.c full
port), SID full audio (resid or fastsid), human UI surfaces.

### Dropped

- **138** push-flush probe — superseded by ADR §3 Decision B.
- **139** kernel sync architecture — replaced by 200.

### Kept as informational

- **137** `docs/vice-iec-arc42.md` — reference for IEC observable
  semantics, no implementation work.

### Diagnostic support specs

These specs support V1/V2 evidence work and may run alongside the core
sequence when they do not edit emulator timing paths. Transaction
swimlanes are a canonical workbench tool, not a one-off MoTM debug
artifact: every hard timing/reverse-engineering question should be
answerable as a small side-by-side trace window instead of another
large raw trace.

| Spec | Title | Depends |
|------|-------|---------|
| 217  | DuckDB trace store and zoomable runtime evidence | 205 |
| 218  | MoTM TX3/TX4 bit-level divergence | 205,217 |
| 219  | CPU illegal opcode coverage (Lorenz disk2-4) | 200, 212 |
| 220  | CI pipeline (GH Actions, 3 tiers) | 207, 219 |

V1 status (2026-05-08): all 200-220 DONE except 218 (debug-only).
true-drive 1541 silikon-equivalent. Lorenz disk1 100%. Disk2 all
TRAP1-17 + illegal opcodes pass. CIA testprogs 59/59. Drive 4/4.
E2E ladder 6/6.

### V2.0 — LLM workbench (refined, ready for impl)

| Spec | Title | Depends |
|------|-------|---------|
| 230  | V2 master spec (8 sub-specs index) | 200-220 |
| 231  | Deterministic replay & rerun | 134, 205, 215 |
| 232  | Event-indexed trace store (24 families) | 205, 217 |
| 233  | Follow-a-path tracing (causal chain) | 232 |
| 234  | Transaction-level swimlane | 232, 205-B |
| 235  | Runtime ↔ disasm link | 232, pipeline |
| 236  | VICE first-divergence diff (debug-tier, low prio) | 232, 205-B |
| 237  | Agent query API (KernelClient ext, ~22 methods) | 231-236, 240+ |
| 238  | V2 MCP tool layer (V1 hard-cut atomic) | 237 |

### V2.x extensions (refined)

| Spec | Title | Depends |
|------|-------|---------|
| 240  | V2.x extensions index | 230 |
| 241  | Conditional breakpoints + watchpoints (VICE parity + JS callback) | 206 |
| 242  | Trace bookmarks / annotations | 232 |
| 243  | Rewind + patch/poke + scenario tree iter | 231, 251, 241 |
| 244  | Taint analysis / dataflow tracking | 232, 233 |
| 245  | Loader / protection profiling | 232, 233 |
| 246  | Save-state semantic diff (debug-tier) | 251, 134 |
| 247  | Routine fingerprinting (TREX-configurable libs) | 232, pipeline |
| 248  | VICE monitor parity + indirect tracking (V3 drops VICE) | 206, 232 |
| 249  | Disasm annotation suggestions + table discovery + .asm sync | 232, 247 |
| 250  | Regression vs known-good (DuckDB baselines, LLM-explicit) | 231, 232, 236 |
| 251  | C64-main VSF completion (drops VICE-runtime dep) | drive-VSF |

V2 sequencing rationale: 251 first (= unblocks rewind 243), then
foundational primitives (232 trace store, 241 breakpoints,
242 bookmarks, 246 diff), then time-travel (243), then RE-leverage
(247 fingerprint, 248 monitor, 249 disasm-sync), then heavier
analytics (244 taint, 245 profile), then comparison/regression
(233/234/235/236/250), then API + tools close-out (237/238).

---

## Sprint Plan (V1 + V2)

| Sprint | Specs              | Mode                |
|--------|--------------------|---------------------|
| 115    | 200                | sequential          |
| 116    | 201, 211           | seq + parallel      |
| 117    | 202, 212, 213      | seq + parallel x2   |
| 118    | 203, 210, 214      | seq + parallel x2   |
| 119    | 204                | sequential          |
| 120    | 205, 215, 216      | parallel            |
| 121    | 207, 219           | sequential          |
| 122    | 206, 220           | sequential          |
| 123    | (V1 close + archive)| —                  |
| 124    | 251                | sequential (VSF)    |
| 125    | 232                | sequential          |
| 126    | 231, 241, 242, 246 | parallel            |
| 127    | 243                | sequential          |
| 128    | 247, 248, 249      | parallel            |
| 129    | 244, 245           | parallel            |
| 130    | 233, 234, 235      | parallel            |
| 131    | 236, 250           | parallel            |
| 132    | 237                | sequential          |
| 133    | 238 (+ V2.1 hard-cut)| sequential        |

### V3.0 — Human UI (refined 2026-05-09)

| Spec | Title | Depends |
|------|-------|---------|
| 260  | V3 master (browser, single-user, WebSocket, indexed-palette) | 200-251 |
| 261  | UI shell (React/Vite) | 272 |
| 262  | VIC pixel-perfect (1:1 VICE, FLI/NUFLI, multiplexer) | per-cycle reg-write log |
| 263  | SID audio (resid + fastsid trace) | 251 |
| 264  | Keyboard + joystick (vicerc bootstrap) | 261 |
| 265  | Media selector (multi-disk, cartridge) | 261 |
| 266  | Monitor + debugger (auto-branch on edit) | 248, 243 |
| 267  | Trace viewer (swimlane + bookmarks) | 234, 242 |
| 268  | Snapshot tree + scenario editor | 243, 231 |
| 269  | Export (PNG, MP4 ffmpeg, WAV) | 263 |
| 271  | Distributed scenarios (worker_threads) | 231 |
| 272  | WebSocket protocol (JSON-RPC + binary) | — |

V3 NOT included: ~~270 VICE drop~~ — VICE stays second-class
(2026-05-09). Headless-over-VICE framing remains binding.

V3 Sprint Plan:

| Sprint | Specs | Mode |
|--------|-------|------|
| 134    | 260, 272 | sequential (foundation) |
| 135    | 261 | sequential (UI shell) |
| 136    | 262 | sequential (VIC pixel-perfect) |
| 137    | 263 | sequential (resid audio) |
| 138    | 264, 265 | parallel |
| 139    | 266, 267 | parallel |
| 140    | 268 | sequential |
| 141    | 269, 271 | parallel |

Acceptance gate per sprint: ADR §10 criteria, plus E2E ladder
(MM/motm/LN/IM2) for sprints 117 and later.

---

## Test Profiles (ADR §11.4)

- `quick` — build + smoke tests.
- `integration` — quick + subsystem integration.
- `trace` — integration + VICE/headless diff captures.
- `e2e-local` — real G64 game boot tests (MM, motm, LN, IM2).
- `release` — integration + selected trace + e2e-local.

Every profile prints kernel mode, media used, traps/hooks used,
pass/fail counts, artifact paths.

---

## Working Process Reminder

CLAUDE.md mandates reading `BUGREPORT.md`, `REQUIREMENTS.md`, and
`PLAN.md` (now pointer) before any task. For emulator-core work also
read this file and the ADR. New work without a 200-series spec is
incomplete for kernel paths.

API-first via headless. Every feature lands first as MCP tool / library
/ endpoint with smoke coverage. UI follows once API stable.
