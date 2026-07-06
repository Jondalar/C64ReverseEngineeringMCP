# Runtime Discipline Gate — extend read-before-trace to every flight-to-runtime door

Status: PLAN (list for review). Companion to the existing gate (commit 96abad61,
`src/server-tools/discipline-gate.ts`). Structured by the RE workflow model (7-stage
spine, `project_re_workflow_model`) because the model tells us *when* a runtime tool is
legitimate vs. a flight-reflex.

## The failure this targets

Cybernoid session, 2026-07-06: reached for `runtime_loader_lens` to extract a payload
(`unknown_08D6_34B3` = 11 KB **packed**) whose drivecode (`$F8E0/$F5E9/$F934` = 1541 ROM)
proved **standard GCR** = substrate readable = the payload is a pure **depack** (static).
The session had the discriminating evidence in hand and overrode it. LN3 (prior session)
had no "packed" trigger, so read-first held **by default, not by discipline**. Variance
between sessions = the signature of instruction-based enforcement. Move it to structure.

## Why the current gate isn't enough

1. **One door.** The gate is wired only into `runtime_trace_start` (`headless.ts:461-463`).
2. **Form, not substance.** `checkTraceDiscipline` passes on `$address` + ≥20 chars of
   rationale. A plausible rationalization (`"$08D6 is the packed payload, trace where it
   lands"`) passes trivially. The gate cannot tell *confirm-a-read-hypothesis* from
   *discover-by-fishing*. It raises the bar; it does not close the category error.

## Process-model mapping — the WHEN

Runtime is legitimate **only as a trace-validate CONFIRM step**, never as the
find/discover step. Per the 7-stage spine:

| Stage | Runtime's legit role | Gate precondition |
|-------|----------------------|-------------------|
| 1 Start/goal | none | — |
| 2 **Extract payloads** | trace-validate *after* characterize-medium + drivecode read | **substrate verdict on record**; standard-GCR ⇒ LOCKED (depack, static) |
| 3 Semantic disasm | confirm the model you built by reading | cite `$address` + what you read |
| 5 Umbau | confirm a change diverged | cite `$address` + what you read |
| 6 Testing/debug | trace-validate = heart of bug-hunt | cite `$address` + what you read |

Stage 2 is where Cybernoid broke and needs the *stronger* gate (substrate). Stages 3/5/6
need the generic form-gate (already the right predicate — "confirm not discover").

---

## Tier 1 — form-gate on the fishing doors (mechanical, low-risk, ships now)

Replicate the `trace_start` pattern: add optional `hypothesis` to the Zod schema, call the
gate at the top of the handler. Gates the **discover-structure** doors; leaves
**targeted-read** doors and **raw grabs** frictionless (over-gating makes the human turn it
off).

### GATE (discover-structure / statistics-mining — the fishing reflex)

| Tool | Handler | Why gate |
|------|---------|----------|
| `runtime_loader_lens` | `headless.ts:577` | derives payload source-block → dest identity (the Cybernoid door); **also Tier 2** |
| `runtime_memory_access_map` | `runtime.ts:200` | runs live, derives payload/free-RAM structure |
| `runtime_diff_snapshots` | `runtime.ts:405` | derives the payload delta between two states |
| `runtime_profile_loader` | `runtime.ts:549` | per-phase loader profile (structure by hotspot) |
| `runtime_trace_taint` | `runtime.ts:529` | "where did this byte come from" = discovery pattern |
| `runtime_follow_path` | `runtime.ts:463` | reconstructs the chain to an event = discovery |
| `trace_memory_map` | `trace-store.ts:216` | reconstructs RAM structure (CODE/DATA/free) |
| `trace_store_top_pcs` | `trace-store.ts:145` | ranked hotspots = the classic "reached for statistics" |

### DO NOT GATE (targeted reads of an already-justified trace — address is in the query)

`trace_store_query` (you write the WHERE), `trace_store_bus_find` (named bus lane),
`runtime_query_events` (by PC/addr), `runtime_swimlane_slice` (around a named cycle),
`trace_store_anchor_find` / `trace_store_anchor_list` / `trace_store_info`.
Rationale: the arm (`trace_start`) was already gated; these are surgical reads with the
address in the call. Low fishing risk; gating = friction.

### DO NOT GATE (raw byte/state grabs — need an address already / are state-mgmt)

`runtime_monitor_memory`, `runtime_monitor_disasm`, `runtime_session_snapshot`,
`runtime_save_vsf`, `runtime_checkpoint_capture`, `runtime_recorder_dump`,
`runtime_overlay_run`. Rationale: legit debugging peeks (stage 6) already carry an
address; gating breaks normal use.

---

## Tier 2 — the substrate discriminator (the category-error killer)

This is the one that would have **actually stopped Cybernoid**. Form can't do it; it needs
a recorded fact.

**The check:** for the Stage-2 extraction doors (`runtime_loader_lens`, and the
loader-trace arm when `domains` includes `drive-mechanism`), the gate reads the medium's
**substrate verdict**. If `standard-GCR` (KERNAL/DOS-readable) → **refuse**: "standard GCR,
this payload is a depack — use `sandbox_depack` / `try_depack`, not runtime." Only
`custom-GCR` / `weak-bits` / `unknown` lets the runtime extraction door open.

**Data dependency (honest):** the verdict must be **on record** and queryable. Today it is
not, in a machine-checkable form — the drivecode read that proves standard-GCR lives in
prose, not a field. Tier 2 therefore needs a small feature, not just wiring:

1. a recorded per-medium `substrate: standard-gcr | custom-gcr | weak-bits | unknown`
   (a finding/entity field the **characterize-medium** step writes — Stage 2's first
   sub-step, which the model already puts first).
2. the gate reads it; absent verdict = refuse with "characterize the medium first"
   (forces the read-first ordering structurally).
3. `standard-gcr` ⇒ extraction-runtime doors locked for that medium.

This encodes the process model exactly: **you cannot reach for runtime extraction until
characterize-medium has recorded a verdict, and if the substrate is readable the door
never opens.** The rationalization has nowhere to go — there is no prose field to spin.

---

## Recommended sequencing

- **Tier 1 now**: mechanical, closes the weakly-/un-gated doors, ships today, zero data
  dependency. Raises the bar on every fishing door.
- **Tier 2 next**: the real fix for the category error, but it needs the substrate-verdict
  record (a small Stage-2 feature). Do it as a focused follow-up so it lands complete
  (record → gate → lock), not half-wired.
