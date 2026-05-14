# Spec 443 — `via1d1541.c` + `via2d.c` device-level literal re-port

**Status:** OPEN
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 441 (rotation + VIA2 backend flip), Spec 442 (viacore audit)
**Doctrine:** Claude-self literal audit. No subagents
([[feedback_1541_port_workflow]] + [[feedback_vice_no_alternatives]]).

**Anchors:**
- `docs/vice-1541-arch.md` §6 (VIA1 IEC + ATN), §7 (VIA2 drive head)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c` (420 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.h`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iecieee/via2d.c` (566 LoC)

## VICE source of truth

| File | LoC | Purpose |
|---|---|---|
| `drive/iec/via1d1541.c` | 420 | VIA1 device: IEC bus (PA = IEC data line, PB = ATN/CLK/DATA), DDR formulae, IRQ wiring, undump_pra/prb |
| `drive/iec/via1d1541.h` | – | hooks: `via1d1541_setup_context`, `*_init`, `*_signal`, store/read register, `*_dump`, `*_reset`, `*_get_state` |
| `drive/iecieee/via2d.c` | 566 | VIA2 device: drive head (PA = GCR byte / write data, PB = motor/LED/step/sync/wps/density/byte-ready), DDR formulae, store_pcr / set_ca2 / set_cb2 → rotation hooks |

## Headless target

`src/runtime/headless/via/via1d1541.ts` (360 LoC) + `via2d1541.ts`
(250 LoC). Spec 441 step 4e-flip already ported the **rotation
hookup** path (storePcr / setCa2 / setCb2 → rotation_rotate_disk +
read_write_mode + byte_ready_active). Spec 443 closes the loop by:

1. Auditing VIA1 device wiring (PA/PB → IEC bus, DDR formulae,
   IRQ → drive cpu).
2. Verifying VIA2 device backend signatures (storePcr void
   tightening per [[Spec 442 Phase 5]] finding).
3. Verifying both device wrappers' `setup_context` ↔ TS constructor
   wiring (callback table → ViaBackend interface).

## Audit procedure (7-step + Claude-self)

1. **Mapping** — `docs/spec-443-via-device-mapping.md` line-by-line:
   - via_context_t backend callbacks ↔ TS ViaBackend interface
   - VIA1 read_pra/read_prb/store_pra/store_prb/store_pcr/store_acr
   - VIA1 set_ca2/set_cb1/set_cb2/set_int
   - VIA2 read_pra/read_prb/store_pra/store_prb/store_pcr/store_acr
   - VIA2 set_ca2/set_cb1/set_cb2/set_int
   - DDR formulae literal (`pa | ~ddra`, `pb | ~ddrb`, etc.)
   - Snapshot / undump callbacks (state shape)
2. **Port** — fix BUG / MISSING rows literally vs VICE.
3. **Purge** — remove TS-only convenience methods.
4. **Proof** — `docs/spec-443-production-proof.md` with greps + line
   cites.
5. **Tests** — `tests/unit/via/via1d1541-conformance.test.ts` +
   `tests/unit/via/via2d-conformance.test.ts`.
6. **No subagent verdicts.**
7. **No arch decisions without ask.**

## Scope

In scope:
- VIA1 PA/PB output formulae for IEC ATN/CLK/DATA lines
- VIA1 PB → IEC bus signalling (drive-side perspective)
- VIA1 CA1 ATN edge ingestion (Spec 432 already did the literal
  ATN edge-tag plumbing; verify wiring still matches under
  Spec 442 changes)
- VIA1 IRQ aggregation into drive cpu
- VIA2 PA = GCR read byte / write data path (Spec 441 done; re-verify)
- VIA2 PB = motor/LED/step/sync/wps/density bits
- VIA2 setCa2 / setCb2 / storePcr → rotation hooks (Spec 441 done;
  re-verify)
- DDR formulae literal
- `via1d1541_dump` / `via2d_dump` state output (debug-tier MATCH OK)

Out of scope (other specs):
- `viacore.c` core itself (Spec 442 owns)
- Snapshot read/write VSF compat (Spec 451)
- 1571 / 1581 VIA variants
- Parallel cable (Spec 450, V1 OUT)

## Acceptance

1. `docs/spec-443-via-device-mapping.md` row-per-callback verdict
   matrix (target: 40+ rows).
2. Each BUG → fix patch in same Spec OR ticket-out reason.
3. Each MISSING → port-patch (no scope-cut).
4. Snapshot module name + state-shape matches VICE for VIA1 + VIA2
   (V1 best-effort; full VSF cross-load = Spec 451).
5. `npm run canary:spec-430` 5/5 PASS.
6. `tests/unit/via/via1d1541-conformance.test.ts` PASS (cite VICE
   lines for every assertion).
7. `tests/unit/via/via2d-conformance.test.ts` PASS.
8. `docs/spec-443-production-proof.md` committed with final verdict.
9. No subagent verdicts.

## Do Not

- Do not delegate audit to subagent.
- Do not change rotation hooks (Spec 441 owned + locked).
- Do not "simplify" IEC bus signalling formulae.
- Do not touch viacore core (Spec 442 closed).
- Do not start Spec 444 before 443 DONE
  ([[feedback_sequential_specs]]).

## Workflow gates

7-step per [[feedback_1541_port_workflow]]:
mapping → port → purge → proof → tests → no-subagent → no-arch-
without-ask.
