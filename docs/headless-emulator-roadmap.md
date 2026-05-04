# Full Headless TS C64 + 1541 TrueDrive Roadmap

## Intent

Build a full TypeScript C64 + 1541 emulator that is useful without a
GUI:

- deterministic CLI/MCP sessions for LLM-driven reverse engineering
- inspectable state at CPU, memory, VIC, CIA, SID, IEC, drive, and disk
  layers
- scriptable input and breakpoints
- visual render artifacts when needed
- full C64 hardware behavior, except actual sound output
- full 1541 TrueDrive behavior for D64/G64 media, including real drive
  ROM execution, IEC protocol, GCR rotation, drive CPU/VIA timing, and
  write-back

This is not a reduced loader harness. It is a headless emulator. VICE
remains the external oracle and human-facing fallback while this runtime
catches up, but the target state is that VICE is no longer needed for
normal autonomous analysis runs.

The only explicit non-goal is audio output. SID register behavior,
readback, timers/envelopes/oscillator state relevant to software, and SID
write tracing are still in scope. Generating audible WAV/audio is not.

## Current State

The project has already crossed several important thresholds:

- C64 cold boot reaches BASIC in microcoded + lockstep mode.
- Keyboard typing works end-to-end.
- C64 CPU has an equivalence harness against the legacy core.
- Integrated C64+1541 lockstep exists.
- G64 sessions default to cycle-lockstep + microcoded CPU.
- Drive CPU can use the microcoded core for sub-instruction bus access.
- IEC LISTEN/SECOND/NAME transfer works far enough for real-serial LOAD.
- GCR has a free-running bit-level shifter and byte-ready/SO wiring.
- Maniac Mansion `LOAD"MM",8,1` transfers 38658 bytes byte-perfect.

Current blocker:

- Bug 40: after successful LOAD and EOI detection, C64 KERNAL remains in
  ACPTR/EOI retry instead of returning cleanly to BASIC/direct mode.

Do not touch:

- `src/disk/g64-parser.ts` unless a parser-specific regression is proven.
- KERNAL serial/file traps as a success path for TrueDrive acceptance.
- game-specific PC traps.

## North Star

Two goals drive the roadmap:

1. A full TS C64 emulator for CLI/LLM use, excluding only sound output.
2. A full 1541 TrueDrive implementation comparable to VICE for real disk
   behavior, including G64 custom loaders and write-back.

The work should be cut into small stories that each create a regression
artifact or a tool an agent can reuse.

## Milestone 0 — Finish Real LOAD Control Flow

Goal: real KERNAL LOAD returns to a usable C64 state without traps.

Stories:

- **M0.1 Bug 40 EOF trace**
  Capture drive PC, C64 PC, IEC lines, `$90`, `$A5`, drive channel state,
  and TALK/UNTALK state from the last data byte through return to idle.

- **M0.2 VICE EOF comparison**
  Capture the same end-of-file window in VICE and align on the last data
  byte / EOI signal. Record the first behavioral divergence.

- **M0.3 EOI/TALK fix**
  Fix whichever side is wrong:
  drive failing to send the EOI byte frame, C64 retry loop timing, TALK
  cleanup, UNTALK handling, or ATN ACK state.

- **M0.4 LOAD acceptance smoke**
  Add a stable smoke command that proves:
  `LOAD"*",8,1`, `LOAD"MM",8,1`, and a small synthetic one-block file
  return to BASIC with the expected status and bytes in RAM.

Acceptance:

- no `?DEVICE NOT PRESENT`
- no `?LOAD ERROR`
- `$90` ends as EOI-only or clean status according to KERNAL path
- C64 leaves `$EE00` retry area
- drive remains ready for the next command

## Milestone 1 — Emulator Core Contract

Goal: make the runtime a coherent emulator API, not a pile of sprint
debug hooks.

Stories:

- **M1.1 Session modes**
  Define explicit modes:
  `fast-trap`, `real-kernal`, `true-drive`, `debug-vice-compare`.
  Tool output must always report the active mode.

- **M1.2 Unified stepping**
  Provide clear APIs for:
  `step_cycles`, `step_instructions`, `run_until_pc`,
  `run_until_raster`, `run_until_iec_event`, `run_until_stable_screen`.

- **M1.3 Deterministic reset profile**
  Standardize PAL/NTSC, RAM init pattern, ROM set, joystick state,
  keyboard buffer, disk motor/head state, and drive RAM reset.

- **M1.4 Structured state snapshots**
  One JSON snapshot shape for CPU, memory banks, VIC, CIA1/2, SID, IEC,
  drive CPU, VIA1/2, GCR head, disk, keyboard, joystick, and traps.

- **M1.5 Regression harness**
  Add a compatibility matrix runner that records pass/fail plus artifacts
  for each target disk/PRG/CRT.

Acceptance:

- an agent can start a session, run it, inspect every subsystem, and
  reproduce the same result from the same inputs.

