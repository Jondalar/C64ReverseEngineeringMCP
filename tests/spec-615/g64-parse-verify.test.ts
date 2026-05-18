// RFL fsimage_gcr.ts vs G64 spec — direct read motm.g64 + parse + compare
// vs in-port parsed result.

import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const diskPath = resolvePath(
  import.meta.dirname, "..", "..", "samples/motm.g64",
);
const g64 = readFileSync(diskPath);

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}
function leWord(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function leDword(b: Uint8Array, off: number): number {
  return ((b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0);
}

console.log("=== motm.g64 file structure ===");
console.log(`File size: ${g64.length} bytes`);
console.log(`Magic: "${String.fromCharCode(...g64.subarray(0, 8))}"`);
console.log(`Version: ${g64[8]}`);
console.log(`Num half-tracks: ${g64[9]}`);
console.log(`Max track size: ${leWord(g64, 10)} ($${hex(leWord(g64, 10), 4)})`);

console.log(`\nPointer table entries (84 × 4 bytes at offset 12):`);
for (let i = 0; i < 84; i++) {
  const off = leDword(g64, 12 + i * 4);
  const ht = i + 2;
  if (ht >= 32 && ht <= 40) {
    let trackLen = -1;
    let firstBytes = "";
    if (off > 0 && off + 2 < g64.length) {
      trackLen = leWord(g64, off);
      firstBytes = Array.from(g64.subarray(off + 2, off + 2 + 8))
        .map((b) => hex(b)).join(" ");
    }
    console.log(`  HT${ht.toString().padStart(2)} (track ${ht / 2}): ptr_offset=$${hex(off, 6)}  track_len=${trackLen}  first8=[${firstBytes}]`);
  }
}

console.log(`\nSpeed zone table (84 × 4 bytes at offset ${12 + 84 * 4}):`);
for (let i = 32; i <= 40; i++) {
  const z = leDword(g64, 12 + 84 * 4 + i * 4);
  console.log(`  HT${(i + 2).toString().padStart(2)}: speed=$${hex(z, 8)}`);
}

// Now mount via port + compare HT36 buffer.
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, diskPath);
session.resetCold("pal-default");
session.runFor(100_000);

const drv = (session.kernel.drive1541 as { unit: any }).unit;
const d0 = drv.drives[0]!;
const image = d0.image;
console.log("\n=== Port-side parsed state ===");
console.log(`image.type = ${image?.type}`);
console.log(`image.max_half_tracks = ${image?.max_half_tracks}`);
console.log(`image.tracks = ${image?.tracks}`);
console.log(`d0.current_half_track = ${d0.current_half_track}`);
console.log(`d0.GCR_current_track_size = ${d0.GCR_current_track_size}`);
console.log(`d0.GCR_head_offset = ${d0.GCR_head_offset}`);

if (d0.GCR_track_start_ptr) {
  const ptr: Uint8Array = d0.GCR_track_start_ptr;
  console.log(`d0.GCR_track_start_ptr length: ${ptr.length}`);
  console.log(`First 32 bytes of HT36 buffer:`);
  let l = "  ";
  for (let i = 0; i < 32 && i < ptr.length; i++) l += hex(ptr[i]!) + " ";
  console.log(l);

  // Compare to direct G64 read.
  const ht36PtrOffset = leDword(g64, 12 + 34 * 4); // HT36 = index 34
  if (ht36PtrOffset > 0) {
    const directLen = leWord(g64, ht36PtrOffset);
    const directBytes = g64.subarray(ht36PtrOffset + 2, ht36PtrOffset + 2 + 32);
    console.log(`\nDirect-read HT36 from G64:`);
    console.log(`  ptr_offset = $${hex(ht36PtrOffset, 6)}, track_len = ${directLen}`);
    console.log(`  First 32 bytes:`);
    let l2 = "  ";
    for (let i = 0; i < 32; i++) l2 += hex(directBytes[i]!) + " ";
    console.log(l2);

    let match = true;
    for (let i = 0; i < 32; i++) {
      if (ptr[i] !== directBytes[i]) { match = false; break; }
    }
    console.log(`\nFirst-32-byte match: ${match ? "YES" : "NO"}`);
    console.log(`Lengths match: ${ptr.length === directLen ? "YES" : `NO (port=${ptr.length}, direct=${directLen})`}`);
  } else {
    console.log(`\nHT36 ptr_offset == 0 (empty track in G64)`);
  }
} else {
  console.log(`d0.GCR_track_start_ptr = null`);
}
