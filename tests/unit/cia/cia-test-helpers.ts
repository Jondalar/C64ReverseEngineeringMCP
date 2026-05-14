// Spec 145 — shared CIA test scaffolding.
//
// VICE-faithful unit tests need: a mock backend that records calls,
// a maincpu alarm context, and a CPU-clock pointer the test owns.

import { alarm_context_new } from "../../../src/runtime/headless/alarm/alarm-context.js";
import { Cia6526Vice, type CiaBackend } from "../../../src/runtime/headless/cia/cia6526-vice.js";

export interface BackendEvents {
  storePa: Array<{ val: number; old: number }>;
  storePb: Array<{ val: number; old: number }>;
  pulsePc: number;
  setIntClk: Array<{ val: number; clk: number }>;
  storeSdr: Array<number>;
  setSp: Array<boolean>;
  setCnt: Array<boolean>;
}

export function makeMockBackend(opts?: {
  paPins?: number; pbPins?: number;
}): { backend: CiaBackend; events: BackendEvents; portA: { pins: number }; portB: { pins: number } } {
  const events: BackendEvents = {
    storePa: [], storePb: [], pulsePc: 0, setIntClk: [],
    storeSdr: [], setSp: [], setCnt: [],
  };
  const portA = { pins: opts?.paPins ?? 0xff };
  const portB = { pins: opts?.pbPins ?? 0xff };
  const backend: CiaBackend = {
    storePa: (val, old) => { events.storePa.push({ val, old }); },
    storePb: (val, old) => { events.storePb.push({ val, old }); },
    readPa: () => portA.pins,
    readPb: () => portB.pins,
    pulsePc: () => { events.pulsePc++; },
    setIntClk: (val, clk) => { events.setIntClk.push({ val, clk }); },
    storeSdr: (b) => { events.storeSdr.push(b); },
    setSp: (b) => { events.setSp.push(b); },
    setCnt: (b) => { events.setCnt.push(b); },
  };
  return { backend, events, portA, portB };
}

/** Build a Cia6526Vice fully wired for unit tests. Caller controls clk. */
export function makeTestCia(opts?: {
  paPins?: number; pbPins?: number;
  ticksPerSec?: number; powerFreq?: number;
  startClk?: number;
  model?: number;
  writeOffset?: number;
}): {
  cia: Cia6526Vice;
  events: BackendEvents;
  portA: { pins: number };
  portB: { pins: number };
  clk: { v: number };
} {
  const clk = { v: opts?.startClk ?? 1000 };
  const ctx = alarm_context_new("test_maincpu");
  const { backend, events, portA, portB } = makeMockBackend({ paPins: opts?.paPins, pbPins: opts?.pbPins });
  const cia = new Cia6526Vice({
    backend,
    alarmContext: ctx,
    clkPtr: () => clk.v,
    name: "TEST_CIA",
    ticksPerSec: opts?.ticksPerSec ?? 985248,
    powerFreq: opts?.powerFreq ?? 50,
    model: opts?.model,
    writeOffset: opts?.writeOffset,
  });
  cia.reset();
  return { cia, events, portA, portB, clk };
}
