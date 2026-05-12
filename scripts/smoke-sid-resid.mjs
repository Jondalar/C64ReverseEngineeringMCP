#!/usr/bin/env node
// Spec 263 — resid TS port + audio pipeline smoke (8+ cases).

import { resolve as resolvePath } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { Resid, PAL_CLOCK_FREQ, DEFAULT_SAMPLE_RATE } =
  await import(`${repoRoot}/dist/runtime/headless/sid/resid.js`);
const { Sid6581 } = await import(`${repoRoot}/dist/runtime/headless/sid/sid.js`);
const { createSid, isAudioSid } =
  await import(`${repoRoot}/dist/runtime/headless/sid/sid-engine.js`);
const { AudioRingBuffer, monoToStereoLR, int16ToLeBytes } =
  await import(`${repoRoot}/dist/runtime/headless/audio/audio-buffer.js`);
const { writeWav, readWav, buildWav, parseWav } =
  await import(`${repoRoot}/dist/runtime/headless/audio/wav-writer.js`);

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

console.log("=== Spec 263 — SID resid + audio pipeline ===\n");

// ---- Test 1: resid voice waveform output (sawtooth produces non-zero PCM) ----
{
  const r = new Resid();
  // Voice 1: sawtooth, freq ~440Hz @ PAL → freq16 = 440 * 16777216 / 985248 ≈ 7493
  // SID freq formula: f = (Fout / Fclk) * 16777216 / 256 (raw 16-bit). Use simpler:
  // freq16 ≈ 7493 (= sawtooth at A4).
  r.write(0xD400, 7493 & 0xff);
  r.write(0xD401, (7493 >> 8) & 0xff);
  r.write(0xD405, 0x09); // attack=0 decay=9
  r.write(0xD406, 0xf0); // sustain=15 release=0
  r.write(0xD418, 0x0f); // master volume = 15
  r.write(0xD404, 0x21); // GATE | SAW
  // Run ~50ms → ~2200 samples
  const samples = r.emit(Math.floor(0.05 * PAL_CLOCK_FREQ));
  const nonZero = samples.filter(s => s !== 0).length;
  const max = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  test("1. saw waveform produces non-trivial PCM",
       nonZero > 100 && max > 100, `nonZero=${nonZero} max=${max} len=${samples.length}`);
}

// ---- Test 2: envelope ADSR shape (attack ramps from 0 to peak) ----
{
  const r = new Resid();
  r.write(0xD400, 0xff); r.write(0xD401, 0x10); // mid-range freq
  r.write(0xD405, 0x90); // attack=9 (~250ms), decay=0
  r.write(0xD406, 0xff); // sustain=15 release=15
  r.write(0xD418, 0x0f);
  r.write(0xD404, 0x21); // GATE | SAW
  // Take peaks across 0..200ms; should rise monotonically.
  const win = Math.floor(0.02 * PAL_CLOCK_FREQ);
  const peaks = [];
  for (let i = 0; i < 10; i++) {
    const s = r.emit(win);
    let p = 0;
    for (const v of s) if (Math.abs(v) > p) p = Math.abs(v);
    peaks.push(p);
  }
  // Late peak >> early peak
  const ok = peaks[9] > peaks[0] && peaks[9] > 200;
  test("2. envelope attack ramps", ok, `peaks=[${peaks.join(",")}]`);
}

// ---- Test 3: filter cutoff applied (mute via low-pass at fc=0) ----
{
  const noFilter = new Resid();
  const filtered = new Resid();
  for (const r of [noFilter, filtered]) {
    r.write(0xD400, 0xff); r.write(0xD401, 0x40); // higher freq
    r.write(0xD405, 0x09); r.write(0xD406, 0xf0);
    r.write(0xD418, 0x0f);
    r.write(0xD404, 0x21); // GATE | SAW
  }
  // Filtered: route V1, low-pass mode, cutoff = 0.
  filtered.write(0xD415, 0x00);
  filtered.write(0xD416, 0x00);
  filtered.write(0xD417, 0x01); // route V1
  filtered.write(0xD418, 0x1f); // mode=LP | vol=15
  const cycles = Math.floor(0.05 * PAL_CLOCK_FREQ);
  const a = noFilter.emit(cycles);
  const b = filtered.emit(cycles);
  const energyA = a.reduce((s, v) => s + v * v, 0);
  const energyB = b.reduce((s, v) => s + v * v, 0);
  const ratio = energyB / Math.max(1, energyA);
  test("3. low-pass at fc=0 attenuates high freq", ratio < 0.7,
       `noFilterE=${energyA.toExponential(2)} filteredE=${energyB.toExponential(2)} ratio=${ratio.toFixed(3)}`);
}

// ---- Test 4: register write changes audible parameter ----
{
  const r = new Resid();
  r.write(0xD400, 0xff); r.write(0xD401, 0x40);
  r.write(0xD405, 0x09); r.write(0xD406, 0xf0);
  r.write(0xD418, 0x0f);
  r.write(0xD404, 0x21);
  const before = r.emit(50000);
  // Change to noise — different waveform should produce different PCM.
  r.write(0xD404, 0x81); // GATE | NOISE
  const after = r.emit(50000);
  const minLen = Math.min(before.length, after.length);
  let differ = 0;
  for (let i = 0; i < minLen; i++) if (before[i] !== after[i]) differ++;
  // Expect majority of samples to differ.
  test("4. waveform-bit change → different audio output", differ >= minLen / 2 && minLen > 100,
       `differ=${differ}/${minLen}`);
}

