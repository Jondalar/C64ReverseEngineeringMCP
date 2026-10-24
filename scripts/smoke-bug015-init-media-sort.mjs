// BUG-015 — project_init / init flow sorts loose root media into typed input/
// folders, registers each at its canonical path with preserved provenance,
// leaves the root clean (unknown types stay), and is idempotent.
import { writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-015 — project_init sorts media into typed input/ folders\n");

const dir = testTmpDir("c64re-bug015-");
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

const { ProjectKnowledgeService } = await import(pathToFileURL(`${ROOT}/dist/project-knowledge/service.js`).href);
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

// 6. media in a folder the user made (a project often arrives as disk/*.d64) are registered
//    where they are: nothing moves, nothing is copied, every path into the folder stays
{
  const { mkdirSync, rmSync } = await import("node:fs");
  const d2 = testTmpDir("c64re-bug015-sub-");
  mkdirSync(join(d2, "disk"), { recursive: true });
  mkdirSync(join(d2, "extras", "deep"), { recursive: true });
  writeFileSync(join(d2, "disk", "side-a.d64"), Buffer.from([1]));
  writeFileSync(join(d2, "disk", "side-b.d64"), Buffer.from([2]));
  writeFileSync(join(d2, "extras", "deep", "trainer.prg"), Buffer.from([1, 8, 0x60]));
  writeFileSync(join(d2, "extras", "notes.md"), "# mine");
  const s2 = new ProjectKnowledgeService(d2);
  s2.initProject({ name: "BUG-015 subfolders" });
  const h2 = (p) => existsSync(join(d2, p));
  // a re-run of init (no subfolders option) never looks into the user's folders
  ok(s2.sortLooseInputMedia().sorted.length === 0 && h2("disk/side-a.d64"), "12a without the first-init option a user folder is not entered");
  const r = s2.sortLooseInputMedia({ subfolders: true });
  const arts = s2.listArtifacts();
  const at = (rel) => arts.find((x) => (x.path ?? "").replace(/\\/g, "/").endsWith(rel));
  ok(!!at("disk/side-a.d64") && !!at("disk/side-b.d64") && !!at("extras/deep/trainer.prg") && at("disk/side-a.d64")?.kind === "d64", "12 media in user subfolders (any depth) are registered at their own path", r.sorted.map((x) => x.from).join(","));
  ok(!h2("input/disk/side-a.d64") && !h2("input/prg/trainer.prg"), "12b nothing is copied into input/ (one file, one artifact)");
  ok(h2("extras/notes.md") && !h2("input/docs/notes.md"), "13 a user folder's notes stay where they are");
  ok(h2("disk/side-a.d64") && h2("disk/side-b.d64") && h2("extras/deep/trainer.prg"), "14 the files stay where they were");
  const art = at("disk/side-a.d64");
  ok(!!art && /Registered in place/.test(art.description ?? ""), "15 the record says it was registered in place", art?.description);
  ok(s2.sortLooseInputMedia({ subfolders: true }).sorted.length === 0, "16 idempotent with subfolders");
  rmSync(d2, { recursive: true, force: true });
}

// 7. through project_init: the first init takes disk/*.d64; a re-run leaves a build folder alone
{
  const { mkdirSync, rmSync } = await import("node:fs");
  const { Harness } = await import("./lib/e2e-906-harness.mjs");
  const H = new Harness("bug015-");
  const d3 = testTmpDir("c64re-bug015-mcp-");
  try {
    mkdirSync(join(d3, "disk"), { recursive: true });
    writeFileSync(join(d3, "disk", "boot.d64"), Buffer.from([1]));
    const m = await H.mcp(d3, { onboard: false });
    const r1 = await m.call("project_init", { project_dir: d3, name: "sub", preferred_assembler: "kickass" });
    ok(!existsSync(join(d3, "input", "disk", "boot.d64")) && existsSync(join(d3, "disk", "boot.d64")) && /disk\/boot\.d64 registered in place/.test(r1), "17 project_init registers disk/*.d64 in place on the first init", (r1.match(/Input media sorted.*\n.*/) ?? [""])[0]);
    mkdirSync(join(d3, "port"), { recursive: true });
    writeFileSync(join(d3, "port", "build.prg"), Buffer.from([1, 8, 0x60]));
    await m.call("project_init", { project_dir: d3, name: "sub", machine_model: "c64-ntsc" });
    ok(existsSync(join(d3, "port", "build.prg")) && !existsSync(join(d3, "input", "prg", "build.prg")), "18 a re-run of project_init leaves a build folder's PRG where it is");
  } finally { H.cleanup(); rmSync(d3, { recursive: true, force: true }); }
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug015: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
