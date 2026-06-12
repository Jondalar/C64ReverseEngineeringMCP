# Headless Runtime — Single-Machine-Per-Process Audit

**Status:** audit complete, root cause empirically proven, remediation deferred to
a joint decision (see "Remediation options"). **Date:** 2026-06-12.
**Gate:** `scripts/probe-session-isolation.mjs` (RED today = bug present).

## Why this exists

A session started by the LLM/daemon rendered differently in the UI than a
`ui.sh`-started session — the C64 boot text came out **black** instead of
light-blue, although color RAM (`$D800`) correctly held `$0E`. A process restart
("`ui.sh` neu") cleaned it up. The underlying complaint: the backend is **not**
headless in the sense that a human and the LLM can work on the **same** live
session in parallel — and it was never built that way.

## Root cause (verified)

The runtime **core is single-machine-per-process**. It is a faithful VICE port,
and **Spec 612 (1541 Port Fidelity) mandates module-level globals** ("one C
module-level global → one TS module-level `let`, same name"). VICE is
single-machine-per-process, so the literal-port VIC and the whole vice1541 drive
stack keep machine state in **process-global module state**, not per session.

On top of that core sits a **multi-session API** (`runtimeSessions.start` /
`startIntegratedSession` / UI `session/create` / MCP `runtime_session_start`)
that hands out N session ids with **no single-machine guard**. Every new
`IntegratedSession` constructor **rebinds the process-global VIC + drive hooks
onto itself** (last-writer-wins) and **never restores them on close**. So a
second session in the same process captures the global machine; the first
session — untouched by the user — then renders through the foreign/blank global
state. Closing the second session leaves the globals dangling on the dead one.

This is **not** a second render path and **not** a start-option divergence. It is
**one shared single-machine core under a multi-session façade.**

### Empirical proof (`scripts/probe-session-isolation.mjs`)

```
session A boots: bg=(39,36,196) idx6 blue, text=(104,100,255) idx14 light-blue  ✓
build session B in the same process (sets its $D021 = black), run A one frame:
session A render CORRUPTED → bg=(0,0,0) BLACK   ← A now reads B's global VIC regs
```

A is corrupted by B's mere construction. Restarting the process (one session
only) makes the globals consistent again — exactly the observed `ui.sh`-fix.

## Befund A — Process-global machine state (the core)

| Location | Global | Per-session rebind site |
|---|---|---|
| `vic/literal/vicii-types.ts:335` | `export const vicii = new_vicii_t()` — **one** VIC instance/process | `integrated-session.ts:1135` `vicii.regs = this.vic.regs` |
| `vic/literal/vicii-fetch.ts:52/62` | `let host` + `setFetchHost()` (color-RAM / chargen / ultimax lane) | `integrated-session.ts:1192` |
| `vic/literal/vicii-irq.ts:17/24` | `let host` + `setIrqHost()` (VIC IRQ → CPU) | `integrated-session.ts:1224` |
| `vic/literal/vicii-draw-cycle.ts:35–88` | ~28 module `let` (cbuf_reg/vbuf_reg/pipes/border/sprites) | implicit via `vicii_draw_cycle()` |
| `vic/literal/vicii-cycle.ts:37` | `let maincpu_clk` + `setMaincpuClk()` | per-session init |
| `vice1541/drive.ts:347/375` | `g_hooks` + `drive_install_hooks()` | `drive1541/vice1541-facade.ts:639` |
| `vice1541/drivecpu.ts:281/327` | `g_hooks` + `drivecpu_install_hooks()` | `vice1541-facade.ts:588` |
| `vice1541/drive_snapshot.ts:297/360` | `g_hooks` + `drive_snapshot_install_hooks()` | `vice1541-facade.ts:705` |
| `vice1541/iec.ts:305` | `iec_drive_hooks` + `iec_drive_install_hooks()` | `vice1541-facade.ts:835` |
| `vice1541/drive_6510core.ts:260–262,2152` | `g_drivecpu_*` / `g_cpu_reset` / `g_drivecpu_jam` slots | install setters |
| `vice1541/viacore.ts:1402` | `g_snap_hooks` | install setter |
| `vice1541/iecbus.ts:178` | `let iec_old_atn` | mutated in iecbus R/W |

