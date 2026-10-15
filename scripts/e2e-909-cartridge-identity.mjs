#!/usr/bin/env node
// Spec 909 — each cartridge in a project is its own place, with its own type and its own role.
//
//   S1 two cartridges, two sets of chips     two nodes per bank, each pointing at its own .bin; the auto
//                                            disassembly of B's bank 0 is B's bytes; folders and extracts apart;
//                                            graph_find without a cartridge lists both, each naming its own
//   S2 a rebuilt target is the same place    a name at B bank 1 $8010 survives B' (same path) and B'' (named); the
//                                            image is a new VERSION of B, not a third cartridge
//   S3 type and role per cartridge           declared with contract_set; project_status / contract_show name them;
//                                            $DE00 is GMod2's in A's listing and EasyFlash's in B's, and a node
//                                            reached without lineage still gets its type from the cartridge named
//   S4 nothing is guessed                    two cartridges, no declaration: both "other", the answer says how
//   S6 an old project moves once             a project written with crt/<bank> ids (the bug's state), opened: every
//                                            node renamed with its names and edges, the unplaceable listed by name,
//                                            B's chips created fresh from B's own extract, a second open changes nothing
//   S7 the old form is refused for writing   by name (crt-needs-cart), listing the cartridges the project holds
//
// Hermetic: synthetic CRTs generated here, a temp project outside the repo, MCP over stdio. No ROMs, no runtime.
// S5 (the runtime) is its own gate: e2e:909-runtime.   Run: npm run e2e:909
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chipBytes, bankSwitchCode, HW_EASYFLASH, HW_GMOD2, makeCrt } from "./lib/cartridge-fixture-909.mjs";
import { makeChecker, load, ROOT } from "./lib/e2e-906-harness.mjs";
import { startMcp } from "./lib/mcp-stdio.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-909");
const { check, head } = T;
console.log("Spec 909 — each cartridge is its own place (type, role, identity, old projects)\n");

const ids = await load("knowledge-graph/ids.js");
const { GraphStore } = await load("knowledge-graph/store.js");
const { ProjectKnowledgeService } = await load("project-knowledge/service.js");
const { nameNode } = await load("knowledge-graph/migrate/human.js");
const { annotationId } = await load("knowledge-graph/migrate/schema-822.js");

// ── the images ─────────────────────────────────────────────────────────────────────────────────
// A: GMod2 (60), one bank. B: EasyFlash (32), two banks. Bank 0 of both is at $8000 and stores to $DE00;
// the fill bytes differ ($EA / $60), so a byte compare tells the two apart.
const A = makeCrt({ name: "A", hardwareType: HW_GMOD2, banks: [{ bank: 0, code: bankSwitchCode(1), fill: 0xea }] });
const B = makeCrt({ name: "B", hardwareType: HW_EASYFLASH, banks: [{ bank: 0, code: bankSwitchCode(2), fill: 0x60 }, { bank: 1, code: [0xa9, 0x05, 0x60], fill: 0x60, at: 0x10 }] });
// B': the target rebuilt — same file, other bytes in bank 0
const B2 = makeCrt({ name: "B", hardwareType: HW_EASYFLASH, banks: [{ bank: 0, code: bankSwitchCode(3), fill: 0x61 }, { bank: 1, code: [0xa9, 0x05, 0x60], fill: 0x60, at: 0x10 }] });

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "media"), { recursive: true });
  return dir;
}

async function session(dir, { onboard = false } = {}) {
  const m = startMcp({ root: ROOT, env: { C64RE_PROJECT_DIR: dir, C64RE_RUNTIME_AUTOSTART: "0" } });
  await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-909", version: "1" } });
  m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  if (onboard) await m.call("agent_onboard", { project_dir: dir });
  return m;
}

const slugOf = (dir) => JSON.parse(readFileSync(join(dir, "knowledge", "project.json"), "utf8")).slug;
const nodesLike = (dir, like) => {
  const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT DISTINCT id FROM nodes WHERE id LIKE ? ORDER BY id").all(like).map((r) => r.id); } finally { db.close(); }
};
const payloadRows = (txt) => txt.split("\n").filter((l) => /:chip:[0-9a-f]{4}\s*\|/.test(l)).map((l) => ({ id: l.split("|")[0].trim(), src: (/src=(\S+)/.exec(l) ?? [])[1] }));
const listingOf = (out) => { const m = /^Output: (.+)$/m.exec(out); return m && existsSync(m[1]) ? readFileSync(m[1], "utf8") : ""; };

