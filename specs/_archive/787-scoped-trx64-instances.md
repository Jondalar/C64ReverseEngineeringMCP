# Spec 787 — Scoped TRX64 Instances (one live, N scratch)

**Status:** PROPOSED
**Repos:** cross-repo — the instance lifecycle is TRX64 (`../TRX64`); the
live-session attach + the LLM-facing CLI/MCP wiring are C64RE.
**Number:** 787 (shared board `specs/README.md`).
**Doctrine anchors:** Leitregel (Capability → TRX64), Spec 723 (single-path: ONE
execution path — untouched here), Spec 744 (shared-attach live session), Spec 771
(TRX64 backend), Spec 780 (TRX64cli), Spec 782 (C64RE/TRX64 split charter),
CLAUDE.md "One Machine Per Process" (session isolation, Option A).

---

## 0. What this spec IS (and is NOT)

**IS:** the foundation that lets an LLM run **more than one** TRX64 machine —
exactly **one live machine under the C64RE UI** (the shared-attach co-drive
session) plus **N throwaway scratch instances** for sandbox / oracle / targeted
single runs. It defines the lifecycle, the surfaces (CLI for scratch, MCP for
live), and the guardrails.

**IS NOT:** the execution/depack primitive itself (that is its first consumer,
Spec 788), a second execution *path* (Single-Path / Spec 723 stays — every
instance runs the same pipeline; scoped ≠ modes), a raw "LLM pokes the live
machine at will" surface (§8), or a new `trx64-mcp` server (that is the 782 split,
later; this ships on the surfaces we already have).

## 1. Why now — the single-machine limit is a TS artifact

"One machine per process" was never a law of nature. Its cause is **module-global
singleton state in the TS port**: the literal VIC is a module-global
(`vic/literal/vicii-types.ts` `export const vicii`); the whole vice1541 drive
stack keeps state in module-level globals (`setFetchHost` / `*_install_hooks`).
Two machines in one TS process trample each other's globals. It is a port-shape
constraint (VICE-faithful, Spec 612), **not** a load/perf ceiling.

The **Rust core does not have it.** TRX64's `Machine` is a first-class
instantiable, cloneable struct — externally demonstrated: a harness minted 26
payloads with `Machine::new()` once and `base.clone()` **per file**, i.e. 26
machines in one process, no collision. Scoped instantiation is not "now
affordable with Rust" — it is how the core is already built. We inherited the
limit from the TS world; it retires with the TS runtime.

## 2. Model — one live, N scratch

- **Exactly one LIVE machine under the C64RE UI.** The shared-attach co-drive
  session (Spec 744): human + LLM see the same machine. `runtimeSessions.start`
  keeps attaching to it; never a second *live* one. Singular, always.
- **N SCRATCH instances**, spawned on demand, each its own machine, invisible to
  the UI, disposed after use. A scratch instance is **not** the live session and
  must never `resetCold` / mutate it.
- **Lifecycle:** `spawn scratch → (seed) → run → (harvest) → dispose`. The live
  session's lifecycle is unchanged (`start` = attach). A scratch **seed** comes
  from **cold + load** or a **saved `.c64re` file** (707 undump) — never from the
  live session's current state (§9).
- **Single-Path guardrail (hard):** every instance — live or scratch — runs the
  one execution path (Spec 723: microcoded CPU / literal VIC / vice1541). Scoped
  instantiation introduces **no** mode flag and reopens **no** toggle 723 closed.
  More machines, not more paths.

This dissolves the old "session-isolation tension": a throwaway is not a conflict
with one-machine-per-process — it is a *scratch* instance, by definition not the
live one. It also *strengthens* the "no scripts on the live session" rule — an LLM
with its own scratch machine has no reason to touch the shared one.

## 3. Surfaces — the capability needs no MCP; it needs a stable invocable form

The core is the power; MCP/CLI are only how an LLM reaches it repeatably and
safely. Three tiers exist; linking `trx64-core` and writing Rust per task works
but is the worst ergonomics (a bespoke compiled binary each time, no reuse, and
**raw** — no gating, no provenance). We want the reach without that cost.

- **Scratch / sandbox / targeted single runs → CLI (Spec 780).** A scratch
  instance = a separate short-lived process, which maps one-to-one onto a
  `trx64cli` invocation returning `--json`. The LLM Bash-invokes it, gets a
  result, the process disposes itself. Process isolation is free.
