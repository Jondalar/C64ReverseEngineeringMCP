#!/usr/bin/env node
// Spec 245 — Loader / protection profiling smoke test.
//
// Cases (≥6 required):
//   1. synthetic loader trace → ioTouches count correct
//   2. IEC CLK edges counted, bitTimingHistogram populated
//   3. iecActivity.bytesTransferred estimated from CLK edges
//   4. key_compare pattern detected (CMP + BNE with RAM read)
//   5. self_modify pattern detected (STA into future instruction operand)
//   6. c64Cycles + driveCycles split by PC range
//   7. confidence scoring — key_compare with no RAM read gets lower confidence
//   8. minConfidence filter removes low-confidence candidates

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

let profileLoader;
try {
  ({ profileLoader } = await import(
    `${repoRoot}/dist/runtime/headless/v2/loader-profile.js`
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

// ---- Test harness -----------------------------------------------------------

const results = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => {
        results.push({ name, pass: true });
        console.log(`  PASS  ${name}`);
      }).catch((e) => {
        results.push({ name, pass: false, err: e.message });
        console.log(`  FAIL  ${name}: ${e.message}`);
      });
      return r;
    }
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, err: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

// ---- Synthetic backend builder -----------------------------------------------
//
// Builds an in-memory QueryEventsBackend from a list of "rows" per table.
// queryEvents sends SQL with '?' placeholders + separate params array.
// We inline the params then parse the resulting SQL to filter rows.

function makeSyntheticBackend(rows) {
  return {
    async exec(sql, params) {
      // Inline '?' placeholders with params (same logic as DuckDbQueryBackend).
      let i = 0;
      const filled = sql.replace(/\?/g, () => {
        const p = params[i++];
        if (typeof p === "string") return `'${p.replace(/'/g, "''")}'`;
        if (typeof p === "number") return String(p);
        return String(p);
      });

      // Determine which table.
      const tableMatch = filled.match(/FROM\s+(\w+)/i);
      const table = tableMatch ? tableMatch[1] : null;
      if (!table || !rows[table]) return [];

      // Extract run_id filter
      const runIdMatch = filled.match(/run_id = '([^']+)'/);
      const runId = runIdMatch ? runIdMatch[1] : null;
      if (!runId) return [];

      let filtered = rows[table].filter((r) => r.run_id === runId);

      // Apply clock range
      const clockMatch = filled.match(/clock BETWEEN (\d+) AND (\d+)/);
      if (clockMatch) {
        const lo = Number(clockMatch[1]);
        const hi = Number(clockMatch[2]);
        filtered = filtered.filter((r) => r.clock >= lo && r.clock <= hi);
      }

      // Apply kind filter
      const kindMatch = filled.match(/kind = '([^']+)'/);
      if (kindMatch) {
        const kind = kindMatch[1];
        filtered = filtered.filter((r) => r.kind === kind);
      }

      // Apply limit
      const limitMatch = filled.match(/LIMIT (\d+)/);
      if (limitMatch) {
        filtered = filtered.slice(0, Number(limitMatch[1]));
      }

      return filtered;
    },
  };
}

// ---- Case 1: ioTouches count correct ----------------------------------------

