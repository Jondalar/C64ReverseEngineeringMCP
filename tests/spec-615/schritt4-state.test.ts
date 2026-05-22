// SCHRITT 4 Action A: dump 4 state lines after mount motm.g64.
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

console.log(`complicated_image_loaded = ${d0.complicated_image_loaded}`);
console.log(`image.type               = ${d0.image?.type}`);
console.log(`GCR_image_loaded         = ${d0.GCR_image_loaded}`);
let path = "?";
if (d0.complicated_image_loaded) {
  path = d0.P64_image_loaded ? "p64" : "gcr";
} else {
  path = "simple";
}
console.log(`active rotation path     = ${path}`);
