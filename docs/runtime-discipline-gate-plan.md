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

## Tier 2 — the substrate discriminator (the category-error killer) — BUILT

The one that **actually stops Cybernoid**. Form can't do it; it reads a recorded fact.

**Scope (tighter than Tier 1):** ONLY the payload-extraction-FROM-MEDIUM doors —
`runtime_loader_lens` (reads the landing map) and `runtime_trace_start` when `domains`
includes `drive-mechanism` (arms the loader-lens capture). The general trace-analysis doors
(taint / follow_path / profile / hotspots / …) are stage-3/6 debugging where runtime is
legit even on a standard-GCR disk — they keep the form gate only.

**The record** (`src/project-knowledge/types.ts`, stored `knowledge/substrate-verdict.json`,
singleton mirroring `project-profile.json`): a per-medium verdict
`{ substrate: standard-gcr | custom-gcr | weak-bits | mixed | unknown, evidence, source:
auto|manual, recordedBy, diskId?, fileCount?, at }`. Written at the **characterize-medium**
step (Stage-2 sub-step 1):
- **auto** — `inspect_disk` / `extract_disk` parse the DOS directory at 18/0: populated ⇒
  `standard-gcr`, `UNTITLED`/0 files ⇒ `custom-gcr` candidate (`recordDiskSubstrate` in
  `media.ts`).
- **manual** — `inspect_disk(substrate_override=…)` after an agent READ the drivecode; a
  `manual` verdict outranks `auto` (`recordSubstrateVerdict` never lets auto clobber it).

**Project posture** (`deriveSubstratePosture`): no verdicts ⇒ `unknown`; any protected
medium ⇒ `protected`; all `standard-gcr` ⇒ `standard-gcr`. The gate
(`src/server-tools/substrate-gate.ts`, `checkSubstrateDiscipline`):
- `unknown` → refuse **"characterize the medium first"** (structural read-first ordering).
- `standard-gcr` → refuse **"static depack, use `sandbox_depack`"** + the escape hatch.
- `protected` → allow (runtime earns it).
- no project context → allow (Tier 2 is project-scoped; ad-hoc runtime keeps the form gate).

**Escape hatch** for a standard directory whose payload is really in custom-GCR tracks:
read the drivecode, then `inspect_disk(substrate_override="custom-gcr")` — the override
*requires* having read the protection, which is the doctrine.

This encodes the process model exactly: **you cannot reach for runtime extraction until
characterize-medium has recorded a verdict, and if the substrate is readable the door never
opens.** The rationalization has nowhere to go — there is no prose field to spin.

`e2e-discipline-gate` 32/32 (Tier 1 19/19 + Tier 2 posture 6/6 + integration 7/7, incl. the
standard-gcr → loader_lens-refused Cybernoid block and the manual-override unlock).

---

## Status

- **Tier 1** — BUILT (commit `e1eb95f6`). Form gate on 8 discover-structure doors.
- **Tier 2** — BUILT. Substrate discriminator on the 2 payload-extraction doors.
- **Persona / gatekeeper layer** — designed, not built (see
  `project_runtime_discipline_enforcement_architecture` memory). The gate is the floor the
  whole persona stack rests on; both tiers are that floor.
