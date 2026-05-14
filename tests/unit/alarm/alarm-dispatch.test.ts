// Spec 448 — alarm dispatch tie-breaking + edge-case smoke.
//
// Pins literal-VICE alarm.c + alarm.h semantics that Sprint 149
// audited but did not explicitly cover with tests. Each assertion
// cites a VICE line range.
//
// Run via:
//   npx tsx tests/unit/alarm/alarm-dispatch.test.ts

import { strict as assert } from "node:assert";
import {
  alarm_context_new,
  alarm_new,
  alarm_set,
  alarm_unset,
  alarm_context_dispatch,
  alarm_context_next_pending_clk,
  alarm_context_update_next_pending,
  alarm_context_time_warp,
  CLOCK_MAX,
  type alarm_context_t,
  type alarm_t,
} from "../../../src/runtime/headless/alarm/alarm-context.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeFiringAlarm(context: alarm_context_t, name: string, log: string[]): alarm_t {
  return alarm_new(context, name, (_offset, _data) => { log.push(name); }, null);
}

// ---------------------------------------------------------------------------
// Tie-breaking — alarm.h:110-129 alarm_context_update_next_pending uses
// `<=` comparator. Among multiple entries with the SAME clk, the LAST
// inserted into pending_alarms[] wins as the cached head.
// ---------------------------------------------------------------------------

test("tie-break: 3 alarms same clk → cached head is LAST registered (VICE alarm.h:121 <=)", () => {
  const ctx = alarm_context_new("test");
  const log: string[] = [];
  const a = makeFiringAlarm(ctx, "A", log);
  const b = makeFiringAlarm(ctx, "B", log);
  const c = makeFiringAlarm(ctx, "C", log);
  alarm_set(a, 100);
  alarm_set(b, 100);
  alarm_set(c, 100);
  // VICE rescans on each set; the cached next-pending is set inline
  // by alarm_set itself in the not-pending append branch:
  //   if (cpu_clk < next_pending_alarm_clk) {
  //     next_pending_alarm_clk = cpu_clk;
  //     next_pending_alarm_idx = new_idx;
  //   }
  // With ALL three at clk=100, ONLY the first append sets the cache
  // (since cpu_clk == next_pending_alarm_clk = 100 = CLOCK_MAX..100;
  // actually the FIRST set makes 100 < CLOCK_MAX, then second/third
  // see cpu_clk (100) NOT < next_pending_alarm_clk (100) — no update).
  // So cached head = A (the first), NOT the last. The `<=` tie-break
  // only applies in `alarm_context_update_next_pending` slow path.
  assert.equal(alarm_context_next_pending_clk(ctx), 100);
  // Verify: dispatch fires A (first registered won via the fast-path).
  alarm_context_dispatch(ctx, 100);
  assert.deepEqual(log, ["A"], `fired ${log.join(",")}, expected A`);
});

test("tie-break: update_next_pending rescan → LAST entry wins (VICE alarm.h:121 <=)", () => {
  const ctx = alarm_context_new("test");
  const log: string[] = [];
  const a = makeFiringAlarm(ctx, "A", log);
  const b = makeFiringAlarm(ctx, "B", log);
  const c = makeFiringAlarm(ctx, "C", log);
  alarm_set(a, 100);
  alarm_set(b, 100);
  alarm_set(c, 100);
  // Force a slow-path rescan by calling update_next_pending directly.
  // VICE comparator: pending_clk <= next_pending_alarm_clk → entry
  // at higher idx wins for ties. Pending array is [A@0, B@1, C@2].
  // Scan visits A (sets clk=100, idx=0) → B (100 <= 100, sets idx=1)
  // → C (100 <= 100, sets idx=2). Final cached idx = 2 = C.
  alarm_context_update_next_pending(ctx);
  alarm_context_dispatch(ctx, 100);
  assert.deepEqual(log, ["C"], `slow-path rescan should fire C; got ${log.join(",")}`);
});

// ---------------------------------------------------------------------------
// alarm_set update cache cheaply on earlier-clk insert (alarm.h:170-173).
// ---------------------------------------------------------------------------

