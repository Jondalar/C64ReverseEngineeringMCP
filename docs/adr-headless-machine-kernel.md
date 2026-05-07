# ADR / Spec: Headless Machine Kernel

**Status:** Accepted (2026-05-06). Amended 2026-05-06 with Pi1541
architecture lessons. Binding for all V1/V2/V3 emulator-core work.
Supersedes `docs/headless-core-synchronization-refactor.md` and the legacy
Sprint 112/113 spec slate (specs 137-153). Spec cut lives in
`EPIC_ROADMAP.md`.

**Date:** 2026-05-06

**Scope:** C64RE V1, V2, and V3 runtime architecture.

**Decision:** Build one central, VICE-compatible machine kernel. The
kernel owns time, cross-domain synchronization, bus events, chip wiring,
trace emission, and compatibility-hook reporting. `IntegratedSession`
becomes a session facade, not the emulator core.

## 1. Product Goals This Kernel Must Serve

### V1.0 - Full Headless C64 + 1541 Emulator

V1 needs a real emulator, not a loader harness:

- full C64 behavior except audible sound output
- full 1541 TrueDrive for D64/G64 through real drive ROM
- IEC, VIA, CIA, GCR, CPU, VIC, SID-visible state, PLA, input, reset,
  snapshots, traces
- no KERNAL serial/file traps as acceptance path
- commercial games with custom loaders must boot through the same core

Implication: the kernel must be accurate enough for timing-sensitive
custom IEC fastloaders. Passing simple KERNAL `LOAD` is not sufficient.

### V2.0 - LLM Reverse-Engineering Workbench

V2 needs the emulator to be queryable by agents:

- deterministic replay
- structured snapshots
- event-indexed traces
- follow-a-path tracing
- runtime evidence linked to disassembly and project knowledge
- first-divergence comparison against VICE while VICE remains oracle

Implication: the kernel must emit canonical events. Debugging cannot
depend on ad hoc scripts reading random internal fields.

### V3.0 - Human C64RE UI

V3 needs the same runtime to drive a human UI:

- live C64 screen
- keyboard and joystick emulation
- media selection
- monitor/debugger
- SID playback and export as UI features
- screenshots, video, audio export

Implication: there must not be a second UI emulator path. The UI is a
client of the same kernel used by CLI/MCP/LLM.

## 2. Problem Statement

The current implementation has many good chip-level pieces, but the
core integration is still historically layered:

- `IntegratedSession` wires almost every subsystem directly.
- The scheduler still has lockstep, probe, and disabled-drive variants.
- IEC has VICE-style cached state, but C64-side flush is not active in
  lockstep production mode.
- Drive execution can happen through per-cycle scheduler ticks or
  `executeToClock`.
- Rescue hooks and trap paths still exist near the hot path.
- Some comments say "1:1 VICE" while the actual composition is not 1:1.

This is enough to pass standard KERNAL `LOAD` smokes. It is not enough
for multi-stage custom fastloaders where one wrong `$1800` or `$DD00`
sample changes the whole control flow.

The core issue is not TypeScript. A synchronous Node process can behave
like one native emulator binary. The issue is that the runtime does not
yet have one authoritative machine-kernel contract.

### 2.1 External Reference: Pi1541

Pi1541 is a useful behavioral and architectural reference:

- upstream: <https://github.com/pi1541/Pi1541>
- role: cycle-sensitive 1541 emulator attached to a real C64 over GPIO
- license: GPLv3, therefore reference only; do not copy source into this
  MIT project

Pi1541 is not the same product as C64RE. It does not emulate the C64
side. It emulates a 1541 device that must satisfy a real C64's IEC
timing. That makes it especially useful for V1 TrueDrive work.

Relevant lessons:

1. A working 1541 emulator is one tight synchronous loop, not several
   loosely connected services. The loop samples IEC, advances the drive
   CPU, updates VIA/disk/mechanics, and applies real-time pacing in a
   fixed order.
2. The disk side is hardware behavior, not "return next GCR byte". Motor,
   density, head movement, write-protect, byte-ready, SYNC, SO/V flag,
   and shift-register phase are coupled.
3. IEC is not three plain booleans. Direction bits, line drivers,
   ATNA/ATN gating, drive VIA1 port readback, and CA1 edge signaling are
   one hardware boundary.
4. Reset order is observable. VIA input defaults, drive state, IEC state,
   and CPU reset must be initialized by one owner.
