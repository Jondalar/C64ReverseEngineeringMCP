// Bug 19 (BUGREPORT): analyze_prg used to accept any file and
// reinterpret the first two bytes as a PRG load address. The Murder
// project hit this when an auto-pipeline fed
// `analysis/disk/motm/manifest.json` (76971 bytes JSON) into
// analyze_prg, producing endAddress=$13725 garbage analysis.
//
// This smoke recreates that exact shape and asserts the new
// validatePrgInput in pipeline/src/analysis/prg.ts rejects it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrg } from "../dist/pipeline/analysis/prg.cjs";

const root = mkdtempSync(join(tmpdir(), "c64re-bug19-smoke-"));

try {
  // 1) Replica of the Murder example — JSON manifest, 76971 bytes.
  const fakeManifestPath = join(root, "manifest.json");
  // Real-shape JSON header + filler to reach 76971 bytes.
  const header = `{\n  "format": "d64",\n  "files": [\n`;
  const filler = "    { \"name\": \"PADDING.PRG\", \"track\": 1, \"sector\": 0 },\n".repeat(900);
  const footer = `    { \"name\": \"END\" }\n  ]\n}`;
  let body = header + filler + footer;
  while (body.length < 76971) body += " ";
  body = body.slice(0, 76971);
  writeFileSync(fakeManifestPath, body);
  let threwSize = undefined;
  try { loadPrg(fakeManifestPath); } catch (e) { threwSize = e; }
  assert.ok(threwSize, "loadPrg should reject the 76971-byte manifest.json");
  assert.match(String(threwSize.message), /Not a PRG.*65538/);

  // 2) Edge case: exactly at the 65538 byte cap should pass shape
  // validation (load=$0801, body 65536 bytes -> end=$1080..nope —
  // pick a load address that does not overflow). Use load=$0801 +
  // body=2046 = end $0FFF. Tiny file, well under 64K, must pass.
  const validPath = join(root, "tiny.prg");
  const valid = Buffer.alloc(2 + 0x100);
  valid.writeUInt16LE(0x0801, 0);
  writeFileSync(validPath, valid);
  const ok = loadPrg(validPath);
  assert.equal(ok.mapping.loadAddress, 0x0801);
  assert.equal(ok.mapping.endAddress, 0x0900);

  // 3) Load-address overflow: a 60-byte body claiming load=$FFE0
  // should pass (end=$1001D wait - end = $FFE0 + 60 - 1 = $1001B)
  // Actually $FFE0 + 60 - 1 = 0xFFE0 + 0x3B = 0x1001B = 65563 > 65535
  // -> overflow check should reject.
  const overflowPath = join(root, "overflow.prg");
  const overflow = Buffer.alloc(2 + 60);
  overflow.writeUInt16LE(0xffe0, 0);
  writeFileSync(overflowPath, overflow);
  let threwOverflow = undefined;
  try { loadPrg(overflowPath); } catch (e) { threwOverflow = e; }
  assert.ok(threwOverflow, "loadPrg should reject load+body that overflows 16-bit");
  assert.match(String(threwOverflow.message), /overflows the 16-bit/);

  // 4) Size-2 (header only, no body) should reject as too-small.
  const tooSmallPath = join(root, "header-only.prg");
  writeFileSync(tooSmallPath, Buffer.alloc(2));
  let threwTiny = undefined;
  try { loadPrg(tooSmallPath); } catch (e) { threwTiny = e; }
  assert.ok(threwTiny, "loadPrg should reject 2-byte file");
  assert.match(String(threwTiny.message), /too small/);

  console.log("bug 19 (Murder example) smoke test passed");
  console.log(root);
} catch (error) {
  console.error("smoke test FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (process.exitCode === 0 || !process.exitCode) {
    rmSync(root, { recursive: true, force: true });
  }
}
