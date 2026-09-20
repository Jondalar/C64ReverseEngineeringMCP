# Spec 862 — Finding optimisation candidates

**Status:** BUILT 2026-09-20 — every rule, every exclusion, every gate. §9 records what was
built, the two things §4 says that turned out not to be so, and the numbers the gates
measured.
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

---

## §9 As built (2026-09-20)

**The rule table** — `src/optimise/rules.ts`. Eleven rows: `id`, `class`, the pattern, the
preconditions, the rewrite, what it saves, and how its verdict is reached. `RULES` is the
declaration and `MATCHERS` is one function per row; the tool prints the table on request
(`show_rules`), so what a rule requires is readable without reading the code. Adding a rule
is adding a row and a matcher.

**The verdict** — `src/optimise/verdict.ts`. Every proposal goes through it and nothing a
matcher says about its own correctness survives the trip. It judges in three ways, and the
candidate always names which one carries it.

* **equivalence** — 861 §3.4, unchanged: both versions executed symbolically, compared over
  A/X/Y, the stack, every memory cell either writes, the flags that are LIVE at that point
  in that routine, and every access to $D000–$DFFF **in order**. `redundant-load`,
  `known-carry`, `known-register`, `lax-load`, `rmw-alu-fuse`.
* **control-flow** — for the three local rules that are not straight-line code. §4 says the
  local class takes "the verdict by 861's equivalence directly", and for three of its four
  rows that is not possible: a `jsr`, a `jmp` and an `rts` end a block, so `compareCost`
  answers UNKNOWN by construction. They are decidable all the same, and the obligation is
  named and **checked against the bytes** rather than assumed. `jsr x / rts` against `jmp x`
  differs in exactly one thing — while x runs the stack is two bytes deeper — so the
  callee's own bytes are decoded and a `tsx`, a `txs`, an `rti`, an indirect exit, an
  unbalanced pull or a routine that leaves something on the stack stops the rewrite with
  that instruction's address printed. A `jmp` to the next instruction and a jump threaded
  through another `jmp` carry no state at all, so the obligation is only that the bytes at
  the hop really are a `jmp abs` in this image and, for a branch, that the displacement
  fits.
* **measurement** — the structural class, where §4 says so outright. The number is a count:
  the page crossings 861 charged in the capture, the accesses in the code, the iterations a
  resolved loop makes. The candidate says `MEASURED`, not `EQUIVALENT`.

NOT EQUIVALENT ends a candidate, as §1 requires. UNKNOWN does not — it is shown, marked and
counted, because "the check could not decide" must never read as "it is fine".

**The dataflow class needed one thing 861 did not have**: a way to say what is already true
at a window's entry. `SymOptions.known` seeds constants (and the one relation that matters,
"N and Z already follow this register") into both versions, and `compareCost` prints them in
the assumption list because the verdict holds only under them. The facts themselves are
derived, never pattern-matched: the block's prefix is run symbolically from a fully symbolic
entry and whatever comes out constant is a constant for **every** way into the block. A
prefix the engine cannot model — a `jsr`, an opcode it has no semantics for — yields no facts
at all. One place needs more than that: the carry a branch edge guarantees (the fall-through
of a `bcc` has C set, its target has C clear). That is used only when the block has exactly
one predecessor, nothing outside reaches its first address, and nothing between the edge and
the instruction can have written C — where "can have" counts a `jsr`, which the effects table
says writes nothing and which can of course clear the carry.

**What must never be made faster** — `src/optimise/exclusions.ts`. Each is a span with a
reason and all of them are printed; silence was the failure mode to avoid, because a scan
that quietly skipped the hot routine looks exactly like one that found nothing there. A
delay loop is recognised strictly — no I/O, no call, and no memory touched but the one cell
the counter lives in, so a loop that reads a table is computing something and its cycles are
a cost rather than a purpose. Raster-timed code is recognised statically from a `$D011`/`$D012`
read inside a loop, or from a raster read together with a video-register write; with a
capture there is a third signal, and it is the one §3 names: a write to a VIC register that
landed **inside the displayed picture** (PAL lines 51–250), where when it lands is the
effect. Drive code is the 1541's VIAs, a `bvc` spinning on its own address (the byte-ready
handshake) and a serial-port access inside a loop (a fastloader handshake, whose other end is
not being changed), plus whatever the graph itself places on the drive's CPU. And 861 D1's
UNKNOWN: an indirect jump, an `rti`, bytes that do not decode, a stack left unbalanced, a
`txs`, and a store — from the graph or from the scanned code itself — that lands inside the
range.

**Where `zp-promote` may move a variable to** — `src/optimise/free-zp.ts`. Spec 844's
free-RAM slot, and nothing else. It carries that slot's own distinction into the candidate: a
destination a run confirmed, or one read off a listing and still a hypothesis. With no slot
answered there is no destination and therefore no candidate, and the rule says that is why
rather than picking $FB and hoping — four projects in the corpus claimed free RAM from
reading and all four were corrected by running.

