# Spec 861 — The cost of a change: what it touches, what it costs, what it really costs

**Status:** BUILT 2026-09-20 — every deliverable, every gate. §9 records what it cost, and
the one derivation §5 said to stop on rather than work around.
**Repo:** C64RE only. **TRX64: no change** — §5 lists everything used and shows each is
already there.
**Number:** 861 (registry: `specs/README.md`).
**Depends on:** the graph (817–826), 842 D4 (the graph keys relocated code on its runtime
address), the sandbox (788), checkpoints. Uses 804's residency when that lands (§4.4).
**Origin:** the owner, 2026-09-19, as backlog ideas for the graph: *blast radius / impact
analysis of a change* and *deterministic optimisation assessments*. Then, on the second:
"ich wäre da rein im Code gewesen, gar nicht in der Runtime" — so the static half carries
it, and the runtime half is a trace that C64RE evaluates. And: "cool wäre, wenn es wirklich
KEINE Anpassungen braucht in TRX64."

---

## §1 Three questions, three instruments

| question | instrument | where |
|---|---|---|
| **Q1** What can this change break? | a walk over the graph | C64RE, static |
| **Q2** What does the code cost, and is the new version the same? | cycle table, control flow, liveness, symbolic execution | C64RE, static |
| **Q3** What does it cost on the machine — with the cycles the VIC takes, and how often it runs? | a trace TRX64 already records, evaluated in C64RE | TRX64 records, C64RE evaluates |

The doctrine's order holds: read first (Q1, Q2), run only to confirm and to measure what
reading cannot know (Q3). Finding candidates for an optimisation is a heuristic and stays
out (§6); **evaluating** a candidate is deterministic, and that is what this spec builds.

## §2 D1 — Impact of a change (`change_impact`)

