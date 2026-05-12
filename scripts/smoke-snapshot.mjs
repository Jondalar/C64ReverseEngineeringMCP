#!/usr/bin/env node
// Spec 101 (M1.4) — snapshot round-trip smoke.
//
// Boot, run, snapshot1, run more, snapshot2, restore(snapshot1),
// snapshot3 — assert snapshot1 == snapshot3 (modulo schema-stable
// JSON serialization).

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const disk = "samples/synthetic/1byte.g64";
if (!existsSync(disk)) { console.error(`fixture missing: ${disk}`); process.exit(2); }

let startIntegratedSession, snapshotMod;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  snapshotMod = await import("../dist/runtime/headless/snapshot.js");
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

function hashSnapshot(s) {
  return createHash("md5").update(snapshotMod.snapshotToString(s)).digest("hex");
}

const { session } = startIntegratedSession({ diskPath: disk, mode: "true-drive" });
session.resetCold("pal-default");
session.runFor(50_000);

const snap1 = snapshotMod.snapshot(session, { include: ["ram"] });
const h1 = hashSnapshot(snap1);
console.log(`snap1 (after 50k cycles): hash=${h1}`);

session.runFor(50_000);
const snap2 = snapshotMod.snapshot(session, { include: ["ram"] });
const h2 = hashSnapshot(snap2);
console.log(`snap2 (after 100k cycles): hash=${h2}`);

if (h1 === h2) {
  console.log("WARN: snap1 == snap2 — system may not be advancing state");
}

snapshotMod.restore(session, snap1);
const snap3 = snapshotMod.snapshot(session, { include: ["ram"] });
const h3 = hashSnapshot(snap3);
console.log(`snap3 (after restore(snap1)): hash=${h3}`);

console.log("---");
if (h1 === h3) {
  console.log("PASS: snapshot → restore → snapshot is round-trip stable");
  process.exit(0);
}
console.log("FAIL: round-trip diverged");
process.exit(1);