## Milestone 2 — Full C64 Hardware Fidelity

Goal: emulate the C64 machine completely enough that software cannot
tell it is running in a reduced runtime. The only excluded surface is
actual audio output.

Stories:

- **M2.1 CPU cycle and interrupt fidelity**
  Harden documented and stable undocumented opcodes, IRQ/NMI timing,
  BRK/RTI/RTS/JSR stack behavior, RDY/stall behavior, and per-cycle bus
  accesses.

- **M2.2 CIA1/CIA2 fidelity**
  Complete timers A/B, TOD clock, serial/shift behavior, ICR/IER
  edge cases, keyboard matrix, joystick ports, IEC-facing CIA2, NMI
  behavior, and timer interactions used by KERNAL serial and games.

- **M2.3 VIC-II fidelity**
  Raster counter, badlines, sprite DMA, sprite priority/collision,
  border behavior, text/bitmap/multicolor/ECM modes, raster IRQ timing,
  open-border tricks, and mid-frame register writes.

- **M2.4 PLA and memory bus fidelity**
  `$00/$01` CPU port, RAM/ROM/I/O banking, color RAM, char ROM access,
  Ultimax, EXROM/GAME, open bus behavior, and cartridge interaction.

- **M2.5 Input fidelity**
  Keyboard, joysticks, RESTORE/NMI, key debounce, typed text macros, and
  frame/cycle scheduled input playback.

- **M2.6 SID software-visible behavior**
  SID registers, readable oscillator/noise/envelope behavior, ADSR timing
  relevant to polling loops, and write tracing. No sound output required.

Acceptance:

- BASIC/KERNAL behave normally under typed commands.
- raster IRQ games and sprite-heavy screens reach stable visual states.
- cart, PRG, D64, and G64 boot paths share the same C64 core.
- no acceptance item depends on audible output.

## Milestone 3 — Full 1541 TrueDrive

Goal: emulate the 1541 as a real drive, not as a file provider. Real
KERNAL serial, drive ROM, VIA timing, GCR rotation, head movement,
read/write behavior, and custom loaders must work without traps.

Stories:

- **M3.1 Drive CPU microcoded hardening**
  Keep drive on microcoded sub-instruction access. Add drive-specific
  CPU equivalence fixtures around IRQ, SO/V flag, indexed addressing,
  stack, and undocumented opcodes seen in drive code.

- **M3.2 VIA1 IEC contract**
  Lock down line polarity, CA1 ATN edge behavior, PB4 ATN_ACK, device ID
  jumpers, IRQ timing, and read/write side effects with synthetic tests.

- **M3.3 KERNAL serial byte matrix**
  Test LISTEN, UNLISTEN, TALK, UNTALK, SECOND, TKSA, CIOUT, ACPTR, EOI,
  timeout, and retry paths against synthetic drive states.

- **M3.4 D64 file path**
  Ensure standard D64 directory/file loading uses the same true-drive
  path where possible, not a trap path. Keep fast direct extract as a
  separate analysis helper.

- **M3.5 G64 GCR shifter fidelity**
  Harden bit-level rotation, sync detection, byte-ready/SO, density
  zones, motor on/off, head stepping, half-track behavior, and write
  protect.

- **M3.6 Write support**
  Verify SAVE, scratch/rename/write-back basics and persist modified G64
  tracks without mutating the original image.

- **M3.7 Multi-drive shape**
  Model drive 8-11 cleanly. Drive 8 can land first, but the architecture
  must not assume a single drive forever.

- **M3.8 Drive fidelity backlog**
  Cover the remaining true-drive details explicitly: motor spin-up/down,
  density-bit override, track zero/stop behavior, half-track reads,
  open-bus behavior, VIA shift-register modes, timer edge cases, SO pin
  behavior, write splice behavior, and disk-change semantics.

Acceptance titles:

- synthetic LISTEN/SECOND/NAME/EOI
- standard D64 one-file LOAD
- Maniac Mansion side 1 boot file and `MM` file
- Murder on the Mississippi boot
- Impossible Mission II / Last Ninja Remix first load

## Milestone 4 — Visual Runtime

Goal: make the emulator visually useful to an LLM.

Stories:

- **M4.1 Stable framebuffer API**
  `headless_render_screen` returns PNG plus VIC mode metadata and source
  memory ranges.

- **M4.2 VIC timing baseline**
  Raster counter, badlines, sprite DMA, IRQ timing, border state, and
  mid-frame register writes need known limitations and tests.

- **M4.3 Screen-state query**
  Provide text/screen RAM/PETSCII extraction, color RAM summary, sprite
  positions, bitmap mode state, and dirty regions.

- **M4.4 Input macros**
  Typed text, joystick scripts, key holds, frame-based input playback.

- **M4.5 Visual acceptance**
  For each target game, store a small expected-state artifact:
  "BASIC READY", "searching/loading", "title screen", "first gameplay".

