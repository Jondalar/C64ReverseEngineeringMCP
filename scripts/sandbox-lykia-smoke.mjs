#!/usr/bin/env node
// Smoke-test for the new sandbox runner: replicates lykia_disk_depack.py on
// Lykia disk1 file 01 and compares the result against the Python reference.
//
// Usage:
//   npm run build:mcp && node scripts/sandbox-lykia-smoke.mjs
//
// Expects these inputs (matching the Python script defaults):
//   loader_runtime_0200.prg   (built loader runtime)
//   file_01_t01s17_load6711.bin   (raw LUT-extracted packed file)

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runSandbox } from "../dist/sandbox/index.js";

const LOADER = process.env.LYKIA_LOADER
  ?? "/Users/alex/Development/C64/Cracking/Lykia/analysis/disks/disk1/files_unpacked/loader_runtime_0200.prg";
const PACKED = process.env.LYKIA_PACKED
  ?? "/Users/alex/Development/C64/Cracking/Lykia/analysis/disks/disk1/files/file_01_t01s17_load6711.bin";
const PY_REF = process.env.LYKIA_PY_REF ?? "/tmp/sandbox-py-out.prg";
const TS_OUT = process.env.LYKIA_TS_OUT ?? "/tmp/sandbox-ts-out.prg";

const SRC_ADDR = 0x4000;
const ENTRY = 0x030d;

const packed = readFileSync(PACKED);

// Patch loader self-mod slots to point reads at SRC_ADDR (matches Python).
const result = runSandbox({
  loads: [
    { prgPath: LOADER },
    { rawPath: PACKED, address: SRC_ADDR },
    // Self-mod slot patches.
    { bytes: [SRC_ADDR & 0xff, (SRC_ADDR >> 8) & 0xff], address: 0x02c7 },
    { bytes: [SRC_ADDR & 0xff, (SRC_ADDR >> 8) & 0xff], address: 0x032f },
    { bytes: [(SRC_ADDR >> 8) & 0xff], address: 0x02ba },
  ],
  initialPc: ENTRY,
  initialZp: {
    0x04: packed[3] ?? 0xff,                 // end_hi from stream header
    0x05: 0x00,                              // bit-shift register
    0x06: ((packed[0] | (packed[1] << 8)) || 0x4000) & 0xff,
    0x07: (((packed[0] | (packed[1] << 8)) || 0x4000) >> 8) & 0xff,
  },
  inputStream: Array.from(packed),
  streamHookPcs: [0x0251, 0x0289],
  initialSp: 0xfd,
  // Restrict harvest to the destination range, excluding loader page itself.
  // (We re-filter manually below to drop the $0200-$03FF loader window.)
});

const written = result.writes.filter((w) => w.address >= 0x4000 && !(w.address >= 0x0200 && w.address <= 0x03ff));
const byAddr = new Map();
for (const w of written) byAddr.set(w.address, w.value);
const addrs = [...byAddr.keys()].sort((a, b) => a - b);
if (addrs.length === 0) {
  console.error("no output bytes produced");
  process.exit(2);
}
const lo = addrs[0];
const hi = addrs[addrs.length - 1];
const buf = Buffer.alloc(2 + (hi - lo + 1));
buf[0] = lo & 0xff;
buf[1] = (lo >> 8) & 0xff;
for (const [addr, value] of byAddr) buf[2 + (addr - lo)] = value;
writeFileSync(TS_OUT, buf);

const md5 = (path) => createHash("md5").update(readFileSync(path)).digest("hex");

console.log(`stop=${result.stopReason} steps=${result.steps} pc=$${result.finalState.pc.toString(16).padStart(4, "0")}`);
console.log(`TS  out: ${TS_OUT} ($${lo.toString(16).padStart(4, "0")}-$${hi.toString(16).padStart(4, "0")}, ${hi - lo + 1} bytes) md5=${md5(TS_OUT)}`);
try {
  console.log(`PY ref: ${PY_REF} md5=${md5(PY_REF)}`);
  if (md5(TS_OUT) === md5(PY_REF)) {
    console.log("MATCH");
  } else {
    console.log("MISMATCH");
    process.exit(1);
  }
} catch {
  console.log(`PY ref not found at ${PY_REF}; run the Python script first to compare.`);
}