5. CPU and VIA timing are per-cycle concerns. Whole-instruction execution
   plus approximate cycle accounting is not enough for 1541 firmware and
   custom loaders.

These lessons do not replace VICE as the compatibility oracle. They
support the same conclusion: C64RE needs a central machine kernel with
explicit clock domains and bus events.

## 3. Architecture Decision

### Decision A: One Machine Kernel Owns Time

There must be exactly one production owner of time:

```ts
interface MachineKernel {
  c64Clock(): number;
  driveClock(device: number): number;

  runCycles(cycles: number): RunResult;
  runUntil(predicate: KernelPredicate, budget: RunBudget): RunResult;
  stepInstruction(side: "c64" | "drive", device?: number): StepResult;
  stepFrame(): FrameResult;

  snapshot(): MachineSnapshot;
  restore(snapshot: MachineSnapshot): void;

  mountMedia(slot: MediaSlot, media: MountedMedia): void;
  queueInput(input: InputEvent): void;

  trace(): KernelTraceController;
  status(): KernelStatus;
}
```

`IntegratedSession`, MCP tools, CLI scripts, tests, and UI must call the
kernel. They must not manually tick chips or call peer components.

### Decision B: Production Synchronization Is VICE-Style Event/Catch-up

Production TrueDrive mode must use VICE-compatible observable semantics:

1. C64 CPU advances in its clock domain.
2. Drive CPU advances in its own clock domain.
3. The drive may lag between cross-domain events.
4. On C64-side IEC access, the kernel catches the drive up to the
   corresponding C64 clock before the access is observed.
5. On drive-side IEC access, the kernel provides the bus state produced
   by the last authoritative cross-domain update.
6. IEC ports are cached and updated through explicit bus mutations, not
   recomputed through arbitrary live object getters in the hot path.

The production target is not "physical wires in abstract". The target
is VICE-compatible behavior first, because VICE is the working oracle.
Pi1541 is a secondary reference that validates the same shape from the
real-device side: tight ordering, explicit line direction, per-cycle VIA
behavior, and hardware-like GCR side effects.

### Decision C: Lockstep Is Diagnostic, Not Production Acceptance

The current cycle-lockstep scheduler can remain as a diagnostic or
ablation mode, but it must not be the acceptance path for V1 TrueDrive.

Allowed:

- `debug-lockstep`
- `debug-push-only`
- `debug-hybrid`
- trace comparison between modes

Not allowed:

- "Game boots only in lockstep variant X" as V1 acceptance.
- mode-specific fixes that make one game pass without matching VICE
  event traces.

### Decision D: Chips Are Pure Components

Chips may own local registers and local behavior. Chips must not own
global time.

Allowed inside a chip:

- local register state
- local latch state
- local alarm scheduling request
- local read/write behavior
- local IRQ line state

Forbidden inside a chip:

- ticking another chip
- calling `drive.executeToClock` directly
- mutating another clock domain
- directly poking drive RAM as protocol rescue
- silently choosing a trap/fallback path

### Decision E: Cross-Domain Bus Accesses Go Through Kernel Entry Points

Every bus access that can affect another subsystem goes through a
kernel entry point carrying a context:

```ts
interface BusAccessContext {
  side: "c64" | "drive";
  device?: number;
  clock: number;
  pc: number;
  opcode: number;
  phase: CpuPhase;
  addr: number;
  access: "read" | "write" | "rmw" | "dummy-read" | "dummy-write";
}

interface KernelBus {
  c64Read(addr: number, ctx: BusAccessContext): number;
  c64Write(addr: number, value: number, ctx: BusAccessContext): void;
  driveRead(device: number, addr: number, ctx: BusAccessContext): number;
  driveWrite(device: number, addr: number, value: number, ctx: BusAccessContext): void;
}
```

Local RAM/ROM can stay local for performance. I/O and all cross-domain
surfaces must enter the kernel.

### Decision F: Event Order Is Part Of The Emulator Contract

The kernel must document and own the observable order of events. Ordering
must not be an accidental side effect of callback nesting.

At minimum, the true-drive loop defines deterministic points for:

1. clock-domain catch-up
2. CPU/VIA/CIA/VIC/GCR alarm dispatch
3. CPU micro-cycle or instruction phase
4. bus read/write mutation
5. IEC port recomputation/cache update
6. CA1/CB1/IRQ/NMI/SO edge delivery
7. trace emission

The exact implementation can be optimized, but the observable ordering
must be testable and traceable. A fix that depends on a hidden callback
order is not accepted.

