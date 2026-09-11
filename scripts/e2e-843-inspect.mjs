#!/usr/bin/env node
// Spec 843 — click a pixel, name the thing.
//
// Hermetic: the source, the generated tool surface, and the graph through a real
// temp project. The parts that need a running machine (the daemon RPCs) are checked
// at their contract, not by booting a C64 — a gate that needs the owner's session is
// a gate that runs once.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:843-inspect
import { readFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TRX = resolve(ROOT, "..", "TRX64");
let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

console.log("Spec 843 — the frozen screen, and what it can tell you\n");

const overlay = read(join(ROOT, "ui/src/workbench/components/ExploreOverlay.tsx"));
const filmstrip = read(join(ROOT, "ui/src/workbench/components/Filmstrip.tsx"));
const persist = read(join(ROOT, "src/workspace-ui/inspect-evidence-persist.ts"));
const runtimeTs = read(join(ROOT, "src/server-tools/runtime.ts"));
const tiers = read(join(ROOT, "src/server-tools/tier-tools.ts"));

// ── D1/D2 — the daemon half (skipped, loudly, without a TRX64 checkout) ───────
if (!existsSync(TRX)) {
  console.log("  SKIP  D1/D2: no TRX64 checkout at ../TRX64 — the daemon half is unchecked (NOT a pass)");
} else {
  const snap = read(join(TRX, "crates/trx64-core/src/c64re_snapshot.rs"));
  const vic = read(join(TRX, "crates/trx64-core/src/vic.rs"));
  const insp = read(join(TRX, "crates/trx64-core/src/vic_inspect.rs"));
  const daemon = read(join(TRX, "crates/trx64-daemon/src/main.rs"));

  check(!/"vicProvenance": serde_json::Value::Null/.test(snap),
    "D1: the capture site no longer hardcodes a null provenance");
  check(/capture_vic_provenance/.test(snap), "D1: …it calls a real capture");
  check(/pub provenance: \[ProvenanceRegs/.test(vic), "D1: the VIC holds a per-line record");
  check(/if self\.raster_cycle == 0 \{/.test(vic), "D1: …written at the START of each line");
  check(/captured: true/.test(vic) && /filter\(\|\(_, p\)\| p\.captured\)/.test(snap),
    "D1: an unvisited line is omitted rather than sent stale");

  check(/pub bytes: Option<Vec<u8>>/.test(insp), "D2: a MemoryRef can carry a run of bytes");
  check(/bytes: byte_run\(ram, bitmap_addr, 8, false\)/.test(insp), "D2: …the bitmap ref carries its 8");
  check(/bytes: byte_run\(ram, char_addr, 8, bases\.char_rom_shadow\)/.test(insp),
    "D2: …and the charset ref, except out of the ROM shadow where there are none");

  check(/pub fn coalesce_region_ranges/.test(insp), "D6: a region coalesces into source ranges");
  check(/"ranges": ranges/.test(daemon), "D6: …and the RPC returns them");
  check(/"checkpoint\/read_memory" =>/.test(daemon), "D9: a frozen checkpoint can be read");
  check(/"search": \{/.test(daemon) && /"limits": \[/.test(daemon),
    "D11: the origin RPC reports what it searched and why it may find nothing");
}

// ── D3 — the frame map is kept and rendered ──────────────────────────────────
check(/setFrame\(r\.frame \?\? null\)/.test(overlay), "D3: the frame memory map is kept, not dropped");
check(/const baseOf = \(kind: string\)/.test(overlay) && /renderFrameMap/.test(overlay),
  "D3: …and each ref is shown against its base");
check(/bytes\.map\(\(b\) => b\.toString\(16\)/.test(overlay), "D3: multi-byte refs render their bytes");

// ── D4 — the checkpoint follows the picture ──────────────────────────────────
check(/c64re:machine-moved/.test(filmstrip), "D4: a scrub announces that the machine moved");
check(/c64re:machine-moved/.test(overlay) && /reopenNonce/.test(overlay),
  "D4: …and the overlay re-opens on it");
check(/\[sessionId, reopenNonce\]/.test(overlay),
  "D4: …through the same effect, so the old checkpoint is unpinned before the new one");

// ── D5 — the pin ─────────────────────────────────────────────────────────────
check(/openCpRef = useRef<string \| null>/.test(overlay),
  "D5: the open checkpoint is a ref, not a local the cleanup closes over");
check(/close failed — a checkpoint stays pinned/.test(overlay),
  "D5: …and a failing close is reported, not swallowed");

// ── D6 — ranges in the UI ────────────────────────────────────────────────────
check(/setRegionRanges/.test(overlay), "D6: the UI keeps the source ranges");
check(/source range\(s\) across/.test(overlay), "D6: …and says how many, not just a node count");

// ── D7 — promote writes knowledge ────────────────────────────────────────────
check(/saveFinding\(\{/.test(persist), "D7: promote writes a FINDING, not only an artifact");
check(/addressRange: \{ start, end \}/.test(persist), "D7: …with an address range, so the graph can find it");
check(/artifactIds: \[artifact\.id/.test(persist) && !/sessionId/.test(persist),
  "D7: …against the evidence artifact, never a runtime session id (B7)");
check(/NO findings: nothing had a source range/.test(overlay),
  "D7: …and the UI says when it did NOT reach the graph");

// ── D9/D10 — the two ends ────────────────────────────────────────────────────
for (const t of ["runtime_rip_range", "runtime_inject_range"]) {
  check(runtimeTs.includes(`"${t}"`), `${t} exists`);
  check(tiers.includes(`"${t}"`), `…and is in DEFAULT_TOOLS, so a client can find it`);
}
const inv = JSON.parse(read(join(ROOT, "docs/tool-surface-inventory.json")) || "{}");
const tools = Array.isArray(inv) ? inv : (inv.tools ?? []);
const desc = (n) => tools.find((t) => t.name === n)?.desc ?? "";
check(/OVERLAY/.test(desc("runtime_inject_range")) && /reset drops the layer/.test(desc("runtime_inject_range")),
  "runtime_inject_range says it is a layer and that a reset drops it");
check(/there is none/.test(desc("runtime_inject_range")),
  "…and that there is no permanent write to the medium, rather than leaving the caller to hope");
check(/refusing to write a short file/.test(runtimeTs),
  "a short read does not silently produce a truncated .bin");

// Every parameter described (Spec 835).
const schemaOf = (src, tool) => {
  const at = src.indexOf(`"${tool}",`);
  if (at < 0) return "";
  const open = src.indexOf("\n    {", at);
  const close = src.indexOf("\n    },", open);
  return open < 0 || close < 0 ? "" : src.slice(open, close);
};
for (const t of ["runtime_rip_range", "runtime_inject_range"]) {
  const lines = schemaOf(runtimeTs, t).split("\n").filter((l) => /^\s+[a-z_]+: z\./.test(l));
  const bare = lines.filter((l) => !l.includes(".describe(")).map((l) => l.trim().split(":")[0]);
  check(lines.length > 0 && bare.length === 0,
    `${t}: every parameter described${bare.length ? ` — bare: ${bare.join(", ")}` : ` (${lines.length})`}`);
}

// ── D8 — the projection, against a real (empty) project ──────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-843-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const gen = join(ROOT, "scripts/gen-annotations-from-graph.mjs");
  const w = spawnSync(process.execPath, [gen, dir], { encoding: "utf8" });
  check(w.status === 0, `D8: the projection runs${w.status !== 0 ? `: ${w.stderr}` : ""}`);
  const out = join(dir, "knowledge", "generated", "graph_annotations.json");
  check(existsSync(out), "D8: …and writes the generated file");
  check(/edit the GRAPH, not this file/.test(read(out)),
    "D8: …which says it is generated, so nobody hand-edits it and loses the edit");
  const c1 = spawnSync(process.execPath, [gen, dir, "--check"], { encoding: "utf8" });
  check(c1.status === 0 && /in sync/.test(c1.stdout), "D8: --check passes right after a write");
  // And it has teeth.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, "{}\n");
  const c2 = spawnSync(process.execPath, [gen, dir, "--check"], { encoding: "utf8" });
  check(c2.status === 1 && /DRIFT/.test(c2.stdout), "D8: …and fails when the file drifts from the graph");
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 843: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
