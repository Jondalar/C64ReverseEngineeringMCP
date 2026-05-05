# Sprint 111 Playbook — Fix motm Drive Wake-Up

## Goal

Make headless 1541 drive enter custom code at the same simulated
cycle VICE does. Oracle: VICE captured trace
`samples/traces/v2-baseline/motm/`.

**Acceptance**: `node scripts/diff-vice-headless.mjs` shows motm drive
RAM% within 5% of VICE (currently 31% vs 65%).

## Phase A — Identify divergence point in VICE history

### A1. Find the last "good" sample (both in same class)

```bash
node -e '
const r = require("./scripts/diff-vice-headless.mjs");  // OR replicate inline
// Already known: first class divergence at sample 2 for motm.
// Sample 2 = ts 100000 (chunk 2 × INSTR_PER_CHUNK 50000).
// Sample 1 = ts 50000 — both should be aligned.
'
```

**Manual**: load `samples/traces/v2-baseline/motm/trace.jsonl` line 1
(VICE sample 1) and `headless-trace.jsonl` line 1 (headless sample 1).
Drive PC at this point in both should still be in same class.

### A2. Inspect VICE drive CPU history at chunk 20 (= ts 1M)

`samples/traces/v2-baseline/motm/drive-history.jsonl` has entries every
20 chunks (= 1M cycles). First entry covers chunk 20 ≈ ts 1M.

```bash
head -1 samples/traces/v2-baseline/motm/drive-history.jsonl | python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
for item in data["items"]:
    pc = next(r["value"] for r in item["registers"] if r["id"] == 3)
    bytes_str = " ".join(f"{b:02x}" for b in item["instructionBytes"])
    print(f"clock {item['"'"'clock'"'"']} pc=${pc:04x} bytes={bytes_str}")
'
```

Output is the last 32 drive instructions VICE executed before chunk 20.
Look for:
- PC sequence inside drive RAM ($0300-$07FF)
- Instructions that JMP from ROM ($CC00+) into RAM
- Instructions that JSR to RAM-loaded routines

### A3. Find the JMP-to-RAM event

In VICE drive history, scan for an instruction where:
- `pc` is in drive ROM ($CC00+)
- Followed by next item where `pc` is in drive RAM
- Bytes of the ROM instruction = JMP / JSR / RTI / RTS

This is the **wake-up event**. The address it jumped TO is what
fastloader installed via M-W. The TYPE (JMP/IRQ/RTI) tells us the
mechanism.

Common patterns:
1. **IRQ-driven**: PC in IRQ handler ($EA31 or ROM IRQ vector path),
   then PC = $0314/$0315 indirect = patched IRQ vector → custom code
