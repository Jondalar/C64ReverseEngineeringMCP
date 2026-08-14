# Spec 811 — The hardware bus stream as a second evidence source

**Status:** WEIRD IDEA — deliberately not PROPOSED. Nothing here is scheduled, nothing is
designed to the point of being buildable, and one load-bearing fact is still unknown (§6).
It is written down because the reasoning is worth keeping and because the idea collides
with binding doctrine in a way that deserves a considered answer rather than a reflex.
**Repos:** would be both — the capability (capture, ingest, emit) is TRX64's, the meaning
(the comparison, the first divergence, the acceptance) is C64RE's. Leitregel unchanged.
**Prerequisite:** a physical Ultimate 64. There is none here. Everything below is derived
from published sources, not from a device.

---

## 1. The idea in one sentence

A C64 Ultimate can stream **every CPU and VIC bus cycle** off the machine over the
network. If TRX64 could read that stream, real silicon becomes a reference we can diff
against — and if TRX64 could *emit* that stream, every tool written for the Ultimate's
debug stream would work against our emulator.

Neither half makes the Ultimate a runtime. That distinction is the whole spec.

## 2. Why this is not a second runtime, and why the question is fair

Binding rule 1 says C64RE has one runtime and no second implementation to A/B against.
`DOCTRINE.md` states what that rule is protecting:

> the failure this rule exists to prevent is debugging against the wrong machine, and two
> machines in one view is exactly how that happens

and the retired-oracle section adds the other half: two implementations **we maintain**,
with an authority question that kept getting answered by whichever was convenient.

A piece of hardware fails to be either of those things.

- **It is not an implementation.** We do not maintain it, it cannot drift toward us, and
  the question "which one is right" does not arise. Silicon is right; we are the thing
  under test. That asymmetry is structural, not a policy we have to keep enforcing — and
  it is exactly what TS-versus-VICE never had, because there both sides were ours and
  either was allowed to be the authority on a tired evening.
- **It cannot be a runtime for us even if we wanted it.** No rewind, no checkpoint
  restore, no overlay, no sandbox, no drive-to-state. Everything C64RE asks of a runtime —
  769, 787/788, 794, 795/796, 808, 809 — is unavailable on a real C64. It can do exactly
  one thing we cannot: produce cycle-accurate evidence from silicon.

So the honest category is **instrument, not machine**. The same shelf the VICE source tree
sits on: something you consult, never something you run against. Rule 1 stays intact; it
forbids a second path, not an oscilloscope.

**What would still need saying out loud** if this were ever built: a hardware trace answers
*"does our timing match"*. It never answers *"what does this code do"* — that stays a
reading question (rule 5). Without that line written into the tool itself, "just run it on
the U64" becomes the flight-to-the-runtime reflex with an authority bonus attached, which
is the precise failure the discipline architecture exists for.

## 3. The wire format, as published

From the Ultimate's own FPGA sources (`fpga/io/debug/vhdl_source/bus_analyzer_32.vhd`),
one 32-bit word per phi2 edge — so CPU cycles *and* VIC cycles:

```vhdl
vector_in <= phi2 & gamen & exromn & ba & irqn & rom & nmin & rwn & data & addr;
```

| Bit | Meaning |
|---|---|
| 31 | phi2 (1 = CPU half, 0 = VIC half) |
| 30 / 29 | GAME̅ / EXROM̅ |
| 28 | BA |
| 27 / 25 | IRQ̅ / NMI̅ |
| 26 | ROM̅ (= ROMLn ∧ ROMHn) |
| 24 | R/W̅ |
| 23–16 | data |
| 15–0 | address |

Transport is UDP, default multicast `239.0.1.66:11002`, stream #2. The selectable modes
(`software/io/network/debug_streamer_u2p.cc`) map onto the analyzer's enable bits — bit 0
CPU, bit 1 VIC, bit 2 drive, bit 3 IEC:

```
"6510 Only" "VIC Only" "6510 & VIC" "1541 Only" "6510 & 1541" "6510 w/IEC" "6510 & VIC w/IEC"
   0x01        0x02        0x03        0x04         0x05          0x09            0x0B
```

There is also an on-board recorder writing the same words to DRAM up to `0x1FFFFF4` —
about 8.4 M events, roughly four seconds at full rate. The long captures come from the
network stream, not from that buffer.

## 4. Direction A — hardware in

### 4.1 The cheap half: a trace

The stream is a bus-event list, and TRX64 already has a bus-event schema and a store for
it (726.B, 753 — exact effective address plus old value). **U64 stream → `.c64retrace`** is
a format match, not a stretch. `trace_store_*`, `trace_memory_map` and the swimlane would
then run over real hardware data without an emulator in the loop at all.

### 4.2 The interesting half: a seed, and then replay

A snapshot cannot be *read out of* a stream. The stream carries the bus; it does not carry
what stays inside a chip — the VIC's MCBASE, the SID's envelope phase, the CIA counters.
Same many-to-one wall as reverse emulation.

But the Ultimate's REST monitor (`doc/U64_Monitor.md`) supplies the missing start:

