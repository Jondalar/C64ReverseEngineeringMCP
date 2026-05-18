// Spec 615.10 step-debug — capture every drv.current_half_track change.
//
// Run via: npx tsx tests/spec-615/step-debug-stepper.test.ts

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
const drv_pc = () => drv.cpu.cpu_regs.pc & 0xffff;

// Track via Object.defineProperty.
type Event = {
  drv_clk: number;
  c64_clk: number;
  drv_pc: number;
  ht_before: number;
  ht_after: number;
  step: number;
};
const events: Event[] = [];
let lastHt = d0.current_half_track;

// Install setter spy.
let _ht = d0.current_half_track;
Object.defineProperty(d0, "current_half_track", {
  configurable: true,
  enumerable: true,
  get() { return _ht; },
  set(v: number) {
    if (v !== _ht && events.length < 100) {
      events.push({
        drv_clk: drv.clk_ptr.value >>> 0,
        c64_clk: session.c64Cpu.cycles >>> 0,
        drv_pc: drv_pc(),
        ht_before: _ht,
        ht_after: v,
        step: v - _ht,
      });
    }
    _ht = v;
  },
});

console.log(`Initial HT = ${d0.current_half_track}`);
console.log(`Running boot (2M c64 cycles)...`);
session.runFor(2_000_000);
console.log(`Post-boot HT = ${d0.current_half_track}`);
console.log("");

function hex(n: number, w = 2): string { return n.toString(16).padStart(w, "0"); }

console.log("HT change events during boot:");
console.log("idx | c64_clk    | drv_clk    | drv_pc | HT before→after  | step");
for (let i = 0; i < Math.min(events.length, 30); i++) {
  const e = events[i]!;
  console.log(
    `${String(i).padStart(3)} | ${String(e.c64_clk).padStart(10)} | ${String(e.drv_clk).padStart(10)} | $${hex(e.drv_pc, 4)}  | ${String(e.ht_before).padStart(3)} → ${String(e.ht_after).padStart(3)}      | ${e.step >= 0 ? "+" : ""}${e.step}`,
  );
}
console.log("");
console.log(`Total HT-change events during boot: ${events.length}`);
console.log(`Final HT after boot: ${d0.current_half_track}`);
console.log("");

// Now type LOAD$ and continue capture.
events.length = 0;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 6 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

console.log("HT change events during LOAD$ window:");
console.log("idx | c64_clk    | drv_clk    | drv_pc | HT before→after  | step");
for (let i = 0; i < Math.min(events.length, 50); i++) {
  const e = events[i]!;
  console.log(
    `${String(i).padStart(3)} | ${String(e.c64_clk).padStart(10)} | ${String(e.drv_clk).padStart(10)} | $${hex(e.drv_pc, 4)}  | ${String(e.ht_before).padStart(3)} → ${String(e.ht_after).padStart(3)}      | ${e.step >= 0 ? "+" : ""}${e.step}`,
  );
}
console.log(`Total HT-change events during LOAD$: ${events.length}`);
console.log(`Final HT after LOAD$: ${d0.current_half_track}`);
