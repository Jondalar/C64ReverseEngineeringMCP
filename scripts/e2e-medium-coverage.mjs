// Uniform block-coverage over the Medium substrate — the Discovery→RE gate
// signal. Synthetic + deterministic: build one MediumLayoutView holding a disk
// medium AND a cart medium, run BOTH through the SAME computeMediumCoverage,
// assert the neutral MediumBlockCoverage. THE point: disk sectors and cart
// chips resolve to the same {dataBlocks, attributed, unclaimed} shape — no
// disk/cart branch above the block. Run: npm run e2e:medium-coverage (build:mcp first).
import { computeDiscoveryCoverage, computeMediumCoverage, discoveryCoverageComplete } from "../dist/project-knowledge/medium-coverage.js";
import { applyDiscoveryCoverageGate, applyMediaFloor } from "../dist/agent-orchestrator/lifecycle.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("medium-coverage — uniform block-coverage (disk + cart, one shape)\n");

const sec = (track, sector, category) => ({
  id: `s-${track}-${sector}`, track, sector, angleStart: 0, angleEnd: 1, occupied: category === "file", category,
});
const slotSpan = (bank, offsetInBank, length, slot = "ROML") => ({ kind: "slot", bank, slot, offsetInBank, length });

const view = {
  id: "v", kind: "medium-layout", title: "t", projectId: "p", generatedAt: "2026-07-03T00:00:00.000Z",
  mediums: [
    {
      id: "m-disk", mediumKind: "disk", mediumLabel: "adventures.d64", artifactId: "disk-1",
      capacityBytes: 254 * 6, blockSize: 254,
      grid: { kind: "sector-grid", tracks: [], sectors: [
        sec(17, 0, "file"), sec(17, 1, "file"),      // attributed
        sec(18, 0, "bam"),                            // system (ignored)
        sec(5, 0, "free_data"),                       // unclaimed data
        sec(5, 1, "orphan_allocated"),                // unclaimed data
        sec(6, 0, "free_zero"),                       // empty (ignored)
      ] },
      files: [], resident: [], empty: [], boot: undefined,
    },
    {
      id: "m-cart", mediumKind: "cartridge", mediumLabel: "game.crt", artifactId: "cart-1",
      capacityBytes: 8192 * 3, blockSize: 8192,
      grid: { kind: "bank-grid",
        banks: [{ bank: 0 }, { bank: 1 }, { bank: 2 }],
        slotLayout: { slotsPerBank: 1, bankSize: 8192, hasRomh: false, hasEeprom: false, isUltimax: false, canFlash: true, bankCount: 3, totalRomBytes: 8192 * 3 },
        chips: [
          { bank: 0, loadAddress: 0x8000, size: 8192, slot: "ROML" }, // fully claimed
          { bank: 1, loadAddress: 0x8000, size: 8192, slot: "ROML" }, // half claimed → unclaimed
          { bank: 2, loadAddress: 0x8000, size: 8192, slot: "ROML" }, // fully empty flash → not data
        ] },
      files: [
        { id: "f0", name: "engine", origin: "registered-payload", spans: [slotSpan(0, 0, 8192)], length: 8192, notes: [], sourceRefs: [] },
        { id: "f1", name: "part", origin: "registered-payload", spans: [slotSpan(1, 0, 4096)], length: 4096, notes: [], sourceRefs: [] },
      ],
      resident: [],
      empty: [ { id: "e2", reason: "flash-empty-ff", spans: [slotSpan(2, 0, 8192)] } ],
      boot: undefined,
    },
  ],
};

const cov = computeDiscoveryCoverage(view);
const disk = cov.find((c) => c.mediumKind === "disk");
const cart = cov.find((c) => c.mediumKind === "cartridge");

ok(cov.length === 2, "both media resolve through the SAME computeMediumCoverage", `${cov.length}`);
// disk: 2 file + 2 unclaimed = 4 data blocks; bam/free_zero ignored.
ok(disk?.dataBlocks === 4 && disk?.attributedBlocks === 2 && disk?.unclaimedBlocks === 2,
  "disk: sector categories → {data 4, attributed 2, unclaimed 2}", JSON.stringify(disk));
// cart: chip0 claimed, chip1 half → unclaimed, chip2 all-ff → not data.
ok(cart?.dataBlocks === 2 && cart?.attributedBlocks === 1 && cart?.unclaimedBlocks === 1,
  "cart: chip spans → {data 2, attributed 1, unclaimed 1} (empty flash excluded)", JSON.stringify(cart));

ok(discoveryCoverageComplete(cov) === false, "unclaimed data present → discovery NOT complete");
ok(applyDiscoveryCoverageGate("re", false) === "discovery", "gate caps re→discovery while incomplete");
ok(applyDiscoveryCoverageGate("re", true) === "re", "gate is a no-op once complete");
ok(applyDiscoveryCoverageGate("onboarding", false) === "onboarding", "gate never advances onboarding→discovery");
// media floor: a media-loaded project reads as Discovery even with no explicit phase.
ok(applyMediaFloor("onboarding", true) === "discovery", "media floor raises onboarding→discovery");
ok(applyMediaFloor("onboarding", false) === "onboarding", "no media → floor is a no-op");
ok(applyMediaFloor("re", true) === "re", "floor never lowers a later phase");
ok(applyDiscoveryCoverageGate(applyMediaFloor("onboarding", true), false) === "discovery", "floor+gate: media + unclaimed → Discovery (the Pawn/onboarding case)");

