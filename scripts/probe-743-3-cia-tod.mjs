// Spec 743.3 — CIA timer (ciat) + TOD absolute clocks stay monotonic across the
// old 32-bit boundary. Unit-level. The fidelity-critical part: the predict-walk
// (Ciat.setAlarm) and TOD scheduling must NOT u32-truncate an absolute clk > 2^32
// (which would place the alarm BEFORE the current clk → drainAlarms spin = BUG-025).
// Timer COUNTERS (cnt/latch) stay 16-bit — checked separately.
import { Ciat, CIAT_CR_START, CIAT_PHI2IN } from "../dist/runtime/headless/cia/ciat.js";
import { makeTodState, todReset, todTickCallback, CIA_CRA_TODIN_50HZ } from "../dist/runtime/headless/cia/cia-tod.js";
import { CLOCK_NEVER } from "../dist/runtime/headless/util/uint.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const hx = (n) => "0x" + n.toString(16);
const TWO32 = 0x1_0000_0000;

console.log("Spec 743.3 — CIA timer + TOD monotonic across 2^32\n");

// --- CIA timer (ciat) predict-walk across the boundary ---
const base = TWO32 + 0x10000;        // timer internal clk above 2^32
const t = new Ciat("ta", base);
t.latch = 0x1000;
t.cnt = 0x1000;
// start + phi2 continuous (byte bit0=start, bit5=0 → phi2 after the internal XOR)
t.setCtrl(base, CIAT_CR_START & 0xff);
// settle the COUNT2/COUNT3/COUNT pipeline a few cycles
t.update(base + 4);
ok((t.state & CIAT_CR_START) !== 0, "ciat timer is running");
const alarmClk = t.setAlarm(base + 4);
ok(alarmClk !== CLOCK_NEVER, "running timer predicts a real underflow (not NEVER)", hx(alarmClk));
ok(alarmClk > t.clk, "predicted underflow is in the FUTURE (monotonic, not wrapped below clk)",
  `alarm=${hx(alarmClk)} clk=${hx(t.clk)}`);
ok(alarmClk > TWO32, "predicted underflow stays above 2^32 (no u32 truncation)", hx(alarmClk));
// counter stays 16-bit
ok(t.cnt >= 0 && t.cnt <= 0xffff, "timer counter still 16-bit", hx(t.cnt));

// stopped timer → CLOCK_NEVER (monotonic sentinel, not 0xffffffff)
const t2 = new Ciat("tb", base);
t2.setCtrl(base, 0);                 // stop
const stoppedAlarm = t2.setAlarm(base);
ok(stoppedAlarm === CLOCK_NEVER, "stopped timer → CLOCK_NEVER (not 0xffffffff)", hx(stoppedAlarm));
ok(stoppedAlarm > TWO32, "stopped sentinel is above any reachable clk", hx(stoppedAlarm));

// --- TOD scheduling across the boundary ---
const cCia = new Uint8Array(16);
const tod = makeTodState(985248, 50);
const todBase = TWO32 + 0x20000;
todReset(tod, cCia, todBase);
ok(tod.todclk > todBase, "TOD reset schedules next tick in the future", hx(tod.todclk));
ok(tod.todclk > TWO32, "TOD todclk stays above 2^32 (no u32 truncation)", hx(tod.todclk));

const before = tod.todclk;
todTickCallback(tod, cCia, CIA_CRA_TODIN_50HZ, before);
ok(tod.todclk > before, "TOD tick reschedules forward monotonically", `${hx(before)} -> ${hx(tod.todclk)}`);
ok((tod.todclk - before) > 0 && (tod.todclk - before) < 0x10000,
  "TOD tick interval is a sane ~1/50s span (no wrap)", `${tod.todclk - before} cyc`);

console.log(`\nSpec 743.3: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
