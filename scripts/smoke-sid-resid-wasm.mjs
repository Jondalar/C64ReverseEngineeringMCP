#!/usr/bin/env node
// Spec 703.3/703.4 smoke — reSID WASM engine produces audible PCM.
//
// Builds a single sawtooth voice with sustain held, advances the engine, and
// asserts: module loads, sample count tracks cycles, and the PCM is non-silent
// with reasonable amplitude. Run: npm run smoke:sid-resid-wasm

import { ResidWasm } from "../dist/runtime/headless/sid/resid-wasm-engine.js";

const PAL = 985248;
const SR = 44100;
const D = (r) => 0xd400 + r;

let failed = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failed++;
}

const sid = new ResidWasm(undefined, { sampleRate: SR, clockFreq: PAL, model: "6581" });
await sid.ready();
check("module ready", true);

// Voice 1: A≈440Hz sawtooth, full sustain, max volume.
// freq = f * 16777216 / clock ≈ 440 * 16.777M / 985248 ≈ 7493 = 0x1d45
sid.write(D(0x00), 0x45);
sid.write(D(0x01), 0x1d);
sid.write(D(0x05), 0x00); // attack=0 decay=0
sid.write(D(0x06), 0xf0); // sustain=15 release=0
sid.write(D(0x18), 0x0f); // volume 15
sid.write(D(0x04), 0x21); // sawtooth + gate on

// Readback coherence (§7 bridge via inner Sid6581).
check("readback regs[0x18]", (sid.regs[0x18] & 0x0f) === 0x0f, `vol=${sid.regs[0x18] & 0x0f}`);

// Advance ~10 PAL frames; collect samples.
const FRAME = 19656;
let total = 0;
let nonZero = 0;
let peak = 0;
for (let f = 0; f < 10; f++) {
  const buf = sid.emit(FRAME);
  total += buf.length;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) nonZero++;
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
}

const expected = Math.round((10 * FRAME * SR) / PAL);
check("sample count ~ cycles", Math.abs(total - expected) <= 4, `got ${total}, expect ≈${expected}`);
check("PCM non-silent", nonZero > total * 0.5, `${nonZero}/${total} non-zero`);
check("amplitude plausible", peak > 1000, `peak=${peak}`);

// Each of the 3 voices must be audible on its own (catches a muted
// voice_mask — VICE inits 0x07; the reSID ctor does not).
for (const [vname, vbase] of [["v1", 0x00], ["v2", 0x07], ["v3", 0x0e]]) {
  const s = new ResidWasm(undefined, { sampleRate: SR, clockFreq: PAL, model: "6581" });
  await s.ready();
  s.write(D(vbase + 0x00), 0x45);
  s.write(D(vbase + 0x01), 0x1d);
  s.write(D(vbase + 0x05), 0x00);
  s.write(D(vbase + 0x06), 0xf0);
  s.write(D(0x18), 0x0f);
  s.write(D(vbase + 0x04), 0x21); // saw + gate
  let vp = 0;
  for (let f = 0; f < 6; f++) {
    const b = s.emit(FRAME);
    for (let i = 0; i < b.length; i++) vp = Math.max(vp, Math.abs(b[i]));
  }
  check(`voice ${vname} audible`, vp > 1000, `peak=${vp}`);
}

// Gate off → release to silence over time.
sid.write(D(0x04), 0x20); // gate off
for (let f = 0; f < 60; f++) sid.emit(FRAME);
const tail = sid.emit(FRAME);
let tailPeak = 0;
for (let i = 0; i < tail.length; i++) tailPeak = Math.max(tailPeak, Math.abs(tail[i]));
check("decays after gate-off", tailPeak < peak, `tailPeak=${tailPeak} < peak=${peak}`);

console.log(failed === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
