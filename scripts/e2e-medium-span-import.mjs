// Keystone slice — manifest-import fills mediumSpans + derivedBy provenance.
// Deterministic, synthetic, copyright-free: build a disk + crt manifest, import
// via the REAL importManifestKnowledge, assert the neutral Medium/Payload substrate.
// NOT a disk-count test. Run: npm run e2e:medium-span-import (needs build:mcp).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importManifestKnowledge } from "../dist/project-knowledge/manifest-import.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const tmp = mkdtempSync(join(tmpdir(), "c64re-mspan-"));
try {
  console.log("medium-span-import — Medium->Payload substrate from any representation\n");

  // ── DISK: kernal file (chain), custom file (chain), fallback file (no chain) ──
  const diskPath = join(tmp, "disk-manifest.json");
  writeFileSync(diskPath, JSON.stringify({
    format: "g64", diskName: "TEST", diskId: "T1",
    files: [
      { index: 0, name: "boot", type: "PRG", origin: "kernal", track: 18, sector: 1,
        sectorChain: [
          { index: 0, track: 17, sector: 0, nextTrack: 17, nextSector: 1, bytesUsed: 254, isLast: false },
          { index: 1, track: 17, sector: 1, nextTrack: 0, nextSector: 0, bytesUsed: 120, isLast: true },
        ] },
      { index: 1, name: "lut_e0", type: "PRG", origin: "custom", track: 5, sector: 0,
        sectorChain: [{ index: 0, track: 5, sector: 0, nextTrack: 0, nextSector: 0, bytesUsed: 200, isLast: true }] },
      { index: 2, name: "nochain", type: "PRG", origin: "kernal", track: 9, sector: 3 },
    ],
  }));
  const de = importManifestKnowledge({ id: "art-disk", path: diskPath, role: "disk-manifest" })?.entities ?? [];
  ok(de.length === 3, "disk: 3 entities imported", `${de.length}`);
  const boot = de.find((e) => e.name === "boot");
  ok((boot?.mediumSpans ?? []).length === 2, "kernal file: 2 sector spans from chain");
  ok(boot?.mediumSpans?.[0]?.length === 254 && boot?.mediumSpans?.[1]?.length === 120, "span length = bytesUsed (data, not physical)", `${boot?.mediumSpans?.map((s) => s.length)}`);
  ok(boot?.mediumSpans?.every((s) => s.derivedBy === "kernal-directory"), "kernal file: derivedBy = kernal-directory");
  ok(boot?.mediumSpans?.every((s) => s.mediumRef === "art-disk"), "spans scoped to the manifest artifact (mediumRef)");
  const custom = de.find((e) => e.name === "lut_e0");
  ok(custom?.mediumSpans?.every((s) => s.derivedBy === "custom-lut"), "custom (LUT) file: derivedBy = custom-lut");
  const nochain = de.find((e) => e.name === "nochain");
  ok((nochain?.mediumSpans ?? []).length === 1 && nochain?.mediumSpans?.[0]?.length === 254, "fallback (no chain): 1 span, length 254");

  // ── CRT: chips at ROML / ROMH / Ultimax / unknown ──
  const crtPath = join(tmp, "crt-manifest.json");
  writeFileSync(crtPath, JSON.stringify({
    header: { name: "TESTCART" },
    chips: [
      { bank: 0, load_address: 0x8000, size: 8192 },
      { bank: 1, load_address: 0xa000, size: 8192 },
      { bank: 2, load_address: 0xe000, size: 8192 },
      { bank: 3, load_address: 0x1234, size: 4096 },
    ],
    banks: {},
  }));
  const ce = importManifestKnowledge({ id: "art-crt", path: crtPath, role: "crt-manifest" })?.entities ?? [];
  const chips = ce.filter((e) => e.kind === "chip");
  ok(chips.length === 4, "crt: 4 chip entities", `${chips.length}`);
  ok(ce.every((e) => e.kind !== "payload"), "crt: NO fabricated payload entities (a chip is a block)");
  const spanFor = (bank) => chips.find((c) => c.mediumSpans?.[0]?.bank === bank)?.mediumSpans?.[0];
  ok(spanFor(0)?.slot === "ROML", "load $8000 -> ROML (safe standard derivation)");
  ok(spanFor(1)?.slot === "ROMH", "load $A000 -> ROMH");
  ok(spanFor(2)?.slot === "ULTIMAX_ROMH", "load $E000 -> ULTIMAX_ROMH");
  ok(spanFor(3)?.slot === "OTHER", "unknown load -> OTHER (honest, not invented)");
  ok(spanFor(0)?.length === 8192 && spanFor(3)?.length === 4096, "chip span length = manifest size (explicit, not invented)");
  ok(chips.every((c) => c.mediumSpans?.[0]?.derivedBy === "cart-lut"), "chip spans: derivedBy = cart-lut");
  ok(chips.every((c) => c.mediumSpans?.[0]?.mediumRef === "art-crt"), "chip spans scoped to the crt artifact (mediumRef)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}  medium-span-import: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
