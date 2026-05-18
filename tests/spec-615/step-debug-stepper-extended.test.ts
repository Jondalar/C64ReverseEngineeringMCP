// Spec 615.10 follow-up — extended boot window. Capture EVERY HT change
// over 10s+ to see if drive ROM's "ritsch-ratsch" disk-insert recalibration
// sequence eventually settles back to HT36.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

await mountMedia(
  session,
  8,
  resolvePath(import.meta.dirname, "..", "..", "samples/POLARBEAR.d64"),
);
session.resetCold("pal-default");

const vice = session.kernel.drive1541!;
const drv = (vice as { unit: unknown }).unit as {
  drives: { [k: number]: { current_half_track: number } | null };
  clk_ptr: { value: number };
  cpu: { cpu_regs: { pc: number } };
};
const d0 = drv.drives[0]!;

type Event = {
  drv_clk: number;
  c64_clk: number;
  drv_pc: number;
  ht_before: number;
  ht_after: number;
};
const events: Event[] = [];

let _ht = d0.current_half_track;
Object.defineProperty(d0, "current_half_track", {
  configurable: true,
  enumerable: true,
  get() { return _ht; },
  set(v: number) {
    if (v !== _ht) {
      events.push({
        drv_clk: drv.clk_ptr.value >>> 0,
        c64_clk: session.c64Cpu.cycles >>> 0,
        drv_pc: drv.cpu.cpu_regs.pc & 0xffff,
        ht_before: _ht,
        ht_after: v,
      });
    }
    _ht = v;
  },
});

console.log(`Initial HT = ${d0.current_half_track}`);

// Run boot phase 10s — let drive ROM completely settle.
const PAL_HZ = 985_248;
session.runFor(10 * PAL_HZ);
console.log(`After 10s boot: HT = ${d0.current_half_track}  events=${events.length}`);

// Continue 5 more seconds.
session.runFor(5 * PAL_HZ);
console.log(`After 15s total: HT = ${d0.current_half_track}  events=${events.length}`);

function hex(n: number, w = 2): string { return n.toString(16).padStart(w, "0"); }
console.log("\nAll HT-change events:");
console.log("idx | c64_clk    | drv_clk    | drv_pc | HT step");
for (let i = 0; i < events.length; i++) {
  const e = events[i]!;
  const step = e.ht_after - e.ht_before;
  console.log(`${String(i).padStart(3)} | ${String(e.c64_clk).padStart(10)} | ${String(e.drv_clk).padStart(10)} | $${hex(e.drv_pc, 4)}  | ${String(e.ht_before).padStart(3)}→${String(e.ht_after).padStart(3)} (${step >= 0 ? "+" : ""}${step})`);
}