## 4. Required Kernel Subsystems

### 4.1 Clock Domains

The kernel owns these clocks:

- `c64Clock`
- `driveClock[8]`
- future `driveClock[9]`
- frame/raster derived from C64/VIC state

Drive clock conversion must be centralized:

- PAL C64 to 1541 ratio
- NTSC C64 to 1541 ratio
- fractional accumulator
- catch-up target calculation

No chip may keep an independent "last sync" clock that is not owned by
the kernel.

### 4.2 Alarm Scheduler

CIA, VIA, VIC, drive, and timers use kernel-owned alarm contexts:

- alarms are scheduled in their owning clock domain
- alarm dispatch happens at deterministic kernel points
- alarm callbacks may change local chip state
- alarm callbacks may request IRQ/NMI line changes
- alarm callbacks must not advance time

### 4.3 Interrupt Lines

IRQ/NMI/CA1/CB1/SO events are timestamped:

- edge clock
- visible clock
- serviced clock
- source component
- target CPU

CPU interrupt delay must be computed from timestamps, not incidental
scheduler ordering.

### 4.4 IEC Core

IEC is a kernel-owned bus core with VICE-compatible cached state:

- `cpu_bus`
- `cpu_port`
- `drv_bus[unit]`
- `drv_data[unit]`
- `drv_port`
- `iec_old_atn`

C64 `$DD00` read/write and drive `$1800` read/write must use this core.
There must be no parallel "released flag" bus model in production.

IEC must model the 1541 hardware boundary explicitly:

- C64 CIA2 port A output value and DDR
- drive VIA1 port B output value and DDR
- ATN input to drive VIA1
- ATNA / ATN-acknowledge gate behavior
- DATA and CLK drivers as active pull-down participants
- port readback as the drive ROM sees it
- CA1 edge signal timing from ATN transitions

This is the area where Pi1541 is most instructive: the IEC bus is
implemented as line drivers plus port-direction semantics, not as
independent flags. C64RE may cache state VICE-style, but that cache must
represent the same hardware boundary.

### 4.5 GCR / Disk Rotation

The kernel owns disk rotation timing:

- motor state
- density zone
- head position
- bit rotation
- SYNC detection
- byte-ready event
- SO/V flag behavior

Drive VIA2 exposes this state. VIA2 does not independently tick disk
rotation.

The GCR/disk subsystem must be validated as a hardware timing path:

- VIA2 PB motor/head/density outputs drive the disk model
- density changes affect bit timing
- byte-ready/SO events are generated by disk-side phase, not by a file
  reader callback
- SYNC detection is based on bitstream history
- read and write paths share the same rotation/head state
- G64 parser correctness is not assumed broken without parser-specific
  evidence

Pi1541's drive code shows the right level of abstraction: emulate the
observable counters, shift registers, phase, and side effects. C64RE does
not need identical code, but it needs equivalent observable behavior.

### 4.6 VIC / Render

For V1/V2:

- VIC register behavior
- raster IRQ
- bus stealing
- frame metadata
- renderable framebuffer sufficient for visual artifacts

For V3:

- pixel-perfect renderer
- sprites
- collisions
- revision quirks
- screenshots/video from kernel frames

UI reads from kernel snapshots/events, not from a separate rendering
runtime.

### 4.7 SID

For V1:

- software-visible SID behavior
- register read/write
- oscillator/envelope state needed by software
- SID write trace
- no audible output required

For V3:

- SID playback becomes a UI/export client of kernel SID state
- JS/WASM SID or resid/fastsid-style implementation can be plugged in
- audio must not fork emulator timing

### 4.8 Reset / Power-On Contract

Reset and power-on are kernel responsibilities.

Required:

- one reset entry point for C64 plus attached drives
- documented order for CPU, CIA, VIA, VIC, SID, IEC, media, and drive
  mechanics
- byte-level defaults for software-visible registers and input pins
- trace event for reset/power-on with selected mode and mounted media
- no component may silently reinitialize peer state after reset

Pi1541 reinforces that reset ordering matters: VIA input defaults and
IEC line state must be established before drive firmware starts relying
on them.

## 5. Mandatory Trace Contract

V2 and debugging require canonical events. The kernel must emit these
event families:

- CPU instruction boundary
- CPU bus access
- C64 `$DD00` access
- drive `$1800` access
- IEC port update
- ATN/CLK/DATA edge
- VIA/CIA alarm
- IRQ/NMI/SO event
- GCR bit/byte-ready event
- disk head/motor/density event
- VIC raster/frame event
- media mount/reset/input event

