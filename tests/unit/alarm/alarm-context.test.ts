// Spec 149 — Alarm context unit tests.
//
// Each test cites the VICE 3.7.1 alarm.c / alarm.h line range whose
// behavior it pins. Standalone runner (no jest in this repo). Run via:
//   npx tsx tests/unit/alarm/alarm-context.test.ts

import { strict as assert } from "node:assert";
import {
  ALARM_CONTEXT_MAX_PENDING_ALARMS,
  CLOCK_MAX,
  alarmContextDispatch,
  alarmContextNew,
  alarmContextNextPendingClk,
  alarmContextTimeWarp,
  alarmContextUpdateNextPending,
  alarmDestroy,
  alarmNew,
  alarmSet,
  alarmUnset,
  type Alarm,
  type AlarmContext,
} from "../../../src/runtime/headless/alarm/alarm-context.js";

interface Case {
  name: string;
  run: () => void;
}
const cases: Case[] = [];
function test(name: string, run: () => void): void {
  cases.push({ name, run });
}

// Helper: small recorder.
function recorder(): {
  fn: (offset: number, data: unknown) => void;
  events: Array<{ offset: number; data: unknown }>;
} {
  const events: Array<{ offset: number; data: unknown }> = [];
  return {
    fn: (offset, data) => {
      events.push({ offset, data });
    },
    events,
  };
}

// --------------------------------------------------------------------------
// Schedule single alarm, dispatch fires it. (alarm.h lines 131-144)
// --------------------------------------------------------------------------
test("schedule single alarm: dispatch fires callback with correct offset", () => {
  const ctx = alarmContextNew("test");
  const rec = recorder();
  const a = alarmNew(ctx, "a", rec.fn, "data-a");

  alarmSet(a, 1000);
  assert.equal(alarmContextNextPendingClk(ctx), 1000);

  // Dispatch at clk 1003 → offset = 1003 - 1000 = 3.
  alarmContextDispatch(ctx, 1003);
  assert.equal(rec.events.length, 1);
  assert.equal(rec.events[0].offset, 3);
  assert.equal(rec.events[0].data, "data-a");
});

// --------------------------------------------------------------------------
// Schedule + unset cancels. (alarm.c lines 167-207)
// --------------------------------------------------------------------------
test("schedule + unset removes alarm; next-pending = CLOCK_MAX", () => {
  const ctx = alarmContextNew("test");
  const rec = recorder();
  const a = alarmNew(ctx, "a", rec.fn, null);

  alarmSet(a, 500);
  assert.equal(alarmContextNextPendingClk(ctx), 500);

  alarmUnset(a);
  assert.equal(alarmContextNextPendingClk(ctx), CLOCK_MAX);
  assert.equal(ctx.num_pending_alarms, 0);
  assert.equal(a.pending_idx, -1);
});

// --------------------------------------------------------------------------
// Two alarms different clk: dispatch order = clk order. (alarm.h 110-129)
// --------------------------------------------------------------------------
test("two alarms different clk: earliest fires first", () => {
  const ctx = alarmContextNew("test");
  const fired: string[] = [];
  const aLater = alarmNew(ctx, "later", (_o, d) => fired.push(d as string), "later");
  const aEarly = alarmNew(ctx, "early", (_o, d) => fired.push(d as string), "early");

  // Set later first, earlier second — ensures the "earlier" code path
  // in alarmSet (cpu_clk < next_pending_alarm_clk) is exercised.
  alarmSet(aLater, 2000);
  alarmSet(aEarly, 1000);

  assert.equal(alarmContextNextPendingClk(ctx), 1000);
  alarmContextDispatch(ctx, 1000);
  // After dispatch, callback didn't reschedule/unset; we manually
  // unset to advance to the next.
  alarmUnset(aEarly);

  assert.equal(alarmContextNextPendingClk(ctx), 2000);
  alarmContextDispatch(ctx, 2000);
  alarmUnset(aLater);

  assert.deepEqual(fired, ["early", "later"]);
});

