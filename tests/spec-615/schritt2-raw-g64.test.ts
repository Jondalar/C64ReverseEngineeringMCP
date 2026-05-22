// Spec 615 SCHRITT 2: raw G64 file parse for motm.g64, HT36 expected.
import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const g64 = readFileSync(resolvePath(import.meta.dirname, "..", "..", "samples/motm.g64"));

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}
function leWord(off: number): number { return g64[off]! | (g64[off + 1]! << 8); }
function leDword(off: number): number {
  return ((g64[off]! | (g64[off + 1]! << 8) | (g64[off + 2]! << 16) | (g64[off + 3]! << 24)) >>> 0);
}

const magic = Array.from(g64.subarray(0, 8)).map((b) => hex(b)).join(" ");
console.log(`G64 header magic   = ${magic}  ("${String.fromCharCode(...g64.subarray(0, 8))}")`);
console.log(`num_half_tracks    = ${g64[9]}`);
console.log(`half_track_size_hdr = ${leWord(10)}`);

// Try 3 indexing hypotheses.
const HT = 36;
const idx_minus2 = HT - 2;  // VICE port: (half_track - 2) * 4
const idx_minus1 = HT - 1;  // user's 1-indexed guess
const idx_plus0 = HT;       // user's 0-indexed guess

for (const [name, idx] of [["(HT-2)*4 [VICE-port]", idx_minus2], ["(HT-1)*4", idx_minus1], ["HT*4", idx_plus0]] as const) {
  const ptr = leDword(12 + idx * 4);
  const sane = ptr > 0 && ptr + 2 < g64.length;
  console.log(`pointer_for_HT36 [${name}] @ file 0x${hex(12 + idx * 4, 4)} = 0x${hex(ptr, 6)}  (sane=${sane})`);
  if (sane) {
    const sz = leWord(ptr);
    const bytes = Array.from(g64.subarray(ptr + 2, ptr + 2 + 16)).map((b) => hex(b)).join(" ");
    console.log(`  size_at_pointer    = ${sz}`);
    console.log(`  first 16 bytes at pointer+2 = ${bytes}`);
  }
}