**Input:** an address range, a routine id, or a candidate (796's patch: bytes at an address).
Relocated code is resolved through 842 D4, so a patch given in file coordinates hits the
runtime range it lands on.

**The walk** uses edges the graph already has:

- **who reaches it** — `CALLS`, `JUMPS_TO`, `BRANCHES_TO` (upstream, by depth);
- **who depends on what it writes** — `WRITES` from the changed range, then `READS` of those
  addresses elsewhere;
- **what points into it** — `REFERENCES_DATA` (jump and pointer tables — the dependency a
  call graph never shows);
- **what describes it** — its payload and model container (`CONTAINS`), documents whose
  `covers` include it (847), findings with an overlapping address range. Those claims may
  be false after the change and are listed as such;
- **what actually ran** — edges with `origin = runtime` mark "reached in a trace" against
  "reachable on paper".

**Output**, deterministic and ordered: depth 1 (will break), depth 2 (likely affected),
depth 3 (may need testing), then **UNKNOWN** as its own class, never folded into "low":
`JMP ($xxxx)`, RTS-tricks and computed returns, self-modifying code (a `WRITES` edge into a
code range), code on the other CPU (drive), and every address the graph cannot resolve. Plus
the claims that go stale. With Q2's liveness (§3.3) the result also names **what the change
must preserve**: the registers and flags live after the changed range.

**Timing is a direction of impact too.** When a Q3 measurement exists for the routine
(§4), the impact names the raster lines it runs in and its cycle budget there: a patch that
adds cycles inside a raster-timed routine is flagged with the line and the margin.

## §3 D2 — Static cost (`code_cost`)

Input: one range (cost) or two (a comparison: original and candidate).

### §3.1 A cycle table in C64RE

`pipeline/src/lib/mos6502.ts` decodes all 256 opcodes and knows no cycles. D2 adds, per
opcode: base cycles, whether an indexed read pays +1 on a page crossing, and the branch rule
(+1 taken, +1 more when the target is on another page). The undocumented opcodes are
included with their stable timings; `JAM` has none. The table is proved against the runtime
without touching it (§7.1).

### §3.2 Blocks, paths, loops

Per basic block: **bytes exact**, **cycles as a span** `[min, max]` — the only data-dependent
parts are the page crossing and the branch. Per path: sums of spans. A loop whose bound is a
constant is resolved — the pattern `LDr #imm … (DEr|INr) … Bxx` back to the head, with no
other write to `r` in the body — and its cost is exact up to the page crossings; any other
loop is reported per iteration with its bound marked unknown.

### §3.3 Liveness

For every instruction, which of A, X, Y and N, V, Z, C (plus D and I) are **live** afterwards,
over the control-flow graph. Conservative at every successor the graph cannot see
(RTS, `JMP (ind)`, self-modified code, an interrupt handler's exit): everything live. Q1 uses
it to say what a change must preserve; §3.4 uses it to decide equivalence.

### §3.4 Equivalence

For straight-line code, symbolic execution of both versions and a comparison of their
effects: A, X, Y, SP, the flags that are **live-out**, and every memory write (address and
value as expressions). Reads of addresses written inside the block are resolved; other reads
are symbols. **Any access to I/O (`$D000–$DFFF`) must be the same access in the same order**
— reading `$DC0D` clears the interrupt flags, and a reordering is a behaviour change. The
verdict is one of **EQUIVALENT**, **NOT EQUIVALENT** (with the differing effect as a
counter-example) or **UNKNOWN** (a loop, an indirect jump, self-modified bytes — named).

### §3.5 The verdict

Δ bytes, Δ cycles as a span, equivalence, and the liveness assumptions it rests on. Same
input, same answer.

## §4 D3 — Measured cost from a trace (`trace_cost`)

### §4.1 What the trace already carries (verified in TRX64, 2026-09-19)

- `instructions` (`trx64-traceindex/src/schema.rs:49`): per retired instruction `clock`, `pc`,
  `opcode`, `b1`, `b2`, `a`, `x`, `y`, `sp`, `p`.
- `clock` is the post-instruction cycle minus one on the default cycle-exact core
  (`trx64-core/src/full_sc.rs`, at the `on_instruction` call) — a constant offset, so the
  **difference between consecutive rows is the exact number of cycles the instruction took**,
  including every cycle the VIC stole from it.
- The registers are **post**-instruction (`trx64-core/src/lib.rs`, `Observer::on_instruction`),
  so the previous row holds this instruction's **pre**-state. `p` has N/Z masked out — not
  needed here.
- `bus_events` with the `mem` channel: the READs and WRITEs with address, value, pc and clock.
- **Not** in the trace: interrupts (`on_interrupt` is a no-op in the trace sink,
  `trx64-trace/src/lib.rs:515`), and VIC events (the encoder exists, but nothing writes them:
  "RESERVED in practice", `lib.rs:203-211`). Both are derived instead (§4.2).

### §4.2 The arithmetic, per instruction instance

- **measured** = Δclock.
- **static, exact:** the table (§3.1). The page crossing is exact for `abs,X`/`abs,Y` (the base
  is the operand, the index is the pre-state) and for `(zp),Y` from the traced read of the
  pointer; without that read it is a span. Branch taken and its page crossing follow from the
  next row's `pc`.
- **interrupt entry:** recognised from the traced reads of the vector (`$FFFE/$FFFF`,
  `$FFFA/$FFFB`) and the three stack writes; its 7 cycles belong to the entry, not to the
  instruction before it. Fallback, if the vector reads turn out not to be traced (§7.3 decides
  which): the next `pc` is not a successor of the previous instruction, and the stack pointer
  dropped by 3.
- **stolen** = measured − static − (7 on an interrupt entry). On the drive CPU there is no DMA,
  so stolen must be 0 — a free consistency check.
- **raster position:** the capture starts at a frame boundary (`session/advance_to_frame`,
  which stops on raster line 0); that clock is the anchor, and PAL is 63 cycles × 312 lines.

### §4.3 What it reports

Per routine: cycles per call (measured and static), stolen cycles and where (bad lines,
sprite DMA), calls per frame, share of the frame. Per raster line: the cycles a routine
occupies, which is what §2's timing impact reads.

### §4.4 Which routine a pc belongs to

Where one payload covers the address, the routine is the graph's. Where several could
(multiload, banked carts), residency decides — 804's byte-match when it has landed; before
that the row is attributed only where it is unambiguous, and the rest are counted as
**unattributed**, never guessed.

### §4.5 Capture

A sandbox run (788) from a checkpoint: advance to a frame boundary, record with the `cpu` and
`mem` channels for the window the caller names (frames, or a scenario from 812/814), finalize
into the trace store. The window is the caller's choice; the capture records all of it and
filters on query (doctrine rule 4). No new TRX64 operation.

## §5 Why TRX64 needs no change

Used, all existing: the trace store's `instructions` and `bus_events`; sandbox runs;
checkpoints; `session/advance_to_frame`; `vic/line_trace` (859) as an independent cross-check
in §7.2 only.

Deliberately **not** asked of TRX64: interrupt rows in the trace (derived from the vector
reads), VIC events in the trace (the anchor replaces them), the fetch clock, an exported
cycle table (proved against the runtime instead). **If a gate shows that one of the
derivations cannot be made, the build stops and names the smallest TRX64 change instead of
working around it** — a workaround here would be a second, silent model of the machine.

## §6 Scope

- **PAL** (6569): 63 × 312. NTSC later, as everywhere.
- **1 MHz.** A turbo profile (851) keeps `clk` as the PHI2 clock, so several instructions share
  a cycle and Δclock stops meaning "cycles taken". Out of scope.
- **Not in this spec:** generating optimisation candidates (hot spots, JSR+RTS→JMP and the
  like — heuristics; a later spec may feed them in); applying a patch (796/797 do that);
  equivalence across loops or calls; NTSC; turbo.

## §7 Acceptance

Every fixture is built through the product's own doors (sandbox runs of small programs,
`save_finding`, `disasm_prg` with annotations, `doc_register`), so the gates run in CI.

1. **The cycle table, proved by the runtime.** A program runs every documented opcode and
   addressing mode, and the stable undocumented ones, with the display off (`$D011` bit 4 = 0:
   no bad lines, no sprites). For every traced instance, measured == static and stolen == 0.
2. **Stolen cycles land on bad lines.** The same program with the display on: stolen cycles
   appear only on bad lines, and their count per line matches `vic/line_trace` (859) for that
   frame.
3. **Interrupts.** A raster-IRQ program: every handler entry is recognised, its 7 cycles are
   attributed to the entry, and no instruction before an entry shows phantom stolen cycles.
   This gate also settles whether the vector reads are traced (§4.2's fallback).
4. **Raster anchor.** A `STA $D020` at a known raster position is placed on that line and
   cycle by §4.2's anchor, and agrees with 859's record of the same frame.
5. **Impact.** A patch in routine R lists R's callers at depth 1, the readers of the bytes R
   writes, the pointer table pointing into R, the document covering R and the finding on R. A
   `JMP ($xxxx)` in the chain yields UNKNOWN, not low.
6. **Equivalence with liveness.** `LDA $10 / CLC / ADC #$01 / STA $10` against `INC $10`: NOT
   EQUIVALENT (A, C and the flags differ); the same pair where A, C, N, V and Z are dead
   afterwards: EQUIVALENT. A pair that reorders a read of `$DC0D`: NOT EQUIVALENT.
7. **Static loop bounds.** `LDX #$27 / loop: … / DEX / BPL loop` resolves to 40 iterations,
   and the cost matches the measured cost of the same code in gate 1's conditions.
8. **Drive CPU.** A drive-code window: stolen == 0 for every instance.

## §8 Surface

Three MCP tools, API first (doctrine rule 6): `change_impact`, `code_cost` (one range, or two
to compare), `trace_cost`. A UI view is a later step on top of them.

---

## §9 As built (2026-09-20)

**D1 `change_impact`** — `src/cost/impact.ts`. The walk is upstream by depth over `CALLS`,
`JUMPS_TO`, `BRANCHES_TO`, plus `REFERENCES_DATA` into the range at depth 1 and the readers
of what the range writes at depth 2 (`WRITES` out, then `READS` of those cells). Documents
whose `covers` overlap and findings whose address range overlaps are listed as claims that
may be false afterwards. An edge with `origin = runtime` is marked "seen in a trace".
UNKNOWN is its own class: an indirect jump, a computed return, an `rti`, a write that lands
inside the range, the drive's CPU, and every node the graph could not resolve.

What the change must preserve composes 826 and §3.3 rather than choosing between them: the
routine's computed signature is what its caller expects at the return, and liveness carries
it backwards to the end of the changed range. With no signature it stays conservative and
says so.

**Two gaps had to be closed before the walk could answer**, and both were in what the graph
records rather than in the walk:

* A `jmp ($xxxx)` produces no edge at all — 819 D3 deliberately emits none, because the
  operand is a pointer and not a target. So 819 now records `unresolved_exits` on the
  routine (the indirect jumps, the `rti`s, and an `rts` reached with two more pushes than
  pulls — the RTS-trick, counted rather than guessed). Without it "no outgoing edge" read as
  "goes nowhere", which is the reading that turns an UNKNOWN into a low.
* The pointer xrefs a detected pointer table produces were being dropped. `resolveSegments`
  kept an xref only when its TARGET fell inside the slice — right for code, backwards for a
  pointer, whose SOURCE is the cell. Both readers of them (820 D5's `REFERENCES_DATA` and
  the relation import) take the source as the segment's own address, so a table with eight
  targets produced no edge into any of them. Only `pointer` is widened; code xrefs keep the
  rule they had.

**D2 `code_cost`** — `src/cost/{cycles,cfg,liveness,symbolic,code-cost}.ts`. The cycle table
is one grid of sixteen rows of sixteen in `pipeline/src/lib/mos6502.ts`, and the same grid
in `src/cost/cycles.ts` because ESM and CommonJS cannot import each other here;
`npm run check:cycle-table` reads the literal out of both and fails on any difference, which
is the gate the duplicated opcode table never had. Blocks carry exact bytes and a cycle span
whose only width is the page crossings and the branches. A resolved loop is costed exactly:
the back edge is charged taken n−1 times and not-taken once, and where the indexed read uses
the counter the crossings are counted rather than left open — which is what makes
`ldx #$27 … dex / bpl` 567 cycles rather than 528–648.

Equivalence executes both versions symbolically and compares A, X, Y, the stack delta, every
memory cell either writes, the flags that are live, and every access to $D000–$DFFF **in
order**. A volatile read is its own symbol per address per occurrence, so two versions that
make the same accesses in a different order come out NOT EQUIVALENT on the order, which is
the thing that matters. Decimal is taken as clear at entry (a block that sets it is modelled
as it is) and the verdict says so; that is what lets `clc / adc #$01` and `inc` reach the
same expression.

**D3 `trace_cost`** — `src/cost/{trace-cost,trace-store-read,capture,routine-spans}.ts`.
Rows are grouped by `seq`, not by a clock window: the trace is one ordered stream, so a
retired instruction's own accesses — and any interrupt dispatch that ran before it — are
exactly the events between the previous CPU row and this one. The capture is a sandbox run
with `afterSteps`, because the load is almost never what is being measured (recording it
cost 12 million events against 47 thousand). The anchor is written into the store as a mark
(`861-anchor line=… cycle=… cpl=… lpf=…`) and read back out of it, so a store carries its
own frame origin. The raster cycle is reported 1..63, the way a VIC-II chart, vicspector and
859 number it; the runtime's own raster counter is 0-based, and the difference was measured
against 859 on one machine with one store visible in both records rather than reasoned
about. Per-line occupancy is split across the lines an instruction actually ran on; stolen
cycles stay on the line it retired on, because a bad line stretches the instruction it
interrupts.

**Gates.** `check:cycle-table`, `e2e:861-static` (33/33) and `e2e:861-impact` (20/20) are
hermetic and in CI. `smoke:861` (40/40) runs the real runtime, on sandboxes and a reader
daemon of its own — the shared machine is never addressed.

* §7.1 — 244 opcodes (the twelve JAMs excepted: a JAM never retires), 47 379 instances,
  137 591 cycles measured against 137 591 from the table, stolen 0. All 32 opcodes that pay
  for a page crossing were run across one; all 8 branches were taken across one.
* §7.2 — the same bytes with the display on: 1075 stolen against 1075 cycles the CPU did not
  have in 859's record of THE SAME FRAME, 25 bad lines at 43 each, and every line with a
  stolen cycle is a line 859 calls a bad line.
* §7.3 — six entries in six frames, all six recognised from the traced vector reads: §4.2's
  fallback is never needed, which settles the question §4.2 left open. The 7 cycles are the
  entry's and no instruction before one shows phantom stolen cycles.
* §7.4 — the `sta $D020` lands on line 100, cycle 13, and 859 says line 100, cycle 13.
* §7.7 — 567 measured for the loop the static gate prices at 567.
* §8 — the three tools over MCP against the stores the gates recorded, including
  `trace_cost` recording its own capture.

### §9.1 §7.8 cannot be derived, and §5 says to stop rather than work around it

**The gate asked for:** a drive-code window, stolen == 0 for every instance, because the
drive has no DMA.

**Why it cannot be answered.** The drive lane is not an instruction stream. The drive's 6502
runs with a null sink; its program counter is SAMPLED at each C64 instruction boundary and
deduplicated (`Machine::sample_pc_change`), and the record carries no opcode —
`write_drive_cpu_step` writes a zero with the comment *"opcode: not observable in sampled
mode"*. Several drive instructions pass between two rows, so Δclock is not an instruction's
cycles, and with no opcode there is nothing to price against. §4.1's description of the
`instructions` table is true of the C64 lane and not of this one.

**What was done instead of a workaround.** `evaluateTrace` refuses a lane whose rows carry
no opcodes: no totals, no stolen figure, and the reason plus the change printed in its
place. `trace_cost` refuses it the same way through the tool, and `smoke:861` asserts the
refusal. Priced anyway — which is what it did first — the 1541's ROM came back as a stream
of BRKs with **minus 1 227 148 stolen cycles**: a number that looks like an answer, which is
the outcome §5 exists to prevent.

**The smallest TRX64 change that would make §7.8 answerable:** one row per RETIRED drive
instruction carrying its opcode and operand bytes. The record format already has every field
(`pc`, `opcode`, `b1`, `b2`, `a`, `x`, `y`, `sp`, `p`, `clk`) and the reader already projects
them as `cpu='drive8'`; only the producer is missing — the drive core calling the same retire
hook the C64 core calls, instead of the run loop sampling its PC. Nothing in this spec would
change: same table, same arithmetic, same `cpu` parameter. Until then the refusal stands, and
it is a better answer than a number.

### §9.2 Left out, and why

* **NTSC and turbo** stay out, as §6 says. The arithmetic reads the machine's own
  `cyclesPerLine` / `linesPerFrame`, so a capture on another model is evaluated on its own
  geometry; only the gates are PAL.
* **Equivalence across a loop or a call** stays out (§6). Both answer UNKNOWN with the reason
  named.
* **Finding optimisation candidates** is 862, and nothing here proposes one.
