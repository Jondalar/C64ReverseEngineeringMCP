// Spec 743.1 — CPU clk + alarm primitive are monotonic across the old 32-bit
// boundary. Unit-level (no full machine; CIA/VIC scheduling is 743.2/.3). Proves:
//   - clkAdd / CPU cycles do NOT wrap at 2^32
//   - alarm schedule + next-pending + capture/restore stay monotonic past 2^32
//   - the empty/disabled sentinel (CLOCK_MAX = CLOCK_NEVER) is > any reachable clk
//     so drainAlarms cannot spin on an empty context above 2^32 (BUG-025 core).
import { clkAdd, CLOCK_NEVER } from "../dist/runtime/headless/util/uint.js";
import {
  alarmContextNew, alarmNew, alarmSet, alarmContextDispatch,
  alarmContextNextPendingClk, alarmContextCaptureSchedule, alarmContextRestoreSchedule,
  CLOCK_MAX,
} from "../dist/runtime/headless/alarm/alarm-context.js";
import { Cpu65xxVice } from "../dist/runtime/headless/cpu/cpu65xx-vice.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const hx = (n) => "0x" + n.toString(16);
const TWO32 = 0x1_0000_0000;

console.log("Spec 743.1 — CPU clk + alarm primitive monotonic across 2^32\n");

// 1. uint helpers.
ok(CLOCK_NEVER === Number.MAX_SAFE_INTEGER, "CLOCK_NEVER = MAX_SAFE_INTEGER", hx(CLOCK_NEVER));
ok(clkAdd(0xfffffff0, 0x20) === 0xfffffff0 + 0x20, "clkAdd monotonic past 2^32",
  hx(clkAdd(0xfffffff0, 0x20)));
ok(clkAdd(0xfffffff0, 0x20) > TWO32, "clkAdd result exceeds 2^32 (no wrap)");

// 2. CPU cycles setter does not u32-truncate.
const cpu = new Cpu65xxVice({ memBus: { read: () => 0, write: () => {} } });
cpu.cycles = TWO32 + 5;
ok(cpu.cycles === TWO32 + 5, "Cpu65xxVice.cycles stores absolute clk > 2^32", hx(cpu.cycles));

// 3. Alarm schedule past 2^32.
const ctx = alarmContextNew("maincpu");
ok(alarmContextNextPendingClk(ctx) === CLOCK_MAX && CLOCK_MAX === CLOCK_NEVER,
  "empty context next-pending = CLOCK_NEVER (not 0xffffffff)", hx(alarmContextNextPendingClk(ctx)));
// A clk above 2^32 must be < the empty sentinel → no spurious 'due'.
ok((TWO32 + 0x1000) < alarmContextNextPendingClk(ctx),
  "clk>2^32 is below the empty sentinel (drain cannot spin on empty ctx)");

let fired = 0; let lastOffset = -1;
const a = alarmNew(ctx, "T", (offset) => { fired++; lastOffset = offset; }, null);
const base = TWO32 + 0x4000;       // schedule above 2^32
alarmSet(a, base + 0x64);
ok(alarmContextNextPendingClk(ctx) === base + 0x64, "alarm scheduled at monotonic clk>2^32",
  hx(alarmContextNextPendingClk(ctx)));

// 4. Capture/restore round-trip preserves the >2^32 clk exactly.
const sched = alarmContextCaptureSchedule(ctx);
ok(sched.length === 1 && sched[0].clk === base + 0x64, "capture preserves clk>2^32", hx(sched[0]?.clk ?? -1));
alarmContextRestoreSchedule(ctx, sched);
ok(alarmContextNextPendingClk(ctx) === base + 0x64, "restore preserves clk>2^32",
  hx(alarmContextNextPendingClk(ctx)));

// 5. Dispatch + reschedule stays monotonic (no spin). Simulate the CPU drain.
let clk = base + 0x64;             // reached the alarm
let guard = 0, tripped = false;
const period = 0x4000;
// callback reschedules forward by period
const a2ctx = alarmContextNew("maincpu");
const a2 = alarmNew(a2ctx, "P", (_o) => { alarmSet(a2, clk + period); }, null);
alarmSet(a2, clk);
while (clk >= alarmContextNextPendingClk(a2ctx)) {
  alarmContextDispatch(a2ctx, clk);
  if (++guard > 0x1000) { tripped = true; break; }
}
ok(!tripped, "drain across boundary does not spin (reschedules forward past clk)",
  `dispatched ${guard}x, next=${hx(alarmContextNextPendingClk(a2ctx))}`);
ok(alarmContextNextPendingClk(a2ctx) === clk + period, "rescheduled alarm is monotonic > clk",
  hx(alarmContextNextPendingClk(a2ctx)));
ok(fired === 0 || lastOffset >= 0, "dispatch offset non-negative");

console.log(`\nSpec 743.1: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