// ---- Test 5: WAV export round-trip ----
{
  const tmp = `${tmpdir()}/spec263-roundtrip-${process.pid}.wav`;
  // Build deterministic test signal.
  const n = 2205; // 50ms mono
  const mono = new Int16Array(n);
  for (let i = 0; i < n; i++) mono[i] = Math.floor(10000 * Math.sin(2 * Math.PI * i / 50));
  const stereo = monoToStereoLR(mono);
  writeWav(tmp, stereo, { sampleRate: 44100, channels: 2 });
  const parsed = readWav(tmp);
  let ok = parsed.sampleRate === 44100 && parsed.channels === 2 &&
           parsed.bitsPerSample === 16 && parsed.samples.length === stereo.length;
  for (let i = 0; ok && i < stereo.length; i++) ok = parsed.samples[i] === stereo[i];
  test("5. WAV export round-trip byte-equal", ok,
       `len=${parsed.samples.length} sr=${parsed.sampleRate} ch=${parsed.channels}`);
  if (existsSync(tmp)) unlinkSync(tmp);
}

// ---- Test 6: audio ring buffer producer/consumer ----
{
  const buf = new AudioRingBuffer({ capacitySamples: 1024, sampleRate: 44100 });
  buf.attach("c1");
  buf.attach("c2");
  const data = new Int16Array(500);
  for (let i = 0; i < 500; i++) data[i] = i;
  buf.write(data);
  const r1 = buf.read("c1", 500);
  const r2 = buf.read("c2", 200);
  let ok = r1.samples.length === 500 && r2.samples.length === 200;
  for (let i = 0; ok && i < 500; i++) ok = r1.samples[i] === i;
  for (let i = 0; ok && i < 200; i++) ok = r2.samples[i] === i;
  ok = ok && !r1.overflowed && !r2.overflowed;
  // Overflow test
  buf.write(new Int16Array(1500));
  const r1b = buf.read("c1", 2000);
  ok = ok && r1b.overflowed;
  test("6. audio ring buffer producer + 2 consumers + overflow", ok,
       `r1=${r1.samples.length} r2=${r2.samples.length} overflow=${r1b.overflowed}`);
}

// ---- Test 7: engine selector switches resid/fastsid ----
{
  const fast = createSid({ engine: "fastsid" });
  const res = createSid({ engine: "resid" });
  const okFast = !isAudioSid(fast) && fast instanceof Sid6581;
  const okRes = isAudioSid(res) && typeof res.emit === "function";
  // Env-var fallback
  process.env.C64RE_SID_ENGINE = "resid";
  const env = createSid();
  const okEnv = isAudioSid(env);
  delete process.env.C64RE_SID_ENGINE;
  const def = createSid();
  const okDef = !isAudioSid(def);
  test("7. engine selector resid/fastsid + env + default",
       okFast && okRes && okEnv && okDef,
       `fast=${okFast} resid=${okRes} env=${okEnv} default=${okDef}`);
}

// ---- Test 8: determinism — 2x same scenario → byte-equal WAV ----
{
  function run() {
    const r = new Resid();
    r.write(0xD400, 0xff); r.write(0xD401, 0x10);
    r.write(0xD405, 0x09); r.write(0xD406, 0xf0);
    r.write(0xD418, 0x0f);
    r.write(0xD404, 0x21);
    const out = [];
    for (let i = 0; i < 5; i++) out.push(r.emit(20000));
    let total = 0;
    for (const c of out) total += c.length;
    const merged = new Int16Array(total);
    let off = 0;
    for (const c of out) { merged.set(c, off); off += c.length; }
    return monoToStereoLR(merged);
  }
  const a = run();
  const b = run();
  let ok = a.length === b.length && a.length > 100;
  for (let i = 0; ok && i < a.length; i++) ok = a[i] === b[i];
  // Build WAV bytes too — must be byte-equal.
  const wavA = buildWav(a, { sampleRate: 44100, channels: 2 });
  const wavB = buildWav(b, { sampleRate: 44100, channels: 2 });
  let okW = wavA.length === wavB.length;
  for (let i = 0; okW && i < wavA.length; i++) okW = wavA[i] === wavB[i];
  test("8. determinism — 2x same scenario → byte-equal PCM + WAV",
       ok && okW, `pcmEq=${ok} wavEq=${okW} len=${a.length}`);
}

// ---- Test 9: int16ToLeBytes encoding ----
{
  const s = new Int16Array([0, 1, -1, 32767, -32768]);
  const bytes = int16ToLeBytes(s);
  // 0=00 00, 1=01 00, -1=ff ff, 32767=ff 7f, -32768=00 80
  const expected = [0, 0, 1, 0, 0xff, 0xff, 0xff, 0x7f, 0, 0x80];
  let ok = bytes.length === 10;
  for (let i = 0; ok && i < expected.length; i++) ok = bytes[i] === expected[i];
  test("9. int16ToLeBytes little-endian encoding", ok,
       `bytes=${Array.from(bytes).map(b => b.toString(16)).join(",")}`);
}

// ---- Summary ----
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
console.log(`\nsummary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
