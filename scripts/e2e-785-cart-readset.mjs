// Spec 785 C2/C3 — the CART read-set: decode CART_READ (0x36) out of a .c64retrace,
// aggregate it, and diff a manifest's slot spans against it.
//
// THE point, and the line this gate defends: the read-set proves USED-IN-THIS-RUN and
// NEVER UNUSED (785 §2.1). A span the run did not touch is "not seen in this run" and
// must not fail a verdict. What a run CAN contradict is narrower: it read a payload and
// read PAST a span it never read. Both directions are asserted below, plus the two
// producer facts a naive reader gets wrong — the drain-split (one walk arrives as
// several records) and the bounding range (offLo..offHi is not a coverage set).
//
// Run after build:mcp:  node scripts/e2e-785-cart-readset.mjs
//
// Against a REAL capture + manifest (neither can live in this repo — both proof
// cartridges are third-party property):
//
//   C64RE_785_CAPTURE=/path/run.c64retrace \
//   C64RE_785_MANIFEST=/path/loader-manifest.json \
//   node scripts/e2e-785-cart-readset.mjs
//
// Mint the capture isolated, no daemon:
//   trx64cli --rom-dir <roms> boot --disk <crt> --cycles 30000000 \
//     --trace run.c64retrace --trace-domains cart-read --dump /tmp/x.c64re
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  buildCartReadSet, cartBankUsage, cartReadSetFromCaptureFile, captureMetaFromFile,
} from "../dist/runtime/headless/trace/loader-lens.js";
import { encodeFileHeader, encodeCartRead, decodeFileHeader, decodeEventStream } from "../dist/runtime/headless/trace/binary-format.js";
import { validateExtraction } from "../dist/server-tools/validate-extraction.js";
import { validateManifest } from "../dist/server-tools/loader-manifest.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const h = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;

console.log("Spec 785 C2/C3 — cart read-set: decode, aggregate, diff a manifest\n");

// ---------------------------------------------------------------- synthetic capture
//
// A cross-bank packer walk the way the producer really emits it: bank 7 tail, then
// bank 8 head — and bank 8 SPLIT across two records because the producer drains
// periodically (it closes live residencies on every drain, so one uninterrupted walk
// arrives as consecutive abutting records). Plus a LUT scan on bank 1: a wide bounding
// range with far fewer served reads than it spans — the SPARSE case.
const header = encodeFileHeader({
  runId: "test-cart", defId: "d", defVersion: 1, defName: "cart-read", defJson: "{}",
  domains: ["cart-read"], cycleStart: 0, createdAt: "2026-08-11",
});
const evbuf = new Uint8Array(4096);
const dv = new DataView(evbuf.buffer);
let off = 0;
const cr = (cycle, bank, slot, lo, hi, bytes) => {
  off = encodeCartRead(dv, off, evbuf.length, cycle, bank, slot, lo, hi, bytes);
};
cr(1000, 1, 0, 0x00f0, 0x1f4a, 133);            // LUT scan — sparse
cr(2000, 7, 0, 0x1a00, 0x1fff, 0x0600);         // stream: bank 7 tail
cr(3000, 8, 0, 0x0000, 0x0fff, 0x1000);         // bank 8, first drain
cr(4000, 8, 0, 0x1000, 0x17ff, 0x0800);         // bank 8, second drain — ABUTS the first
cr(5000, 9, 1, 0x0000, 0x00ff, 0x0100);         // a ROMH residency

const file = new Uint8Array(header.length + off);
file.set(header, 0);
file.set(evbuf.subarray(0, off), header.length);

