// Spec 615 SCHRITT 1: mount motm.g64 only. Report 4 state lines.
import { resolve as resolvePath } from "node:path";

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

const drv = (session.kernel.drive1541 as { unit: any }).unit;
const d0 = drv.drives[0];

function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

console.log(`drv.current_half_track = ${d0.current_half_track}`);
const ptr = d0.GCR_track_start_ptr;
const trackBuf = d0.image?.gcr?.tracks?.[34]?.data ?? null;
console.log(`drv.GCR_track_start_ptr === image.gcr.tracks[34].data ? ${ptr === trackBuf}`);
console.log(`drv.GCR_current_track_size = ${d0.GCR_current_track_size}`);
if (ptr !== null && ptr instanceof Uint8Array) {
  const bytes: string[] = [];
  for (let i = 0; i < 16 && i < ptr.length; i++) bytes.push(hex(ptr[i]!));
  console.log(`first 16 bytes of GCR_track_start_ptr: ${bytes.join(" ")}`);
} else {
  console.log(`GCR_track_start_ptr = ${ptr === null ? "null" : "non-Uint8Array"}`);
}
