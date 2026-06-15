#!/usr/bin/env node
// Spec 766.3 — recorder medium gen-gate.
//
//   A) DISK gen (facade, deterministic): diskWriteGeneration() is stable while
//      the image content is untouched, bumps once per content change (content
//      hash over the live GCR track buffers), holds when nothing changed, and
//      — crucially — does NOT lose/spuriously move when the core clears the
//      GCR_dirty_track flag on an internal writeback (the under-count trap).
//      persistDirtyTracks() does NOT bump (it only materializes same content).
//   B) MEDIUM-SOURCE helper: collectMediumDescriptors() surfaces the attached
//      disk + cartridge as gen-gated descriptors; the generation reflects the
//      underlying medium; getBytes() is lazy and returns the current bytes; a
//      simulated write moves the disk gen so a producer would re-ship.
//   C) gen-gate semantics: with NO change the gen is identical across samples
//      (producer ships nothing); after a change the gen differs (producer ships
//      once).

import { Vice1541Facade } from "../dist/runtime/headless/drive1541/vice1541-facade.js";
import { collectMediumDescriptors } from "../dist/runtime/headless/recorder/medium-source.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

const driveOf = (f) => f.diskunit.drives[0];

// Flip a byte in the first available live GCR track buffer to simulate a real
// write (rotation.write_next_bit mutates exactly these buffers).
function mutateTrack(d, delta) {
  const tracks = d.gcr?.tracks ?? [];
  for (const trk of tracks) {
    if (trk?.data && trk.data.length > 0) { trk.data[0] = (trk.data[0] + delta) & 0xff; return true; }
  }
  return false;
}

console.log("Spec 766.3 — recorder medium gen-gate");

// ---- A: disk generation via content hash (survives the writeback flag clear) -
{
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: new Uint8Array(683 * 256), readOnly: false });
  const d = driveOf(f);

  const g0 = f.diskWriteGeneration();
  const g0b = f.diskWriteGeneration();
  gate("A pristine disk: gen stable across reads", g0 === g0b, `gen=${g0}`);

  // a real write: content changes + the core sets the dirty flag
  mutateTrack(d, 1); d.GCR_dirty_track = 1;
  const g1 = f.diskWriteGeneration();
  gate("A first write: content change bumps gen once", g1 === g0 + 1, `${g0}→${g1}`);

  const g1b = f.diskWriteGeneration();
  gate("A no further change: gen held", g1b === g1, `gen=${g1b}`);

  // the UNDER-COUNT TRAP: the core clears the flag on an internal writeback, but
  // the content is unchanged → gen must NOT move (and must not be lost).
  d.GCR_dirty_track = 0;
  const g1c = f.diskWriteGeneration();
  gate("A internal writeback clears flag, content same: gen steady", g1c === g1, `gen=${g1c}`);

  // a NEW write AFTER the flag was cleared still bumps (the trap: flag-edge would miss this)
  mutateTrack(d, 1); d.GCR_dirty_track = 0; // note: flag stays 0, only content changed
  const g2 = f.diskWriteGeneration();
  gate("A write after writeback (flag still 0): content hash still catches it", g2 === g1 + 1, `${g1}→${g2}`);

  // explicit writeback materializes same content → NO bump
  const g3 = (f.persistDirtyTracks(), f.diskWriteGeneration());
  gate("A persistDirtyTracks does NOT bump (same content)", g3 === g2, `${g2}→${g3}`);
}

// ---- B + C: medium-source helper over a structural kernel -------------------
{
  const f = new Vice1541Facade();
  f.attachDisk({ kind: "d64", bytes: new Uint8Array(683 * 256), readOnly: false });
  const d = driveOf(f);

  // a structural cartridge mapper (real flash path proven by BUG-040; here we
  // only assert the gen-gate plumbing surfaces it)
  let cartGen = 7;
  const cartImg = new Uint8Array([0x43, 0x36, 0x34, 0x20]); // "C64 "
  const cart = {
    writableGeneration: () => cartGen,
    getCrtImage: () => cartImg,
  };
  const kernel = { drive1541: f, c64Bus: { getCartridge: () => cart } };

  const m0 = collectMediumDescriptors(kernel);
  const disk0 = m0.find((x) => x.kind === "disk");
  const cart0 = m0.find((x) => x.kind === "cart");
  gate("B both media surface as descriptors", !!disk0 && !!cart0, `kinds=[${m0.map((x) => x.kind).join(",")}]`);
  gate("B cart gen reflects mapper", cart0?.generation === 7, `cart.gen=${cart0?.generation}`);

  // getBytes lazy + correct
  const cb = cart0?.getBytes();
  gate("B cart getBytes returns the crt image", cb instanceof Uint8Array && cb.length === 4 && cb[0] === 0x43, `len=${cb?.length}`);
  const db = disk0?.getBytes();
  gate("B disk getBytes returns image bytes", db instanceof Uint8Array && db.length === 683 * 256, `len=${db?.length}`);

  // C — gen-gate: no change → identical gen (ship nothing)
  const m1 = collectMediumDescriptors(kernel);
  const disk1 = m1.find((x) => x.kind === "disk");
  const cart1 = m1.find((x) => x.kind === "cart");
  // note: disk0.getBytes above called persistDirtyTracks → one commit bump; from
  // here on, with no writes, the disk gen must hold steady.
  const m2 = collectMediumDescriptors(kernel);
  const disk2 = m2.find((x) => x.kind === "disk");
  gate("C no change: disk gen steady across samples", disk1?.generation === disk2?.generation, `${disk1?.generation}==${disk2?.generation}`);
  gate("C no change: cart gen steady", cart1?.generation === 7, `cart.gen=${cart1?.generation}`);

  // a disk write moves the gen → producer would re-ship
  mutateTrack(d, 1); d.GCR_dirty_track = 1;
  const m3 = collectMediumDescriptors(kernel);
  const disk3 = m3.find((x) => x.kind === "disk");
  gate("C disk write: gen advances (re-ship)", disk3.generation > disk2.generation, `${disk2?.generation}→${disk3?.generation}`);

  // a cart flash write moves the cart gen
  cartGen = 8;
  const m4 = collectMediumDescriptors(kernel);
  const cart4 = m4.find((x) => x.kind === "cart");
  gate("C cart write: gen advances (re-ship)", cart4.generation === 8, `7→${cart4?.generation}`);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 766.3 medium-gen: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 766.3 medium-gen: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
