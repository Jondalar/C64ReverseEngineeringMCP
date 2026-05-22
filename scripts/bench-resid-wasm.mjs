#!/usr/bin/env node
// reSID WASM render cost — answers "how much runtime does reSID need" and which
// sampling method is affordable for live realtime playback.
//
// Renders SECONDS of audio (busy 3-voice patch) per sampling method and reports
// wall-time + realtime factor (xRT = how many times faster than realtime; >1 is
// affordable, <1 means it cannot keep up with the running machine).

import createResidModule from "../dist/runtime/headless/sid/wasm/resid.mjs";

const PAL = 985248;
const SR = 44100;
const SECONDS = 10;
const FRAME = 19656; // PAL cycles/frame — render in frame chunks like the live pump

const METHODS = [
  ["FAST        ", 0],
  ["INTERPOLATE ", 1],
  ["RESAMPLE    ", 2],
  ["RESAMPLE_FM ", 3],
];

const mod = await createResidModule();
const setChip = mod.cwrap("resid_set_chip_model", null, ["number"]);
const setMask = mod.cwrap("resid_set_voice_mask", null, ["number"]);
const enFilt = mod.cwrap("resid_enable_filter", null, ["number"]);
const setSamp = mod.cwrap("resid_set_sampling", "number", ["number", "number", "number"]);
const reset = mod.cwrap("resid_reset", null, []);
const write = mod.cwrap("resid_write", null, ["number", "number"]);
const clock = mod.cwrap("resid_clock", "number", ["number", "number", "number"]);
const clockRem = mod.cwrap("resid_clock_remaining", "number", []);
const MAX = 4096;
const buf = mod._malloc(MAX * 2);

function busyPatch() {
  // 3 voices, different waveforms + a filter sweep value.
  for (const [vb, ctrl, freq] of [[0x00, 0x21, 0x1d45], [0x07, 0x41, 0x0e22], [0x0e, 0x11, 0x2a88]]) {
    write(vb + 0x00, freq & 0xff);
    write(vb + 0x01, (freq >> 8) & 0xff);
    write(vb + 0x02, 0x00); write(vb + 0x03, 0x08); // pulse width
    write(vb + 0x05, 0x09); write(vb + 0x06, 0xa8); // AD / SR
    write(vb + 0x04, ctrl);
  }
  write(0x15, 0x00); write(0x16, 0x40); // filter cutoff
  write(0x17, 0xf1);                    // resonance + voices to filter
  write(0x18, 0x1f);                    // volume 15 + low-pass
}

console.log(`reSID render cost — ${SECONDS}s audio, PAL ${PAL}Hz → ${SR}Hz, 6581\n`);
for (const [name, method] of METHODS) {
  reset();
  setChip(0);
  setMask(0x07);
  enFilt(1);
  if (setSamp(PAL, SR, method) === 0) { console.log(`${name}  set_sampling FAILED`); continue; }
  busyPatch();

  const totalCycles = SECONDS * PAL;
  let produced = 0;
  const t0 = performance.now();
  let remaining = totalCycles;
  while (remaining > 0) {
    let dt = Math.min(FRAME, remaining);
    remaining -= dt;
    while (dt > 0) {
      const n = clock(dt, buf, MAX);
      produced += n;
      const rem = clockRem();
      if (n === 0 && rem >= dt) break;
      dt = rem;
    }
  }
  const ms = performance.now() - t0;
  const xRT = (SECONDS * 1000) / ms;
  console.log(
    `${name}  ${ms.toFixed(1).padStart(7)} ms   ${xRT.toFixed(1).padStart(6)}x realtime   ${produced} samples`,
  );
}