const dir = mkdtempSync(join(tmpdir(), "cart-lens-"));
const path = join(dir, "cap.c64retrace");
let realExit = 0;
try {
  writeFileSync(path, file);

  // ------------------------------------------------------------------ decode + shape
  const set = cartReadSetFromCaptureFile(path);
  ok(set.length === 5, "5 CART_READ residencies decoded from the file", `${set.length}`);
  ok(set[0].bank === 1 && set[0].slot === 0 && set[0].slotName === "ROML" &&
     set[0].offLo === 0x00f0 && set[0].offHi === 0x1f4a && set[0].bytes === 133,
     "record fields survive the round trip (bank/slot/offLo/offHi/bytes)", JSON.stringify(set[0]));
  ok(set[4].slotName === "ROMH", "slot 1 renders as ROMH", set[4].slotName);
  const big = buildCartReadSet(decodeEventStream(
    new Uint8Array(readFileSync(path)), decodeFileHeader(new Uint8Array(readFileSync(path))).headerLen, 2));
  ok(big.length === 5, "buildCartReadSet over a decoded stream agrees with the file reader");

  // -------------------------------------------------- aggregation: drain-split + sparse
  const usage = cartBankUsage(set);
  const b8 = usage.find((u) => u.bank === 8 && u.slot === 0);
  ok(usage.length === 4, "4 distinct (bank, slot) pairs", `${usage.length}`);
  ok(!!b8 && b8.residencies === 2 && b8.ranges.length === 1 &&
     b8.ranges[0].offLo === 0 && b8.ranges[0].offHi === 0x17ff,
     "the drain-split walk of bank 8 merges into ONE range $0000-$17FF",
     b8 ? `${b8.residencies} recs → ${b8.ranges.map((r) => h(r.offLo) + "-" + h(r.offHi)).join(",")}` : "missing");
  const b1 = usage.find((u) => u.bank === 1);
  ok(!!b1 && b1.sparse === true && b1.solidRanges.length === 0,
     "the LUT scan is SPARSE and contributes NO solid range (a hull, not a sweep)",
     b1 ? `bytes ${b1.bytes} < rangeWidth ${b1.rangeWidth}, solid ${b1.solidRanges.length}` : "missing");
  ok(!!b8 && b8.sparse === false && b8.solidWidth === 0x1800,
     "a full walk is NOT sparse and yields a solid range of its full width",
     b8 ? `bytes ${b8.bytes} rangeWidth ${b8.rangeWidth} solidWidth ${b8.solidWidth}` : "missing");

  // --------------------------------------------------------------- manifest diff rules
  const mk = (payloads) => validateManifest({
    manifestVersion: 1, extractor: "synthetic (785 C2 gate)", sourceImage: "test.crt",
    loaderModels: [{ id: "m", kind: "cross-bank-packer" }],
    payloads: payloads.map((p) => ({ name: p.name, derivedBy: "m", spans: p.spans })),
  }).manifest;
  const slot = (bank, offsetInBank, length, s = "ROML") =>
    ({ kind: "slot", bank, slot: s, offsetInBank, length });
  const run = (m) => validateExtraction([], m, { cartReadSet: set, runLabel: "run cap" });

  // (1) A correct cross-bank payload: bank 7 $1A00 + bank 8 $0000, both read.
  const correct = run(mk([{ name: "chunk_A", spans: [slot(7, 0x1a00, 0x0600), slot(8, 0x0000, 0x0400)] }]));
  ok(correct.verdict === "pass", "correct manifest → PASS", correct.verdict);
  ok(correct.cart.evaluated && correct.cart.confirmedSpans === 2 && correct.cart.conflicts.length === 0,
     "both spans read in run cap, 0 conflicts",
     JSON.stringify({ confirmed: correct.cart.confirmedSpans, conflicts: correct.cart.conflicts.length }));
  ok(correct.skippedSlotSpans === 0, "slot spans are no longer skipped when a cart read-set is supplied", `${correct.skippedSlotSpans}`);

  // (2) §2.1 — a payload the run never reached is NOT a refutation.
  const unreached = run(mk([{ name: "chunk_L90", spans: [slot(40, 0x0000, 0x0400)] }]));
  ok(unreached.verdict === "pass", "a payload the run never reached → still PASS (read-set proves used, never unused)", unreached.verdict);
  ok(unreached.cart.notSeenSpans === 1 && unreached.cart.conflicts.length === 0 && unreached.cart.payloadsSeenInRun === 0,
     "it is counted NOT SEEN IN THIS RUN, not mismatched",
     JSON.stringify({ notSeen: unreached.cart.notSeenSpans, conflicts: unreached.cart.conflicts.length }));

  // (3) THE acceptance case — a span claiming a bank the title never read, inside a
  //     payload the run demonstrably read PAST. That, and only that, is refutable.
  const wrong = run(mk([{ name: "chunk_A", spans: [slot(60, 0x1a00, 0x0600), slot(8, 0x0000, 0x0400)] }]));
  ok(wrong.verdict === "fail", "a wrong bank inside a payload the run read past → FAIL", wrong.verdict);
  ok(wrong.cart.conflicts.length === 1 && wrong.cart.conflicts[0].bank === 60,
     "the wrong span (bank 60) is the flagged conflict", JSON.stringify(wrong.cart.conflicts.map((c) => c.bank)));
  ok(/read PAST this one/.test(wrong.cart.conflicts[0].reason) && /run cap/.test(wrong.cart.conflicts[0].reason),
     "the conflict states its evidence and names the run", wrong.cart.conflicts[0].reason.slice(0, 80));

  // (4) A trailing unread span of a seen payload is TRUNCATED, not a conflict — the
  //     capture may simply have stopped mid-payload.
  const trailing = run(mk([{ name: "chunk_B", spans: [slot(8, 0x0000, 0x0400), slot(60, 0x0000, 0x0400)] }]));
  ok(trailing.verdict === "pass" && trailing.cart.truncated.length === 1 && trailing.cart.conflicts.length === 0,
     "a trailing unread span → truncated (reported), NOT a conflict",
     JSON.stringify({ verdict: trailing.verdict, truncated: trailing.cart.truncated.length }));

  // (5) A span reaching beyond what the run read, with a later span confirmed → conflict.
  const overreach = run(mk([{ name: "chunk_C", spans: [slot(7, 0x1a00, 0x0600), slot(8, 0x0000, 0x2000)] }]));
  ok(overreach.cart.partialSpans === 1, "the over-long span is classed PARTIAL", `${overreach.cart.partialSpans}`);

  // (6) Sparse observation: a containment match inside a sparse range is reported weak.
  const sparse = run(mk([{ name: "lut_row", spans: [slot(1, 0x0500, 0x0010)] }]));
  ok(sparse.cart.confirmedSpans === 1 && sparse.cart.weakConfirmedSpans === 1 && sparse.cart.payloadsSolidInRun === 0,
     "a match inside the sparse LUT hull is a WEAK confirmation and does not count as solid",
     JSON.stringify({ confirmed: sparse.cart.confirmedSpans, weak: sparse.cart.weakConfirmedSpans, solid: sparse.cart.payloadsSolidInRun }));

  // (7) The mirror of `unclaimed`: bank bytes the run read that no span claims.
  ok(correct.cart.unclaimedReads.some((u) => u.bank === 9 && u.slotName === "ROMH"),
     "the ROMH residency no span claims is reported as an unclaimed read",
     JSON.stringify(correct.cart.unclaimedReads.map((u) => `${u.bank}/${u.slotName}`)));

  // (8) No cart lane in the capture → the pre-785 behaviour, stated as a reason.
  const noLane = validateExtraction([], mk([{ name: "x", spans: [slot(7, 0, 16)] }]), { cartReadSet: [] });
  ok(noLane.skippedSlotSpans === 1 && noLane.cart.evaluated === false && !!noLane.cart.reason,
     "a capture without the cart-read lane skips slot spans and says why", noLane.cart.reason);
  const noOpt = validateExtraction([], mk([{ name: "x", spans: [slot(7, 0, 16)] }]));
  ok(noOpt.skippedSlotSpans === 1 && noOpt.cart.evaluated === false,
     "omitting the option entirely keeps the pre-785 contract");

  // (9) C3 — no output renders a bare "used" / "unused".
  const label = JSON.stringify(unreached.cart) + JSON.stringify(wrong.cart);
  ok(!/\b(un)?used\b/i.test(label) || /in this run|run cap/i.test(label),
     "read-set results are labelled by run, never bare used/unused");

  // ------------------------------------------------------------------- real capture
  const capPath = process.env.C64RE_785_CAPTURE;
  const manPath = process.env.C64RE_785_MANIFEST;
  if (capPath && manPath) {
    console.log(`\n--- real capture: ${basename(capPath)} vs ${basename(manPath)} ---`);
    const realSet = cartReadSetFromCaptureFile(capPath);
    const meta = captureMetaFromFile(capPath);
    const realUsage = cartBankUsage(realSet);
    const raw = JSON.parse(readFileSync(manPath, "utf8"));
    const mres = validateManifest(raw);
    if (!mres.ok) { console.log("  manifest invalid:", mres.errors.join("; ")); process.exit(1); }
    const runLabel = `run ${basename(capPath)}`;
    console.log(`  domains ${JSON.stringify(meta.domains)}  residencies ${realSet.length}  (bank,slot) pairs ${realUsage.length}`);
    if (raw.imageIdentity) {
      console.log(`  manifest image: ${raw.imageIdentity.file} hw ${raw.imageIdentity.hardwareType} sha ${String(raw.imageIdentity.sha256).slice(0, 16)}…`);
    }
    console.log("  banks read in this run (merged, in first-read order):");
    for (const u of realUsage.slice(0, 40)) {
      console.log(`    bank ${String(u.bank).padStart(3)} ${u.slotName}  ${u.ranges.map((r) => h(r.offLo) + "-" + h(r.offHi)).join(" ")}  ` +
        `${u.bytes} served read(s) over ${u.residencies} residenc(ies)${u.sparse ? "  SPARSE" : ""}`);
    }
    if (realUsage.length > 40) console.log(`    … +${realUsage.length - 40} more`);

    const real = validateExtraction([], mres.manifest, { cartReadSet: realSet, runLabel });
    const c = real.cart;
    console.log(`  verdict ${real.verdict.toUpperCase()} — slot spans ${c.slotSpans} over ${c.payloadsTotal} payload(s); ` +
      `${c.payloadsSeenInRun} payload(s) seen in ${runLabel}, ${c.payloadsSolidInRun} on a full-sweep read`);
    console.log(`    read in ${runLabel} ${c.confirmedSpans} (${c.weakConfirmedSpans} weak/hull-only), partly read ${c.partialSpans}, ` +
      `NOT SEEN in ${runLabel} ${c.notSeenSpans}, contradicted ${c.conflicts.length}, trailing-unread ${c.truncated.length}`);
    for (const x of c.conflicts.slice(0, 10)) console.log(`      CONFLICT ${x.payload} bank ${x.bank} ${x.slot} ${h(x.offsetInBank)}+${x.length}`);
    for (const x of c.truncated.slice(0, 10)) console.log(`      trailing ${x.payload} bank ${x.bank} ${x.slot} ${h(x.offsetInBank)}+${x.length}`);
    console.log(`    unclaimed read ranges ${c.unclaimedReads.length}:`);
    for (const u of c.unclaimedReads.slice(0, 12)) console.log(`      bank ${u.bank} ${u.slotName} ${h(u.offLo)}-${h(u.offHi)}${u.sparse ? " (sparse)" : ""}`);
    ok(real.verdict === "pass", "the project's own manifest passes against the real run", real.verdict);
    ok(c.confirmedSpans > 0, "the real run confirms at least one slot span", `${c.confirmedSpans}`);

    // The acceptance case on real data: take a payload the run read END TO END and move
    // its FIRST span to a bank the run never touched. The run read past that position,
    // so the claim is refuted — while every untouched payload stays "not seen".
    const readBanks = new Set(realUsage.map((u) => `${u.bank}/${u.slot}`));
    const laneSlot = (s) => (s === "ROML" ? 0 : s === "ROMH" || s === "ULTIMAX_ROMH" ? 1 : -1);
    const victim = mres.manifest.payloads.find((p) =>
      p.spans.length >= 2 && p.spans.every((s) => s.kind === "slot" && readBanks.has(`${s.bank}/${laneSlot(s.slot)}`)));
    if (!victim) {
      console.log("  (no fully-read multi-span payload in this run — skipping the wrong-span injection)");
    } else {
      let freeBank = 0;
      while (readBanks.has(`${freeBank}/0`) || readBanks.has(`${freeBank}/1`)) freeBank++;
      const bent = JSON.parse(JSON.stringify(mres.manifest));
      const bp = bent.payloads.find((p) => p.name === victim.name);
      const wasBank = bp.spans[0].bank;
      bp.spans[0].bank = freeBank;
      const bad = validateExtraction([], bent, { cartReadSet: realSet, runLabel });
      console.log(`  wrong-span injection: ${victim.name} span 1 bank ${wasBank} → ${freeBank} (never read in this run)`);
      console.log(`    verdict ${bad.verdict.toUpperCase()}  conflicts ${bad.cart.conflicts.length}`);
      for (const x of bad.cart.conflicts.slice(0, 3)) console.log(`      ✗ ${x.payload} bank ${x.bank} ${x.slot} ${h(x.offsetInBank)}+${x.length} — ${x.reason}`);
      ok(bad.verdict === "fail", "the deliberately wrong span is FLAGGED", bad.verdict);
      ok(bad.cart.conflicts.some((x) => x.bank === freeBank), "the injected span is the conflict");
      ok(bad.cart.notSeenSpans >= c.notSeenSpans, "the untouched payloads stay 'not seen', not mismatched",
         `${bad.cart.notSeenSpans} vs ${c.notSeenSpans}`);
    }
  } else {
    console.log("\n  (set C64RE_785_CAPTURE + C64RE_785_MANIFEST to also run against a real capture)");
  }

  console.log(`\n${fail === 0 ? "GREEN" : "RED"}  785 C2/C3 cart read-set: ${pass} pass, ${fail} fail.`);
  realExit = fail === 0 ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(realExit);
