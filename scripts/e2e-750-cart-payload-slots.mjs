// Spec 750.1b — the cartridge-layout view overlays registered-payload SLOT
// medium_spans onto the bank/slot grid, SCOPED per cart image by `mediumRef`:
//   • span.mediumRef === this cart  → shown here (scoped).
//   • span.mediumRef === a DIFFERENT cart → excluded.
//   • no span.mediumRef            → UNSCOPED: shown on every cart image, flagged.
// Same artifact on multiple carts = multiple spans. LUT-chunk cells deduped.
// The cart twin of e2e-bug031-disk-payload-spans.mjs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 750.1b — cartridge-layout overlays payload slot spans, scoped per image\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-750cart-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "750cart" });

// Minimal EasyFlash-shaped manifest (hardwareType 32 = EasyFlash): 2 banks,
// ROML chips. A cart-manifest artifact per image.
const mkCart = (stem, name, banks) => {
  const chips = [];
  for (const b of banks) chips.push({ bank: b, load_address: 0x8000, size: 0x2000, file: `${stem}_b${b}.bin` });
  const bankMap = {};
  for (const b of banks) bankMap[String(b)] = { slots: ["ROML"], file: `${stem}_b${b}.bin` };
  writeFileSync(join(projectDir, `${stem}.json`), JSON.stringify({
    header: { name, hardwareType: 32, exrom: 0, game: 0 }, chips, banks: bankMap,
  }, null, 2));
  const art = svc.saveArtifact({ kind: "manifest", scope: "analysis", title: `${stem}.json`, path: `${stem}.json`, role: "crt-manifest" });
  return art;
};
const cartA = mkCart("efA", "EF-A", [0, 1]);
const cartB = mkCart("efB", "EF-B", [0, 1]);

// scoped-to-A payload: ROML bank 0 @ off $0000, 0x1000 bytes.
svc.saveEntity({ kind: "payload", name: "engine_8000",
  mediumSpans: [{ kind: "slot", bank: 0, slot: "ROML", offsetInBank: 0x0000, length: 0x1000, mediumRef: cartA.id }],
  payloadLoadAddress: 0x8000, payloadFormat: "prg" });
// two-bank scoped payload → ONE chunk, 2 spans.
svc.saveEntity({ kind: "payload", name: "overlay_split",
  mediumSpans: [
    { kind: "slot", bank: 0, slot: "ROML", offsetInBank: 0x1800, length: 0x0800, mediumRef: cartA.id },
    { kind: "slot", bank: 1, slot: "ROML", offsetInBank: 0x0000, length: 0x0400, mediumRef: cartA.id },
  ],
  payloadLoadAddress: 0x9800, payloadFormat: "raw" });
// unscoped payload (no mediumRef) → shows on A AND B, flagged.
svc.saveEntity({ kind: "payload", name: "shared_stub",
  mediumSpans: [{ kind: "slot", bank: 1, slot: "ROML", offsetInBank: 0x1000, length: 0x0200 }],
  payloadLoadAddress: 0x9000, payloadFormat: "raw" });
// scoped-to-B payload → NOT on A.
svc.saveEntity({ kind: "payload", name: "cartB_only",
  mediumSpans: [{ kind: "slot", bank: 0, slot: "ROML", offsetInBank: 0x0400, length: 0x0100, mediumRef: cartB.id }],
  payloadLoadAddress: 0x8400, payloadFormat: "raw" });
// EEPROM-slot payload on A → listed but not on a ROML/ROMH bar (grid-slot filter).
svc.saveEntity({ kind: "payload", name: "eeprom_save",
  mediumSpans: [{ kind: "slot", bank: 0, slot: "EEPROM", offsetInBank: 0, length: 0x80, mediumRef: cartA.id }],
  payloadFormat: "raw" });

let buildErr = "";
try { svc.buildAllViews(); } catch (e) { buildErr = e instanceof Error ? e.message : String(e); }
ok(!buildErr, "0 build_all_views ok", buildErr || "ok");

const cartView = svc.buildWorkspaceUiSnapshot().views?.cartridgeLayout;
const cA = (cartView?.cartridges ?? []).find((c) => c.title?.includes("efA"));
const cB = (cartView?.cartridges ?? []).find((c) => c.title?.includes("efB"));
const pA = cA?.payloadChunks ?? [];
const pB = cB?.payloadChunks ?? [];
const nA = pA.map((p) => p.name);

// 1 scoped-to-A payload present, not unscoped, carries mediumRef.
const engine = pA.find((p) => p.name === "engine_8000");
ok(!!engine && engine.unscoped !== true && engine.mediumRef === cartA.id && engine.slot === "ROML" && engine.bank === 0,
  "1 mediumRef=A payload scoped to A", engine ? `unscoped=${engine.unscoped} ref=${engine.mediumRef === cartA.id}` : `pA=[${nA}]`);

// 2 two-bank payload = ONE chunk with 2 spans.
const split = pA.filter((p) => p.name === "overlay_split");
ok(split.length === 1, "2 two-bank payload = ONE chunk (not 2)", `entries=${split.length}`);
ok((split[0]?.spans?.length ?? 0) === 2, "2b chunk carries both bank spans", `spans=${split[0]?.spans?.length}`);
const spanBanks = new Set((split[0]?.spans ?? []).map((s) => s.bank));
ok(spanBanks.has(0) && spanBanks.has(1), "2c spans cover bank 0 + bank 1", [...spanBanks].join(","));

// 3 unscoped shows on A + flagged.
const stubA = pA.find((p) => p.name === "shared_stub");
ok(!!stubA && stubA.unscoped === true, "3 unscoped payload shows on A + flagged", stubA ? `unscoped=${stubA.unscoped}` : "missing");

// 4 B-scoped excluded from A; unscoped ALSO on B; A-scoped NOT on B.
ok(!pA.some((p) => p.name === "cartB_only"), "4 mediumRef=B payload excluded from A", nA.join(","));
ok(pB.some((p) => p.name === "shared_stub" && p.unscoped === true), "4b unscoped payload also on B", pB.map((p) => p.name).join(","));
ok(!pB.some((p) => p.name === "engine_8000"), "4c A-scoped payload NOT on B");
ok(pB.some((p) => p.name === "cartB_only"), "4d B-scoped payload shows on B");

// 5 EEPROM-slot payload is present in the list (grid filters it, but the data is there).
const ee = pA.find((p) => p.name === "eeprom_save");
ok(!!ee && ee.slot === "EEPROM", "5 EEPROM-slot payload listed (slot=EEPROM)", ee ? ee.slot : "missing");

// 6 entityId wired for click-through.
ok(!!engine?.entityId, "6 payload chunk carries entityId (click-through)", engine?.entityId ?? "none");

// 7 disk view unaffected (no disks here → empty, no crash).
const diskView = svc.buildWorkspaceUiSnapshot().views?.diskLayout;
ok(Array.isArray(diskView?.disks), "7 disk view still builds (empty)", `disks=${diskView?.disks?.length}`);

console.log(`\nproject: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} 750.1b: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