// --------------------------------------------------------------------------
// Same-clk deterministic order. VICE alarm_context_update_next_pending
// uses `<=` so the LAST entry in pending_alarms array order wins as
// cached head when ties occur. With set order A, B at same clk:
//   pending_alarms[0] = A, pending_alarms[1] = B → cached head = B.
// alarm_set fast-path also uses `<` (strict): when B is set with the
// SAME clk as A, the fast-path `cpu_clk < next_pending_alarm_clk`
// fails, so the cache stays pointing at A — only the slow-path rescan
// would prefer B. Therefore: with two same-clk alarms set in order,
// FIFO dispatch (A first) is what alarmSet actually produces.
// --------------------------------------------------------------------------
test("two alarms same clk: FIFO dispatch (set-order) matches VICE alarm_set fast path", () => {
  const ctx = alarmContextNew("test");
  const fired: string[] = [];
  const aFirst = alarmNew(ctx, "first", (_o, d) => fired.push(d as string), "first");
  const aSecond = alarmNew(ctx, "second", (_o, d) => fired.push(d as string), "second");

  alarmSet(aFirst, 1000);
  alarmSet(aSecond, 1000);

  // Cached head should still point at aFirst (idx 0) — fast-path keeps
  // first entry as head when ties.
  assert.equal(ctx.next_pending_alarm_idx, 0);
  alarmContextDispatch(ctx, 1000);
  alarmUnset(aFirst);

  alarmContextDispatch(ctx, 1000);
  alarmUnset(aSecond);

  assert.deepEqual(fired, ["first", "second"]);
});

// --------------------------------------------------------------------------
// Reschedule existing alarm to earlier clk. (alarm.h 176-184 modify-path)
// --------------------------------------------------------------------------
test("reschedule existing alarm to earlier clk: fires at new clk", () => {
  const ctx = alarmContextNew("test");
  const rec = recorder();
  const a = alarmNew(ctx, "a", rec.fn, null);

  alarmSet(a, 5000);
  assert.equal(alarmContextNextPendingClk(ctx), 5000);

  alarmSet(a, 2000); // reschedule earlier
  assert.equal(alarmContextNextPendingClk(ctx), 2000);

  alarmContextDispatch(ctx, 2000);
  assert.equal(rec.events.length, 1);
  assert.equal(rec.events[0].offset, 0);
});

// --------------------------------------------------------------------------
// Reschedule existing alarm to later clk. Modify path with idx ===
// next_pending_alarm_idx triggers slow-path rescan. (alarm.h 180-183)
// --------------------------------------------------------------------------
test("reschedule existing alarm to later clk: fires at new clk", () => {
  const ctx = alarmContextNew("test");
  const rec = recorder();
  const a = alarmNew(ctx, "a", rec.fn, null);

  alarmSet(a, 1000);
  alarmSet(a, 4000); // reschedule later — same single alarm
  assert.equal(alarmContextNextPendingClk(ctx), 4000);

  alarmContextDispatch(ctx, 4000);
  assert.equal(rec.events.length, 1);
});

// --------------------------------------------------------------------------
// Reschedule the cached-head alarm to later when a non-head alarm
// exists at an earlier clk: rescan must promote the non-head.
// --------------------------------------------------------------------------
test("reschedule cached-head later: non-head alarm becomes new head", () => {
  const ctx = alarmContextNew("test");
  const aHead = alarmNew(ctx, "head", () => {}, null);
  const aOther = alarmNew(ctx, "other", () => {}, null);

  alarmSet(aHead, 100); // cached head at 100
  alarmSet(aOther, 200);
  assert.equal(alarmContextNextPendingClk(ctx), 100);
  assert.equal(ctx.pending_alarms[ctx.next_pending_alarm_idx]!.alarm, aHead);

  // Push aHead out to clk 500. Slow-path rescan must promote aOther.
  alarmSet(aHead, 500);
  assert.equal(alarmContextNextPendingClk(ctx), 200);
  assert.equal(ctx.pending_alarms[ctx.next_pending_alarm_idx]!.alarm, aOther);
});

