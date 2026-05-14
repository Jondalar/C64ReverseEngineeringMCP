# Spec 442 — `viacore.c` Claude-self literal re-audit + port-gaps

**Status:** OPEN
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 441 (DONE)
**Doctrine:** Manual Claude-self-audit. No subagents (per epic 440).
**Anchors:**
- `docs/vice-1541-arch.md` §7 (VIA 6522)
- `/Users/alex/Development/C64/Tools/vice/vice/src/core/viacore.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/core/viacore.h`

## Vertrauensbruch (warum dieser Spec)

Spec 434 audit-doc (`spec-434-viacore-audit.md`) gab "33 fns MATCH"
per Subagent. Nach GCR-Subagent-Fail (Spec 441 prelude) ist jeder
Subagent-audit unter Epic 440 invalidiert. Dieser Spec ersetzt 434
durch eine Claude-eigene line-by-line prüfung.

## VICE source of truth

| File | LoC | Function family |
|---|---|---|
| `core/viacore.c` | 2243 | `via_init`, `via_shutdown`, `viacore_reset`, `viacore_store`, `viacore_read`, `viacore_peek`, `viacore_set_*`, alarm handlers (T1/T2/SR), CA1/CA2/CB1/CB2 transitions, shift register, IRQ flag/enable, snapshot read/write |
| `core/viacore.h` | – | `via_context_t` struct shape (ifr/ier/t1/t2/sr/acr/pcr/ca/cb fields) |

## Headless target

`src/runtime/headless/via/via6522-vice.ts` (1341 LoC). Subclassed
by `via1d1541.ts` (Spec 443) + `via2d1541.ts` (Spec 443) + the
machine-side `cia*` aren't relevant (CIA = own chip).

## Audit procedure (Claude-self, kein Subagent)

1. Open `viacore.c` + `viacore.h`. Read top to bottom.
2. For each function in viacore.c, find TS counterpart in
   `via6522-vice.ts` (grep, `Read` region).
3. Write row in `docs/spec-442-viacore-mapping.md`:
   - VICE file:line range
   - TS file:line range
   - Behavioural diff (Konkret, nicht "stimmt überein")
   - Verdict: MATCH | DEVIATION | BUG | MISSING
4. Every non-MATCH = fix in this Spec OR ticket-out to Spec 443
   (VIA1/VIA2 device wiring), with reason.
5. Verify `via_context_t` field-shape (ifr/ier/t1/t2/sr/acr/pcr/
   ila/ilb/ca2_state/cb2_state/t1c_pb7/shift_state/...) maps
   1:1 to TS class fields.

## Scope

In scope (viacore.c primitive):
- `via_init` / `viacore_reset` — register init + zero-state
- `viacore_store` — write-path for all 16 register addrs
- `viacore_read` / `viacore_peek` — read-path, peek MUST NOT clear
  flags
- Timer T1 modes (one-shot, free-run, PB7 toggle)
- Timer T2 modes (one-shot, pulse-count PB6)
- Shift register all 8 modes (shift_in/shift_out, T2/CB1/φ2 clk)
- CA1/CB1 edge select + IFR latch
- CA2/CB2 modes (input/output, handshake, pulse, manual)
- IFR/IER flag + interrupt assert path
- ILA/ILB input-latch when ACR bit set
- T1C_PB7 PB7 toggle output
- Alarm timing (set_*_alarm, alarm dispatch via alarm-context)
- Snapshot read/write (snapshot module format, Spec 451 verifier
  consumer)

Out of scope (own specs):
- VIA1 device IRQ wiring (Spec 443)
- VIA2 device PA/PB/PCR backend (Spec 443 — already partial via
  Spec 441 4e-flip)
- CIA 6526 (separate Spec 146 alarm-driven port)
- Parallel cable signalling (Spec 450, V1 OUT)

## Doctrine recap

- **Genau wie VICE.** Kein "scope cut". Wenn VICE shift_state hat
  mit acht 1-cycle phases, TS hat das auch. Kein "we condense".
- **Keine TS-OO-tricks.** `via_context_t` ist struct, kein
  abstrakter base-class mit ts-typische "getter/setter override".
  Felder werden 1:1 als TS-class members exposed.
- **Eine Source of truth.** Wenn VICE `viacore_set_irq()` ruft,
  TS ruft `viacore_set_irq()` (gleicher name). Kein
  `notifyInterruptController()`.
- **Numerische Tabellen verbatim.** PCR-bit-tables, ACR-bit-tables,
  shift-modes — falls VICE-arrays existieren, TS-arrays haben
  identische werte.
- **`peek` NIE side-effects.** VICE peek_ifr / peek_t1 lesen ohne
  flag-clear. TS muss das exakt mirroren.

## Acceptance

1. `docs/spec-442-viacore-mapping.md` committed:
   - JEDE function in viacore.c hat eine row
   - JEDES struct-feld in via_context_t hat eine row
   - Target: 60+ rows (das alte 33-row subagent-doc ist Untergrenze)
2. Verdicts dokumentiert: MATCH / DEVIATION / BUG / MISSING
3. Jede BUG-row = fix-patch + neuer commit ODER ticket in
   Spec 443/444/etc mit explizitem reason
4. Jede MISSING-row = port-patch in diesem Spec (es sei denn
   out-of-scope per Epic 440 scope-cut)
5. `via_context_t` field-mirror PASS (line-by-line check)
6. `npm run canary:spec-430` (5/5) weiterhin grün
7. `npm test -- tests/unit/via/` (falls vorhanden) PASS
8. Neuer smoke `tests/unit/via/viacore-conformance.test.ts` (oder
   `.ts` literal eqv) prüft:
   - T1 one-shot fires correct cycle
   - T1 free-run reloads from latch
   - T1 PB7 toggle output present at PB7
   - T2 one-shot ditto
   - Shift register modes 0-7 dispatch
   - CA1 edge-select + IFR latch + clear-on-read
   - IFR/IER → IRQ line literal
   - PEEK does not clear flags
9. `docs/spec-442-production-proof.md` committed mit final verdict
10. Kein Subagent benutzt (assert in proof-doc)

## Do Not

- Do not delegate any audit step to a subagent.
- Do not "simplify" the shift-register state machine.
- Do not collapse CA1/CB1/CA2/CB2 into "generic edge handler".
- Do not skip ILA/ILB input-latch even if "no test exercises it".
- Do not change snapshot format (VSF compatibility — Spec 451).
- Do not start Spec 443 before 442 verdict is DONE
  ([[feedback_sequential_specs]]).

## Workflow (7-step per [[feedback_1541_port_workflow]])

1. **Mapping** — `docs/spec-442-viacore-mapping.md` (this spec).
2. **Port** — fix every BUG / MISSING row literally vs VICE.
3. **Purge** — remove any TS-only "convenience" methods that
   don't have viacore.c equivalent (or mark `@internal` if
   wrapper-only).
4. **Proof** — `docs/spec-442-production-proof.md` with greps
   showing literal port + line-cites.
5. **Tests** — `tests/unit/via/viacore-conformance.test.ts` PASS.
6. **No subagent verdicts** — every verdict authored by Claude
   line-by-line.
7. **No arch decisions without ask** — if a port choice has
   user-visible behavioural impact, AskUserQuestion first.
