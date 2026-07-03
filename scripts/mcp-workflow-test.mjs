// MCP-workflow test harness (the safety net that was missing — see
// docs/redesign/keystone-schema.md + scratch test-concept). Drives the C64RE
// meaning-layer against REAL project fixtures, isolated: each fixture is copied
// to a temp dir, exercised, asserted, then removed. NEVER touches a live project.
//
// Layer 3 (BDD real) fixtures = the Cracking/ projects, opt-in + SKIP-loud if
// absent. Layer 2 synthetic committed fixtures are a follow-up.
//
// Run: npm run test:mcp-workflow   (needs `npm run build:mcp` first)
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const CRACKING = process.env.C64RE_TEST_PROJECTS || "/Users/alex/Development/C64/Cracking";
// Each fixture: the expectation is derived from the media it OWNS, not from which
// extraction tool ran — that's the whole point of the keystone Medium→Payload model.
const FIXTURES = [
  { name: "Wasteland_EF", dir: join(CRACKING, "Wasteland_EF"), note: "BAM / extract_disk succeeded — 4 sides" },
  { name: "The Pawn", dir: join(CRACKING, "The Pawn"), note: "custom-GCR / protected — 2 sides, no CBM directory" },
];

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

function withFixture(dir, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "c64re-fixture-"));
  try {
    cpSync(dir, join(tmp, "proj"), { recursive: true });
    return fn(join(tmp, "proj"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// count of real medium artifacts the project owns (disk images) = how many disks
// the disk view MUST show, regardless of BAM vs custom-GCR.
function diskImageCount(svc) {
  return svc.listArtifacts().filter((a) => a.kind === "g64" || a.kind === "d64").length;
}

console.log("MCP-workflow harness — keystone Medium->Payload spine\n");

for (const fx of FIXTURES) {
  console.log(`# ${fx.name} — ${fx.note}`);
  if (!existsSync(join(fx.dir, "knowledge"))) { skip++; console.log(`  SKIP  fixture absent: ${fx.dir}\n`); continue; }
  withFixture(fx.dir, (proj) => {
    const svc = new ProjectKnowledgeService(proj);
    const nSides = diskImageCount(svc);

    // (a) no crash — a single view must never blank the whole snapshot.
    let snap = null;
    try { snap = svc.buildWorkspaceUiSnapshot(); ok(true, "buildWorkspaceUiSnapshot returns (no crash)"); }
    catch (e) { ok(false, "buildWorkspaceUiSnapshot returns (no crash)", e.message); }
    if (!snap) { console.log(); return; }

    // (b) THE keystone assertion: disk view shows one disk per disk-image (the
    //     medium), medium-agnostic — NOT one per manifest, NOT 0 for custom-GCR.
    const disks = snap.views?.diskLayout?.disks ?? [];
    ok(disks.length === nSides,
      `disk-layout shows one disk per side (medium-agnostic)`,
      `${disks.length} disks vs ${nSides} disk-image sides`);

    // (c) no phantom disks (the regression: 70 per-track metadata as disks).
    ok(disks.length <= nSides, `no phantom disks`, `${disks.length} <= ${nSides}`);

    // (d) shape: every disk is a valid disk object (id + files[] + sectors[]).
    if (disks.length > 0) {
      const shaped = disks.every((d) => d && typeof d.artifactId === "string" && Array.isArray(d.files) && Array.isArray(d.sectors));
      ok(shaped, `every disk has {artifactId, files[], sectors[]}`);
      // block occupancy (geometry) must be present for EVERY disk, BAM or custom-GCR.
      ok(disks.every((d) => (d.sectors ?? []).length > 0), `every disk shows block/sector occupancy`);
    }

    // (e) BAM disk keeps its CBM directory; custom-GCR disk is allowed empty files
    //     (payloads pending) but still shows geometry — both from the SAME model.
    if (fx.name === "Wasteland_EF" && disks.length > 0) {
      ok(disks.some((d) => (d.files ?? []).length > 0), `BAM disk preserves its CBM directory (files present)`);
    }
  });
  console.log();
}

console.log(`${fail === 0 ? "GREEN" : "RED"}  mcp-workflow: ${pass} pass, ${fail} fail, ${skip} skip.`);
process.exit(fail === 0 ? 0 : 1);