// --------------------------------------------------------------------------
// Empty context peek. (alarm.c lines 49-57 init)
// --------------------------------------------------------------------------
test("alarm_context_next_pending_clk returns CLOCK_MAX when empty", () => {
  const ctx = alarmContextNew("test");
  assert.equal(alarmContextNextPendingClk(ctx), CLOCK_MAX);
});

// --------------------------------------------------------------------------
// Re-entrant: callback reschedules itself. Models the common chip
// pattern (CIA timer reload → alarmSet for next underflow).
// --------------------------------------------------------------------------
test("re-entrant: callback that calls alarmSet to reschedule itself works", () => {
  const ctx = alarmContextNew("test");
  let fires = 0;
  const a = alarmNew(
    ctx,
    "self-resched",
    (_offset, _data) => {
      fires++;
      if (fires < 3) {
        alarmSet(a, 1000 + fires * 1000); // reschedule for next round
      } else {
        alarmUnset(a);
      }
    },
    null,
  );

  alarmSet(a, 1000);

  // Drive a tiny dispatch loop.
  let safety = 10;
  while (alarmContextNextPendingClk(ctx) !== CLOCK_MAX && safety-- > 0) {
    const clk = alarmContextNextPendingClk(ctx);
    alarmContextDispatch(ctx, clk);
  }
  assert.equal(fires, 3);
  assert.equal(alarmContextNextPendingClk(ctx), CLOCK_MAX);
});

// --------------------------------------------------------------------------
// 256-pending capacity limit — alarm.h line 160 +
// alarm_log_too_many_alarms (alarm.c 209-212). The 257th set is
// silently dropped (warning emitted).
// --------------------------------------------------------------------------
test("256-pending capacity: 257th set is dropped with warning, no crash", () => {
  const ctx = alarmContextNew("test");
  const alarms: Alarm[] = [];
  for (let i = 0; i < ALARM_CONTEXT_MAX_PENDING_ALARMS; i++) {
    alarms.push(alarmNew(ctx, `a${i}`, () => {}, null));
  }
  for (let i = 0; i < ALARM_CONTEXT_MAX_PENDING_ALARMS; i++) {
    alarmSet(alarms[i], 1000 + i);
  }
  assert.equal(ctx.num_pending_alarms, ALARM_CONTEXT_MAX_PENDING_ALARMS);

  // Capture warn output.
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => {
    warnings.push(msg);
  };
  try {
    const overflow = alarmNew(ctx, "overflow", () => {}, null);
    // Should NOT throw; should emit warning; should leave overflow.pending_idx === -1.
    alarmSet(overflow, 9999);
    assert.equal(overflow.pending_idx, -1);
    assert.equal(ctx.num_pending_alarms, ALARM_CONTEXT_MAX_PENDING_ALARMS);
    assert.ok(warnings.length >= 1, "expected warning");
    assert.ok(
      warnings[0].includes("Too many alarms"),
      `warning text: ${warnings[0]}`,
    );
  } finally {
    console.warn = origWarn;
  }
});

// --------------------------------------------------------------------------
// alarm_context_time_warp: positive direction. (alarm.c 79-101)
// --------------------------------------------------------------------------
test("time_warp positive: shifts all pending clks + cached head clk by +amount", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  const b = alarmNew(ctx, "b", () => {}, null);
  alarmSet(a, 1000);
  alarmSet(b, 5000);

  alarmContextTimeWarp(ctx, 100, +1);

  assert.equal(ctx.pending_alarms[a.pending_idx]!.clk, 1100);
  assert.equal(ctx.pending_alarms[b.pending_idx]!.clk, 5100);
  assert.equal(alarmContextNextPendingClk(ctx), 1100);
});

