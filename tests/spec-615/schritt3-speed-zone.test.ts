// SCHRITT 3: speed-zone for HT36 in motm.g64 + runtime state.
import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const g64 = readFileSync(resolvePath(import.meta.dirname, "..", "..", "samples/motm.g64"));

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}
function leDword(off: number): number {
  return ((g64[off]! | (g64[off + 1]! << 8) | (g64[off + 2]! << 16) | (g64[off + 3]! << 24)) >>> 0);
}

// Speed-zone table at 0x15C + (HT-2)*4 = 0x15C + 0x88 = 0x1E4
const speedFileOff = 0x15c + (36 - 2) * 4;
const speedVal = leDword(speedFileOff);
console.log(`speed_zone_HT36 in file (uint32 LE at 0x${hex(speedFileOff, 4)}) = 0x${hex(speedVal, 8)} = ${speedVal}`);

// Runtime state after mount.
const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "..", "samples/motm.g64"));

// rotation slot for drive 0.
const rotationMod = await import("../../dist/runtime/headless/vice1541/rotation.js");
// rotation array is module-private; access via export rotation_table_get / set or via debug.
// Use rotation_table_get to read speed_zone for dnr=0.
const tbl = { value: 0 };
const ptr = { value: 0 };
rotationMod.rotation_table_get(0, tbl, ptr);
console.log(`drv runtime rotation[0].speed_zone (via rotation_table_get) = ${tbl.value}`);
