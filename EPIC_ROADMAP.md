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

---

## Sprint Plan

| Sprint | Specs          | Mode               |
|--------|----------------|--------------------|
| 115    | 200            | sequential         |
| 116    | 201, 211       | seq + parallel     |
| 117    | 202, 212, 213  | seq + parallel x2  |
| 118    | 203, 210, 214  | seq + parallel x2  |
| 119    | 204            | sequential         |
| 120    | 205, 215, 216  | parallel           |
| 121    | 207            | sequential         |
| 122    | 206            | sequential         |

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