Lifecycle: `installLiteralPortRenderer` runs only in the constructor
(`integrated-session.ts:472`); `stopIntegratedSession` is just
`sessions.delete(id)` (`integrated-session-manager.ts:24`) — no rebind to a
surviving session.

## Befund B — Start paths (the suspected "two paths")

Four start paths — daemon (`daemon/run.ts:122`), MCP `runtime_session_start`
(`server-tools/headless.ts:237`), UI `session/create` (`ws-server.ts:545`), all
through `runtimeSessions.start` → `startIntegratedSession`. Their option
differences (`mode`, `traceIec/Drive`, `enableBusAccessTrace`, `driveDispatchMode`)
do **not** change the render path: `vicRenderer` is ignored
(`integrated-session.ts:467`, always literal-port) and `driveDispatchMode` is a
dead diagnostic flag. **There is no second render or start-config path.** The
real defect of B is that `runtimeSessions.start` has **no single-machine guard**.

## Befund C — Tests/gates don't cover this class

- `scripts/probe-single-path.mjs` (Spec 723): asserts only toggle removal, with a
  **single** session (line 21). No isolation check.
- `scripts/runtime-product-proof.mjs` (Spec 715, 7 games): all gates sequential,
  single-session. None build ≥2 sessions in one process.
- `scripts/probe-705-core-roundtrip.mjs:12–14`: **documents the bug explicitly**
  ("the literal VIC … is a global singleton, so two parallel sessions cannot be
  used") and sidesteps it by staying sequential.
- `scripts/smoke-744-4-session-authority.mjs`: checks registry list/ids, not render
  isolation.
- **Gap:** no gate builds 2 sessions and asserts the first stays intact. Now
  filled by `scripts/probe-session-isolation.mjs`.

## Befund D — Docs (MD + MCP tool descriptions) don't tell the truth

- `CLAUDE.md` "Single-Path Runtime (Spec 723)" conflates **execution-path** (one
  CPU/VIC/drive pipeline — true) with **session-isolation** (false). No mention of
  the process-global singleton. Corrected by the new "One Machine Per Process"
  section.
- `specs/744-*` §2.3 "Shared-Attach" promises "both surfaces see the same
  CPU/VIC/CIA/SID/1541 state" — true **only** because there is one global machine,
  but reads as if sessions were N isolated machines.
- MCP tool descriptions (`server-tools/headless.ts`: `runtime_session_start` /
  `_close` / `_status`) imply freely startable, isolated sessions and never warn
  that a second in-process session corrupts the first. Tool descriptions are docs.

## Remediation options (next decision — not yet executed)

- **A (recommended) — enforce one machine per process.** `runtimeSessions.start` /
  `session/create` do not build a second machine in the same process; they
  **attach** to the existing one (Spec 744 shared-attach: human + LLM on the
  **same** session). An isolated machine = a separate process (matches the
  "separate backend" rule). Keeps the module-globals (Spec-612-faithful), smallest
  change, fixes the exact pain.
- **B — context-swap** the global VIC + hosts + draw-cycle + drive state on session
  switch (mechanics partly exist: `vicii_snapshot_write/read`, draw-cycle get/set).
  N sessions, one active at a time. Fragile (every global from the table must be in
  the swap set).
- **C — full per-session instancing** (thread `vicii_t` + hosts through every
  literal-port + vice1541 function). True N-parallel machines. **Violates Spec
  612**, huge, highest risk.
- **D — process-per-session** (each machine in its own worker; globals stay). Clean
  isolation, heavy infra (the daemon already has WS transport).

## Verification

- `node scripts/probe-session-isolation.mjs` → RED today (corruption after the 2nd
  constructor). After a fix lands, run with `EXPECT_ISOLATED=1` → asserts session A
  is byte-identical before/after session B (GREEN = contract held).
