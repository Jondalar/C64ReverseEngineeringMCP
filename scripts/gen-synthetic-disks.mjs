#!/usr/bin/env node
// Spec 097 (M0.4b) — synthetic disk fixture generator.
//
// Generates deterministic D64/G64 fixtures for the LOAD acceptance smoke
// matrix and Spec 094's 1-byte trace fixture.
//
// Output:
//   samples/synthetic/1byte.d64
//   samples/synthetic/1byte.g64
//   samples/synthetic/1block.g64   (256-byte payload)
//
// Usage: node scripts/gen-synthetic-disks.mjs [--out=samples/synthetic]

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.out ?? "samples/synthetic";

let buildD64, buildG64, G64Parser, decodeGCRHeader, decodeGCRDataBlock;
try {
  ({ buildD64 } = await import("../dist/disk/d64-builder.js"));
  ({ buildG64 } = await import("../dist/disk/g64-builder.js"));
  ({ G64Parser } = await import("../dist/disk/g64-parser.js"));
  ({ decodeGCRHeader, decodeGCRDataBlock } = await import("../dist/disk/gcr.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// L1: 1-byte file. Payload = $0801 load-address + 1 data byte = 3 bytes.
const onebytePayload = new Uint8Array([0x01, 0x08, 0x42]);
const oneblockPayload = (() => {
  // 256 bytes with a varied pattern: alternating, runs, ramp, sync-ish.
  const buf = new Uint8Array(258); // 2 load addr + 256 data
  buf[0] = 0x01; buf[1] = 0x08;
  for (let i = 0; i < 64; i++)  buf[2 + i] = i & 0xff;             // ramp
  for (let i = 0; i < 64; i++)  buf[2 + 64 + i] = i & 1 ? 0xff : 0x00; // alt
  for (let i = 0; i < 64; i++)  buf[2 + 128 + i] = 0x55;            // half-pattern
  for (let i = 0; i < 64; i++)  buf[2 + 192 + i] = 0xaa;
  return buf;
})();

const fixtures = [
  {
    label: "1byte.d64",
    kind: "d64",
    diskName: "ONEBYTE",
    files: [{ name: "X", payload: onebytePayload }],
  },
  {
    label: "1byte.g64",
    kind: "g64",
    diskName: "ONEBYTE",
    files: [{ name: "X", payload: onebytePayload }],
  },
  {
    label: "1block.g64",
    kind: "g64",
    diskName: "ONEBLOCK",
    files: [{ name: "X", payload: oneblockPayload }],
  },
];

let exitCode = 0;
for (const f of fixtures) {
  const d64 = buildD64({ diskName: f.diskName, files: f.files });
  let bytes;
  if (f.kind === "d64") {
    bytes = d64;
  } else {
    bytes = buildG64({ d64 });
    // Round-trip smoke: parse the G64 and verify track 17 sector 0 decodes.
    const parser = new G64Parser(bytes);
    const file = f.files[0];
    const startTrack = file.startTrack ?? 17;
    const startSector = file.startSector ?? 0;
    const halfTrackData = parser.getRawTrackBytes(startTrack);
    if (!halfTrackData) {
      console.error(`${f.label}: parser.getRawTrackBytes(${startTrack}) returned null`);
      exitCode = 1;
      continue;
    }
    // Locate first SYNC (≥10 ones), then header GCR, then verify track/sector.
    const found = findFirstHeader(halfTrackData);
    if (!found.ok) {
      console.error(`${f.label}: header decode failed: ${found.reason}`);
      exitCode = 1;
      continue;
    }
    if (found.track !== startTrack || found.sector !== startSector) {
      console.error(`${f.label}: header track/sector mismatch — expected ${startTrack}/${startSector}, got ${found.track}/${found.sector}`);
      exitCode = 1;
      continue;
    }
  }
  const path = `${outDir}/${f.label}`;
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`wrote ${path} (${bytes.length} bytes)`);
}

function findFirstHeader(track) {
  // SYNC = 10+ consecutive 1 bits. We expect 5 × 0xff at start.
  // Walk forward for first byte that's not 0xff after a SYNC region.
  let i = 0;
  while (i < track.length && track[i] !== 0xff) i++;
  while (i < track.length && track[i] === 0xff) i++;
  // i now points at first non-0xff byte after SYNC. That is the first
  // GCR header byte.
  const h = decodeGCRHeader(track, i);
  if (!h.gcrValid) return { ok: false, reason: "gcrValid=false" };
  if (!h.valid)    return { ok: false, reason: `header valid=false (chk=${h.checksum} calc=${(h.sector ^ h.track ^ h.id2 ^ h.id1) & 0xff})` };
  return { ok: true, track: h.track, sector: h.sector, id1: h.id1, id2: h.id2 };
}

void decodeGCRDataBlock;
process.exit(exitCode);