// ═══ S1 / S4 / S3 / S2 / S7 in one project ═══════════════════════════════════════════════════
const dir = project("c64re-e2e-909-");
check(!dir.startsWith(ROOT), "project dir is outside the repo", dir);
writeFileSync(join(dir, "media", "gmod2-orig.crt"), A);
writeFileSync(join(dir, "media", "ef-port.crt"), B);
const m = await session(dir);
const call = m.call;
try {
  await call("project_init", { project_dir: dir, name: "x909" });
  await call("agent_onboard", { project_dir: dir });
  const slug = slugOf(dir);

  head("S1. two cartridges, two sets of chips");
  const ea = await call("extract_crt", { project_dir: dir, crt_path: "media/gmod2-orig.crt" });
  const eb = await call("extract_crt", { project_dir: dir, crt_path: "media/ef-port.crt" });
  check(/Cartridge gmod2-orig \(GMod2, other/.test(ea) && /new cartridge/.test(ea), "S1.1 the first extract mints the cartridge from the image name and says its type", ea.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  check(/Cartridge ef-port \(EasyFlash, other/.test(eb) && /new cartridge/.test(eb), "S1.2 the second image is a second cartridge", eb.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  check(!/refused/.test(eb), "S1.3 the second extract was not refused, and did not overwrite the first (own directory)", eb.split("\n")[0]);
  check(existsSync(join(dir, "analysis", "extracted", "chips", "bank_00_8000.bin")) && existsSync(join(dir, "analysis", "extracted-ef-port", "chips", "bank_00_8000.bin")), "S1.4 each cartridge has its own extract directory");
  const aBin = readFileSync(join(dir, "analysis", "extracted", "chips", "bank_00_8000.bin"));
  const bBin = readFileSync(join(dir, "analysis", "extracted-ef-port", "chips", "bank_00_8000.bin"));
  check(aBin.equals(chipBytes(A, 0)) && bBin.equals(chipBytes(B, 0)) && !aBin.equals(bBin), "S1.5 the two extracted bank-0 files are A's and B's own bytes, and differ");

  const lp = await call("list_payloads", { project_dir: dir, limit: 50 });
  const rows = payloadRows(lp);
  check(rows.length === 3, "S1.6 list_payloads shows A's 1 + B's 2 chip payloads (3), nothing replaced", `${rows.length}: ${rows.map((r) => r.id).join(", ")}`);
  const idA0 = `${slug}:crt/gmod2-orig/00:chip:8000`, idB0 = `${slug}:crt/ef-port/00:chip:8000`, idB1 = `${slug}:crt/ef-port/01:chip:8000`;
  check([idA0, idB0, idB1].every((id) => rows.some((r) => r.id === id)), "S1.7 the ids carry the cartridge: crt/<cart>/<bank>", rows.map((r) => r.id).join(", "));
  const svc = new ProjectKnowledgeService(dir);
  const arts = svc.listArtifacts();
  const pathOf = (src) => arts.find((a) => a.id === src)?.path ?? "";
  const srcA0 = pathOf(rows.find((r) => r.id === idA0)?.src), srcB0 = pathOf(rows.find((r) => r.id === idB0)?.src), srcB1 = pathOf(rows.find((r) => r.id === idB1)?.src);
  check(srcA0.endsWith(join("extracted", "chips", "bank_00_8000.bin")) && srcB0.endsWith(join("extracted-ef-port", "chips", "bank_00_8000.bin")), "S1.8 each src points at its OWN extract", `${srcA0} | ${srcB0}`);
  check(existsSync(srcA0) && readFileSync(srcA0).equals(chipBytes(A, 0)) && existsSync(srcB0) && readFileSync(srcB0).equals(chipBytes(B, 0)) && existsSync(srcB1) && readFileSync(srcB1).equals(chipBytes(B, 1)), "S1.9 …and the bytes behind each src are that cartridge's bank, byte for byte");
  const folders = readdirSync(join(dir, "artifacts", "generated", "payloads"));
  check(folders.length === 3 && new Set(folders).size === 3 && folders.some((f) => /gmod2-orig/.test(f)) && folders.filter((f) => /ef-port/.test(f)).length === 2, "S1.10 the generated payload folders are separate per cartridge and bank", folders.join(", "));
  const folderB0 = folders.find((f) => /ef-port_00/.test(f));
  const asmB0 = readFileSync(join(dir, "artifacts", "generated", "payloads", folderB0, "bank_00_8000.bin_disasm.asm"), "utf8");
  const asmA0 = readFileSync(join(dir, "artifacts", "generated", "payloads", folders.find((f) => /gmod2-orig/.test(f)), "bank_00_8000.bin_disasm.asm"), "utf8");
  // The auto disassembly reads the chip file as a headed image (its first two bytes are the origin): B's bank 0 starts
  // A9 02 -> $02A9, A's A9 01 -> $01A9. The origin therefore names the file the listing was made from, byte for byte.
  const originOf = (crt) => { const c = chipBytes(crt, 0); return `.pc = $${((c[1] << 8) | c[0]).toString(16).toUpperCase().padStart(4, "0")}`; };
  check(asmB0.includes(originOf(B)) && !asmB0.includes(originOf(A)) && asmA0.includes(originOf(A)) && !asmA0.includes(originOf(B)), "S1.11 the auto disassembly of B's bank 0 is made from B's bytes, A's from A's (origin = each chip's first two bytes)", `${originOf(B)} / ${originOf(A)}`);
  const gf = await call("graph_find", { project_dir: dir, query: "bank:00:$8000" });
  check(gf.includes(idA0) && gf.includes(idB0) && /cart:gmod2-orig/.test(gf) && /cart:ef-port/.test(gf), "S1.13 graph_find for bank 0 $8000 with no cartridge lists both, each naming its cartridge", gf.split("\n").slice(0, 6).join(" | "));
  const gfA = await call("graph_find", { project_dir: dir, query: "bank:00:$8000", cart: "ef-port" });
  check(gfA.includes(idB0) && !gfA.includes(idA0), "S1.14 …and with cart it answers for that cartridge only", gfA.split("\n").slice(0, 3).join(" | "));
  const gn = await call("graph_node", { project_dir: dir, ref: "bank:00:$8000", cart: "gmod2-orig" });
  check(/cart:gmod2-orig/.test(gn) || /ambiguous/.test(gn), "S1.15 graph_node takes cart and names it", gn.split("\n").slice(0, 3).join(" | "));
  const ge = await call("graph_edges", { project_dir: dir, ref: idB0, cart: "ef-port" });
  check(!/transport error|tool error/.test(ge), "S1.16 graph_edges accepts cart", ge.split("\n")[0]);
  const cartNodes = nodesLike(dir, `${slug}:crt/%:cartridge`);
  check(cartNodes.length === 2, "S1.17 each cartridge is a node of its own (<slug>:crt/<cart>:cartridge)", cartNodes.join(", "));

  head("S4. a second unexplained cartridge is not guessed");
  const ps0 = await call("project_status", { project_dir: dir });
  check(/gmod2-orig \(GMod2, other — not declared\)/.test(ps0) && /ef-port \(EasyFlash, other — not declared\)/.test(ps0), "S4.1 both cartridges have role other, nothing is filed as source or target", ps0.split("\n").filter((l) => /gmod2|ef-port/.test(l)).join(" | "));
  check(/contract_set cartridges:\[\{cart:"/.test(ps0), "S4.2 …and the answer says how to declare it", ps0.split("\n").filter((l) => /role not declared/.test(l)).join(" | "));
  check(!/source\)/.test(ps0.split("Cartridges (")[1] ?? "") && !/target\)/.test(ps0.split("Cartridges (")[1] ?? ""), "S4.3 neither is called source or target before it is said");

  head("S3. type and role per cartridge");
  const refuse = await call("contract_set", { project_dir: dir, cartridges: [{ cart: "nope", role: "source" }] });
  check(/refused/.test(refuse) && /gmod2-orig/.test(refuse) && /ef-port/.test(refuse), "S3.1 an unknown cartridge is refused, naming the ones the project holds", refuse.split("\n")[0]);
  const declared = await call("contract_set", { project_dir: dir, cartridges: [{ cart: "gmod2-orig", role: "source" }, { cart: "ef-port", role: "target" }] });
  check(/gmod2-orig \(GMod2, source\)/.test(declared) && /ef-port \(EasyFlash, target\)/.test(declared), "S3.2 contract_set declares A source and B target", declared.split("\n").slice(0, 5).join(" | "));
  const ps1 = await call("project_status", { project_dir: dir });
  const cs = await call("contract_show", { project_dir: dir });
  check(/gmod2-orig \(GMod2, source\)/.test(ps1) && /ef-port \(EasyFlash, target\)/.test(ps1), "S3.3 project_status names A as source (GMod2) and B as target (EasyFlash)");
  check(/gmod2-orig \(GMod2, source\)/.test(cs) && /ef-port \(EasyFlash, target\)/.test(cs), "S3.4 contract_show names them the same way");
  const listA = await call("disasm", { path: join(dir, "analysis", "extracted", "chips", "bank_00_8000.bin"), load_address: "8000", space: "crt", bank: 0 });
  const listB = await call("disasm", { path: join(dir, "analysis", "extracted-ef-port", "chips", "bank_00_8000.bin"), load_address: "8000", space: "crt", bank: 0 });
  const asmA = listingOf(listA), asmB = listingOf(listB);
  check(/sta\s+gmod2_ctrl\b/.test(asmA) && /GMod2 control register/.test(asmA) && !/ef_bank|EasyFlash/.test(asmA), "S3.5 $DE00 is GMod2's register in A's listing", asmA.split("\n").filter((l) => /DE00|gmod2/i.test(l)).slice(0, 3).join(" | "));
  check(/sta\s+ef_bank\b/.test(asmB) && /EasyFlash bank register/.test(asmB) && !/gmod2/i.test(asmB), "S3.6 …and EasyFlash's in B's, in the same project", asmB.split("\n").filter((l) => /DE00|ef_/i.test(l)).slice(0, 3).join(" | "));
  check(/crt\/gmod2-orig\/00/.test(listA) || /cartridge gmod2-orig/.test(listA), "S3.7 the answer names the cartridge the names were filed under", listA.split("\n").filter((l) => /artridge/.test(l)).join(" | "));
  mkdirSync(join(dir, "loose"), { recursive: true });
  writeFileSync(join(dir, "loose", "b0.bin"), bBin);
  const loose = await call("disasm", { path: join(dir, "loose", "b0.bin"), load_address: "8000", space: "crt", bank: 0, cart: "ef-port" });
  check(/sta\s+ef_bank\b/.test(listingOf(loose)) && /Cartridge: EasyFlash \(CRT hardware type 32, from cartridge ef-port\)/.test(loose), "S3.8 a node reached without lineage still gets its type, from the cartridge it names", loose.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));

  head("S7. the old form is refused for writing");
  const noCart = await call("disasm", { path: join(dir, "loose", "b0.bin"), load_address: "8000", space: "crt", bank: 0 });
  check(/refused/.test(noCart) && /crt-needs-cart/.test(noCart) && /gmod2-orig/.test(noCart) && /ef-port/.test(noCart), "S7.1 disasm into cartridge space with two cartridges and none named: refused by name, listing both", noCart.split("\n").slice(0, 4).join(" | "));
  const noCartModel = await call("model_assert", { project_dir: dir, name: "stage two loader", level: "container", address_start: 0x8000, address_end: 0x9fff, space: "crt", bank: 0, description: "a loader in a cartridge bank", evidence: ["b0.bin listing"] });
  check(/crt-needs-cart/.test(noCartModel) && /ef-port/.test(noCartModel), "S7.2 model_assert in space crt with two cartridges and none named: refused by name", noCartModel.split("\n").slice(0, 3).join(" | "));
  let err;
  const writer = GraphStore.open(dir);
  try { writer.upsertHuman({ id: `${slug}:crt/00:label:8000`, kind: "label", name: "old_form" }); } catch (e) { err = e; } finally { writer.close(); }
  check(err?.rule === "crt-needs-cart" && /gmod2-orig/.test(err.message) && /ef-port/.test(err.message), "S7.3 the store refuses `crt/00` — the old form — by name, listing the cartridges", err?.message);
  const unit = [];
  const refusesWith = (fn) => { try { fn(); return undefined; } catch (e) { return e.rule; } };
  unit.push(refusesWith(() => ids.parseId("x:crt/00:chip:8000")) === "crt-needs-cart");
  unit.push(refusesWith(() => ids.deriveProjectId({ slug: "x", ctx: { space: "crt", bank: 0 }, kind: "chip", address: 0x8000 })) === "crt-needs-cart");
  unit.push(ids.deriveProjectId({ slug: "x", ctx: { space: "crt", cart: "ef-port", bank: 7 }, kind: "routine", address: 0x8000 }) === "x:crt/ef-port/07:routine:8000");
  unit.push(ids.parseId("x:crt/ef-port/07:routine:8000").ctx.cart === "ef-port" && ids.parseId("x:crt/ef:cartridge").form === "cartridge");
  unit.push(refusesWith(() => ids.deriveProjectId({ slug: "x", ctx: { space: "crt", cart: "Bad_Name", bank: 0 }, kind: "chip", address: 0x8000 })) === "cart-charset");
  unit.push(refusesWith(() => ids.deriveProjectId({ slug: "x", ctx: { space: "ram", owner: "a", cart: "ef" }, kind: "routine", address: 0x8000 })) === "ram-no-cart");
  check(unit.every(Boolean), "S7.4 the id grammar: crt/<cart>/<bank> derives and parses, crt/<bank> is refused, a bad token and a cart on ram are refused", unit.join(","));

  head("S2. a rebuilt target is the same place");
  nameNode(dir, { id: `${slug}:crt/ef-port/01:label:8010`, kind: "label", name: "b_routine", comment: "named in the target" });
  writeFileSync(join(dir, "media", "ef-port.crt"), B2); // the same path, other bytes
  const rb = await call("extract_crt", { project_dir: dir, crt_path: "media/ef-port.crt" });
  check(/Cartridge ef-port \(EasyFlash, target\)/.test(rb) && /same cartridge/.test(rb) && !/new cartridge/.test(rb), "S2.1 the rebuilt image is the same cartridge, and keeps its declared role", rb.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  const ps2 = await call("project_status", { project_dir: dir });
  check(/Cartridges \(2\)/.test(ps2), "S2.2 still two cartridges, not three", ps2.split("\n").filter((l) => /Cartridges/.test(l)).join(" | "));
  const named = await call("graph_find", { project_dir: dir, query: "b_routine" });
  check(named.includes(`${slug}:crt/ef-port/01:label:8010`), "S2.3 the name saved at B bank 1 $8010 is still on B's node", named.split("\n").slice(0, 2).join(" | "));
  const bBin2 = readFileSync(join(dir, "analysis", "extracted-ef-port", "chips", "bank_00_8000.bin"));
  check(bBin2.equals(chipBytes(B2, 0)) && !bBin2.equals(bBin), "S2.4 the chips now carry B' bytes (same extract directory, same cartridge)");
  const imgB = new ProjectKnowledgeService(dir).listArtifacts().find((a) => a.title === "ef-port.crt" || a.path.endsWith("ef-port.crt"));
  check((imgB?.versions?.length ?? 0) >= 1, "S2.5 the image is a new VERSION of one artifact (lineage), not a new image", `versions=${imgB?.versions?.length}`);
  const lp2 = await call("list_payloads", { project_dir: dir, limit: 50 });
  check(payloadRows(lp2).length === 3, "S2.6 list_payloads still shows 3 chip payloads, none duplicated", String(payloadRows(lp2).length));
  writeFileSync(join(dir, "media", "ef-port-v2.crt"), B2);
  const named2 = await call("extract_crt", { project_dir: dir, crt_path: "media/ef-port-v2.crt", cart: "ef-port" });
  check(/Cartridge ef-port \(EasyFlash, target\)/.test(named2) && /same cartridge/.test(named2), "S2.7 a rebuild registered at another path joins the cartridge it names", named2.split("\n").filter((l) => /Cartridge/.test(l)).join(" | "));
  const ps3 = await call("project_status", { project_dir: dir });
  check(/Cartridges \(2\)/.test(ps3), "S2.8 …and the project still holds two cartridges", ps3.split("\n").filter((l) => /Cartridges/.test(l)).join(" | "));
  const other = await call("extract_crt", { project_dir: dir, crt_path: "media/gmod2-orig.crt", output_dir: "analysis/extracted-ef-port" });
  check(/refused/.test(other) && /ef-port/.test(other), "S2.9 an extract directory that holds another cartridge's extract is refused, never overwritten", other.split("\n")[0]);
} catch (e) {
  check(false, "script ran", String(e && e.stack || e));
} finally {
  m.stop();
}

// ═══ S6 an old project moves once ═══════════════════════════════════════════════════════════════
head("S6. an old project moves once");
{
  const old = project("c64re-e2e-909-old-");
  writeFileSync(join(old, "media", "gmod2-orig.crt"), A);
  writeFileSync(join(old, "media", "ef-port.crt"), B);
  const s1 = await session(old);
  let slug;
  try {
    await s1.call("project_init", { project_dir: old, name: "old909" });
    await s1.call("agent_onboard", { project_dir: old });
    slug = slugOf(old);
    await s1.call("extract_crt", { project_dir: old, crt_path: "media/gmod2-orig.crt" });
    await s1.call("extract_crt", { project_dir: old, crt_path: "media/ef-port.crt" });
  } finally { s1.stop(); }
  // Names a session saved before 909 (the ids are turned into the old form below). What ties each to a cartridge:
  //   the chip of A's bank 0     its payload is A's own file                                    -> A
  //   a label in bank 1          only B has a bank 1 (each cartridge's own manifest says so)   -> B
  //   a label in bank 0          BOTH have a bank 0 and the name has no source                  -> not placeable
  //   a label in bank 3          neither has one                                                -> not placeable
  nameNode(old, { id: `${slug}:crt/gmod2-orig/00:chip:8000`, kind: "chip", name: "a_boot_chip", comment: "A's boot chip" });
  nameNode(old, { id: `${slug}:crt/ef-port/01:label:8010`, kind: "label", name: "b_routine", comment: "named in B" });
  nameNode(old, { id: `${slug}:crt/gmod2-orig/00:label:8004`, kind: "label", name: "a_entry", comment: "somewhere in bank 0" });
  {
    const store = GraphStore.open(old);
    try { store.upsertHuman({ id: `${slug}:crt/ef-port/03:label:8100`, kind: "label", name: "mystery", origin: "user", confidence: "user_asserted" }); } finally { store.close(); }
  }
  // Down-convert the graph to the state the bug left: no cartridge nodes, `crt/<bank>` ids, B's bank-0 chip folded onto
  // A's node (B's evidence on it), schema version 1, no cart column, no stamp.
  const gpath = join(old, "knowledge", "graph.sqlite");
  const db = new DatabaseSync(gpath);
  const legacyOf = (id) => id.replace(/:crt\/[a-z0-9-]+\/([0-9a-f]{2}):/u, ":crt/$1:");
  db.exec("PRAGMA foreign_keys = OFF; DROP INDEX IF EXISTS nodes_cart; ALTER TABLE nodes DROP COLUMN cart;");
  db.exec("DELETE FROM nodes WHERE kind = 'cartridge'");
  const idsNow = db.prepare("SELECT DISTINCT id FROM nodes WHERE id LIKE '%:crt/%'").all().map((r) => r.id);
  const fold = new Map(); // B's bank-0 duplicates -> A's
  for (const id of idsNow) if (/:crt\/ef-port\/00:/.test(id)) fold.set(id, id.replace("/ef-port/", "/gmod2-orig/"));
  for (const [b, a] of fold) {
    db.prepare("UPDATE evidence SET target_key = ? WHERE target_table = 'nodes' AND target_key = ? AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.target_table = 'nodes' AND e.target_key = ? AND e.legacy_id = evidence.legacy_id)").run(a, b, a);
    db.prepare("DELETE FROM evidence WHERE target_table = 'nodes' AND target_key = ?").run(b);
    db.prepare("DELETE FROM nodes WHERE id = ?").run(b);
    db.prepare("DELETE FROM migration_log WHERE target_table = 'nodes' AND target_id = ?").run(b);
  }
  const allNow = db.prepare("SELECT DISTINCT id FROM nodes WHERE id LIKE '%:crt/%'").all().map((r) => r.id);
  const rename = new Map(allNow.map((id) => [id, legacyOf(id)]));
  const txt = (s) => (s === null ? null : s.replace(/[a-z0-9-]+:crt\/[a-z0-9-]+\/[0-9a-f]{2}:[a-z_]+:[0-9a-f]{4}/g, (x) => rename.get(x) ?? legacyOf(x)));
  for (const [from, to] of rename) {
    db.prepare("UPDATE nodes SET id = ? WHERE id = ?").run(to, from);
    db.prepare("UPDATE claims SET node_id = ? WHERE node_id = ?").run(to, from);
    db.prepare("UPDATE questions SET node_id = ? WHERE node_id = ?").run(to, from);
    db.prepare("UPDATE evidence SET target_key = ? WHERE target_table = 'nodes' AND target_key = ?").run(to, from);
    db.prepare("UPDATE migration_log SET target_id = ? WHERE target_table = 'nodes' AND target_id = ?").run(to, from);
    for (const a of db.prepare("SELECT id, kind, title FROM annotations WHERE node_id = ?").all(from)) {
      const nid = annotationId(to, a.kind, a.title);
      db.prepare("UPDATE annotations SET id = ?, node_id = ? WHERE id = ?").run(nid, to, a.id);
      db.prepare("UPDATE evidence SET target_key = ? WHERE target_table = 'annotations' AND target_key = ?").run(nid, a.id);
    }
  }
  for (const e of db.prepare("SELECT from_id, type, to_id, layer, evidence_key FROM edges WHERE from_id LIKE '%:crt/%' OR to_id LIKE '%:crt/%'").all()) {
    db.prepare("UPDATE OR IGNORE edges SET from_id = ?, to_id = ? WHERE from_id = ? AND type = ? AND to_id = ? AND layer = ? AND evidence_key = ?").run(txt(e.from_id), txt(e.to_id), e.from_id, e.type, e.to_id, e.layer, e.evidence_key);
    db.prepare("DELETE FROM edges WHERE from_id = ? AND type = ? AND to_id = ? AND layer = ? AND evidence_key = ?").run(e.from_id, e.type, e.to_id, e.layer, e.evidence_key);
  }
  db.prepare("DELETE FROM meta WHERE key IN ('cart_grammar', 'cart_migration', 'cart_rederive_pending')").run();
  db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  const rowsBefore = Number(db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n);
  const crtBefore = db.prepare("SELECT DISTINCT id FROM nodes WHERE id LIKE '%:crt/%' ORDER BY id").all().map((r) => r.id);
  db.close();
  check(crtBefore.length > 0 && crtBefore.every((id) => /:crt\/[0-9a-f]{2}:/.test(id)), "S6.0 the fixture is in the old form: every crt id is crt/<bank>", crtBefore.slice(0, 4).join(", "));

  // open it on this build — a new process, the way a session comes to a project
  const s2 = await session(old, { onboard: true });
  let status, found, foundB, entry0, mystery, node0B, lp;
  try {
    status = await s2.call("project_status", { project_dir: old });
    found = await s2.call("graph_find", { project_dir: old, query: "a_boot_chip" });
    foundB = await s2.call("graph_find", { project_dir: old, query: "b_routine" });
    entry0 = await s2.call("graph_find", { project_dir: old, query: "a_entry" });
    mystery = await s2.call("graph_find", { project_dir: old, query: "mystery" });
    node0B = await s2.call("graph_find", { project_dir: old, query: "bank:00:$8000" });
    lp = await s2.call("list_payloads", { project_dir: old, limit: 50 });
  } finally { s2.stop(); }
  const after = nodesLike(old, "%:crt/%");
  check(after.every((id) => /:crt\/[a-z0-9-]+(\/[0-9a-f]{2}:|:cartridge)/.test(id)), "S6.1 every crt node is now crt/<cart>/<bank> (or a cartridge node)", after.filter((id) => !/:crt\/[a-z0-9-]+(\/[0-9a-f]{2}:|:cartridge)/.test(id)).slice(0, 4).join(", "));
  check(/Cartridge nodes moved to the cartridge grammar/.test(status), "S6.2 the open says it moved them", status.split("\n").filter((l) => /moved|Cartridge nodes/.test(l)).join(" | "));
  check(found.includes(`${slug}:crt/gmod2-orig/00:chip:8000`), "S6.3 the name on A's chip follows the rename to A (its payload is A's file)", found.split("\n")[0]);
  check(foundB.includes(`${slug}:crt/ef-port/01:label:8010`), "S6.3b a name in bank 1 goes to B: only B's manifest has a bank 1", foundB.split("\n")[0]);
  check(/NOT PLACED/.test(status) && status.includes(`${slug}:crt/03:label:8100`) && status.includes(`crt/unplaced/03`) && status.includes(`${slug}:crt/00:label:8004`), "S6.4 what nothing can place is LISTED BY NAME in the answer (the bank-0 label both cartridges could own; the bank-3 one), and kept under crt/unplaced/<bank>", status.split("\n").filter((l) => /unplaced|NOT PLACED/.test(l)).join(" | "));
  check(mystery.includes(`${slug}:crt/unplaced/03:label:8100`) && entry0.includes(`${slug}:crt/unplaced/00:label:8004`), "S6.5 …they exist under crt/unplaced, not merged into a real cartridge", `${mystery.split("\n")[0]} | ${entry0.split("\n")[0]}`);
  check(node0B.includes(`${slug}:crt/gmod2-orig/00:chip:8000`) && node0B.includes(`${slug}:crt/ef-port/00:chip:8000`), "S6.6 B's bank-0 chip is created fresh next to A's (the bug's merged node is repaired)", node0B.split("\n").slice(0, 6).join(" | "));
  const rows6 = payloadRows(lp);
  check(rows6.length === 3 && rows6.some((r) => r.id.includes("ef-port/00")), "S6.7 list_payloads shows both cartridges' chips", rows6.map((r) => r.id).join(", "));
  const arts6 = new ProjectKnowledgeService(old).listArtifacts();
  const srcB = arts6.find((a) => a.id === rows6.find((r) => r.id.includes("ef-port/00"))?.src);
  check(srcB && readFileSync(srcB.path).equals(chipBytes(B, 0)), "S6.8 …B's chip points at B's own .bin", srcB?.path);
  const db2 = new DatabaseSync(gpath, { readOnly: true });
  const stamp = db2.prepare("SELECT value FROM meta WHERE key = 'cart_grammar'").get()?.value;
  const rowsAfter = Number(db2.prepare("SELECT COUNT(*) AS n FROM nodes").get().n);
  db2.close();
  check(stamp === "909", "S6.9 the graph carries the stamp", String(stamp));
  console.log(`      (node rows before ${rowsBefore}, after ${rowsAfter}; ${crtBefore.length} crt node ids before)`);
  // a second open changes nothing
  const dumpOf = () => { const st = GraphStore.open(old, { readOnly: true }); try { return `${st.contentHash("generated")}/${st.contentHash("human")}`; } finally { st.close(); } };
  const h1 = dumpOf();
  const s3 = await session(old, { onboard: true });
  try { await s3.call("project_status", { project_dir: old }); await s3.call("list_payloads", { project_dir: old, limit: 50 }); } finally { s3.stop(); }
  new ProjectKnowledgeService(old);
  check(dumpOf() === h1, "S6.10 a second open changes nothing (generated and human layer hashes equal)");
}

console.log("");
process.exit(T.done());
