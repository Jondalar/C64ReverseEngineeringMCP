// Spec 150 — VIC-II test scaffolding (mirror of cia-test-helpers.ts).

import { alarm_context_new } from "../../../src/runtime/headless/alarm/alarm-context.js";
import { VicIIVice, type VicBackend } from "../../../src/runtime/headless/vic/vic-ii-vice.js";

export interface VicBackendEvents {
  steals: Array<{ count: number; clk: number }>;
  irqLine: Array<{ asserted: boolean; clk: number }>;
}

export function makeMockVicBackend(): { backend: VicBackend; events: VicBackendEvents } {
  const events: VicBackendEvents = { steals: [], irqLine: [] };
  const backend: VicBackend = {
    stealCpuCycles: (count, clk) => { events.steals.push({ count, clk }); },
    setIrqLine: (asserted, clk) => { events.irqLine.push({ asserted, clk }); },
    readVbus: () => 0,
    readColorRam: () => 0,
  };
  return { backend, events };
}

export function makeTestVic(opts?: { startClk?: number; ntsc?: boolean }): {
  vic: VicIIVice;
  events: VicBackendEvents;
  clk: { v: number };
} {
  const clk = { v: opts?.startClk ?? 0 };
  const ctx = alarm_context_new("test_maincpu");
  const { backend, events } = makeMockVicBackend();
  const vic = new VicIIVice({
    backend,
    alarmContext: ctx,
    clkPtr: () => clk.v,
    name: "TEST_VIC",
    ntsc: !!opts?.ntsc,
  });
  vic.powerup();
  // Drain reset-time setIrqLine pulse so test assertions start clean.
  events.irqLine.length = 0;
  events.steals.length = 0;
  return { vic, events, clk };
}
