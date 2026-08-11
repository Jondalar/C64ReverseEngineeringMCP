// Spec 785 A4 — cartridge identity on the layout.
//
// A project can carry a manifest describing a DIFFERENT image than the artifact
// it is registered against, and a second extraction to the same path makes two
// cartridges look like one. Synthetic + deterministic: two tiny .crt headers on
// disk, one manifest pointing at the wrong one.
// Run: npm run e2e:785-identity (build:mcp first).
import { deriveCartridgeIdentity } from "../dist/project-knowledge/cartridge-identity.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("Spec 785 A4 — cartridge identity + mismatch against the linked image\n");

const dir = mkdtempSync(join(tmpdir(), "c64re-785-identity-"));

/** Minimal VICE .crt header followed by `padding` filler bytes. */
function writeCrt(path, { hardwareType, name, totalBytes }) {
  const buf = Buffer.alloc(totalBytes, 0xff);
  buf.write("C64 CARTRIDGE   ", 0, "latin1");
  buf.writeUInt32BE(0x40, 0x10);
  buf.writeUInt16BE(0x0100, 0x14);
  buf.writeUInt16BE(hardwareType, 0x16);
  buf.writeUInt8(1, 0x18);
  buf.writeUInt8(0, 0x19);
  buf.fill(0, 0x20, 0x40);
  buf.write(name, 0x20, "latin1");
  writeFileSync(path, buf);
  return path;
}

const imageA = writeCrt(join(dir, "title-a.crt"), { hardwareType: 19, name: "TITLE", totalBytes: 4096 });
const imageB = writeCrt(join(dir, "title-b.crt"), { hardwareType: 86, name: "TITLE-B", totalBytes: 8192 });

const artifactA = { id: "art-image-a", role: "cartridge-image", title: "title-a.crt", path: imageA };
const artifactB = { id: "art-image-b", role: "cartridge-image", title: "title-b.crt", path: imageB };

const manifestPath = join(dir, "manifest.json");
writeFileSync(manifestPath, "{}");
const manifestFirst = {
  id: "art-manifest-1", role: "crt-manifest", title: "manifest.json",
  relativePath: "analysis/crt/manifest.json", path: manifestPath, sourceArtifactIds: [artifactB.id],
};
const manifestSecond = {
  id: "art-manifest-2", role: "crt-manifest", title: "manifest.json",
  relativePath: "analysis/crt/manifest.json", path: manifestPath, sourceArtifactIds: [artifactA.id],
};

// The manifest on disk describes image A (hw 19, 4096 B) — but the FIRST
// registration claims it came from image B. That is the double registration.
const header = { hardwareType: 19, name: "TITLE", imageSize: 4096 };
const artifacts = [artifactA, artifactB, manifestFirst, manifestSecond];

const wrong = deriveCartridgeIdentity({
  manifestArtifact: manifestFirst, artifacts, header, chipCount: 1, bankCount: 1, romBytes: 4032,
});
const right = deriveCartridgeIdentity({
  manifestArtifact: manifestSecond, artifacts, header, chipCount: 1, bankCount: 1, romBytes: 4032,
});

ok(wrong.mismatches.length > right.mismatches.length,
  "the two registrations no longer look identical", `${wrong.mismatches.length} vs ${right.mismatches.length}`);
ok(wrong.mismatches.some((m) => m.includes("4096 B image") && m.includes("8192 B")),
  "image size mismatch is named", wrong.mismatches.join(" | "));
ok(wrong.mismatches.some((m) => m.includes("hardware type 19") && m.includes("hardware type 86")),
  "hardware type mismatch is named");
ok(wrong.mismatches.some((m) => m.includes("registered at the same path")),
  "two manifests at one path is flagged on BOTH records");
ok(right.mismatches.length === 1 && right.mismatches[0].includes("registered at the same path"),
  "the correctly linked registration reports only the shared path", right.mismatches.join(" | "));

// Identity itself: hash + hardware type + bank count + image size are persisted.
ok(right.imageSha256 && right.imageSha256.length === 64, "image sha256 is persisted", right.imageSha256?.slice(0, 12));
ok(right.imageSha256 !== wrong.imageSha256, "the two images hash differently");
ok(right.hardwareType === 19 && right.bankCount === 1 && right.imageSizeBytes === 4096 && right.imageBytes === 4096,
  "hardware type + bank count + image size ride with the layout", JSON.stringify({
    hw: right.hardwareType, banks: right.bankCount, size: right.imageSizeBytes, onDisk: right.imageBytes,
  }));

// A single, correctly linked manifest is clean — no false positives.
const clean = deriveCartridgeIdentity({
  manifestArtifact: { ...manifestSecond, relativePath: "analysis/crt/a/manifest.json", path: join(dir, "a-manifest.json") },
  artifacts: [artifactA, artifactB],
  header, chipCount: 1, bankCount: 1, romBytes: 4032,
});
ok(clean.mismatches.length === 0, "a correctly linked, uniquely pathed manifest reports no mismatch", clean.mismatches.join(" | "));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  785 A4 cartridge identity: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
