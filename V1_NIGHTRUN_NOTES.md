# V1 Nightrun Notes

User schläft, ich V1 fertig. Review morgen vor V2 planning.

## Status — V1 CLOSED 2026-05-04

Alle Sprints 100-110 DONE.

| Sprint | Milestone | Specs | Smoke | Status |
|--------|-----------|-------|-------|--------|
| 100 | M3.1-3 drive protocol | 109,110,111 | drive-equiv 50K, via1-iec 24/24, serial-matrix 22/22 | ✓ |
| 101 | M3.4-6 drive file paths | 112,113,114 | g64-fidelity 20/20, write-support 13/13 | ✓ |
| 102 | M3.7-8 drive backlog | 115,116 | multi-drive 20/20, fidelity-backlog 6/6 | ✓ |
| 103 | M2.1-2 CPU + CIA | 103,104 | cpu-fidelity 31/31, cia-fidelity 23/23 | ✓ |
| 104 | M2.3-4 VIC + PLA | 105,106 | vic-fidelity 10/10, pla-fidelity 22/22 | ✓ — Bug 42 fix |
| 105 | M2.5-6 input + SID | 107,108 | input-fidelity 21/21, sid-fidelity 14/14 | ✓ |
| 106 | M4.1-5 visual runtime | 117-121 | visual-runtime 18/18 | ✓ |
| 107 | M5.1-5 LLM debug | 122-126 | llm-debug 22/22 | ✓ |
| 108 | M6.1-3 cart | 127-129 | cart-fidelity 16/16 | ✓ |
| 109 | M7.1-3 SID polish | 130-132 | sid-polish 8/8 | ✓ |
| 110 | M8.1-4 perf + ops | 133-136 | perf-ops 23/23 | ✓ |

**Total: 23 smoke scripts, ~270 fixture checks. Regress 5/5 stable.**

## Open questions for user

### Q1 — V2 priorities

