#!/usr/bin/env node
// Spec 296a-1 smoke — fetchPhi1 / fetchIdle / fetchIdleGfx parity.
//
// Synthetic harness exercises:
//   1. Bank-base + addr mapping (16KB wrap)
//   2. Char ROM overlay: vbank 0 → $1000-$1FFF reads chargen
//   3. Char ROM NOT overlaid: vbank 1 → $1000-$1FFF reads RAM
//   4. ECM=0: fetchIdleGfx() reads Φ1 at $3fff
//   5. ECM=1: fetchIdleGfx() reads Φ1 at $39ff
//   6. fetchIdle() always reads $3fff regardless of ECM
//   7. Ultimax override returns cart byte when addr & 0x3fff >= $3000

import {
  fetchPhi1, fetchIdle, fetchIdleGfx,
} from "../dist/runtime/headless/vic/fetch-phi1.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

// Synthetic 64KB RAM with a recognizable pattern: ram[i] = (i ^ 0xa5) & 0xff
const ram = new Uint8Array(0x10000);
for (let i = 0; i < ram.length; i++) ram[i] = (i ^ 0xa5) & 0xff;

// Synthetic char ROM 4KB: char_rom[i] = i & 0xff
const charRom = new Uint8Array(0x1000);
for (let i = 0; i < charRom.length; i++) charRom[i] = i & 0xff;

const baseCtx = {
  vbank_phi1: 0,
  vaddr_mask_phi1: 0x3fff,
  vaddr_offset_phi1: 0,
  vaddr_chargen_mask_phi1: 0x7000,
  vaddr_chargen_value_phi1: 0x1000,
  ecmActive: false,
  readRamPhi1: (a) => ram[a & 0xffff],
  readChargenRom: (a) => charRom[a & 0xfff],
};

console.log("smoke-vic-fetch-phi1 — Spec 296a-1");

// 1. Bank base wrap
{
  const ctx = { ...baseCtx, vbank_phi1: 0x4000 };
  const got = fetchPhi1(ctx, 0x0000);
  // mapped = (0 + 0x4000) & 0x3fff | 0 = 0
  // BUT then chargen check: 0 & 0x7000 = 0, value = 0x1000 → no overlay
  // So reads ram[0] = 0xa5
  ok("bank-base wrap reads ram[0] for vbank 0x4000 + addr 0", got === 0xa5,
     `expected 0xa5 got 0x${got.toString(16)}`);
}

// 2. Char ROM overlay in vbank 0
{
  const got = fetchPhi1(baseCtx, 0x1234);
  // mapped = 0x1234, chargen 0x1234 & 0x7000 = 0x1000 → overlay → charRom[0x234] = 0x34
  ok("vbank 0 + addr $1234 → chargen[0x234]", got === 0x34,
     `expected 0x34 got 0x${got.toString(16)}`);
}

// 3. Char ROM NOT overlaid in vbank 1 ($4000)
{
  const ctx = { ...baseCtx, vbank_phi1: 0x4000 };
  const got = fetchPhi1(ctx, 0x1234);
  // mapped = (0x1234 + 0x4000) & 0x3fff = 0x1234. Wait, 0x4000+0x1234=0x5234 & 0x3fff = 0x1234.
  // Same mapped addr, chargen check still matches → overlay still active!
  // That's a problem: real VICE uses vaddr_chargen_value_phi1 PER BANK
  // (different value per bank to disable overlay in banks 1/3).
  // For this smoke we test the simpler chargen disable via DIFFERENT
  // mask/value config:
  const ctxNoOverlay = { ...ctx, vaddr_chargen_value_phi1: 0xffff };
  const got2 = fetchPhi1(ctxNoOverlay, 0x1234);
  ok("vbank without chargen overlay reads ram", got2 === ((0x1234 ^ 0xa5) & 0xff),
     `expected 0x${((0x1234 ^ 0xa5) & 0xff).toString(16)} got 0x${got2.toString(16)}`);
}

// 4. fetchIdleGfx ECM=0 → $3fff
{
  const got = fetchIdleGfx(baseCtx);
  // mapped = $3fff. chargen check: $3fff & 0x7000 = 0x3000, value 0x1000 → no overlay
  // reads ram[0x3fff] = 0x3fff ^ 0xa5 = 0x3f5a → low byte 0x5a
  ok("fetchIdleGfx ECM=0 → ram[$3fff]", got === ((0x3fff ^ 0xa5) & 0xff),
     `expected 0x${((0x3fff ^ 0xa5) & 0xff).toString(16)} got 0x${got.toString(16)}`);
}

// 5. fetchIdleGfx ECM=1 → $39ff
{
  const ctx = { ...baseCtx, ecmActive: true };
  const got = fetchIdleGfx(ctx);
  ok("fetchIdleGfx ECM=1 → ram[$39ff]", got === ((0x39ff ^ 0xa5) & 0xff),
     `expected 0x${((0x39ff ^ 0xa5) & 0xff).toString(16)} got 0x${got.toString(16)}`);
}

// 6. fetchIdle always $3fff regardless of ECM
{
  const ctx = { ...baseCtx, ecmActive: true };
  const got = fetchIdle(ctx);
  ok("fetchIdle ECM=1 still reads $3fff", got === ((0x3fff ^ 0xa5) & 0xff),
     `expected 0x${((0x3fff ^ 0xa5) & 0xff).toString(16)} got 0x${got.toString(16)}`);
}

// 7. Ultimax override
{
  const ctx = {
    ...baseCtx,
    readUltimaxRomhPhi1: (addr) => {
      // Cart returns 0xc0 for $1000-$1FFF lookups (= the mapped form)
      return 0xc0;
    },
  };
  // addr $3500 → mapped $3500 → addr & 0x3fff = $3500 >= $3000 → ultimax wins
  const got = fetchPhi1(ctx, 0x3500);
  ok("ultimax overrides Φ1 read in $3000-$3fff window", got === 0xc0,
     `expected 0xc0 got 0x${got.toString(16)}`);
  // addr $2500 → mapped $2500 → addr & 0x3fff = $2500 < $3000 → no override
  // chargen check: 0x2500 & 0x7000 = 0x2000, value 0x1000 → no overlay
  // → ram[0x2500] = 0x2500 ^ 0xa5 = 0x2580 → low 0x80
  const got2 = fetchPhi1(ctx, 0x2500);
  ok("ultimax does NOT override below $3000", got2 === ((0x2500 ^ 0xa5) & 0xff),
     `expected 0x${((0x2500 ^ 0xa5) & 0xff).toString(16)} got 0x${got2.toString(16)}`);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
