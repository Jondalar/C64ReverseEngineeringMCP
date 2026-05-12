#!/usr/bin/env node
// Spec 242 — Trace bookmark smoke test.
//
// Tests:
//   1. addBookmark returns stable id
//   2. listBookmarks returns all bookmarks sorted by cycle
//   3. listBookmarks filtered by cycle range
//   4. removeBookmark deletes the entry
//   5. rebindBookmark — bindMode "event-key": resolves new cycle
//   6. rebindBookmark — bindMode "cycle": keeps original cycle
//   7. rebindBookmark — bindMode "both": event-key match wins
//   8. rebindBookmark — bindMode "both": falls back to cycle when no match
//   9. rebindBookmark — bindMode "event-key" throws when no match
//  10. addBookmark with tags stores and retrieves tags

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

const { openStore, closeStore } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { DuckDbQueryBackend } =
  await import(`${repoRoot}/dist/runtime/headless/v2/duckdb-backend.js`);
const { addBookmark, listBookmarks, removeBookmark, rebindBookmark } =
  await import(`${repoRoot}/dist/runtime/headless/v2/bookmarks.js`);

const tmpDir = "/tmp/c64re-bookmarks-smoke";
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const meta = {
  runId: "run-a",
  source: "headless",
  capturedAt: new Date().toISOString(),
  writerVersion: "spec242",
  c64ClockHz: 985_248,
  driveClockHz: 1_000_000,
  c64ClockZero: 0n,
  driveClockZero: 0n,
  driveToC64Offset: 0n,
};

const store = await openStore({ path: `${tmpDir}/trace.duckdb`, meta });
const backend = new DuckDbQueryBackend(store.conn);

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}

console.log("=== Spec 242 — trace bookmarks ===\n");

// ---- Test 1: addBookmark returns stable id ----
let bmId1, bmId2, bmId3;

await test("1. addBookmark returns stable id", async () => {
  bmId1 = await addBookmark(backend, {
    runId: "run-a",
    cycle: 1000,
    label: "stage-1 handshake start",
    bindMode: "both",
  });
  if (typeof bmId1 !== "string" || bmId1.length < 8) {
    throw new Error(`bad id: ${bmId1}`);
  }
});

// ---- Test 2: listBookmarks returns all bookmarks sorted by cycle ----
await test("2. listBookmarks returns all sorted by cycle", async () => {
  bmId2 = await addBookmark(backend, {
    runId: "run-a",
    cycle: 500,
    label: "reset assert",
    bindMode: "cycle",
  });
  bmId3 = await addBookmark(backend, {
    runId: "run-a",
    cycle: 1500,
    label: "IRQ handler entry",
    bindMode: "both",
    family: "irq_assert",
    eventKey: { source: "cia1" },
  });
  const all = await listBookmarks(backend, "run-a");
  if (all.length !== 3) throw new Error(`expected 3, got ${all.length}`);
  if (all[0].cycle !== 500) throw new Error(`first should be cycle 500, got ${all[0].cycle}`);
  if (all[1].cycle !== 1000) throw new Error(`second should be cycle 1000, got ${all[1].cycle}`);
  if (all[2].cycle !== 1500) throw new Error(`third should be cycle 1500, got ${all[2].cycle}`);
});

// ---- Test 3: listBookmarks filtered by cycle range ----
await test("3. listBookmarks filtered by cycle range", async () => {
  const filtered = await listBookmarks(backend, "run-a", [900, 1200]);
  if (filtered.length !== 1) throw new Error(`expected 1, got ${filtered.length}`);
  if (filtered[0].cycle !== 1000) throw new Error(`expected cycle 1000, got ${filtered[0].cycle}`);
  if (filtered[0].label !== "stage-1 handshake start") {
    throw new Error(`wrong label: ${filtered[0].label}`);
  }
});

// ---- Test 4: removeBookmark deletes the entry ----
await test("4. removeBookmark deletes the entry", async () => {
  await removeBookmark(backend, bmId2);
  const remaining = await listBookmarks(backend, "run-a");
  if (remaining.length !== 2) throw new Error(`expected 2 after remove, got ${remaining.length}`);
  const ids = remaining.map((b) => b.id);
  if (ids.includes(bmId2)) throw new Error(`bmId2 still present after remove`);
});

// ---- Test 5: rebindBookmark — bindMode "event-key": resolves new cycle ----
let bmIdKey;
await test("5. rebindBookmark event-key resolves new cycle", async () => {
  bmIdKey = await addBookmark(backend, {
    runId: "run-a",
    cycle: 2000,
    label: "IRQ rebind test",
    bindMode: "event-key",
    family: "irq_assert",
    eventKey: { source: "cia1" },
  });
  // Simulate a resolver that finds the event at cycle 2500 in "run-b"
  const resolver = async (family, key, runId) => {
    if (runId === "run-b" && family === "irq_assert" && key.source === "cia1") {
      return 2500;
    }
    return null;
  };
  const result = await rebindBookmark(backend, bmIdKey, "run-b", resolver);
  if (result.resolved !== "event-key") throw new Error(`resolved = ${result.resolved}`);
  if (result.cycle !== 2500) throw new Error(`expected cycle 2500, got ${result.cycle}`);
  // Verify DB was updated
  const bms = await listBookmarks(backend, "run-b");
  if (bms.length !== 1) throw new Error(`expected 1 in run-b, got ${bms.length}`);
  if (bms[0].cycle !== 2500) throw new Error(`cycle in DB = ${bms[0].cycle}`);
});