// --------------------------------------------------------------------------
// alarm_context_time_warp: negative direction. (alarm.c 79-101)
// --------------------------------------------------------------------------
test("time_warp negative: shifts pending clks + cached head by -amount", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  alarmSet(a, 1000);

  alarmContextTimeWarp(ctx, 200, -1);

  assert.equal(ctx.pending_alarms[a.pending_idx]!.clk, 800);
  assert.equal(alarmContextNextPendingClk(ctx), 800);
});

// --------------------------------------------------------------------------
// alarm_context_time_warp: direction 0 is a no-op (alarm.c lines 84-86).
// --------------------------------------------------------------------------
test("time_warp direction 0: no-op", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  alarmSet(a, 1000);

  alarmContextTimeWarp(ctx, 99999, 0);

  assert.equal(ctx.pending_alarms[a.pending_idx]!.clk, 1000);
  assert.equal(alarmContextNextPendingClk(ctx), 1000);
});

// --------------------------------------------------------------------------
// alarm_destroy on a pending alarm: implicitly unsets, then removes
// from per-context list. (alarm.c 139-165)
// --------------------------------------------------------------------------
test("alarm_destroy on pending alarm: unsets + removes from list", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  const b = alarmNew(ctx, "b", () => {}, null);

  alarmSet(a, 1000);
  alarmSet(b, 2000);
  assert.equal(ctx.num_pending_alarms, 2);

  alarmDestroy(a);

  assert.equal(ctx.num_pending_alarms, 1);
  assert.equal(alarmContextNextPendingClk(ctx), 2000);

  // alarm `a` should be unlinked from context.alarms.
  let found = false;
  for (let p = ctx.alarms; p !== null; p = p.next) {
    if (p === a) {
      found = true;
      break;
    }
  }
  assert.equal(found, false);
});

// --------------------------------------------------------------------------
// alarm_unset on non-pending alarm: no-op. (alarm.c lines 174-176)
// --------------------------------------------------------------------------
test("alarm_unset on never-set alarm: no-op", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  alarmUnset(a); // should NOT throw or alter state
  assert.equal(ctx.num_pending_alarms, 0);
  assert.equal(a.pending_idx, -1);
});

// --------------------------------------------------------------------------
// alarm_unset middle entry preserves packed array + correct
// pending_idx of swapped-in entry. (alarm.c 184-193)
// --------------------------------------------------------------------------
test("alarm_unset of middle entry: swap-with-last, packed array maintained", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  const b = alarmNew(ctx, "b", () => {}, null);
  const c = alarmNew(ctx, "c", () => {}, null);

  alarmSet(a, 100);
  alarmSet(b, 200);
  alarmSet(c, 300);

  // a→0, b→1, c→2.
  assert.equal(a.pending_idx, 0);
  assert.equal(b.pending_idx, 1);
  assert.equal(c.pending_idx, 2);

  // Unset b (middle): VICE swaps last (c) into b's slot.
  alarmUnset(b);
  assert.equal(ctx.num_pending_alarms, 2);
  assert.equal(b.pending_idx, -1);
  // c should now occupy slot 1.
  assert.equal(c.pending_idx, 1);
  assert.equal(ctx.pending_alarms[1]!.alarm, c);
  // Cached head still points at a (the earliest).
  assert.equal(alarmContextNextPendingClk(ctx), 100);
  assert.equal(ctx.pending_alarms[ctx.next_pending_alarm_idx]!.alarm, a);
});

// --------------------------------------------------------------------------
// alarm_unset of cached-head triggers slow-path rescan that picks the
// new earliest. (alarm.c lines 195-196)
// --------------------------------------------------------------------------
test("alarm_unset of cached head: slow-path rescan picks new earliest", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  const b = alarmNew(ctx, "b", () => {}, null);
  const c = alarmNew(ctx, "c", () => {}, null);

  alarmSet(a, 100); // earliest
  alarmSet(b, 500);
  alarmSet(c, 300);

  assert.equal(alarmContextNextPendingClk(ctx), 100);
  alarmUnset(a);
  // After: pending_alarms holds b (at 500) and c (at 300) in some order.
  // The new earliest is c at 300.
  assert.equal(alarmContextNextPendingClk(ctx), 300);
});