- **The one live session → the existing `runtime_*` / `sandbox_*` MCP** (today a
  proxy to the TRX64 backend, Spec 771). Scoped-instance verbs are an *extension*
  of this surface, not a new server.
- **No new `trx64-mcp` to start.** The 782 split is a later reorganization of the
  surface we already have, not a prerequisite for scoped instances.

The invocable surface (CLI/MCP) is also **where discipline lives** that the raw
path lacks — the static-first gate + provenance capture a consumer needs. That is
the reason to prefer it over "write Rust each time," beyond ergonomics.

## 4. v1 / v2

- **v1 — separate-process scratch.** Each scratch instance is a short-lived TRX64
  process; the OS gives isolation for free. Matches CLI 780. This is what
  consumers get first.
- **V2 — in-process `Machine` clone.** Cheapest isolation (clone a running machine
  in one process), but the daemon must address N in-process machines. **This is
  the substrate for the C64RE Scenarios feature** — fork/branch a *live* machine
  into what-if lines. TRX64 must expose clone eventually; it is deliberately out
  of v1.
- **Core:** TRX64-only. The TS runtime is being retired; no parity fallback. If
  TRX64 is absent, scratch spawning fails cleanly (no TS second path).

## 5. Acceptance / proof gate (`e2e:787`)

1. **Spawn + dispose.** Spawn a scratch instance → it reaches a usable booted
   state → dispose → no leaked process/handle; resources reclaimed.
2. **One-live invariant.** Under the UI, `runtimeSessions.start` yields exactly
   one attached live machine; N scratch spawns neither attach to nor mutate it —
   the live machine's state (RAM + CPU regs + drive `current_half_track`) is
   **byte-identical before and after** a full scratch spawn/run/dispose.
   (`probe-session-isolation.mjs` extended for the live-vs-scratch distinction.)
3. **Isolation both ways.** A scratch instance cannot `resetCold` / mutate the
   live session; live-session operations do not perturb a running scratch.
4. **Single-Path preserved.** `probe-single-path.mjs` green; scoped instantiation
   introduces **no** new mode flag; every instance runs the one pipeline.
5. **CLI.** `trx64cli` spawns a scratch process, runs, returns `--json`, and
   self-disposes; Bash-invocable end-to-end.
6. **TRX64-only.** Scratch is backed by TRX64; with TRX64 absent, spawn fails
   cleanly (no silent TS fallback).
7. Runtime product proof baseline stays green (touches the session/core path).

(V2 clone is **not** gated here — it is a later, separate slice.)

## 6. Build order (backend-first, API-first)

1. **Daemon/session lifecycle.** `spawn-scratch` / `dispose` verbs distinct from
   `start` = attach-live. Backend + probe first (tests 1–3).
2. **CLI wiring (780).** `trx64cli` scratch subcommand over the lifecycle (test 5).
3. **Guardrail gates.** Single-path + one-live + baseline (tests 4, 6, 7).
4. **(V2, separate slice)** in-process `Machine` clone for Scenarios — later, not
   in this spec's gate.

## 7. Consumers

- **Spec 788 — Real-Core Execution Sandbox** (first consumer): runs depack/oracle
  on a v1 separate-process scratch instance, retiring the TS shadow 6502.
- **C64RE Scenarios** (future): fork/branch the live machine — rides V2 clone.

## 8. Non-goals

- Not the execution/depack primitive or the sandbox engine (Spec 788).
- Not a raw "LLM reaches everything in the live machine" surface — a scratch
  instance is the disciplined alternative to that, not a gateway to it.
- Not a second execution path or a new emulator (Spec 723 stays). Fewer paths,
  more machines.
- Not the `trx64-mcp` split (Spec 782) — later reorg, not a blocker.
- Not scrub UI (761) or ring/storage (766).

## 9. Decided

- **OQ1 → no live→scratch coupling in v1.** A scratch instance seeds only from
  **cold + load** or a **saved `.c64re` file** (707 undump) — never from the live
  session's current state. Rationale: a fixed snapshot file is a *better* seed for
  a consumer than the live machine — deterministic and reproducible (mint the same
  result N times, byte-compare); the live session drifts. "Branch off the *live*
  machine" is a Scenarios concern and waits for the **V2 in-process clone**; the
  poor-man's clone (dump-live → spawn → undump) is that bridge, deferred, and
  Spec 788 does not need it.
