#!/usr/bin/env node
// Spec 805 — the sandbox bridge batches: one process start for N runs.
//
// The bridge used to spawn `trx64cli` per depack, and the binary costs ~740 ms to
// start (~650 ms of it eager machine init, before argument parsing). A proof
// project ran 101 chunks through it — ~75 seconds of pure startup for
// milliseconds of work. This gate asserts the three things that must hold once
// the single-payload path became a batch of one:
//
//   1. N payloads give byte-identical results whether run as a batch or singly.
//   2. A batch of one still behaves exactly like a single call.
//   3. A batch of N costs about ONE process start, not N.
//   4. A payload that fails does not sink the batch.
//
// Requires a built `trx64cli` in the sibling TRX64 checkout; skips loudly without
// one, because this repo does not own that build.

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { genericSandboxDepack, genericSandboxDepackMany } = await import(
  join(ROOT, "dist/sandbox/sandbox-depack-generic.js")
);
const { resolveTrx64Cli } = await import(join(ROOT, "dist/sandbox/trx64cli.js"));

if (!existsSync(resolveTrx64Cli())) {
  console.log(`  SKIPPED — no trx64cli at ${resolveTrx64Cli()}. Build it in the sibling TRX64 checkout.`);
  console.log(`\nGREEN  805 sandbox batch: skipped (no runtime binary).`);
  process.exit(0);
}

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

// A minimal "depacker": copy 8 bytes from ($52),y to $4000+y, then RTS. Small
// enough to be obviously correct, real enough to run on the actual 6502.
const RESIDENT = Uint8Array.from([
  0xa0, 0x00,       // LDY #$00
  0xb1, 0x52,       // LDA ($52),y
  0x99, 0x00, 0x40, // STA $4000,y
  0xc8,             // INY
  0xc0, 0x08,       // CPY #$08
  0xd0, 0xf6,       // BNE loop
  0x60,             // RTS
]);
const payload = (fill) => ({
  residentLoader: RESIDENT,
  residentLoadAddress: 0x0300,
  entryPc: 0x0300,
  packed: Uint8Array.from(Array(8).fill(fill)),
  sourceLoadAddress: 0x2000,
  destAddress: 0x4000,
});
const hex = (u8) => Buffer.from(u8).toString("hex");

// ── 1 + 3: batch vs singles, results and cost ────────────────────────────────
const fills = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
const opts = fills.map(payload);

const tBatch0 = Date.now();
const batch = genericSandboxDepackMany(opts);
const tBatch = Date.now() - tBatch0;

const tSingle0 = Date.now();
const singles = opts.map((o) => genericSandboxDepack(o));
const tSingle = Date.now() - tSingle0;

ok("every payload in the batch succeeded", batch.every((r) => r.ok),
  batch.filter((r) => !r.ok).map((r) => r.error).join("; "));
ok("batch results are byte-identical to the singles",
  batch.every((r, i) => r.ok && hex(r.result.unpacked) === hex(singles[i].unpacked)));
ok("each payload kept its OWN bytes (no cross-contamination)",
  batch.every((r, i) => r.ok && hex(r.result.unpacked) === fills[i].toString(16).padStart(2, "0").repeat(8)));

// One process start is the floor; N singles pay it N times. Assert the batch is
// far closer to one than to N — a generous factor, because this measures wall
// clock on a shared machine, and the point is the ORDER, not a benchmark.
const ratio = tSingle / Math.max(tBatch, 1);
ok(`a batch of ${fills.length} costs about one process start, not ${fills.length}`,
  ratio > fills.length / 2,
  `${tSingle} ms singly vs ${tBatch} ms batched — ${ratio.toFixed(1)}x`);

// ── 2: a batch of one is a single call ───────────────────────────────────────
const [only] = genericSandboxDepackMany([payload(0xcd)]);
ok("a batch of one behaves like a single call",
  only.ok && hex(only.result.unpacked) === "cd".repeat(8));

// ── 4: one bad payload does not sink the batch ───────────────────────────────
const bad = payload(0x99);
bad.sourceLoadAddress = 0xfffe; // overflows 64K — a layout error, caught per item
const mixed = genericSandboxDepackMany([payload(0xa1), bad, payload(0xa2)]);
ok("a failing payload is reported in its own slot", mixed[1] && !mixed[1].ok,
  mixed[1] && !mixed[1].ok ? mixed[1].error.slice(0, 60) : "");
ok("its neighbours still succeed, with the right bytes",
  mixed[0]?.ok && mixed[2]?.ok &&
  hex(mixed[0].result.unpacked) === "a1".repeat(8) &&
  hex(mixed[2].result.unpacked) === "a2".repeat(8));

if (fails.length) {
  console.log(`\nRED  805 sandbox batch: ${pass} pass, ${fails.length} fail.`);
  process.exit(1);
}
console.log(`\nGREEN  805 sandbox batch: ${pass} pass, 0 fail.`);