Every event must include:

- kernel sequence number
- clock domain
- clock
- side/device
- PC/opcode/phase when CPU-related
- before/after state where relevant
- compatibility hooks used

Trace output must support:

- ring buffer
- JSONL artifact
- filtered capture windows
- VICE/headless normalization
- first-divergence report

## 6. Compatibility Hooks

Compatibility hooks are allowed only if they are explicit and reported.

Examples:

- KERNAL file/serial traps
- synthetic IEC line release
- direct drive RAM `$7C` ATN-pending poke
- forced PC jumps
- fake disk byte delivery

Rules:

1. Hooks are disabled in `true-drive`.
2. Hooks can be enabled in `fast-trap` or `debug` modes.
3. Kernel status must list every active hook.
4. Trace must record when a hook fires.
5. V1 acceptance tests must fail if a hook fires.

## 7. Public Runtime Modes

Production/public modes:

- `fast-trap`: RE convenience, traps allowed and reported
- `real-kernal`: real C64 KERNAL, simplified drive allowed
- `true-drive`: real C64 plus real 1541 drive path, no hidden hooks
- `debug-vice-compare`: true-drive plus trace/diff instrumentation

Internal diagnostic modes:

- `debug-lockstep`
- `debug-push-only`
- `debug-hybrid`

Internal diagnostic modes are not acceptance modes.

## 8. Migration Plan

### Step 1: Introduce Kernel Facade

Create:

- `src/runtime/headless/kernel/machine-kernel.ts`
- `src/runtime/headless/kernel/kernel-bus.ts`
- `src/runtime/headless/kernel/clock-domains.ts`
- `src/runtime/headless/kernel/kernel-trace.ts`

No behavior change yet. `IntegratedSession` delegates through facade
where possible.

Acceptance:

- build green
- existing smoke load green
- kernel status exposes mode, clocks, hooks

### Step 2: Move IEC Cross-Domain Access Into Kernel

Move C64 `$DD00` and drive `$1800` entry points behind `KernelBus`.

Acceptance:

- no production code calls `IecBus.beforeC64Read`
- no production code calls `drive.executeToClock` except kernel
- bus-access trace still captures `$DD00` and `$1800`
- VICE/headless diff can align first receive window

### Step 3: Move Drive Catch-up Ownership Into Kernel

`DriveCpu.executeToClock` becomes private/internal to kernel. The drive
component cannot be ticked directly from session or bus classes.

Acceptance:

- search proves no external caller except kernel
- C64 KERNAL LOAD smokes remain green
- motm/MM custom-loader trace has one authoritative drive-clock source

### Step 4: Move Alarm Dispatch Into Kernel

Alarm contexts are owned and drained by kernel. Chips schedule alarms;
kernel dispatches them.

Acceptance:

- CIA/VIA/VIC timer tests remain green
- interrupt trace includes source clock and service clock

### Step 5: Remove TrueDrive Rescue Hooks

Disable and mode-guard:

- `$7C` poke
- synthetic release methods
- KERNAL traps
- forced state repair

Acceptance:

- true-drive status says `hooks: []`
- tests fail if any hook fires in true-drive

### Step 6: Promote UI and LLM APIs To Kernel Clients

MCP, CLI, scripts, V2 workbench, and V3 UI use the same API:

- run
- pause
- step
- snapshot
- trace
- media mount
- input
- monitor query
- export

Acceptance:

- no duplicate emulator loop in UI or tools
- V3 screen and input use the same kernel session as CLI

## 9. Files To Refactor

Refactor:

- `src/runtime/headless/integrated-session.ts`
  - becomes session facade and compatibility adapter
  - stops wiring chip-to-chip timing directly

- `src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts`
  - becomes diagnostic scheduler or internal kernel strategy
  - not the production true-drive owner

- `src/runtime/headless/iec/iec-bus.ts`
  - becomes kernel-owned IEC bus implementation
  - loses public `beforeC64Read`
  - loses rescue-hook authority

- `src/runtime/headless/drive/drive-cpu.ts`
  - exposes CPU component to kernel
  - `executeToClock` no longer public to session/bus code

- `src/runtime/headless/via/*`
  - emits kernel-stamped IRQ/edge events

- `src/runtime/headless/cia/*`
  - emits kernel-stamped IRQ/NMI events