// --------------------------------------------------------------------------
// alarm_unset of last-entry that happened to be the cached head:
// next_pending_alarm_idx===last branch (alarm.c lines 197-199).
// --------------------------------------------------------------------------
test("alarm_unset where last==cached-head and idx!=last: cache idx patched", () => {
  // Construct a layout where cached head is the LAST entry (index
  // num_pending-1). Easiest way: set in order earliest→latest, then
  // reschedule the last to be earliest, which forces slow-path rescan
  // to point cache at the last index.
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  const b = alarmNew(ctx, "b", () => {}, null);
  const c = alarmNew(ctx, "c", () => {}, null);

  alarmSet(a, 100);
  alarmSet(b, 200);
  alarmSet(c, 300);
  // Reschedule c to clk 50 → slow path rescan since c is the cached
  // head's competitor; result: cache points at c (idx 2).
  alarmSet(c, 50);
  assert.equal(ctx.next_pending_alarm_idx, 2);

  // Now unset a (idx 0). num_pending becomes 2; last==2; idx (0) !=
  // last (2). After swap-with-last, c moves into slot 0. Code path:
  // next_pending_alarm_idx (2) === last (2) → patches cached idx to 0.
  alarmUnset(a);
  assert.equal(ctx.num_pending_alarms, 2);
  assert.equal(c.pending_idx, 0);
  assert.equal(ctx.next_pending_alarm_idx, 0);
  assert.equal(alarmContextNextPendingClk(ctx), 50);
});

// --------------------------------------------------------------------------
// alarm_context_dispatch with no pending alarms throws (defensive).
// VICE would crash; we throw a clear error.
// --------------------------------------------------------------------------
test("alarm_context_dispatch with no pending alarms throws", () => {
  const ctx = alarmContextNew("test");
  assert.throws(() => alarmContextDispatch(ctx, 0));
});

// --------------------------------------------------------------------------
// alarm_context_update_next_pending exposed for slow-path testing.
// --------------------------------------------------------------------------
test("alarm_context_update_next_pending: empty context → CLOCK_MAX", () => {
  const ctx = alarmContextNew("test");
  ctx.next_pending_alarm_clk = 12345; // poisoned
  ctx.next_pending_alarm_idx = 7;
  alarmContextUpdateNextPending(ctx);
  assert.equal(ctx.next_pending_alarm_clk, CLOCK_MAX);
});

// --------------------------------------------------------------------------
// Linked list: alarmNew prepends to head (alarm.c lines 116-124).
// --------------------------------------------------------------------------
test("alarm_new prepends to context.alarms list", () => {
  const ctx = alarmContextNew("test");
  const a = alarmNew(ctx, "a", () => {}, null);
  const b = alarmNew(ctx, "b", () => {}, null);
  const c = alarmNew(ctx, "c", () => {}, null);
  // Head should be c (most recent), then b, then a.
  assert.equal(ctx.alarms, c);
  assert.equal(c.next, b);
  assert.equal(b.next, a);
  assert.equal(a.next, null);
  assert.equal(a.prev, b);
  assert.equal(b.prev, c);
  assert.equal(c.prev, null);
});

// --------------------------------------------------------------------------
// alarmDestroy(null) is a no-op (alarm.c lines 143-145).
// --------------------------------------------------------------------------
test("alarm_destroy(null) is no-op", () => {
  alarmDestroy(null);
  alarmDestroy(undefined);
});

// ---- runner --------------------------------------------------------------
let pass = 0;
let fail = 0;
for (const c of cases) {
  try {
    c.run();
    pass++;
    console.log(`  PASS ${c.name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${c.name}: ${(e as Error).message}`);
    if ((e as Error).stack) {
      console.log(((e as Error).stack as string).split("\n").slice(1, 4).join("\n"));
    }
  }
}
console.log(`\nalarm-context: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

// Reference unused exports to silence `noUnusedLocals` if it's ever on.
void ({} as AlarmContext);
