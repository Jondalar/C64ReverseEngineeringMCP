// Spec 784 B2 — medium-agnostic manifest→payload registration.
// THE point: full span chains register (never start-only — the Pawn 168/1329 bug);
// span provenance derives from the LoaderModel kind; disk-sector AND cart-slot spans
// register through the SAME core; re-run is idempotent (no dup). Real temp
// ProjectKnowledgeService, no MCP harness. Run after build:mcp.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../dist/server-tools/loader-manifest.js";
import { registerManifestPayloads } from "../dist/server-tools/manifest-register.js";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const root = mkdtempSync(join(tmpdir(), "b2-manifest-"));
console.log(`manifest-register B2 — full spans + derivedBy, disk+cart one path, idempotent\n  root: ${root}\n`);

try {
  const service = new ProjectKnowledgeService(root);

  // Disk manifest — Pawn-like, ONE payload with a FULL 3-sector chain (not start-only).
  const disk = validateManifest({
    manifestVersion: 1, extractor: "pawn-serial", sourceImage: "the_pawn_s1.g64",
    loaderModels: [{ id: "pawn-serial", kind: "sector-stream", indexLocation: "T01/S02" }],
    payloads: [{
      name: "PAWN.PRG", derivedBy: "pawn-serial", loadAddress: 0x0800, format: "raw", contentHash: "sha256:pawn",
      spans: [
        { kind: "sector", track: 33, sector: 0, length: 254 },
        { kind: "sector", track: 33, sector: 1, length: 254 },
        { kind: "sector", track: 33, sector: 2, length: 254 },
      ],
    }],
  });
  ok(disk.ok, "disk manifest valid");

  const r1 = registerManifestPayloads({ service, projectRoot: root, manifest: disk.manifest, resolveImage: () => undefined });
  ok(r1.registered === 1 && r1.perModel["pawn-serial"] === 1, "1 disk payload registered under its LoaderModel", JSON.stringify(r1));

  const pawn = service.listEntities().find((e) => e.kind === "payload" && e.name === "PAWN.PRG");
  ok(!!pawn, "PAWN.PRG payload entity exists");
  ok(pawn?.mediumSpans?.length === 3, "FULL 3-span chain registered (not start-only)", `${pawn?.mediumSpans?.length}`);
  ok(!!pawn?.mediumSpans?.every((s) => s.derivedBy === "custom-lut"), "each span derivedBy = custom-lut (sector-stream kind)");
  ok(pawn?.payloadLoadAddress === 0x0800 && pawn?.payloadContentHash === "sha256:pawn", "load addr + content hash carried");

  // Idempotent re-run — same stable id, no dup.
  registerManifestPayloads({ service, projectRoot: root, manifest: disk.manifest, resolveImage: () => undefined });
  const dupCheck = service.listEntities().filter((e) => e.kind === "payload" && e.name === "PAWN.PRG");
  ok(dupCheck.length === 1, "idempotent re-run: still 1 PAWN.PRG (no dup)", `${dupCheck.length}`);

  // Cart slot manifest — SAME core, different medium.
  const cart = validateManifest({
    manifestVersion: 1, extractor: "lykia-lut", sourceImage: "lykianew.crt",
    loaderModels: [{ id: "lykia-runtime", kind: "cart-lut", indexLocation: "runtime LUTs A-E" }],
    payloads: [{
      name: "lykia_file_042", derivedBy: "lykia-runtime", loadAddress: 0x2000, format: "byteboozer-lykia",
      spans: [{ kind: "slot", bank: 12, slot: "ROML", offsetInBank: 0, length: 8192 }],
    }],
  });
  ok(cart.ok, "cart manifest valid");
  registerManifestPayloads({ service, projectRoot: root, manifest: cart.manifest, resolveImage: () => undefined });
  const lyk = service.listEntities().find((e) => e.name === "lykia_file_042");
  ok(lyk?.mediumSpans?.[0]?.kind === "slot", "cart slot payload registered through the SAME core");
  ok(lyk?.mediumSpans?.[0]?.derivedBy === "cart-lut", "cart span derivedBy = cart-lut (cart-lut kind)");

  const totalPayloads = service.listEntities().filter((e) => e.kind === "payload").length;
  ok(totalPayloads === 2, "2 payloads total across disk + cart", `${totalPayloads}`);

  console.log(`\n${fail === 0 ? "GREEN" : "RED"}  manifest-register B2: ${pass} pass, ${fail} fail.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
