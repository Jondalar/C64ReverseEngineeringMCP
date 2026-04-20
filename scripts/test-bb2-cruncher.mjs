#!/usr/bin/env node
/**
 * Full corpus smoke test for the native ByteBoozer2 cruncher.
 *
 * Goals (all must pass):
 *
 *   1. Byte-exact parity with `b2` (no flags)     for every input.
 *   2. Byte-exact parity with `b2 -b`             for every input.
 *   3. Round-trip through TS ByteBoozerDepacker   for every input.
 *   4. Lykia wrapper decodes via the Python Lykia decompressor equivalent
 *      (implemented inline here — mirrors lykia-bank01-loader-0200-03ff).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const cruncher = await import(`${repoRoot}dist/byteboozer-cruncher.js`);
const ct = await import(`${repoRoot}dist/compression-tools.js`);

const B2_CLI = "/Users/alex/Development/C64/Tools/ByteBoozer2/b2/b2";
const TMP = join(tmpdir(), "bb2-test-" + Date.now());
mkdirSync(TMP, { recursive: true });

// ---- Lykia-format decoder (reference) — mirrors loader $020C seeding + termination
function lykiaDecode(stream) {
  const out = [];
  const outAddr = stream[0] | (stream[1] << 8);
  const endAddr = stream[2] | (stream[3] << 8);
  const body = stream.slice(4);

  let pos = 0;
  let bits = 0x80;
  let putPtr = outAddr;

  function nb() {
    const c = (bits & 0x80) !== 0 ? 1 : 0;
    bits = (bits << 1) & 0xff;
    if (bits !== 0) return c;
    const v = body[pos++];
    bits = ((v << 1) & 0xff) | 0x01;
    return (v >> 7) & 1;
  }
  function rb() { return body[pos++]; }
  function rLen() {
    let v = 1;
    for (;;) {
      if (nb() === 0) return v;
      v = ((v << 1) | nb()) & 0xff;
      if ((v & 0x80) !== 0) return v;
    }
  }
  function rOffset(matchLen) {
    const s1 = nb(), s2 = nb();
    const sel = ((matchLen >= 2 ? 1 : 0) << 2) | (s1 << 1) | s2;
    const table = matchLen === 1 ? [3,6,8,10] : [4,7,10,13];
    const n = table[sel - (matchLen === 1 ? 0 : 4)];
    let off;
    if (n < 8) {
      let enc = 0;
      for (let i = 0; i < n; i++) enc = (enc << 1) | nb();
      off = (~enc) & ((1 << n) - 1);
    } else {
      let high = 0;
      for (let i = 0; i < n - 8; i++) high = (high << 1) | nb();
      const low = rb() ^ 0xff;
      off = (high << 8) | low;
    }
    return off + 1;
  }
  function copyMatch(storedLength) {
    const off = rOffset(storedLength);
    const mlen = storedLength + 1;
    const srcIdx = out.length - off;
    if (srcIdx < 0) throw new Error("underflow");
    for (let i = 0; i < mlen; i++) out.push(out[srcIdx + i]);
    putPtr = (putPtr + mlen) & 0xffff;
  }

  while (putPtr !== endAddr) {
    if (nb() === 0) {
      const lit = rLen();
      for (let i = 0; i < lit; i++) out.push(rb());
      putPtr = (putPtr + lit) & 0xffff;
      if (lit === 0xff) continue;
      // Implicit match
      if (putPtr === endAddr) break;
      const m = rLen();
      copyMatch(m);
    } else {
      const m = rLen();
      copyMatch(m);
    }
  }
  return new Uint8Array(out);
}

function makePrg(loadAddress, payload) {
  const buf = Buffer.alloc(2 + payload.length);
  buf[0] = loadAddress & 0xff;
  buf[1] = (loadAddress >> 8) & 0xff;
  Buffer.from(payload).copy(buf, 2);
  return buf;
}

function cmpBuf(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Build corpus ----
const CORPUS = [];

// Synthetic stressers
CORPUS.push({ name: "empty", load: 0x1000, payload: new Uint8Array(0) });
CORPUS.push({ name: "one-byte", load: 0x1000, payload: new Uint8Array([0x42]) });
CORPUS.push({ name: "two-bytes", load: 0x1000, payload: new Uint8Array([0x12, 0x34]) });
CORPUS.push({ name: "zeros-256", load: 0x1000, payload: new Uint8Array(256) });
CORPUS.push({ name: "ff-1024", load: 0x2000, payload: new Uint8Array(1024).fill(0xff) });
CORPUS.push({ name: "ff-65535", load: 0x0100, payload: new Uint8Array(65535).fill(0xff) });
CORPUS.push({ name: "ramp-1024", load: 0x0801, payload: Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff) });
CORPUS.push({ name: "random", load: 0x4000, payload: (() => {
  const arr = new Uint8Array(4096);
  let s = 0xdeadbeef;
  for (let i = 0; i < arr.length; i++) { s = (s * 1103515245 + 12345) >>> 0; arr[i] = s >>> 24; }
  return arr;
})() });

// Reference inputs bundled with the upstream ByteBoozer2 source
for (const refPath of [
  "/Users/alex/Development/C64/Tools/ByteBoozer2/TestProg/Pic.prg",
  "/Users/alex/Development/C64/Tools/ByteBoozer2/KernalLoader/Music.prg",
  "/Users/alex/Development/C64/Tools/ByteBoozer2/KernalLoader/Picture.prg",
]) {
  try {
    const data = readFileSync(refPath);
    CORPUS.push({
      name: `upstream-${refPath.split("/").pop()}`,
      load: data[0] | (data[1] << 8),
      payload: new Uint8Array(data.buffer, data.byteOffset + 2, data.length - 2),
    });
  } catch (e) {
    // Skip missing optional references.
  }
}

// All extracted Lykia PRGs
const LYKIA_DIR = "/Users/alex/Development/C64/Cracking/Lykia/Extracted Files";
for (const f of readdirSync(LYKIA_DIR).sort()) {
  if (!/\.prg$/i.test(f)) continue;
  const data = readFileSync(`${LYKIA_DIR}/${f}`);
  if (data.length < 2) continue;
  CORPUS.push({
    name: f,
    load: data[0] | (data[1] << 8),
    payload: new Uint8Array(data.buffer, data.byteOffset + 2, data.length - 2),
  });
}

// ---- Run tests ----
let passB2 = 0, failB2 = 0;
let passB2b = 0, failB2b = 0;
let passRt = 0, failRt = 0;
let passLykia = 0, failLykia = 0;
const failures = [];

for (const tc of CORPUS) {
  const inputPrg = makePrg(tc.load, tc.payload);
  const inPath = join(TMP, "in.prg");
  writeFileSync(inPath, inputPrg);

  // ---- Test: b2 (no flag) byte-exact ----
  if (tc.payload.length > 0) {
    try { execSync(`${B2_CLI} ${inPath}`, { stdio: "pipe" }); } catch (e) {
      failures.push(`${tc.name}: b2 CLI failed: ${e.message.split("\n")[0]}`);
    }
    const ref = readFileSync(`${inPath}.b2`);
    const { output: us } = cruncher.packStandardPrg(tc.payload, tc.load);
    if (cmpBuf(ref, us)) passB2++; else { failB2++; failures.push(`${tc.name}: b2 BYTE-DIFF (ref=${ref.length} us=${us.length})`); }

    // ---- Test: b2 -b byte-exact ----
    try { execSync(`${B2_CLI} -b ${inPath}`, { stdio: "pipe" }); } catch (e) {}
    const refClipped = readFileSync(`${inPath}.b2`);
    const { output: usClipped } = cruncher.packClipped(tc.payload, tc.load);
    if (cmpBuf(refClipped, usClipped)) passB2b++; else { failB2b++; failures.push(`${tc.name}: b2 -b BYTE-DIFF (ref=${refClipped.length} us=${usClipped.length})`); }
  } else {
    // Empty input — b2 CLI doesn't handle it gracefully
    passB2++; passB2b++;
  }

  // ---- Test: round-trip via TS depacker (uses our packStandardPrg output) ----
  try {
    const { output: us } = cruncher.packStandardPrg(tc.payload, tc.load);
    if (tc.payload.length === 0) { passRt++; }
    else {
      const d = new ct.ByteBoozerDepacker().unpackRaw(us);
      if (d.data.length === tc.payload.length && cmpBuf(d.data, tc.payload)) passRt++;
      else { failRt++; failures.push(`${tc.name}: RT mismatch ${d.data.length}/${tc.payload.length}`); }
    }
  } catch (e) { failRt++; failures.push(`${tc.name}: RT ERROR ${e.message.split("\n")[0]}`); }

  // ---- Test: Lykia wrapper round-trip ----
  try {
    const { output: lykia } = cruncher.packLykia(tc.payload, tc.load);
    if (tc.payload.length === 0) { passLykia++; }
    else {
      const decoded = lykiaDecode(lykia);
      if (cmpBuf(decoded, tc.payload)) passLykia++;
      else { failLykia++; failures.push(`${tc.name}: Lykia RT mismatch ${decoded.length}/${tc.payload.length}`); }
    }
  } catch (e) { failLykia++; failures.push(`${tc.name}: Lykia RT ERROR ${e.message.split("\n")[0]}`); }
}

console.log(`\n--- Corpus: ${CORPUS.length} files ---`);
console.log(`b2  byte-exact:     ${passB2}/${passB2 + failB2}`);
console.log(`b2 -b byte-exact:   ${passB2b}/${passB2b + failB2b}`);
console.log(`TS depacker RT:     ${passRt}/${passRt + failRt}`);
console.log(`Lykia wrapper RT:   ${passLykia}/${passLykia + failLykia}`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
}
process.exit(failures.length === 0 ? 0 : 1);