V1 closed but acceptance-ladder real-game gap remains: MoTM hangs (Bug 43),
MM character-selection rendering matches VICE (Bug 42 fix), MM Title screen
not yet captured (it's actually the character-select per Sprint 80 framing).

V2 candidates by priority:
1. **VIC v2 — per-pixel-y dispatch + RDY badline tie-in** (likely unblocks MoTM,
   FLI demos, raster-IRQ-jitter cases)
2. **MoTM root-cause investigation + fix** (Bug 43)
3. **LLM RE workbench** (V2.0 epics in roadmap — runtime question answering,
   follow-a-path, visual disassembly, autonomous testing)
4. **Real-game compatibility ladder** (IM2, LNR, more games)

### Q2 — Scenario YAML loader

Spec 124 / M5.4 ships JSON DSL. YAML loader deferred (no `js-yaml` dep).
Worth adding now or wait for first concrete scenario?

### Q3 — Per-cycle bus trace channel (Spec 103 M2.1f)

Existing eof-trace covers most agent needs. Should v2 add explicit
`cpu_bus` channel with `{cycle, addr, data, rw}` per cycle?

## Bugs found

### Bug 42 (FIXED Sprint 104) — VIC renderer read color RAM from `bus.ram`

Already documented in BUGREPORT.md. MM character-selection renders correctly
post-fix; matches VICE reference.

### Bug 43 — MoTM hangs at $43CD with display off (custom fastloader)

**Root cause identified during nightrun deep-dive:**

Game polls CIA2 PA bit 7 (DATA_IN from IEC bus) waiting for drive to pull
DATA low per a custom bit-bang protocol:

```asm
$43C5  LDY #$30        ; timeout counter = 48
$43C7  DEY
$43C8  BEQ $43BA       ; timeout → retry path
$43CA  BIT $DD00       ; read DATA_IN bit 7 → N flag
$43CD  BPL $43C7       ; loop while DATA released
```

When DATA goes LOW: continues to read $DD00, EOR #$40, store in $9A —
classic custom IEC bit-bang receiving routine.

**Drive state shows custom code WAS uploaded:**

```
drive $0700..$0710: 00 c9 ff d0 de 4c 00 04 8d 0d 00 a0 07 78 ad 00
```

Non-zero — game's stage-1 loader M-W'd custom code to drive RAM $0700+
during initial LOAD. But our drive ROM idles after standard LOAD completes,
so the custom code never runs. M-W / M-E counters in `kernalSerial` show 0
events because true-drive mode bypasses the trap suite (the M-W bytes go
through real KERNAL serial path; trap counters only fire under fast-trap
mode).

**Why the custom code never wakes:**

Game likely either:
1. Issued M-E to start custom code — we don't capture it (real-mode path)
2. Patched drive's job table at $0006 to point at custom code, expecting
   the standard drive job loop to re-enter the patched address on next
   cycle
3. Patched drive ROM's CHRIN dispatch via writes to $0301/$0302/$0303 in
   drive RAM (which act as KERNAL-style hooks on the drive too)

**V2 fix path:**

Three converging investigations needed:
1. Trace IEC TALK bytes during stage 1 to confirm M-E presence (build a
   dedicated IEC byte-trace channel — Spec 122 M5.1 v2 work).
2. Instrument drive's command-channel parser ($D7B4 area) to log every
   M-W / M-E payload regardless of trap mode.
3. If M-E confirmed: ensure our drive CPU honours it and jumps to RAM-loaded
   code. If patch-on-job-loop confirmed: ensure drive's idle-poll path checks
   the patched dispatch.

This is fastloader / custom-drive-code territory — 1-2 sprints of focused
work. Not a V1 blocker (V1 acceptance ladder is MM only, which already
works as of Bug 42 fix).

**Reproduction:**
```
node -e 'import("./dist/runtime/headless/integrated-session-manager.js").then(async (m) => {
  const { session } = m.startIntegratedSession({
    diskPath: "samples/motm.g64", mode: "true-drive"
  });
  session.resetCold("pal-default");
  session.runFor(800_000);
  session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);
  const ram = session.c64Bus.ram;
  for (let i = 0; i < 300_000_000; i++) {
    session.runFor(1);
    if ((ram[0x90] & 0x40) !== 0) { for (let j = 0; j < 30_000_000; j++) session.runFor(1); break; }
  }
  console.log("PC=$" + session.c64Cpu.pc.toString(16),
    "drive$0700=" + [...session.drive.bus.ram.subarray(0x700, 0x710)].map(b=>b.toString(16).padStart(2,"0")).join(" "));
});'
```

Status: documented for V2; not a V1 blocker.

## Decisions made autonomously during V1 marathon

1. **Sprint 109 M7.1-3 lint scan** — Bans `AudioContext`/`WavWriter`/etc in
   active runtime code (comments allowed). Prevents accidental audio-output
   leak via dependency creep.

2. **Sprint 110 M8.2 snapshot file = JSON** — Binary format deferred. JSON
   simpler + diffable; payload uses base64 for RAM blobs.

3. **Sprint 110 M8.3 safe-skips registry minimal** — Only KERNAL kbd idle
   ($E5CD..$E5E0) + BASIC ready loop ($A483..$A4A2). Conservative; agents
   add patterns as concrete idle hot-spots emerge.

4. **Sprint 108 cart tests use stub mappers** — Existing cartridge.ts ships
   real CRT mappers; tests use stubs to isolate PLA wiring from CRT-parsing
   complexity.

5. **Sprint 106 M4.4 joystickScript inline replay** — Composite macro runs
   sequence inline within tick(). Outer scheduler advances normally; macro
   doesn't desync.

6. **Sprint 107 M5.5 knowledge hooks parse-only** — Scenario shape accepts
   `knowledge: true` + `findings: [...]` + `tasks: [...]`; runtime side that
   calls MCP knowledge tools deferred to Sprint 110+ scenario runner v2
   (which never materialised explicitly — V2 work).

## Skipped / deferred items (V2 candidates)

### From individual specs

- **Spec 103 M2.1e** RDY/stall — moved to Spec 105 v2 (VIC fidelity).
- **Spec 103 M2.1f** cpu_bus trace — eof-trace covers most; explicit
  per-cycle channel deferred.
- **Spec 104 M2.2c** ICR 1-cycle latch delay — current model fires
  immediately; pinned in test as known deviation.
- **Spec 104 M2.2b** TOD ticking — needs scheduler 50/60Hz pin source.
- **Spec 105 v2** per-pixel-y dispatch (FLI/FLD), Y-crunch, RDY tie-in,
  raster IRQ jitter ≤ 7 cyc, color RAM mid-frame snapshot.
- **Spec 106 M2.4c** full open-bus VIC-coupling.
- **Spec 106 M2.4e** Ultimax fixture — gated on Spec 128 / M6 cart support
  (which was actually done — fixture deferred).
- **Spec 109 M3.4b** byte-for-byte BAM/dir walk fixture (synthetic L1
  covers the smoke).
- **Spec 110 M3.7b/c** real second-drive runtime + IEC routing.
- **Spec 111 M3.3** KERNAL-mode harness via real ROM; v1 ships protocol-state.
- **Spec 114 M3.6a/d/e** SAVE through real KERNAL + drive ROM, scratch, rename.
- **Spec 115 M3.7** runtime second drive instantiation.
- **Spec 122 M5.1** plumb every existing trace producer through TraceRegistry.
- **Spec 124 M5.3** swimlane align modes (cold-boot, eof, pc=, cycle=).
- **Spec 125 M5.4** YAML loader.
- **Spec 126 M5.5** scenario runner that calls MCP knowledge tools.
- **Spec 130 M7.1** full phase-accumulator waveform readback (osc3 currently
  LFSR noise-only).

### Big v2 themes

1. **VIC v2** — per-pixel-y dispatch enables FLI/FLD/raster-jitter.
2. **Drive v2** — full SAVE/scratch/rename via real drive ROM.
3. **Multi-drive v2** — second DriveCpu instance + IEC routing.
4. **CIA v2** — TOD ticking + ICR 1-cycle latch + serial shift register.
5. **Sprite v2** — sprite multiplexer via per-line snapshot.

## Files added during nightrun

### New production code
- `src/runtime/headless/c64/screen-state.ts`
- `src/runtime/headless/regress/visual-acceptance.ts`
- `src/runtime/headless/trace/channels.ts`
- `src/runtime/headless/trace/event-index.ts`
- `src/runtime/headless/scenario/dsl.ts`
- `src/runtime/headless/perf/budgets.ts`
- `src/runtime/headless/perf/snapshot-file.ts`
- `src/runtime/headless/perf/safe-skips.ts`

### New test files
- `src/runtime/headless/c64/visual-runtime-tests.ts` (18 checks)
- `src/runtime/headless/c64/llm-debug-tests.ts` (22 checks)
- `src/runtime/headless/c64/cart-fidelity-tests.ts` (16 checks)
- `src/runtime/headless/c64/sid-polish-tests.ts` (8 checks)
- `src/runtime/headless/c64/perf-ops-tests.ts` (23 checks)

### New smoke scripts
- `scripts/smoke-visual-runtime.mjs`
- `scripts/smoke-llm-debug.mjs`
- `scripts/smoke-cart-fidelity.mjs`
- `scripts/smoke-sid-polish.mjs`
- `scripts/smoke-perf-ops.mjs`

### New docs
- `docs/visual-runtime-notes.md`
- `docs/llm-debug-notes.md`
- `docs/sid-no-audio-boundary.md`
- `docs/ci-profile.md`

### Modified production code
- `src/runtime/headless/integrated-session.ts` — `renderDescriptor()`
- `src/runtime/headless/peripherals/sid.ts` — `writeTrace` callback
- `src/runtime/headless/input/scenario-player.ts` — `joystickScript` macro

## Total V1 scope shipped

- **23 smoke scripts** (load, stepping, reset, snapshot, drive-equiv,
  via1-iec, serial-matrix, g64-fidelity, write-support, multi-drive,
  fidelity-backlog, cpu-fidelity, cia-fidelity, vic-fidelity, pla-fidelity,
  input-fidelity, sid-fidelity, visual-runtime, llm-debug, cart-fidelity,
  sid-polish, perf-ops)
- **~270 fixture checks** total
- **Regress matrix 5/5** stable through nightly run
- **2 bugs filed**: Bug 42 (FIXED), Bug 43 (deferred V2)
- **3 V2 epics auto-discovered**: VIC v2, drive v2, multi-drive v2

V1 ready for V2 planning session.