// ---- Test 6: rebindBookmark — bindMode "cycle": keeps original cycle ----
let bmIdCycle;
await test("6. rebindBookmark cycle keeps original cycle", async () => {
  bmIdCycle = await addBookmark(backend, {
    runId: "run-a",
    cycle: 3000,
    label: "cycle-only bookmark",
    bindMode: "cycle",
    family: "cpu_step",
    eventKey: { pc: 0x0800 },
  });
  const resolver = async () => 9999; // should not be called
  const result = await rebindBookmark(backend, bmIdCycle, "run-c", resolver);
  if (result.resolved !== "cycle") throw new Error(`resolved = ${result.resolved}`);
  if (result.cycle !== 3000) throw new Error(`expected original cycle 3000, got ${result.cycle}`);
});

// ---- Test 7: rebindBookmark — bindMode "both": event-key match wins ----
let bmIdBoth;
await test("7. rebindBookmark both: event-key match wins", async () => {
  bmIdBoth = await addBookmark(backend, {
    runId: "run-a",
    cycle: 4000,
    label: "both mode bookmark",
    bindMode: "both",
    family: "cia_timer_underflow",
    eventKey: { chip: "cia1", timer: "ta" },
  });
  const resolver = async (family, key, runId) => {
    if (runId === "run-d" && family === "cia_timer_underflow" && key.chip === "cia1") {
      return 4200;
    }
    return null;
  };
  const result = await rebindBookmark(backend, bmIdBoth, "run-d", resolver);
  if (result.resolved !== "event-key") throw new Error(`resolved = ${result.resolved}`);
  if (result.cycle !== 4200) throw new Error(`expected 4200, got ${result.cycle}`);
});

// ---- Test 8: rebindBookmark — bindMode "both": falls back to cycle when no match ----
let bmIdBoth2;
await test("8. rebindBookmark both: fallback to cycle when no match", async () => {
  bmIdBoth2 = await addBookmark(backend, {
    runId: "run-a",
    cycle: 5000,
    label: "both mode fallback",
    bindMode: "both",
    family: "irq_assert",
    eventKey: { source: "cia2" },
  });
  const resolver = async () => null; // no match
  const result = await rebindBookmark(backend, bmIdBoth2, "run-e", resolver);
  if (result.resolved !== "cycle") throw new Error(`resolved = ${result.resolved}`);
  if (result.cycle !== 5000) throw new Error(`expected original 5000, got ${result.cycle}`);
});

// ---- Test 9: rebindBookmark — bindMode "event-key" throws when no match ----
let bmIdKeyThrow;
await test("9. rebindBookmark event-key throws on no match", async () => {
  bmIdKeyThrow = await addBookmark(backend, {
    runId: "run-a",
    cycle: 6000,
    label: "must-throw rebind",
    bindMode: "event-key",
    family: "cpu_jam",
    eventKey: { pc: 0xdead },
  });
  const resolver = async () => null;
  let threw = false;
  try {
    await rebindBookmark(backend, bmIdKeyThrow, "run-f", resolver);
  } catch (e) {
    threw = true;
    if (!String(e?.message).includes("no matching event")) {
      throw new Error(`unexpected error: ${e?.message}`);
    }
  }
  if (!threw) throw new Error("expected throw but got none");
});

// ---- Test 10: addBookmark with tags stores and retrieves tags ----
await test("10. addBookmark with tags stores and retrieves tags", async () => {
  const id = await addBookmark(backend, {
    runId: "run-a",
    cycle: 7000,
    label: "tagged bookmark",
    note: "some note",
    authorTag: "agent",
    tags: ["iec", "handshake", "stage-1"],
    bindMode: "both",
  });
  const all = await listBookmarks(backend, "run-a");
  const bm = all.find((b) => b.id === id);
  if (!bm) throw new Error("bookmark not found");
  if (bm.note !== "some note") throw new Error(`note = ${bm.note}`);
  if (bm.authorTag !== "agent") throw new Error(`authorTag = ${bm.authorTag}`);
  if (!Array.isArray(bm.tags)) throw new Error(`tags not array: ${JSON.stringify(bm.tags)}`);
  if (!bm.tags.includes("iec")) throw new Error(`tags missing "iec": ${JSON.stringify(bm.tags)}`);
  if (!bm.tags.includes("handshake")) throw new Error(`tags missing "handshake"`);
  if (bm.tags.length !== 3) throw new Error(`expected 3 tags, got ${bm.tags.length}`);
});

await closeStore(store);

console.log("\n---");
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(`FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`\nSpec 242 bookmarks: ${pass}/10 PASS`);
process.exit(0);