await test("1. ioTouches: IO-range reads/writes counted correctly", async () => {
  const RUN = "run-001";
  const backend = makeSyntheticBackend({
    instructions: [
      // 3 CPU steps in C64 range
      { run_id: RUN, clock: 100, pc: 0x0800, opcode: 0xAD, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 103, pc: 0x0803, opcode: 0x8D, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 106, pc: 0x0806, opcode: 0xAD, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [
      // 2 reads to $DC04 (CIA1 timer)
      { run_id: RUN, clock: 101, kind: "read",  pc: 0x0800, addr: 0xDC04, value: 0x10 },
      { run_id: RUN, clock: 104, kind: "read",  pc: 0x0800, addr: 0xDC04, value: 0x0F },
      // 1 write to $D011 (VIC register)
      { run_id: RUN, clock: 107, kind: "write", pc: 0x0803, addr: 0xD011, value: 0x1B },
    ],
    chip_events: [],
  });

  const profile = await profileLoader(backend, RUN, [0, 500]);
  assert(profile.ioTouches.length >= 2, `expected ≥2 ioTouches, got ${profile.ioTouches.length}`);
  const dc04 = profile.ioTouches.find((t) => t.addr === 0xDC04);
  assert(dc04, "expected DC04 in ioTouches");
  assert(dc04.reads === 2, `expected 2 reads for DC04, got ${dc04.reads}`);
  assert(dc04.distinctValues.length === 2, `expected 2 distinct values for DC04`);
  const d011 = profile.ioTouches.find((t) => t.addr === 0xD011);
  assert(d011, "expected D011 in ioTouches");
  assert(d011.writes === 1, `expected 1 write for D011, got ${d011.writes}`);
});

// ---- Case 2: IEC CLK edges counted, bitTimingHistogram populated -------------

await test("2. iecActivity: CLK edges counted + bitTimingHistogram populated", async () => {
  const RUN = "run-002";
  const backend = makeSyntheticBackend({
    instructions: [],
    bus_events: [
      // 4 CLK edges at cycles 1000, 1056, 1112, 1168 — gap = 56 each
      { run_id: RUN, clock: 1000, kind: "line_change", line_atn: 0, line_clk: 1, line_data: 0 },
      { run_id: RUN, clock: 1056, kind: "line_change", line_atn: 0, line_clk: 0, line_data: 0 },
      { run_id: RUN, clock: 1112, kind: "line_change", line_atn: 0, line_clk: 1, line_data: 0 },
      { run_id: RUN, clock: 1168, kind: "line_change", line_atn: 0, line_clk: 0, line_data: 0 },
    ],
    chip_events: [],
  });

  const profile = await profileLoader(backend, RUN, [0, 2000]);
  assert(profile.iecActivity.clkEdges === 4, `expected 4 CLK edges, got ${profile.iecActivity.clkEdges}`);
  const hist = profile.iecActivity.bitTimingHistogram;
  const buckets = Object.keys(hist).map(Number);
  assert(buckets.length >= 1, `expected ≥1 histogram bucket, got ${buckets.length}`);
  // Gap = 56, bucket = round(56/10)*10 = 60
  assert(hist[60] >= 3, `expected ≥3 counts in bucket 60, got ${hist[60]}`);
});

// ---- Case 3: bytesTransferred estimated from CLK edges ----------------------

await test("3. iecActivity.bytesTransferred estimated from CLK edge count", async () => {
  const RUN = "run-003";
  // 16 CLK edges → 1 byte (16 edges = 8 bits × 2 edges per bit)
  const clkEvents = [];
  for (let i = 0; i < 16; i++) {
    clkEvents.push({ run_id: RUN, clock: 1000 + i * 56, kind: "line_change", line_clk: i % 2, line_atn: 0, line_data: 0 });
  }
  const backend = makeSyntheticBackend({
    instructions: [],
    bus_events: clkEvents,
    chip_events: [],
  });

  const profile = await profileLoader(backend, RUN, [0, 5000]);
  assert(profile.iecActivity.clkEdges === 16, `expected 16 CLK edges, got ${profile.iecActivity.clkEdges}`);
  assert(profile.iecActivity.bytesTransferred === 1, `expected 1 byte, got ${profile.iecActivity.bytesTransferred}`);
});

// ---- Case 4: key_compare pattern detected ------------------------------------

await test("4. key_compare pattern detected (CMP + BNE with RAM read)", async () => {
  const RUN = "run-004";
  // Sequence: CMP #$37 (imm) at $C000, then BNE $C010 at $C002
  // mem_read at $C000 from addr $0300 (RAM) to simulate RAM-backed compare
  const backend = makeSyntheticBackend({
    instructions: [
      { run_id: RUN, clock: 100, pc: 0x0C00, opcode: 0xC9 /* CMP imm */, a: 0x37, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 102, pc: 0x0C02, opcode: 0xD0 /* BNE */, a: 0x37, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [
      // RAM read (non-IO) associated with the CMP
      { run_id: RUN, clock: 100, kind: "read", pc: 0x0C00, addr: 0x0300, value: 0x37 },
    ],
    chip_events: [],
  });

  const profile = await profileLoader(backend, RUN, [0, 500]);
  const kc = profile.protectionCandidates.filter((c) => c.pattern === "key_compare");
  assert(kc.length >= 1, `expected ≥1 key_compare candidate, got ${kc.length}`);
  assert(kc[0].confidence >= 0.75, `expected confidence ≥0.75, got ${kc[0].confidence}`);
});

// ---- Case 5: self_modify pattern detected ------------------------------------

await test("5. self_modify pattern detected (STA into future instruction operand)", async () => {
  const RUN = "run-005";
  // Instruction at $C000: STA $C003 (patches operand of instruction at $C002)
  // Instruction at $C002: LDA #$00 (2 bytes; $C003 is its operand)
  const backend = makeSyntheticBackend({
    instructions: [
      { run_id: RUN, clock: 100, pc: 0xC000, opcode: 0x8D /* STA abs */, a: 0x42, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 104, pc: 0xC003, opcode: 0xA9 /* LDA imm */, a: 0x42, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [
      // Write from STA to address $C004 (operand of LDA at $C003, offset +1)
      { run_id: RUN, clock: 102, kind: "write", pc: 0xC000, addr: 0xC004, value: 0x42 },
    ],
    chip_events: [],
  });

  const profile = await profileLoader(backend, RUN, [0, 500]);
  const sm = profile.protectionCandidates.filter((c) => c.pattern === "self_modify");
  assert(sm.length >= 1, `expected ≥1 self_modify candidate, got ${sm.length}`);
  assert(sm[0].confidence >= 0.85, `expected confidence ≥0.85, got ${sm[0].confidence}`);
});

// ---- Case 6: c64Cycles + driveCycles split by PC range ----------------------

await test("6. c64Cycles + driveCycles split by PC range ($C000+ = drive)", async () => {
  const RUN = "run-006";
  const backend = makeSyntheticBackend({
    instructions: [
      // 3 C64 CPU steps (PC < $C000)
      { run_id: RUN, clock: 100, pc: 0x0800, opcode: 0xEA, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 102, pc: 0x0801, opcode: 0xEA, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 104, pc: 0x0802, opcode: 0x60, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      // 2 drive CPU steps (PC ≥ $C000)
      { run_id: RUN, clock: 200, pc: 0xC200, opcode: 0xEA, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 202, pc: 0xC201, opcode: 0x60, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [],
    chip_events: [],
  });

  const profile = await profileLoader(backend, RUN, [0, 500]);
  assert(profile.c64Cycles === 3, `expected c64Cycles=3, got ${profile.c64Cycles}`);
  assert(profile.driveCycles === 2, `expected driveCycles=2, got ${profile.driveCycles}`);
  assert(profile.cyclesTotal === 500, `expected cyclesTotal=500, got ${profile.cyclesTotal}`);
});

// ---- Case 7: confidence scoring (no RAM read → lower confidence) ------------

await test("7. key_compare without RAM read gets lower confidence than with RAM read", async () => {
  const RUN = "run-007";
  // CMP imm + BNE, but the mem_read is at an IO address (not RAM-backed)
  const backend = makeSyntheticBackend({
    instructions: [
      { run_id: RUN, clock: 100, pc: 0x0C00, opcode: 0xC9 /* CMP imm */, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 102, pc: 0x0C02, opcode: 0xD0 /* BNE */, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [
      // IO read (not RAM) associated with CMP — should give lower confidence
      { run_id: RUN, clock: 100, kind: "read", pc: 0x0C00, addr: 0xDC00, value: 0x00 },
    ],
    chip_events: [],
  });

  const profileNoRam = await profileLoader(backend, RUN, [0, 500]);
  const kcNoRam = profileNoRam.protectionCandidates.filter((c) => c.pattern === "key_compare");
  assert(kcNoRam.length >= 1, "expected ≥1 key_compare candidate (no-ram case)");
  assert(kcNoRam[0].confidence < 0.75, `expected confidence < 0.75 (no RAM), got ${kcNoRam[0].confidence}`);

  // Compare with the RAM-backed case from case 4.
  const backend2 = makeSyntheticBackend({
    instructions: [
      { run_id: RUN, clock: 100, pc: 0x0C00, opcode: 0xC9, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 102, pc: 0x0C02, opcode: 0xD0, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [
      { run_id: RUN, clock: 100, kind: "read", pc: 0x0C00, addr: 0x0300, value: 0x37 },
    ],
    chip_events: [],
  });
  const profileRam = await profileLoader(backend2, RUN, [0, 500]);
  const kcRam = profileRam.protectionCandidates.filter((c) => c.pattern === "key_compare");
  assert(kcRam.length >= 1, "expected ≥1 key_compare candidate (ram case)");
  assert(kcRam[0].confidence > kcNoRam[0].confidence,
    `expected RAM confidence (${kcRam[0].confidence}) > no-RAM confidence (${kcNoRam[0].confidence})`);
});

// ---- Case 8: minConfidence filter removes low-confidence candidates ---------

await test("8. minConfidence=0.9 filters out low-confidence candidates", async () => {
  const RUN = "run-008";
  // CMP + BNE without RAM read → confidence 0.50
  const backend = makeSyntheticBackend({
    instructions: [
      { run_id: RUN, clock: 100, pc: 0x0C00, opcode: 0xC9, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 102, pc: 0x0C02, opcode: 0xD0, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      // CIA read + CMP → confidence 0.90
      { run_id: RUN, clock: 200, pc: 0x0C10, opcode: 0xAD /* LDA abs */, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
      { run_id: RUN, clock: 203, pc: 0x0C13, opcode: 0xC9 /* CMP imm */, a: 0, x: 0, y: 0, sp: 0xFF, p: 0 },
    ],
    bus_events: [
      // The LDA abs at $0C10 reads from CIA timer $DC04
      { run_id: RUN, clock: 200, kind: "read", pc: 0x0C10, addr: 0xDC04, value: 0x10 },
    ],
    chip_events: [],
  });

  const profileAll = await profileLoader(backend, RUN, [0, 500], { minConfidence: 0 });
  const profileHigh = await profileLoader(backend, RUN, [0, 500], { minConfidence: 0.9 });

  assert(profileAll.protectionCandidates.length > 0, "expected candidates with minConfidence=0");
  // High threshold should filter out key_compare (0.50) but keep timing_check (0.90)
  const lowInHigh = profileHigh.protectionCandidates.filter((c) => c.confidence < 0.9);
  assert(lowInHigh.length === 0, `expected 0 candidates below 0.9, got ${lowInHigh.length}: ${JSON.stringify(lowInHigh.map(c => ({pattern:c.pattern, conf:c.confidence})))}`);
});

// ---- Summary ----------------------------------------------------------------

// Wait a tick for all async tests to resolve
await new Promise((r) => setTimeout(r, 50));

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${passed}/${results.length} PASS${failed > 0 ? `, ${failed} FAIL` : ""}`);

if (failed > 0) {
  console.error("Some smoke cases failed.");
  process.exit(1);
}
console.log("smoke-loader-profile OK");