- `src/runtime/headless/vic/*`
  - reports bus stealing through kernel, not by directly bumping CPU
    cycles from a backend callback

- `src/runtime/headless/trace/*`
  - trace producers move behind kernel event stream

Keep:

- chip logic ports
- G64 parser unless direct parser regression is proven
- disk/GCR shifter code if traces validate it
- trap implementations as explicit non-true-drive utilities

## 10. Non-Negotiable Acceptance Criteria

The kernel is accepted only when all are true:

1. `true-drive` has one owner of time: `MachineKernel`.
2. `IntegratedSession` cannot tick C64, drive, CIA, VIA, VIC, SID, GCR
   directly.
3. No production path uses `IecBus.beforeC64Read`.
4. No production path calls `drive.executeToClock` except kernel.
5. No hidden hook can fire in `true-drive`.
6. Every `$DD00` and `$1800` access is traceable with clock, PC, value,
   IEC state, and sequence number.
7. VICE/headless diff can report first divergence for motm/MM fastloader
   windows.
8. Standard KERNAL `LOAD` smokes remain green.
9. MM/motm boot failures are no longer investigated through sampling
   artifacts; they must point to one first divergent event.
10. V2 and V3 APIs use the same kernel session, not a second emulator.

## 11. Test Paradigms

Testing must match the risk level. Small smokes are useful, but they are
not enough to prove the emulator core.

### 11.1 Smoke Tests Are Fast Health Checks

Smoke tests are allowed and encouraged for quick feedback:

- build sanity
- synthetic KERNAL `LOAD`
- one-block G64/D64 fixtures
- CPU/CIA/VIA/SID/VIC focused fixture checks
- trace writer starts and produces valid JSONL

Rules:

1. Smokes must run quickly.
2. Smokes may use synthetic fixtures.
3. Smokes may gate commits.
4. Smokes do not prove TrueDrive completeness.
5. A green smoke suite cannot close a custom-loader bug.

### 11.2 Integration Tests Are Mandatory

Any change touching kernel timing, CPU, CIA, VIA, IEC, GCR, VIC, SID,
drive, media, traps, or trace infrastructure must include integration
coverage unless the change is documentation-only.

Required integration surfaces:

- C64 CPU + CIA1/CIA2 + VIC timing
- C64 CIA2 + IEC + drive VIA1
- drive CPU + VIA1 + VIA2 + GCR shifter
- kernel clock domains + alarm dispatch
- media mount + drive ROM + IEC command flow
- snapshot/restore + deterministic replay
- trace event production + first-divergence tooling

Rules:

1. Integration tests must exercise real subsystem boundaries.
2. They must assert observable state, not only "did not crash".
3. They must fail if a hidden trap/rescue hook fires in `true-drive`.
4. They must be stable enough for local pre-commit use.
5. A kernel change without integration coverage is incomplete.

### 11.3 End-to-End Tests With Real G64 Are Product Acceptance

V1 TrueDrive acceptance requires end-to-end tests with real game media.
Synthetic media cannot replace this.

Mandatory E2E targets:

- Maniac Mansion (`MM`)
- motm
- Last Ninja / Last Ninja Remix (`LN`)
- Impossible Mission II (`IM2`)

Minimum acceptance ladder per target:

1. C64 boots cleanly.
2. Disk image mounts through true-drive path.
3. Boot file loads without KERNAL/file traps.
4. Uploaded drive code executes.
5. Custom IEC fastloader transfers at least one payload.
6. Game reaches first stable visual state or known title/game milestone.
7. Trace contains no hidden hooks.
8. Failure output includes first divergent event or last known milestone.

Rules:

1. These tests may be long-running and local-only by default.
2. CI may run a reduced/nightly profile if media licensing or duration is
   an issue.
3. E2E tests must use the same kernel API as MCP/CLI/UI.
4. E2E tests must emit artifacts: screenshot/frame, trace summary,
   runtime status, hook report, and failure milestone.
5. A release candidate cannot be called V1-complete while these are red.

### 11.4 Test Profiles

Use explicit profiles instead of vague "run tests":

- `quick`: build + smoke tests
- `integration`: quick + subsystem integration tests
- `trace`: integration + VICE/headless diff captures
- `e2e-local`: real G64 game boot tests
- `release`: integration + selected trace + e2e-local

Every profile must print:

- kernel mode
- media used
- traps/hooks used
- pass/fail counts
- artifact paths

## 12. Agent Usage Paradigms

