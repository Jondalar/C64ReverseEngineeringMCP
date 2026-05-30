// BUG-015 — project_init / init flow sorts loose root media into typed input/
// folders, registers each at its canonical path with preserved provenance,
// leaves the root clean (unknown types stay), and is idempotent.
import { mkdtempSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-015 — project_init sorts media into typed input/ folders\n");

const dir = mkdtempSync(join(tmpdir(), "c64re-bug015-"));
// loose mixed media in the project root
const files = {
  "game.d64": Buffer.from([0x01, 0x02]),
  "demo.g64": Buffer.from([0x03]),
  "cart.crt": Buffer.from("C64 CARTRIDGE"),
  "loader.prg": Buffer.from([0x01, 0x08, 0xa9]),
  "readme.md": "# notes",
  "log.txt": "hello",
  "manual.pdf": Buffer.from("%PDF-1.4"),
  "keepme.xyz": "unknown type stays in root",
};
for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);

const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(dir);
svc.initProject({ name: "BUG-015 fixture" });
const res = svc.sortLooseInputMedia();

const has = (p) => existsSync(join(dir, p));
const rootEntries = () => readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());

// 1. canonical placement
ok(has("input/disk/game.d64") && has("input/disk/demo.g64"), "1 .d64/.g64 → input/disk/");
ok(has("input/crt/cart.crt"), "2 .crt → input/crt/");
ok(has("input/prg/loader.prg"), "3 .prg → input/prg/");
ok(has("input/docs/readme.md") && has("input/docs/log.txt") && has("input/docs/manual.pdf"), "4 .md/.txt/.pdf → input/docs/");

// 2. root cleaned of sorted media; unknown type stays
const left = rootEntries();
ok(!left.includes("game.d64") && !left.includes("cart.crt") && !left.includes("loader.prg") && !left.includes("readme.md"),
  "5 sorted media removed from project root", `root files: ${left.join(",")}`);
ok(left.includes("keepme.xyz"), "6 unknown type left in root (not swept)", "");

// 3. artifacts registered at canonical paths with provenance
const arts = svc.listArtifacts ? svc.listArtifacts() : [];
const artList = Array.isArray(arts) ? arts : (arts.items ?? []);
const byTo = (rel) => artList.find((a) => (a.path ?? "").replace(/\\/g, "/").endsWith(rel));
const a1 = byTo("input/disk/game.d64");
ok(!!a1, "7 artifact registered for game.d64 at canonical path", a1 ? a1.path : "missing");
ok(a1 && a1.kind === "d64", "8 artifact kind = d64", a1?.kind);
ok(a1 && /Original source: game\.d64/.test(a1.description ?? ""), "9 provenance (original source) preserved in artifact", "");

// 4. result object reports the moves
ok(res.sorted.length === 7, "10 result reports 7 sorted files", `sorted=${res.sorted.length}`);

// 5. idempotent — second run sorts nothing
const res2 = svc.sortLooseInputMedia();
ok(res2.sorted.length === 0, "11 idempotent: second run sorts 0", `sorted=${res2.sorted.length}`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug015: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
