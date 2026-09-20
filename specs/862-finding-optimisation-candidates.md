# Spec 862 — Finding optimisation candidates

**Status:** READY (2026-09-19; 861 landed 2026-09-20, so the dependency is met — its
`code_cost`, `change_impact` and `trace_cost` are on the default surface, and the one thing
it could not derive is the drive lane, which this spec does not use)
**Repo:** C64RE only. TRX64: no change (it inherits 861's §5).
**Number:** 862 (registry: `specs/README.md`).
**Depends on:** Spec 861 — `code_cost` (cycle table, liveness, equivalence), `trace_cost`
(measured cycles, frequency), `change_impact`.
**Origin:** the owner, 2026-09-19, taking the half 861 left out: "Nicht Teil dieser Spec ist
das automatische Finden von Optimierungen — das bleibt eine Heuristik für eine spätere Spec."

---

## §1 The rule this spec lives by

**Finding is a heuristic; the verdict is not.** A candidate is found by a rule that may be
wrong about whether it applies. It is shown only with 861's deterministic verdict attached —
equivalence, Δ bytes, Δ cycles — and ranked by a measured or computed gain, never by the rule's
own opinion of itself. A rule that proposes something NOT EQUIVALENT has proposed nothing; the
candidate is dropped and counted, so a rule that is often wrong is visible as such.

And: **nothing is applied.** Turning a candidate into a patch is 796's `runtime_candidate_*`,
done by a human or an LLM on purpose.

## §2 Where to look

In this order, because the gain is the product of what a candidate saves and how often that
code runs:

1. **Hot code** — with a `trace_cost` measurement (861 §4): routines ranked by cycles per
   frame.
2. **Tight raster lines** — routines in lines whose cycle budget is nearly used (861 §4.3);
   a few cycles there are worth more than many elsewhere.
3. **Everything** — without a trace, the whole of the analysed code, ranked by static gain,
   and the report says it had no frequency to go on.

## §3 What must never be made faster

On a C64, faster is not always right. Code whose purpose IS its timing is excluded, and the
report lists what was excluded and why:

- **delay loops** — a loop that writes nothing to memory or I/O and only counts;
- **raster-timed code** — routines 861 places in lines with stable-raster or mid-line register
  writes (859/860 record them);
- **drive code** and **fastloader handshakes** — GCR and bus timing on the other side of the
  cable;
- anything 861 D1 calls **UNKNOWN** — self-modified bytes, `JMP (ind)`, stack tricks.

## §4 The rules

Declared once in a table, like 846's checks: `id`, `class`, the pattern, its preconditions,
the rewrite, and why it saves. Adding a rule is adding a row.

**Local** — straight-line, verdict by 861's equivalence directly:

- `tail-call` — `JSR x / RTS` → `JMP x`. Precondition: `x` does not read or rewrite its return
  address (no `TSX`-and-index, no `PLA/PLA` of the return). Saves 6 cycles and a byte.
- `redundant-load` — `STA z / LDA z` → drop the `LDA`, when N and Z are dead or already
  follow A.
- `jump-to-next` — a `JMP` to the next instruction.
- `jump-threading` — a branch or jump to a `JMP`, when the final target is in range.

**Dataflow** — needs a known value or flag; the verdict holds under that fact, and the fact is
listed with it:

- `known-carry` — `CLC`/`SEC` where the carry is already known (e.g. on the fall-through of a
  `BCC`).
- `known-register` — `LDA #n` (`LDX`, `LDY`) where the register already holds `n` and the
  flags it sets are dead or unchanged.

**Structural** — not straight-line; the verdict is 861's impact plus a measurement, not
equivalence, and the report says which:

- `page-align` — a table read with an index, or a branch, that crosses a page and pays +1
  cycle. The gain is exact from the trace: 861 §4.2 counts every crossing that happened.
- `zp-promote` — a variable in absolute memory used in hot code, moved to free zero page
  (Spec 844's free-RAM slot says what is free). Saves a byte and a cycle per access; the impact
  lists every access that must move.
- `count-down` — `INX / CPX #n / BNE` → `DEX / BPL`, when the index's direction is not used.

**Undocumented opcodes** (`LAX`, `SAX`, `DCP`, …, the stable ones only) — a rule class that is
**off by default** and switched on per project, because using them is a choice about the
target machines, not a fact about the code.

## §5 What a candidate carries

Rule id and class; location (routine, pc, payload — residency per 804 where it matters); the
bytes before and after; 861's verdict (EQUIVALENT / measured / UNKNOWN) with the assumptions it
rests on (liveness, known values); Δ bytes; Δ cycles per execution; executions per frame when
a trace exists; the resulting gain per frame; 861's impact summary. Ordered by gain per frame,
then static gain, then address — the same input gives the same list.

## §6 Surface

One MCP tool, `optimisation_candidates` — scope (project, payload, routine or range),
optionally a `trace_cost` result to rank by, the rule classes to use. Plus a counter per rule:
proposed, dropped as NOT EQUIVALENT, left UNKNOWN. A UI view is a later step.

## §7 Acceptance

Fixtures through the product's own doors (a sandbox program for every rule, analysed by the
pipeline; a trace captured as in 861 §4.5), so the gates run in CI.

1. **Every rule has a positive and a negative fixture.** The positive yields its candidate with
   verdict EQUIVALENT (or the structural class's measurement) and the exact Δ; the negative —
   a live flag, a return address that is read, a target out of branch range — yields none, and
   where the rule fired, it is counted as dropped.
2. **Timing code is left alone.** A delay loop, a stable-raster routine and a drive GCR loop
   produce no candidate, and all three appear in the exclusion list with the reason.
3. **Frequency ranks.** With a trace, a small saving in a routine called every frame ranks above
   a larger one in code that runs once.
4. **`page-align` is exact.** Its reported gain equals the page-crossing cycles 861 measured in
   the same trace.
5. **Nothing is applied.** The project's bytes and graph are unchanged after a run (hash before
   and after).
6. **Undocumented opcodes are opt-in.** Off: no `LAX`/`SAX` candidate; on: they appear.

## §8 Not in this spec

Applying candidates (796/797); optimising across routines (inlining, reordering code);
compression or size-first rewrites; drive code; NTSC; turbo profiles.