Agents are useful, but only when the work is cut correctly. The kernel
is timing-sensitive; unbounded autonomous patching is not acceptable.

### 12.1 Good Agent Tasks

Use agents for bounded work with concrete artifacts:

- produce or refine specs from a known finding
- build a trace capture tool for one event shape
- compare VICE/headless traces and summarize first divergence
- add integration tests for a defined subsystem boundary
- port a specific chip behavior from VICE into a clearly owned module
- audit code for forbidden patterns such as hidden hooks or direct peer
  ticking
- update docs after an implementation lands

### 12.2 Bad Agent Tasks

Do not ask agents to "make MM boot" or "fix bitbanging" without a
trace-backed failure boundary.

Avoid tasks that:

- span many subsystems with no write ownership
- mix probes, fixes, and refactors
- allow game-specific hacks
- accept progress without VICE/headless evidence
- change parser/media code without proving parser/media fault
- edit tests to fit current behavior instead of intended behavior

### 12.3 Required Agent Workflow

For emulator-core work, an agent must follow this sequence:

1. State the hypothesis.
2. Name the subsystem boundary.
3. Capture or reference evidence.
4. Add or update the relevant integration/E2E test.
5. Implement the smallest change.
6. Run the correct test profile.
7. Record artifacts and remaining divergence.

If no first-divergence evidence exists, the next task is tracing, not
fixing.

### 12.4 Parallel Agent Use

Parallel agents are appropriate when write scopes do not overlap:

- one agent writes/updates a spec
- one agent builds trace tooling
- one agent ports a specific chip behavior
- one agent writes integration tests
- one agent audits forbidden patterns

Parallel agents are not appropriate when multiple agents would touch
the same timing path (`MachineKernel`, IEC, scheduler, drive CPU) without
a single integrator.

### 12.5 Agent Acceptance

Agent work is accepted only when it leaves behind:

- changed files listed
- test profile run
- artifact paths
- clear pass/fail summary
- next unresolved divergence if any

Progress reports without artifacts are not enough for core work.

## 13. ADR Consequences

### Positive

- V1 gets a real TrueDrive path with enforceable timing semantics.
- V2 gets deterministic traces and first-divergence debugging.
- V3 can reuse the same runtime for screen, input, monitor, media, and
  export.
- Future chip ports plug into a defined kernel instead of expanding
  `IntegratedSession`.

### Negative

- This is a substantial refactor.
- Existing scripts may need adapter updates.
- Some current green smokes may reveal hidden reliance on timing quirks.
- Performance may temporarily regress until the event paths are tuned.

### Rejected Alternatives

#### Keep patching fastloader symptoms

Rejected. It can make individual games move forward but will keep
creating incompatible timing islands.

#### Make cycle-lockstep the production model

Rejected for V1 acceptance. Lockstep is useful diagnostically, but the
current failures show that observable bus ordering still does not match
VICE.

#### Fork a UI emulator for V3

Rejected. V3 must exercise the same kernel as V1/V2, otherwise UI bugs
and headless bugs diverge.

#### Copy VICE source directly

Rejected as a code strategy because of license and maintainability.
Accepted as a behavioral oracle: reproduce observable behavior and use
VICE traces as acceptance evidence.

#### Copy Pi1541 source directly

Rejected as a code strategy because Pi1541 is GPLv3 and targets a
different product shape: a 1541 device attached to a real C64. Accepted
as an architectural reference for 1541 timing, IEC line direction,
ATNA/CA1 behavior, VIA execution, disk motor/head/density coupling, and
reset ordering.

## 14. Next Specs

Cut implementation into these specs:

1. **Spec 154.1 - Kernel facade and status**
   Create the kernel facade, no behavior change.

2. **Spec 154.2 - Kernel-owned IEC access**
   Move `$DD00`/`$1800` access behind kernel bus entry points.

3. **Spec 154.3 - Kernel-owned drive catch-up**
   Make drive catch-up private to kernel.

4. **Spec 154.4 - Kernel-owned alarms and IRQ timestamps**
   Move alarm dispatch and IRQ/SO event stamping into kernel.

5. **Spec 154.5 - TrueDrive hook hygiene**
   Enforce hook-free true-drive acceptance.

6. **Spec 154.6 - V2/V3 client API**
   Expose stable APIs for MCP/CLI/UI clients.

## 15. One-Sentence Rule

If a change makes a game progress but cannot explain the exact
VICE/headless event it now matches, it is not a core fix. It is a probe.
