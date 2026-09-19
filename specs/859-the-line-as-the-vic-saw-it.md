# Spec 859 — The line as the VIC saw it

**Status:** BUILT 2026-09-18 — built on `spec-843-inspect` (the owner's call: it belongs to
the frozen-screen inspector and ships with it), merged 2026-09-19, released in TRX64 0.8.0.
See §5.
**Repos:** TRX64 records (capability), C64RE shows (meaning).
**Number:** 859 (registry: `specs/README.md`).
**Origin:** the owner, 2026-09-18, on [vicspector](https://github.com/elysium64/vicspector)
(elysium64, MIT): *"eine solche Sicht wie vicspector, aber halt mit den echten Daten der
Emulation — Bombe!"*

vicspector draws one PAL raster line cycle by cycle — the VIC's two half-cycle accesses, BA and
AEC, sprite DMA, the internal counters — and a planner that places instructions on the line
and shows where the VIC stalls them. It is a MODEL: Bauer's article and Åkesson's chart,
computed. We have the chip. This spec draws the same picture from what the emulated VIC and
CPU actually did on a line of the frame on screen.

## 1. Decisions

**D1 — Measured, never modelled.** The view shows only records the core produced. No timing
model in C64RE, no second VIC anywhere (doctrine rule 1). vicspector's layout is the design
reference; its planner and its arithmetic are not ported.

**D2 — The frame on screen, verified.** The picture is `vic.displayed`, the last completed
frame. The live machine is not touched: a CLONE is restored from the latest ring anchor at or
before that frame's first cycle, replayed with the recorder on, and run past the next frame
start. Its freshly published `displayed` is then compared with the checkpoint's: equal means
the record is the frame on screen (`verified: true`); unequal is reported, not hidden (input
during the replay window is the usual cause). With no anchor that reaches back, the next
frame is recorded instead and labelled so.

**D3 — The recorder costs nothing when off.** Its hooks are compiled only into the VIC tick a
recording observer instantiates; the live path's `tick` has no recorder code. Armed only inside
the scratch replay.

## 2. Deliverables

**TRX64**
- `vic_line_trace.rs`: the per-cycle record — clk, logical frame/line, `$D012` line, cycle
  1–63; Φ1 access (idle / refresh / g / idle-g / sprite pointer / sprite data, sprite number,
  bank-absolute address, ROM flag, byte); Φ2 VIC access (c-access with address and byte,
  s-access with sprite number, blocked while AEC is still high); BA, AEC; bad line, idle,
  VC, VCBASE, RC, VMLI, sprite DMA and display masks, MC/MCBASE per sprite, main and
  vertical border flip-flops; the framebuffer column the cycle's draw produced. CPU side from
  the observer: every bus access of the cycle (read / write / fetch / dummy), and the
  instruction boundaries.
- `vic/line_trace { checkpoint_id, lines: [from, to] }` — the recorded frame is cached per
  checkpoint; later line requests answer from the cache.

**C64RE**
- The line view in the Inspect overlay: 63 columns, lanes for Φ1, Φ2, BA/AEC, CPU (instruction
  pills over their cycles; write, read, stall), sprite DMA 0–7, zones (border / display). Hover
  or click a cycle for the full record. The clicked pixel selects the line and its cycle.
  ±1 line, line number input.

## 3. Gates

- Core: the recorder's clk equals the machine's after a run; a bad line shows 40 c-accesses
  and 40 + 3 BA cycles; no CPU read lands in a BA-low cycle; the recorder off leaves the
  frame digest unchanged.
- Daemon: `vic/line_trace` on a booted machine returns 63 cycles per line, `verified: true`
  for a replay without input, and the live machine's clk is unchanged afterwards.
- C64RE: a smoke drives open → line_trace → the line shape against a sandbox daemon.

## 4. Not in this spec

- vicspector's planner (what-if placement) and the trick reference. They are models.
- NTSC. PAL/6569 only, as the core.

## 5. As built (2026-09-18)

**TRX64.** `vic_line_trace.rs` holds the record, the CPU observer and `record_frame`. The VIC
calls two cold hooks when `VicII::line_rec` is armed and the tick is `tick_g::<true>`: before the Φ1 fetch (the access it is
about to make — the g-access and idle-g addresses now come from helpers the fetch itself uses,
so recorder and chip cannot form different addresses — and whether the previous cycle's Φ2
sprite fetch took the bus), and at the end of the tick (BA, AEC, the c-access, counters,
borders, the framebuffer column the draw wrote). The recorder counts its own clock and
`record_frame` refuses a record whose clock ends anywhere but the machine's.

**The first cut cost 3 %.** Two `Option` tests per tick measured −4.4 / −2.3 / −1.2 / −4.4 %
against main (`bench_pure_headless`, four alternating pairs). The hooks are now behind a const
generic: `Observer::RECORDS_VIC` (false by default, true for `LineTraceObserver`, forwarded by
the daemon's tee) picks `tick_g::<true>` and `steal_cycles_g::<true>` at compile time, and the
live `tick` is `tick_g::<false>`. Re-measured: −1.1 / +0.7 / +0.1 / +1.1 % — noise.

Placing a CPU access on a cycle needs no model: an access stamped `clk` happens in the Φ2 of
the VIC tick that brought the machine to `clk`. A read never lands in a BA-low cycle — the gate
checks every cycle of a frame — and a BA-low cycle with no access is the CPU halted on a read.

`vic/line_trace` restores a CLONE of the machine from the latest ring anchor at or before the
first cycle of the frame on screen, records one frame, and compares the visible window of the
picture the replay publishes with the checkpoint's own framebuffer (not the clone's, which
keeps the live machine's where an anchor carries none). One frame is cached per checkpoint.
Without an anchor that reaches back it records the next frame and says so.

`vic_line_trace_gate`: the frame is 312 × 63 in order and the clocks agree; a text screen has 25
bad lines of 40 c-accesses, 40 g-accesses and 43 BA cycles with AEC three behind; sprite 0
takes BA in cycles 55–59 and its pointer in 58 (`$07F8`); no read under BA; recording changes
nothing the machine computes (RAM, both framebuffers, clk, raster); a replay from three frames
back verifies. Daemon test: the displayed frame verifies, the live clk does not move, the cache
answers the second line, bad parameters are refused.

**C64RE.** `VicLineView` under the node panel of the Inspect overlay, opened by a point click
on the line under the pointer, with the cycle that drew the clicked pixel selected. Lanes:
zone, Φ1, Φ2, BA, AEC, CPU (F/R/W, stalls hatched), code (instruction pills, IRQ sequences),
one lane per sprite that fetches on the line. The detail keeps a fixed set of rows so the panel
does not change height while the pointer moves (the owner's first remark in the live UI).
`runtime_vic_line_trace` is in DEFAULT_TOOLS. `npm run smoke:859`: 11 checks against its own
sandbox daemon.

The rebase itself found a defect in 843: the checkpoint did not round-trip D1's provenance
record (843 §5). Fixed on this branch; the 857 digests re-recorded after proving the only
change is that field. TRX64 pre-push gate GREEN (13 unit suites, daemon suite 388, 7-game 7/7).

Seen in the live workbench (Ultima VI project, READY screen): line 91 a bad line — BA 12–54,
c-accesses and AEC 15–54, the CPU halted 12–54, sprite pointers p3–p7 in cycles 1–10 and
p0–p2 in 58–62, refresh 11–15; the clicked pixel's cycle marked; `frame on screen ✓`.