```
PUT  /api/v1/monitor/stop           freeze the CPU
GET  /api/v1/monitor/readmem        64 K by DMA off the stopped bus
     r                              CPU port $00/$01 + the stack area
     start the stream
PUT  /api/v1/monitor/start          resume; bus events from here
```

**The CPU registers are not in that API and do not need to be.** The monitor doc is
explicit:

> Die 6502-CPU-Register (A, X, Y, SP, PC, Flags) sind im FPGA-6502-Core intern und werden
> beim Stoppen der CPU nicht nach aussen exponiert.

They fall out of the stream instead, and more reliably than an API read would give them.
Every instruction fetch is visible (phi2 = 1, R/W = 1) and its address **is** the PC; the
opcodes and operands are on the same bus. SP appears at the first stack access — `$01xx`
is unmistakable — A/X/Y at the first transfer or store, and P from the arithmetic just
decoded. A handful of instructions resolves the set.

Seed plus forward stream, replayed into a TRX64 machine, and our own chips derive their
internal state the way they do in any other run. The ring falls out because the ring
records what our machine is doing. That is playback, not reconstruction — which is why it
can work at all.

### 4.3 Two wrinkles, neither of them cosmetic

**Banking.** `readmem` reads the **bus view**, and the doc says so: *"Der Monitor zeigt den
Speicher so, wie er ueber den C64-Bus sichtbar ist. Die Bank-Konfiguration ($01) bestimmt,
ob RAM, ROM oder I/O-Bereich gelesen wird."* A dump at `$01 = $37` hands you KERNAL and
BASIC, not the RAM underneath. Getting the real RAM means writing `$01`, dumping, and
writing it back — which perturbs the machine you were trying to hold still, and loses the
I/O register values at the same addresses. Tolerable for a debugging seed. Not tolerable
for something calling itself a faithful `.c64re`, and it should not be called one.

**No precise stop.** There are no breakpoints and no single step; the CPU stops wholesale.
So you halt *somewhere*, not *at a place*. For a first-divergence comparison both runs must
begin at the same instruction, so the anchor has to come out of the stream — the first
occurrence of a distinctive fetch sequence — and not out of the stop. Which is the
technique we already use, so this costs design, not fidelity.

## 5. Direction B — our stream out

Every field of that 32-bit word already exists on our side. Address, data and R/W are the
bus event; phi2 is CPU-versus-VIC; BA comes from the VIC (we already do BA-low stealing);
IRQ̅/NMI̅ are the lines; GAME̅/EXROM̅ come from `cart.get_lines()`; ROM̅ follows from the
memory configuration.

So TRX64 could emit the exact word to the exact multicast address, and a tool written for
an Ultimate would see one. Rate is about 2 M events/s × 4 bytes = 8 MB/s, the order of
magnitude the recorder was built for.

The value is not compatibility. It is that **a third-party visualiser rendering our stream
is a check nobody in our repos wrote.** If badlines land on the same cycles and sprite
pointers appear in the same slots as they do for real hardware, our VIC and bus timing has
been confirmed from outside. That is the kind of independent evidence that went away when
the oracle was retired, and nothing has replaced it.

## 6. What is not known

`fpga/io/debug/vhdl_source/eth_debug_stream.vhd` in the public tree is a stub, and says why:

> Because the Ethernet Debug streamer uses propriatary IP, this module is simply a dummy;
> indicating that it does not support this feature.

So the payload word is known exactly and the **framing is not**: whether a datagram carries
a header, a sequence number, a timestamp, how many words it holds. That is learned from a
capture — which needs a device — or by asking the people who wrote it.

Until then, §5 cannot be verified even if it were built, and §4 could only be tested
against a recording somebody else made.

## 7. Why this is worth writing down at all

Our gates test us against ourselves, so they cannot find an assumption we share with
ourselves. Both bugs found on 2026-08-14 were of exactly that kind and every gate we own
was green through both:

- **BUG-045** — `D64_TRACKS = 35`, a constant where the format allows 35 to 42. A 40-track
  release lost 85 blocks per disk into an unformatted track.
- **BUG-046** — the keyboard matrix modelled in one scan direction only, because "the
  KERNAL never drives PB columns". True of the KERNAL. A title that scans both ways
  received no keystroke at all, ever.

Neither was findable from inside. A hardware trace of the same software diverges at the
first `LDA $dc00`.

That is the entire argument, and it is not enough on its own to schedule the work — which
is why the status line says what it says.

## 8. If it ever stopped being a weird idea

Rough order, smallest useful thing first:

1. **Ingest a recording** (someone else's capture, no device needed): 32-bit words →
   `.c64retrace`. Proves the schema match and gives the store real data.
2. **Emit** (§5): TRX64 writes the same word format to a file, then to UDP. Verifiable
   against our own ingest before any hardware is involved.
3. **Seed + replay** (§4.2): the recipe above, producing a `.c64rering`. Needs a device.
4. **The comparison**: first divergence between a hardware trace and a TRX64 trace of the
   same start. C64RE-side, and the natural place for it is 810's acceptance — a hardware
   run is exactly the sort of thing a scenario gets accepted against once.

Steps 1 and 2 need no hardware and would settle whether any of it is real.
