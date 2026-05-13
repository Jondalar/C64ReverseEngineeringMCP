# Spec 441 — `rotation.c` literal port + `gcr-shifter.ts` audit

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 440 (epic charter)  
**Doctrine:** Manual Claude-self-audit. No subagents (per epic 440).
**Anchors:**
- `docs/vice-1541-arch.md` §8 (Rotation — GCR / disk physics)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.h`

## VICE source of truth

| File | LoC | Function family |
|---|---|---|
| `rotation.c` | ~900 | `rotation_init`, `rotation_reset`, `rotation_overflow_callback`, `rotation_byte_ready`, `rotation_change_mode`, `rotation_table_get`, `rotation_speed_zone`, `rotation_rotate_disk`, `rotation_set_atn_active` |

The header `rotation.h` enumerates `rotation_state_t`, `rotation_t` —
both must have direct TS counterparts.

## Headless target

`src/runtime/headless/drive/gcr-shifter.ts` (690 LOC) — claimed
"VICE 1:1 rotation.c" per [[project_gcr_default_flipped]], but has
never been audited line-by-line by Claude. The default flip
2026-05-06 only switched a behavioural toggle.

Per Epic 440 doctrine the prior subagent-style claim is suspect.

## Audit procedure (Claude-self only)

1. Open `rotation.c` + `rotation.h`. Read top to bottom.
2. For each function, find its TS counterpart in `gcr-shifter.ts`
   (grep, then `Read` whole regions).
3. Write a row in `docs/spec-441-rotation-audit.md`:
   - VICE file:line range
   - TS file:line range
   - Concrete behavioural diff if any
   - Verdict: MATCH | MINOR-DEVIATION | BUG
4. Every non-MATCH gets a fix patch in the same PR.
5. Re-verify state-shape fields match `rotation_t` struct.

## Scope

In scope:
- `rotation_byte_ready` callback timing (BYTE-READY edge → SO line)
- `rotation_overflow_callback` (alarm-driven, per-bit rotation)
- Speed-zone bit-rate table (per VICE source-array)
- Wobble model (if VICE has one; check 8.5 wobble)
- ATN-active rotation suppression (per `rotation_set_atn_active`)
- Half-track stepping integration with rotation pointer

Out of scope:
- Write-path coupling (Spec 445 owns)
- 1571/1581 rotation variants

## Acceptance

1. `docs/spec-441-rotation-audit.md` committed with row-per-function
   verdict.
2. `gcr-shifter.ts` matches `rotation.c` in:
   - state shape (`rotation_t` fields ↔ TS class fields, names
     literal)
   - byte-ready edge stamping cycle
   - speed-zone table values
   - ATN-suppression conditional
3. No subagent was used.
4. `npm run canary:spec-430` still green.
5. New smoke `tests/rotation-vice-bytes.test.ts` (or
   `scripts/smoke-441-rotation.mjs`) compares the produced byte
   sequence at a fixed bit position for ≥3 different speed zones
   against precomputed VICE-baseline byte sequences. Vectors
   harvested via `vice_trace_runtime_start` once (allowed).

## Do Not

- Do not delegate the audit to a subagent (epic-440 rule).
- Do not "modernize" the rotation pointer math.
- Do not change motor-on/off semantics outside the literal port.
- Do not touch VIA2-side BYTE-READY beyond what `rotation.c` does.
