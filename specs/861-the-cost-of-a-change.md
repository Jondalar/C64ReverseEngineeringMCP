# Spec 861 — The cost of a change: what it touches, what it costs, what it really costs

**Status:** READY (2026-09-19)
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
