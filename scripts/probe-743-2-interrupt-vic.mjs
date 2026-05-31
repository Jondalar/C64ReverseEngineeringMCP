// Spec 743.2 — interrupt status + VIC raster IRQ absolute clocks stay monotonic
// across the old 32-bit boundary. Unit-level (CIA is 743.3).
import {
  InterruptCpuStatus, CLOCK_MAX as INT_CLOCK_MAX,
} from "../dist/runtime/headless/cpu/interrupt-cpu-status.js";
import { VicIIVice } from "../dist/runtime/headless/vic/vic-ii-vice.js";
import { alarmContextNew, alarmContextNextPendingClk } from "../dist/runtime/headless/alarm/alarm-context.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const hx = (n) => "0x" + n.toString(16);
const TWO32 = 0x1_0000_0000;

console.log("Spec 743.2 — interrupt + VIC raster IRQ monotonic across 2^32\n");

// --- interrupt status across the boundary ---
ok(INT_CLOCK_MAX === Number.MAX_SAFE_INTEGER, "interrupt CLOCK_MAX = MAX_SAFE_INTEGER", hx(INT_CLOCK_MAX));
const ist = new InterruptCpuStatus();
const clkA = TWO32 + 0x100;           // assert above 2^32
ist.setIrq(1, true, clkA);
ok(ist.irqClk === clkA, "irqClk stores absolute clk > 2^32 (no wrap)", hx(ist.irqClk));
// bumpDelays must see the assert as "in the past" once clk passes it (monotonic compare).
ist.bumpDelays(clkA + 1);
ok(ist.irqDelayCycles >= 1, "bumpDelays compares monotonically past 2^32");
// disabled clk stays disabled.
const ist2 = new InterruptCpuStatus();
ok(ist2.irqClk === INT_CLOCK_MAX, "fresh irqClk = disabled sentinel");
ist2.bumpDelays(TWO32 + 0x5000);
ok(ist2.irqDelayCycles === 0, "disabled irqClk not triggered above 2^32");

// --- VIC raster IRQ scheduling across the boundary ---
let curClk = TWO32 + 0x8000;
const ctx = alarmContextNew("maincpu");
const vic = new VicIIVice({
  backend: { setIrqLine: () => {} },
  alarmContext: ctx,
  clkPtr: () => curClk,
});
vic.powerup();
vic.reset?.();
// arm a raster IRQ on a line ahead of the current raster position.
vic.raster_y = 10;
vic.raster_cycle = 0;
vic.viciiIrqSetRasterLine(100);
ok(vic.raster_irq_clk > curClk, "VIC raster fireClk is in the FUTURE (monotonic, not wrapped below clk)",
  `fire=${hx(vic.raster_irq_clk)} clk=${hx(curClk)}`);
ok(vic.raster_irq_clk > TWO32, "VIC raster fireClk stays above 2^32 (no u32 truncation)", hx(vic.raster_irq_clk));
ok(alarmContextNextPendingClk(ctx) === vic.raster_irq_clk, "raster alarm armed at the monotonic fireClk");

// re-arm for next frame must move forward, not wrap.
const before = vic.raster_irq_clk;
vic.rasterIrqAlarmHandler(0);
ok(vic.raster_irq_clk > before, "next-frame re-arm advances monotonically",
  `${hx(before)} -> ${hx(vic.raster_irq_clk)}`);

console.log(`\nSpec 743.2: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
