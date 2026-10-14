#!/usr/bin/env node
// Issue #82 — a payload is a payload. Only a headed PRG spends two bytes on a load address;
// a raw .bin / extract counts every byte, and its coverage range sits at the load address it
// was rendered with. Fixture: one PRG + two raw .bin payloads, real files, synthetic bytes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { slotReport, payloadBodySize } = await import("../dist/slots/state.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "bodysize";
const dir = mkdtempSync(join(tmpdir(), "c64re-bodysize-"));
try {
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  const prg = Buffer.alloc(1002, 0xea); prg.writeUInt16LE(0x0801, 0); // headed: 2 + 1000
  const roomA = Buffer.alloc(480, 0x11);                              // raw: 480 body bytes at $C000
  const roomB = Buffer.alloc(9360, 0x22);                             // raw: 9360 body bytes at $E000
  writeFileSync(join(dir, "game.prg"), prg);
  writeFileSync(join(dir, "room_a.bin"), roomA);
  writeFileSync(join(dir, "room_b.bin"), roomB);
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  const row = (id, kind, file, size) => ({ id, kind, title: file, path: file, relativePath: file, scope: "input", fileSize: size, tags: [] });
  writeFileSync(join(dir, "knowledge", "artifacts.json"), JSON.stringify({ items: [
    row("a-game", "prg", "game.prg", prg.length),
    row("a-ra", "raw", "room_a.bin", roomA.length),
    row("a-rb", "raw", "room_b.bin", roomB.length),
  ] }, null, 2));

  const rid = (owner, a) => `${SLUG}:ram/${owner}:routine:${a.toString(16).padStart(4, "0")}`;
  const store = GraphStore.open(dir);
  store.replaceGenerated("test", null, [
    { id: rid("game", 0x0801), kind: "routine", name: "G0801", endAddress: 0x08ff, origin: "static", confidence: "certain" },
    // room_a runs at $C000: the whole file, to its last byte ($C1DF)
    { id: rid("room_a", 0xc000), kind: "routine", name: "RA", endAddress: 0xc1df, origin: "static", confidence: "certain" },
    // room_b runs at $E000: the first 256 bytes
    { id: rid("room_b", 0xe000), kind: "routine", name: "RB", endAddress: 0xe0ff, origin: "static", confidence: "certain" },
  ], []);
  for (const [o, a] of [["game", 0x0801], ["room_a", 0xc000], ["room_b", 0xe000]]) {
    store.upsertHuman({ id: rid(o, a), kind: "routine", name: `${o}_main`, origin: "user", confidence: "user_asserted" });
  }
  store.close();

  const r = await slotReport(dir);
  const expectTotal = 1000 + 480 + 9360;
  check("denominator = the sum of the real body sizes (PRG minus its 2 header bytes, raw in full)",
    r.coverage.total === expectTotal, `${r.coverage.total} / expected ${expectTotal}`);
  check("a raw file is covered up to its last byte, at the address it runs at (480 of 480)",
    r.coverage.covered === 255 + 480 + 256, `${r.coverage.covered} / expected ${255 + 480 + 256}`);
  check("nothing is left unmeasured", r.coverage.unmeasured.length === 0, r.coverage.unmeasured.join(", "));

  check("payloadBodySize: raw counts every byte", payloadBodySize({ kind: "raw", fileSize: 480 }) === 480);
  check("payloadBodySize: extract counts every byte", payloadBodySize({ kind: "extract", fileSize: 9360 }) === 9360);
  check("payloadBodySize: prg loses the load address", payloadBodySize({ kind: "prg", fileSize: 1002 }) === 1000);
  check("payloadBodySize: a recorded range wins", payloadBodySize({ kind: "raw", fileSize: 480, addressRange: { start: 0xc000, end: 0xc0ff } }) === 256);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nGREEN  e2e-payload-body-size" : `\nRED  e2e-payload-body-size: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