**The scan and the order** — `src/optimise/{candidates,format}.ts`. §2's order (hot code,
then routines in raster lines with almost nothing left, then everything else) decides what is
looked at first and is printed with the measured cycles behind it; §5's order (gain per
frame, then static gain, then address, then rule id) decides the list and is total, so the
same input gives the same answer. Without a capture the report says outright that it has no
frequency to go on. Each candidate carries the rule and its class, the routine, the bytes
before and after as instructions, the verdict and how it was reached, the facts and the
assumptions, Δ bytes, Δ cycles per execution, the executions the capture recorded, the gain
per frame, and 861's impact walk in one line.

**The tool** — `optimisation_candidates` (`src/server-tools/optimise-tools.ts`), on the
default surface beside the three cost tools and at the front of the change/patch/crack/port
flow with them. It reads bytes and writes none: the graph opens read-only and no record is
touched.

### §9.1 Two things §4 says that turned out not to be so

**`tail-call` saves 9 cycles, not 6.** §4's row says "Saves 6 cycles and a byte". A `jsr` is
6 and an `rts` is 6; a `jmp` is 3. The window costs 12 before and 3 after, so the saving is 9
cycles and one byte. The callee's own `rts` costs 6 either way and is not part of it. Nothing
in the implementation reads the prose — every Δ comes from the cycle table — and the gate
asserts 9.

**There is no `sax` rule, and there should not be.** §4 names `SAX` among the undocumented
opcodes to rewrite into. `SAX` stores `A & X`, and a stock 6502 cannot compute that without a
scratch cell: the documented sequence it would replace is `stx tmp / and tmp / sta dest`,
which writes `tmp` where `sax dest` does not — so the two are NOT EQUIVALENT on a memory
cell, correctly, and a rule that proposed it would be dropped on every match. Where A and X
are already known equal, `sax` and `sta` cost the same and save nothing. The undocumented
class is therefore `lax-load` (`lda m / ldx m` and `lda m / tax` → `lax m`) and
`rmw-alu-fuse` (the six stable read-modify-write pairs → `dcp`, `isc`, `slo`, `sre`, `rla`,
`rra`), and §7.6 is satisfied by the LAX and DCP candidates appearing when the class is
switched on and by nothing from it being counted when it is off.

### §9.2 What the gates measured

`e2e:862-rules` (75/75) and `e2e:862-rank` (23/23) are hermetic and in CI. `smoke:862`
(19/19) records a real capture; it runs on a sandbox of its own and reads through a daemon of
its own, and never addresses the shared machine.

* **§7.1** — a positive and a negative fixture for every rule, in one PRG built through
  `project_init` / `agent_onboard` / `analyze_prg` / `disasm_prg` / `save_finding`. Each
  positive yields its candidate with the verdict and the exact Δ; each negative yields none
  and is counted — the callee that reads its own return address (named with the `tsx`'s
  address), the flags that are live and differ, the branch whose final target is 400 bytes
  out of reach, the loop body that reads its own index, the cell touched once, the two reads
  of `$D012` that are two reads on purpose.
* **§7.2** — the delay loop, the raster wait and the drive's byte-ready loop each contain a
  store/load pair that is a candidate anywhere else in the same program. None is proposed,
  all three are in the exclusion list with their own reason, and the rule that fired inside
  an excluded span is counted rather than silently skipped.
* **§7.3** — with the capture, 2 cycles in a routine that ran 5690 times outranks 9 cycles in
  one that ran exactly once (517.3 against 0.4 per frame). Without it the order flips, which
  is what the measurement is for. The hermetic half builds the same situation out of
  synthesised rows.
* **§7.4** — exact, twice. On the synthesised capture: 24 crossings, against the 24 the index
  values predict. On the real one: **13 656 cycles of page crossing measured by 861, 13 656
  reported as the gain**, and `loops × 24` from the index values agrees with both.
* **§7.5** — every file in the project is byte-for-byte what it was, and the graph's
  write-ahead log is empty afterwards. That second assertion is the sharper one: SQLite
  creates its `-wal` and `-shm` sidecars when a database is opened at all, read-only or not,
  so their appearance proves nothing — an empty log after the scan proves the scan did not
  write.
* **§7.6** — off, the undocumented class is not even counted; on, the LAX and DCP candidates
  appear with the same verdict every other rule gets.

**One correction the gates forced.** `count-down` asks whether the counter and the flags are
dead after the loop, and the first implementation asked what was live *after the branch*.
That set always contains the counter, because the branch's other successor is the loop head
and the loop head reads it — so the rule could never fire. The question it has to ask is what
is live on the way OUT: the live-in of the fall-through. Where the fall-through leaves the
scanned range the answer is unknown and the rule says so instead of assuming.

### §9.3 Left out, and why

* **A UI view**, as §6 says. The tool is the API, and the report is text a session reads.
* **Applying anything** (§1, §8). Nothing here writes a byte; `runtime_candidate_patch` is
  the door, and a human or an LLM walks through it on purpose.
* **Optimising across routines** — inlining, moving code, reordering — and compression or
  size-first rewrites, both out by §8.
* **Drive code**, by §3 and §8, and by 861 §9.1: the drive lane carries no opcodes, so there
  is nothing there to price even if it were in scope.
* **A `sax` rule** — §9.1 has the counter-example.
* **TRX64: no change.** 862 inherits 861 §5's proof; every number here comes out of the
  `instructions` and `bus_events` the runtime already records, and nothing was asked of it.
