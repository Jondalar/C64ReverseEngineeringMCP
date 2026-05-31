// Spec 743.6 — the C64→1541 catch-up bridge passes MONOTONIC C64 time (no >>> 0).
// After C64 clk > 2^32, a wrapped target read as < the drive's last_clk would make
// drivecpu_execute compute cycles=0 (stall) — or, if last_clk were also wrapped,
// jump the drive by ~2^32 cycles. White-box: prime the drive's last_clk near 2^32
// (without running 4e9 cycles), then drive the bridge across the boundary and prove
// the drive advances by the small correct delta.
import { Vice1541Facade } from "../dist/runtime/headless/drive1541/vice1541-facade.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const hx = (n) => "0x" + (n >>> 0).toString(16);
const TWO32 = 0x1_0000_0000;
const blankD64 = () => new Uint8Array(683 * 256);
const unitOf = (f) => f.diskunit;

console.log("Spec 743.6 — C64→1541 bridge passes monotonic clk (no 2^32 truncation)\n");

function mkFacade() {
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: blankD64(), readOnly: false });
  return f;
}

// --- 1. tickToClock across 2^32: drive must advance by the small delta, not stall.
{
  const f = mkFacade();
  const u = unitOf(f);
  const sync = u.cpud.sync_factor;
  ok(sync > 0, "drive sync_factor is set (drivesync primed)", String(sync));

  const BASE = TWO32 - 0x100;          // 0xFFFFFF00 — just below the wrap
  const DELTA = 0x2000;                // small monotonic step that crosses 2^32
  u.cpu.last_clk = BASE;             // prime WITHOUT running 4e9 cycles
  const clkBefore = u.clk_ptr.value;

  f.tickToClock(BASE + DELTA);         // monotonic target > 2^32

  ok(u.cpu.last_clk === BASE + DELTA, "last_clk stored monotonic > 2^32 (no truncation)",
    `${hx(BASE + DELTA)} got ${u.cpu.last_clk}`);
  ok(u.cpu.last_clk > TWO32, "last_clk really exceeds 2^32");
  const advanced = (u.clk_ptr.value - clkBefore + TWO32) % TWO32; // drive-domain delta (uint32)
  ok(advanced > 0, "drive clock ADVANCED (not stalled — the bug was cycles=0)", `+${advanced} drive cyc`);
  // sanity: advance ~ DELTA*sync/65536, NOT ~2^32 (the other wrap failure mode)
  const expect = Math.floor((DELTA * sync) / 65536);
  ok(advanced <= expect + 4 && advanced >= Math.max(0, expect - 4),
    "drive advanced by the correct small delta (no billion-cycle jump)", `~${advanced} vs ~${expect}`);
}

// --- 2. Contrast: the OLD wrapped target (>>> 0) would stall. Prove the fix matters.
{
  const f = mkFacade();
  const u = unitOf(f);
  const BASE = TWO32 - 0x100;
  u.cpu.last_clk = BASE;
  const clkBefore = u.clk_ptr.value;
  // Simulate the OLD bug: caller truncates the target to uint32 before the bridge.
  const wrapped = (BASE + 0x2000) >>> 0;      // = 0x1f00, < BASE
  f.tickToClock(wrapped);
  ok(u.clk_ptr.value === clkBefore, "wrapped target (old >>>0 behaviour) STALLS the drive — confirms the bug",
    `clk ${clkBefore}→${u.clk_ptr.value}`);
}

// --- 3. catchUpTo across 2^32 also passes monotonic.
{
  const f = mkFacade();
  const u = unitOf(f);
  const BASE = TWO32 + 0x4000;          // already above 2^32
  u.cpu.last_clk = BASE;
  const clkBefore = u.clk_ptr.value;
  f.catchUpTo(BASE + 0x1000);
  ok(u.cpu.last_clk === BASE + 0x1000, "catchUpTo stores monotonic last_clk > 2^32", hx(u.cpu.last_clk));
  const adv = (u.clk_ptr.value - clkBefore + TWO32) % TWO32;
  ok(adv > 0, "catchUpTo advanced the drive past 2^32", `+${adv}`);
}

console.log(`\nSpec 743.6: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