// complete case: drop the unclaimed sectors + fully claim chip1.
const done = JSON.parse(JSON.stringify(view));
done.mediums[0].grid.sectors = done.mediums[0].grid.sectors.filter((s) => !["free_data", "orphan_allocated"].includes(s.category));
done.mediums[1].files[1].spans = [slotSpan(1, 0, 8192)];
ok(discoveryCoverageComplete(computeDiscoveryCoverage(done)) === true, "all data claimed → discovery complete");
// no media at all → vacuously complete (nothing to inventory).
ok(discoveryCoverageComplete(computeDiscoveryCoverage({ mediums: [] })) === true, "no media → vacuously complete");

// ---------------------------------------------------------------------------
// Spec 785 B1 + B2 — three axes in bytes, payload claims apart from meaning.
// ---------------------------------------------------------------------------
console.log("\nSpec 785 — Data / Used / Identified\n");

const cartMedium = (id, files, resident, empty, chips) => ({
  id, mediumKind: "cartridge", mediumLabel: id, artifactId: id,
  capacityBytes: 8192 * chips.length, blockSize: 8192,
  grid: {
    kind: "bank-grid",
    banks: chips.map((c) => ({ bank: c.bank })),
    slotLayout: { slotsPerBank: 1, bankSize: 8192, hasRomh: false, hasEeprom: false, isUltimax: false, canFlash: true, bankCount: chips.length, totalRomBytes: 8192 * chips.length },
    chips,
  },
  files, resident, empty, boot: undefined,
});
const chip = (bank) => ({ bank, loadAddress: 0x8000, size: 8192, slot: "ROML" });
const file = (id, spans) => ({ id, name: id, origin: "registered-payload", spans, length: spans.reduce((n, s) => n + s.length, 0), notes: [], sourceRefs: [] });
const island = (id, spans) => ({ id, role: "code", spans });

// B2 — the exact failure the spec was written from: zero payloads, full
// disassembly coverage. Code islands are evidence of MEANING, never evidence
// that the loader fetched anything.
const islandsOnly = computeMediumCoverage(cartMedium("islands", [], [
  island("i0", [slotSpan(0, 0, 4096)]), island("i1", [slotSpan(0, 4096, 4096)]),
], [], [chip(0)]));
ok(islandsOnly.dataBlocks === 1 && islandsOnly.attributedBlocks === 0 && islandsOnly.unclaimedBlocks === 1,
  "B2: 0 payloads + full code-island coverage → NOT attributed", JSON.stringify(islandsOnly));
ok(islandsOnly.identifiedBytes === 8192 && islandsOnly.usedBytes === 0,
  "B2: the islands still count as Identified, on their own axis", `ident=${islandsOnly.identifiedBytes} used=${islandsOnly.usedBytes}`);
ok(discoveryCoverageComplete([islandsOnly]) === false, "B2: island-only cartridge does not complete discovery");

// B1 — a chip 1 % claimed and a chip 99 % claimed must not report the same.
const thin = computeMediumCoverage(cartMedium("thin", [file("f", [slotSpan(0, 0, 82)])], [], [], [chip(0)]));
const thick = computeMediumCoverage(cartMedium("thick", [file("f", [slotSpan(0, 0, 8110)])], [], [], [chip(0)]));
ok(thin.unclaimedBlocks === thick.unclaimedBlocks, "B1: both still read 1 unclaimed BLOCK (the old signal)");
ok(thin.usedBytes === 82 && thick.usedBytes === 8110 && thin.unclaimedBytes === 8110 && thick.unclaimedBytes === 82,
  "B1: bytes separate 1 %-covered from 99 %-covered", `${thin.usedBytes} vs ${thick.usedBytes}`);

// B1 — No-Data is its own axis and never inflates coverage.
const erased = computeMediumCoverage(cartMedium("erased", [], [], [
  { id: "e", reason: "flash-empty-ff", spans: [slotSpan(0, 0, 8192)] },
], [chip(0)]));
ok(erased.dataBlocks === 0 && erased.emptyBytes === 8192 && erased.dataBytes === 0,
  "B1/B3: a fully erased bank is No Data, not unclaimed", JSON.stringify(erased));

// A payload span landing on erased bytes is not counted as Used data.
const overErased = computeMediumCoverage(cartMedium("over", [file("f", [slotSpan(0, 0, 8192)])], [], [
  { id: "e", reason: "flash-empty-ff", spans: [slotSpan(0, 4096, 4096)] },
], [chip(0)]));
ok(overErased.dataBytes === 4096 && overErased.usedBytes === 4096 && overErased.attributedBlocks === 1,
  "B1: Used is clipped to the Data part of the block", JSON.stringify(overErased));

// The disk reader emits the SAME byte axes — no branch above the block layer.
const diskCov = computeDiscoveryCoverage(view).find((c) => c.mediumKind === "disk");
ok(diskCov.dataBytes === 4 * 254 && diskCov.usedBytes === 2 * 254 && diskCov.emptyBytes === 254,
  "disk emits the same Data/Used/Empty byte axes", JSON.stringify({ d: diskCov.dataBytes, u: diskCov.usedBytes, e: diskCov.emptyBytes }));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  medium-coverage: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
