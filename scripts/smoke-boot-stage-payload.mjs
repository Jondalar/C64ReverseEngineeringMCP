#!/usr/bin/env node
// A boot stage may be registered before the data-geometry slot: the boot chain is what that
// answer is read from. Only a stage whose loader is on record — the KERNAL (its first sector
// starts a directory file) or a boot-stage payload registered before it. Everything else still
// waits for the slot. Synthetic disk only, built here.
//
//   node scripts/smoke-boot-stage-payload.mjs     (needs `npm run build`)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "./lib/e2e-906-harness.mjs";

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${String(detail).slice(0, 220)})` : ""}`);
};

const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
const off = (t, s) => { let o = 0; for (let x = 1; x < t; x++) o += SPT(x); return (o + s) * 256; };
const disk = new Uint8Array(683 * 256);
disk[off(18, 0)] = 18; disk[off(18, 0) + 1] = 1;
const entry = (slot, t, s, name) => {
  const o = off(18, 1) + slot * 32;
  disk[o + 2] = 0x82; disk[o + 3] = t; disk[o + 4] = s;
  for (let i = 0; i < 16; i++) disk[o + 5 + i] = i < name.length ? name.charCodeAt(i) : 0xa0;
  disk[o + 0x1e] = 1;
};
entry(0, 17, 0, "BOOT");

const H = new Harness("bootstage-");
try {
  console.log("A boot stage is registered before data-geometry; nothing else is\n");
  const proj = await H.project("bootstage");
  mkdirSync(join(proj, "input", "disk"), { recursive: true });
  writeFileSync(join(proj, "input", "disk", "game.d64"), disk);
  mkdirSync(join(proj, "analysis", "carved"), { recursive: true });
  writeFileSync(join(proj, "analysis", "carved", "stub.prg"), Buffer.from([0x26, 0x03, 0x31, 0x03, 0x60]));
  writeFileSync(join(proj, "analysis", "carved", "drive.prg"), Buffer.from([0x00, 0x03, 0x60]));
  writeFileSync(join(proj, "analysis", "carved", "level.prg"), Buffer.from([0x00, 0x40, 0x60]));
  const m = await H.mcp(proj, {});
  await m.call("project_inventory_sync", {});
  // engage the slots: a project with records is a project being mapped
  await m.call("save_finding", { kind: "observation", title: "stub at $0326", summary: "boot stub", address_range: { start: 0x0326, end: 0x0330 } });

  const reg = (name, file, extra = {}) => m.call("register_payload", { name, source_prg_path: `analysis/carved/${file}`, ...extra });

  let r = await reg("level", "level.prg", { load_address: 0x4000, medium_spans: [{ kind: "sector", track: 20, sector: 0, length: 1 }] });
  check(/data-geometry/.test(r) && !/registered/i.test(r.split("\n")[0]), "a game payload still waits for data-geometry", r.split("\n")[0]);

  r = await reg("stub", "stub.prg", { load_address: 0x0326, medium_spans: [{ kind: "sector", track: 17, sector: 5, length: 1 }], boot_stage: { loaded_by: "kernal" } });
  check(/no directory entry on game\.d64 starts at 17\/5/.test(r), "loaded_by kernal is refused when no directory file starts at the span", r);

  r = await reg("stub", "stub.prg", { load_address: 0x0326, medium_spans: [{ kind: "sector", track: 17, sector: 0, length: 1 }], boot_stage: { loaded_by: "kernal" } });
  check(!/refused/.test(r), "a KERNAL-loaded stage (its span starts the directory file BOOT) is registered before data-geometry", r.split("\n")[0]);
  r = await m.call("list_payloads", {});
  check(/stub/.test(r), "the stub is a payload", r.split("\n").filter((l) => /stub/.test(l)).join(" | "));

  r = await reg("drive", "drive.prg", { load_address: 0x0300, medium_spans: [{ kind: "sector", track: 18, sector: 17, length: 1 }], boot_stage: { loaded_by: "nobody" } });
  check(/no payload has that id or name/.test(r), "a loader that is not on record is refused", r);

  r = await reg("drive", "drive.prg", { load_address: 0x0300, medium_spans: [{ kind: "sector", track: 18, sector: 17, length: 1 }], boot_stage: { loaded_by: "stub", at: "$0205 M-E job READ 18/17" } });
  check(!/refused/.test(r), "a stage loaded by a boot-stage payload is registered", r.split("\n")[0]);

  // a non-boot payload cannot vouch for a boot stage
  r = await m.call("slot_record", { slot: "data-geometry", answer: "Game payloads sit by a loader table on tracks 19-35, unpacked.", evidence: "analysis/carved/stub.prg loader table read at $0340" });
  r = await reg("level", "level.prg", { load_address: 0x4000, medium_spans: [{ kind: "sector", track: 20, sector: 0, length: 1 }] });
  check(!/refused/.test(r), "with data-geometry answered the game payload registers as before", r.split("\n").slice(0, 8).join(" | "));
  r = await reg("x", "level.prg", { load_address: 0x4000, medium_spans: [{ kind: "sector", track: 21, sector: 0, length: 1 }], boot_stage: { loaded_by: "level" } });
  check(/is not a boot stage itself/.test(r), "a payload that is not a boot stage cannot vouch for one", r);
} finally {
  H.cleanup();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-boot-stage-payload: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
