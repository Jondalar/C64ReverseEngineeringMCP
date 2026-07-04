// Spec 784 B1 — the abstract extractor-manifest contract validator.
// THE point: a disk-span manifest AND a cart-slot-span manifest validate through
// the SAME path (no branch above the block layer); missing spans/derivedBy are
// rejected; a brand-new loader `kind` string is accepted without a code change.
// Run: npm run build:mcp first, then node scripts/e2e-loader-manifest.mjs
import { validateManifest, mediumDerivationForKind } from "../dist/server-tools/loader-manifest.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log("loader-manifest B1 — abstract contract, one path for disk + cart\n");

// Pawn — custom sector-stream loader, disk spans (full chain, not start-only).
const diskManifest = {
  manifestVersion: 1, extractor: "pawn-serial", sourceImage: "the_pawn_s1.g64",
  loaderModels: [{ id: "pawn-serial", kind: "sector-stream", indexLocation: "T01/S02 4-byte records" }],
  payloads: [{
    name: "PAWN.PRG", derivedBy: "pawn-serial", loadAddress: 0x0800, format: "raw", contentHash: "sha256:ab",
    spans: [{ kind: "sector", track: 33, sector: 0, length: 254 }, { kind: "sector", track: 33, sector: 1, length: 254 }],
  }],
};
// Lykia — cart LUT loader, slot spans. SAME schema, different medium.
const slotManifest = {
  manifestVersion: 1, extractor: "lykia-lut", sourceImage: "lykianew.crt",
  loaderModels: [{ id: "lykia-runtime", kind: "cart-lut", indexLocation: "runtime LUTs A-E via ZP $0D" }],
  payloads: [{
    name: "file_042", derivedBy: "lykia-runtime", loadAddress: 0x2000, format: "byteboozer-lykia",
    spans: [{ kind: "slot", bank: 12, slot: "ROML", offsetInBank: 0, length: 8192 }],
  }],
};

ok(validateManifest(diskManifest).ok, "disk-span manifest accepted");
ok(validateManifest(slotManifest).ok, "cart-slot-span manifest accepted THROUGH THE SAME path");

const noSpans = clone(diskManifest); noSpans.payloads[0].spans = [];
ok(validateManifest(noSpans).ok === false, "payload with empty spans rejected");

const noDerived = clone(diskManifest); delete noDerived.payloads[0].derivedBy;
ok(validateManifest(noDerived).ok === false, "payload missing derivedBy rejected");

const badRef = clone(diskManifest); badRef.payloads[0].derivedBy = "nope";
const br = validateManifest(badRef);
ok(br.ok === false && br.errors.some((e) => e.includes("does not match")), "unresolved derivedBy rejected (referential)", br.errors.join("; "));

const dupLm = clone(diskManifest); dupLm.loaderModels.push({ id: "pawn-serial", kind: "dos" });
ok(validateManifest(dupLm).ok === false, "duplicate loaderModel id rejected");

const noLm = clone(diskManifest); noLm.loaderModels = [];
ok(validateManifest(noLm).ok === false, "empty loaderModels rejected");

const startOnly = clone(diskManifest); // full chain present — the anti-168/1329 shape
ok(validateManifest(startOnly).ok && startOnly.payloads[0].spans.length > 1, "full multi-span chain (not start-only) accepted");

const newKind = clone(diskManifest); newKind.loaderModels[0].kind = "magnetic-scrolls-v2";
ok(validateManifest(newKind).ok === true, "brand-new loader kind accepted (open string, no code change)");

// kind -> MediumDerivation enum mapping (used by B2).
ok(mediumDerivationForKind("dos") === "kernal-directory", "dos -> kernal-directory");
ok(mediumDerivationForKind("cart-lut") === "cart-lut", "cart-lut -> cart-lut");
ok(mediumDerivationForKind("cross-bank-packer") === "cart-lut", "cross-bank-packer -> cart-lut");
ok(mediumDerivationForKind("sector-stream") === "custom-lut", "sector-stream -> custom-lut");
ok(mediumDerivationForKind("something-brand-new") === "custom-lut", "unknown kind -> custom-lut fallback");

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-manifest B1: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