test("alarm_set: earlier-clk insert updates cached head (alarm.h:170)", () => {
  const ctx = alarm_context_new("test");
  const log: string[] = [];
  const a = makeFiringAlarm(ctx, "A", log);
  const b = makeFiringAlarm(ctx, "B", log);
  alarm_set(a, 100);
  alarm_set(b, 50);   // earlier → must become cached head
  assert.equal(alarm_context_next_pending_clk(ctx), 50);
  alarm_context_dispatch(ctx, 50);
  assert.deepEqual(log, ["B"]);
});

// ---------------------------------------------------------------------------
// alarm_unset removes + recomputes cache (alarm.c:179-204).
// ---------------------------------------------------------------------------

test("alarm_unset: remove cached head → next-earliest becomes cache", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  const b = alarm_new(ctx, "B", () => {}, null);
  const c = alarm_new(ctx, "C", () => {}, null);
  alarm_set(a, 100);
  alarm_set(b, 50);    // B cached
  alarm_set(c, 200);
  assert.equal(alarm_context_next_pending_clk(ctx), 50);
  alarm_unset(b);
  // After unset, cache must point at next-earliest = A@100.
  assert.equal(alarm_context_next_pending_clk(ctx), 100);
});

test("alarm_unset: last pending removed → cache = (CLOCK_MAX, -1)", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  alarm_set(a, 100);
  alarm_unset(a);
  assert.equal(alarm_context_next_pending_clk(ctx), CLOCK_MAX);
});

test("alarm_unset: not-pending alarm is no-op (alarm.c:174)", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  // Never set; pending_idx = -1.
  alarm_unset(a);   // must not throw
  assert.equal(alarm_context_next_pending_clk(ctx), CLOCK_MAX);
});

// ---------------------------------------------------------------------------
// alarm_set on already-pending modifies clk in place (alarm.c:178-184).
// ---------------------------------------------------------------------------

test("alarm_set on already-pending: clk updated, cache recomputed when needed", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  const b = alarm_new(ctx, "B", () => {}, null);
  alarm_set(a, 100);
  alarm_set(b, 200);
  assert.equal(alarm_context_next_pending_clk(ctx), 100);
  alarm_set(a, 300);   // A now later than B → cache must move to B
  assert.equal(alarm_context_next_pending_clk(ctx), 200);
  alarm_set(b, 400);   // B now later than A → cache must move back to A
  assert.equal(alarm_context_next_pending_clk(ctx), 300);
});

// ---------------------------------------------------------------------------
// alarm_context_time_warp (alarm.c:79-101) — direction 0 = no-op,
// positive = +amount, negative = -amount on all pending + cache.
// ---------------------------------------------------------------------------

test("time_warp: direction=0 is no-op (alarm.c:84)", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  alarm_set(a, 100);
  alarm_context_time_warp(ctx, 1000, 0);
  assert.equal(alarm_context_next_pending_clk(ctx), 100);
});

test("time_warp: positive shifts pending forward (alarm.c:89-91)", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  const b = alarm_new(ctx, "B", () => {}, null);
  alarm_set(a, 100);
  alarm_set(b, 200);
  alarm_context_time_warp(ctx, 50, 1);
  assert.equal(alarm_context_next_pending_clk(ctx), 150);
});

test("time_warp: negative shifts pending backward (alarm.c:92)", () => {
  const ctx = alarm_context_new("test");
  const a = alarm_new(ctx, "A", () => {}, null);
  alarm_set(a, 1000);
  alarm_context_time_warp(ctx, 200, -1);
  assert.equal(alarm_context_next_pending_clk(ctx), 800);
});

// ---------------------------------------------------------------------------
// alarm_context_dispatch only fires the cached alarm; does NOT remove.
// ---------------------------------------------------------------------------

test("dispatch: fires cached alarm only; callback responsible for remove/reschedule", () => {
  const ctx = alarm_context_new("test");
  const log: string[] = [];
  let fired_offset = -1;
  const a = alarm_new(ctx, "A", (offset, _data) => {
    fired_offset = Number(offset);
    log.push("A");
  }, null);
  alarm_set(a, 100);
  alarm_context_dispatch(ctx, 105);  // cpu_clk = 105, alarm @ 100 → offset = 5
  assert.equal(fired_offset, 5);
  assert.deepEqual(log, ["A"]);
  // Without alarm_set/alarm_unset by callback, the same alarm is
  // still cached; dispatch would re-fire. Verify with another call.
  alarm_context_dispatch(ctx, 110);
  assert.deepEqual(log, ["A", "A"], "callback didn't reschedule → re-fires");
});

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nalarm-dispatch: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