2. **JSR ROM-hook**: PC at $C194 (drive's CHRIN dispatch via $0300)
   or similar, then JMP indirect through $0300+ patched hook
3. **M-E direct**: drive command-channel parser handles "M-E" opcode,
   JMPs to specified address
4. **Job-table-pending**: drive idle loop $D6B9 reads $00 = job
   command, BMI to job dispatcher → JSR to job routine

## Phase B — Reproduce in headless

### B1. Add drive PC trace at instruction boundary

Currently `session.drive.cpu.pc` only sampled at our 200K-cyc
intervals. Add per-instruction trace ring (last 256 instructions)
in `IntegratedSession`:

```ts
public driveInstrTrace: { cycle: number; pc: number; opcode: number }[] = [];
public enableDriveInstrTrace = false;
```

Hook at every drive instruction completion. Already exists for sample
intervals; extend to full instruction stream when flag set.

In `integrated-session.ts` near `sampleDrivePc()`:
```ts
if (this.enableDriveInstrTrace && this.drive.cpu.pc !== this.lastDrivePc) {
  this.driveInstrTrace.push({
    cycle: this.c64Cpu.cycles,
    pc: this.drive.cpu.pc,
    opcode: this.drive.bus.read(this.drive.cpu.pc),
  });
  if (this.driveInstrTrace.length > 256) this.driveInstrTrace.shift();
  this.lastDrivePc = this.drive.cpu.pc;
}
```

### B2. Run motm to first divergence point

Modify `scripts/headless-180s-baseline.mjs`:
- Enable `session.enableDriveInstrTrace = true`
- After sample 1 (~50K cycles past trace-start), dump
  `driveInstrTrace` to `samples/traces/v2-baseline/motm/headless-drive-instr-window1.jsonl`

### B3. Compare to VICE drive-history.jsonl chunk 20

Both should show drive instructions around ts 1M. Side-by-side:
- Same PC sequence? → bug is timing (different clock)
- Different PC sequence? → bug is in instruction-level execution
  (cycle accounting, interrupt timing, VIA register read)

## Phase C — Fix iteratively

### Hypothesis 1: VIA CA1 (ATN edge) timing

VICE: `viacore_signal(VIA_SIG_CA1, RISE)` queues edge with cycle delay.
Ours: `via.pulseCa1(level)` fires immediately.

**Fix**: Add 1-cycle delay between bus ATN edge and CA1 IFR set in
drive VIA1.

### Hypothesis 2: Drive IRQ entry timing

VICE drive IRQ entry: 7 cycles, vector $FFFE → custom IRQ handler
which usually JMPs through $0314/$0315 patched vector → fastloader
custom code.

**Check**: drive RAM $0314/$0315 in motm headless final state. If
not pointing at custom code, M-W to those locations didn't happen
or wasn't honored.

```bash
xxd -s 0x314 -l 4 samples/traces/v2-baseline/motm/drive-ram.bin     # VICE
xxd -s 0x314 -l 4 samples/traces/v2-baseline/motm/headless-drive-ram.bin  # ours
```

If they differ, that's the bug location.

### Hypothesis 3: Drive command-channel M-E execution

If VICE drive shows "M-E" handling (search drive-history for instructions
near drive's command-channel parser at ROM $D7B4-$D830 area), and
headless doesn't, fix is in our drive-side command-channel emulation.

## Iteration loop

```bash
# Establish baseline (only once):
node scripts/vice-180s-baseline.mjs motm        # ~5s
node scripts/headless-180s-baseline.mjs motm    # ~25s
node scripts/diff-vice-headless.mjs

# Note current divergence: 31% headless vs 65% VICE drive RAM %.

# Each iteration:
# 1. Identify candidate fix from history compare (Phase A/B)
# 2. Edit headless code (e.g. via1.ts pulseCa1, or drive-cpu.ts IRQ entry)
# 3. Rebuild:
npm run build:mcp

# 4. Re-capture headless:
node scripts/headless-180s-baseline.mjs motm

# 5. Diff:
node scripts/diff-vice-headless.mjs

# 6. Confirm motm drive RAM% increased toward 65%.
# 7. Other games regression-check:
npm run regress
node scripts/headless-180s-baseline.mjs       # all 5 games
node scripts/diff-vice-headless.mjs

# Repeat until motm reaches 60-65% drive RAM % AND
# regress 5/5 stays green AND other games' drive RAM % don't degrade.
```

## Acceptance per fix iteration

After each fix:
- motm drive RAM% should increase monotonically toward VICE's 65%
- mm-s1 baseline (regress L7) must stay green
- regress 5/5 must stay green
- No other game's drive RAM% should drop > 5 pp

## When motm reaches parity

Run all 5 games:
- motm reaching 60-65% RAM% likely means it boots to game now.
- Render `/tmp/motm-final.png` to confirm visual.
- If yes: motm goes into regress matrix as L9.
- If no: still divergence somewhere; continue iteration.

## Stop conditions

- motm drive RAM% within 5pp of VICE → silicon-equivalent on this fixture
- Move to Sprint 112: pick next game (lnr-s1, polarbear) and repeat
- Sprint 113-114: when all 5 games converge, ship as 1541-v2
- mm-s1 stays regression net throughout

## Files referenced

- `samples/traces/v2-baseline/motm/{trace,headless-trace,drive-history,c64-history}.jsonl`
- `samples/traces/v2-baseline/motm/{drive-ram,headless-drive-ram}.bin`
- `scripts/vice-180s-baseline.mjs` — VICE harness
- `scripts/headless-180s-baseline.mjs` — Headless harness
- `scripts/diff-vice-headless.mjs` — Diff
- `src/runtime/headless/iec/iec-bus.ts` — Bus state model
- `src/runtime/headless/drive/via1-iec.ts` — Drive VIA1 IEC backends
- `src/runtime/headless/drive/drive-cpu.ts` — Drive CPU + bus
- `src/runtime/headless/cia/cia6526.ts` — CIA timer/ICR
- `/Users/alex/Downloads/trex_cracktro_complete/tools/vice-3.7.1/src/iecbus/iecbus.c`
- `/Users/alex/Downloads/trex_cracktro_complete/tools/vice-3.7.1/src/drive/iec/via1d1541.c`

## Time estimate (revised)

- Phase A (analyze VICE history at divergence point): 1-2 hours
- Phase B (add per-instruction trace + capture window): 2-4 hours
- Phase C iteration #1 (first fix): 4-8 hours
- Iterations #2-#5: 2-4 hours each as fixes get more targeted
- Total Sprint 111: 2-4 days for motm parity
- Sprint 112-113 each: 1-2 days (other games) once oracle approach established
- Sprint 114 acceptance: 0.5-1 day
- **Grand total V2 1541-silicon: 5-10 days**

(Earlier 2-3 weeks was conservative pre-baseline; with oracle data
already captured tonight, iteration cycle is fast.)
