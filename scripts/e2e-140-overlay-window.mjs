#!/usr/bin/env node
// Issue #140 part 2 — a window that starts inside mine and runs past my end
// overlays mine from its start; a call into that stretch is not my code.
//
// Spec 867 already treats a window wholly INSIDE mine as a hole. A program
// loaded at $3400 over the tail of a menu at $2700-$7F3F sticks out past the
// menu's end, so it was no hole, and the loader's `jmp $3400` seeded the menu.
//
// Hermetic: own PRGs, own graph.sqlite through the real schema, no runtime.
//
//   menu  payload window $2700-$7F3F, image $2700-$3401 (JAM filler)
//   prog  payload window $3400-$9ABF, image $3400-$3401: inx / rts
//   loader -> $3400  CALLS, certain
//
// Exit 0 = pass, 1 = fail.   npm run e2e:140-overlay-window

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const check = (c, m) => { if (c) { pass += 1; console.log(`  PASS  ${m}`); } else { failCount += 1; console.log(`  FAIL  ${m}`); } };

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const { GRAPH_DDL } = await import("../dist/knowledge-graph/schema.js");

const dir = mkdtempSync(join(tmpdir(), "c64re-140w-"));
const prg = (name, base, bytes) => {
  const p = join(dir, `${name}.prg`);
  writeFileSync(p, Buffer.from([base & 0xff, base >> 8, ...bytes]));
  return p;
};
const menuImage = Buffer.alloc(0x3402 - 0x2700, 0x02);
menuImage.set([0x60], 0); // $2700 rts
menuImage.set([0xe8, 0x60], 0x3400 - 0x2700); // the same bytes prog has there
const menuPrg = prg("menu", 0x2700, menuImage);
const progPrg = prg("prog", 0x3400, [0xe8, 0x60]);

mkdirSync(join(dir, "knowledge"), { recursive: true });
const db = new DatabaseSync(join(dir, "knowledge", "graph.sqlite"));
db.exec(GRAPH_DDL);
const node = db.prepare("INSERT INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?, 'generated', ?, 'ram', ?, NULL, ?, ?, ?, ?, ?, 'static', 'certain', 'control-flow', '[]')");
const payload = (owner, start, end) => node.run(`fx:ram/${owner}:payload:${start.toString(16)}`, "payload", owner, owner, start, end, owner, JSON.stringify({ payload: { window: { start, end } } }));
node.run("fx:ram/menu:routine:2700", "routine", "menu", "menu", 0x2700, 0x2700, null, "{}");
node.run("fx:ram/prog:routine:3401", "routine", "prog", "prog", 0x3401, 0x3401, null, "{}");
node.run("fx:ram/loader:routine:1420", "routine", "loader", "loader", 0x1420, 0x1430, null, "{}");
node.run("fx:ram:addr:3400", "addr", null, null, 0x3400, null, null, "{}");
payload("menu", 0x2700, 0x7f3f);
payload("prog", 0x3400, 0x9abf);
db.prepare("INSERT INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES ('fx:ram/loader:routine:1420', 'CALLS', 'fx:ram:addr:3400', 'generated', 'src:1425', 'static', 'certain', 'control-flow', 'loader', '{}')").run();
db.close();

const analyze = (p, entry) => {
  const out = p.replace(/\.prg$/, ".json");
  execFileSync(process.execPath, [cli, "analyze-prg", p, out, entry, "--no-register"], {
    stdio: "pipe", env: { ...process.env, C64RE_PROJECT_DIR: dir, C64RE_NO_GRAPH_SEEDS: "" },
  });
  return JSON.parse(readFileSync(out, "utf8")).codeSeedReport ?? {};
};
const menu = analyze(menuPrg, "2700");
const prog = analyze(progPrg, "3401");

check(!(menu.seeds ?? []).some((s) => s.address === 0x3400), "menu: $3400 is not seeded");
check((menu.outOfScope ?? []).some((o) => o.address === 0x3400 && /overlays it/.test(o.detail)), "menu: $3400 is named out of scope, overlaid by prog");
check((prog.seeds ?? []).some((s) => s.address === 0x3400 && s.origin === "cross_owner_call"), "prog: $3400 is still seeded");
rmSync(dir, { recursive: true, force: true });

console.log(`\n${failCount ? "RED" : "GREEN"}  140 overlay window: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