Acceptance:

- MM title/character-select screen can be rendered as an artifact.
- visual state can be queried without relying only on screenshots.

## Milestone 5 — LLM-Oriented Debugging

Goal: make the emulator explainable and easy to drive from tools.

Stories:

- **M5.1 Trace channels**
  Separate CPU, memory, IEC, drive PC, GCR, VIC, CIA, SID, keyboard,
  joystick traces. Ring buffers for live use, JSONL for persisted runs.

- **M5.2 Event-indexed search**
  Search by PC, address read/write, IEC edge, raster line, IRQ, drive
  command, GCR sync, byte-ready, and screen change.

- **M5.3 VICE swimlane**
  Keep headless-vs-VICE trace alignment as a first-class command. Every
  compatibility bug should end with a small divergence artifact.

- **M5.4 Scenario DSL**
  YAML/JSON scenario files:
  media, reset mode, typed input, joystick script, breakpoints, run
  limits, expected state, artifacts to emit.

- **M5.5 Knowledge integration**
  Every diagnostic run registers artifacts and can emit findings/tasks
  into project knowledge.

Acceptance:

- Claude/Codex can run one command and get a precise "next divergence"
  artifact instead of manually reading console logs.

## Milestone 6 — Cartridge and Expansion Coverage

Goal: make non-disk C64 software boot paths reliable.

Stories:

- **M6.1 PLA truth-table tests**
  Verify RAM/ROM/I/O/cart banking for normal, Ultimax, EXROM/GAME, and
  C64 port `$00/$01` cases.

- **M6.2 CRT runtime mappers**
  Implement and test priority cart types: 8K/16K, Ocean, Magic Desk,
  EasyFlash, GMOD, Megabyter, C64MegaCart.

- **M6.3 Cart debug tools**
  Report cart type, active bank, EXROM/GAME state, mapped ranges, and
  bank-switch writes.

Acceptance:

- representative CRTs boot to first visible screen.
- disk + cart combinations do not regress disk loading.

## Milestone 7 — SID Behavior Without Audio Output

Goal: emulate SID behavior that software can observe, while explicitly
excluding actual sound output.

Stories:

- **M7.1 SID register and readback model**
  Stable read/write behavior, oscillator/noise readback, paddle read
  behavior where relevant, ADSR state, envelope counters, and timing
  enough that polling code behaves correctly.

- **M7.2 SID trace**
  Log SID writes with PC/cycle attribution and identify music init/play
  routines.

- **M7.3 No-audio boundary**
  Document the boundary clearly: no speaker/audio stream/WAV output is
  required for the headless emulator. SID state and traces remain
  queryable.

Acceptance:

- games polling SID do not hang.
- agents can identify active music/SFX routines from traces.
- no acceptance item requires audible output.

## Milestone 8 — Performance and Operations

Goal: make long headless runs practical.

Stories:

- **M8.1 Run budgets**
  Clear cycle/instruction/frame budgets with partial results.

- **M8.2 Snapshot/resume**
  VSF or internal snapshots for C64 + drive + disk head + traces.

- **M8.3 Fast-forward safe paths**
  Safe idle-loop skips only when proven not to change externally visible
  state. Never hide timing bugs in TrueDrive mode.

- **M8.4 CI profile**
  Small synthetic tests in CI, sample game tests skipped unless local
  samples exist.

Acceptance:

- a 100M-cycle run is debuggable, cancellable, and produces useful
  artifacts.

## Story Cutting Rules

Use these rules when turning this roadmap into specs and sprints:

- One story must produce one reusable command, tool, or regression
  artifact.
- Do not combine a probe and a fix unless the fix is trivial.
- Prefer synthetic tests for protocol invariants, sample games for
  acceptance.
- Every emulator compatibility bug should name the exact subsystem it
  exonerates and the exact subsystem it implicates.
- Keep trap-based helpers as analysis tools, not acceptance paths.
- Update `BUGREPORT.md` only for bugs; update this roadmap when the
  compatibility ladder changes.

## Compatibility Ladder

Use this as the long-term acceptance ladder:

1. C64 cold boot reaches BASIC READY.
2. Typed BASIC commands execute.
3. PRG injection and direct SYS work.
4. CRT boot works for simple cartridges.
5. Real KERNAL `LOAD"*",8,1` works from D64.
6. Real KERNAL `LOAD"*",8,1` works from G64.
7. Real KERNAL file load returns cleanly after EOI.
8. Maniac Mansion boot file loads and starts.
9. Maniac Mansion `MM` file loads and starts.
10. Maniac Mansion reaches title/character-select.
11. Murder, Last Ninja Remix, and Impossible Mission II reach first
    interactive state.
12. Custom fastloaders and drive-code uploads work without traps.
13. Raster/sprite-heavy demos render acceptably.
14. Save/write-back scenarios persist correctly.
