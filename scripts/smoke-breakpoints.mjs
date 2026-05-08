#!/usr/bin/env node
// Spec 241 — Conditional breakpoints + watchpoints smoke test.
//
// 10 scenarios:
//   1. PC breakpoint fires at expected PC.
//   2. mem-write watchpoint (valueEq).
//   3. mem-read watchpoint.
//   4. Conditional: a > 0x80.
//   5. AND combinator.
//   6. OR combinator.
//   7. Structured predicate + VICE-syntax string produce equivalent hit.
//   8. Hit-limit auto-disables after N hits.
//   9. Callback timeout disables breakpoint.
//  10. All-fire on same cycle: two breakpoints at same PC both fire.

import { existsSync } from "node:fs";

const disk = "samples/synthetic/1byte.g64";
if (!existsSync(disk)) {
  console.error(`fixture missing: ${disk} — run \`npm run smoke:gen\``);
  process.exit(2);
}

let startIntegratedSession;
let bpMod, viceMod, bprtMod;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  bpMod  = await import("../dist/runtime/headless/v2/breakpoints.js");
  viceMod = await import("../dist/runtime/headless/v2/vice-syntax.js");
  bprtMod = await import("../dist/runtime/headless/v2/breakpoint-runtime.js");
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const { BreakpointManager, compilePredicate } = bpMod;
const { parseViceExpression, viceExprToPredicate } = viceMod;
const { BreakpointRuntime, createBreakpointRuntime } = bprtMod;

// ---- Helper ----

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

console.log("breakpoints smoke — Spec 241 acceptance (10 scenarios)\n");

// Boot a session we'll reuse across pure-logic tests (no ROM boot needed).
const { session } = startIntegratedSession({ diskPath: disk, mode: "fast-trap" });
session.resetCold();

// Synthetic CPU state we can control for pure-logic tests.
function makeCtx(overrides = {}) {
  const base = {
    cycle: 1234,
    cpu: { pc: 0x0800, a: 0x00, x: 0x00, y: 0x00, sp: 0xfd, flags: 0x20 },
    mem: () => 0x00,
    io: () => 0x00,
    irqPending: false,
    nmiPending: false,
  };
  return { ...base, ...overrides, cpu: { ...base.cpu, ...(overrides.cpu ?? {}) } };
}

// ========================
// Scenario 1: PC breakpoint
// ========================
check("1. PC breakpoint fires at expected PC", () => {
  const mgr = new BreakpointManager();
  mgr.addPc("bp1", 0x0800);

  const ctx = makeCtx({ cpu: { pc: 0x0800, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  const hits = mgr.evaluate(ctx);
  assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
  assert(hits[0].id === "bp1", `expected id bp1, got ${hits[0].id}`);

  // Different PC — should not fire.
  const ctx2 = makeCtx({ cpu: { pc: 0x0801, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  const hits2 = mgr.evaluate(ctx2);
  assert(hits2.length === 0, `expected 0 hits at wrong PC, got ${hits2.length}`);
});

// ========================
// Scenario 2: mem-write watchpoint
// ========================
check("2. mem-write watchpoint (valueEq)", () => {
  const mgr = new BreakpointManager();
  mgr.add({
    id: "mw1",
    predicate: { kind: "mem_write", addr: 0x0763, valueEq: 0x11 },
    action: "halt",
    enabled: true,
  });

  // Match: memory at 0x0763 returns 0x11.
  const ctx = makeCtx({ mem: (a) => a === 0x0763 ? 0x11 : 0x00 });
  const hits = mgr.evaluate(ctx);
  assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);

  // No match: memory returns 0x00.
  const ctx2 = makeCtx({ mem: () => 0x00 });
  const hits2 = mgr.evaluate(ctx2);
  assert(hits2.length === 0, `expected 0 hits, got ${hits2.length}`);
});

// ========================
// Scenario 3: mem-read watchpoint
// ========================
check("3. mem-read watchpoint (addr range)", () => {
  const mgr = new BreakpointManager();
  mgr.addWatch("mr1", [0x0400, 0x07ff], { mode: "read", action: "log" });

  // PC inside watched range → fires.
  const ctx = makeCtx({ cpu: { pc: 0x0600, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  const hits = mgr.evaluate(ctx);
  assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
  assert(hits[0].action === "log", "expected log action");

  // PC outside range → no fire.
  const ctx2 = makeCtx({ cpu: { pc: 0x0800, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  const hits2 = mgr.evaluate(ctx2);
  assert(hits2.length === 0, `expected 0 hits, got ${hits2.length}`);
});

// ========================
// Scenario 4: conditional a > 0x80
// ========================
check("4. Conditional register predicate: a > 0x80", () => {
  const mgr = new BreakpointManager();
  mgr.add({
    id: "cond1",
    predicate: {
      kind: "callback",
      fn: (ctx) => ctx.cpu.a > 0x80,
    },
    action: "halt",
    enabled: true,
  });

  const ctx81 = makeCtx({ cpu: { pc: 0x0800, a: 0x81, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  const hits = mgr.evaluate(ctx81);
  assert(hits.length === 1, `a=0x81 > 0x80 should fire, got ${hits.length} hits`);

  const ctx80 = makeCtx({ cpu: { pc: 0x0800, a: 0x80, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  const hits2 = mgr.evaluate(ctx80);
  assert(hits2.length === 0, `a=0x80 is not > 0x80, should not fire`);
});

// ========================
// Scenario 5: AND combinator
// ========================
check("5. AND combinator (pc == 0x0800 && a > 0x10)", () => {
  const mgr = new BreakpointManager();
  mgr.add({
    id: "and1",
    predicate: {
      kind: "and",
      left: { kind: "pc", pc: 0x0800 },
      right: { kind: "callback", fn: (ctx) => ctx.cpu.a > 0x10 },
    },
    action: "halt",
    enabled: true,
  });

  // Both true → fires.
  const ctx = makeCtx({ cpu: { pc: 0x0800, a: 0x20, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  assert(mgr.evaluate(ctx).length === 1, "AND(pc match, a>0x10) should fire");

  // PC wrong → no fire.
  const ctx2 = makeCtx({ cpu: { pc: 0x0900, a: 0x20, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  assert(mgr.evaluate(ctx2).length === 0, "AND(pc mismatch) should not fire");

  // a wrong → no fire.
  const ctx3 = makeCtx({ cpu: { pc: 0x0800, a: 0x05, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  assert(mgr.evaluate(ctx3).length === 0, "AND(a<=0x10) should not fire");
});

// ========================
// Scenario 6: OR combinator
// ========================
check("6. OR combinator (pc == 0x0800 || pc == 0x0900)", () => {
  const mgr = new BreakpointManager();
  mgr.add({
    id: "or1",
    predicate: {
      kind: "or",
      left: { kind: "pc", pc: 0x0800 },
      right: { kind: "pc", pc: 0x0900 },
    },
    action: "log",
    enabled: true,
  });

  const ctxA = makeCtx({ cpu: { pc: 0x0800, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  assert(mgr.evaluate(ctxA).length === 1, "OR: first branch should fire");

  const ctxB = makeCtx({ cpu: { pc: 0x0900, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  assert(mgr.evaluate(ctxB).length === 1, "OR: second branch should fire");

  const ctxC = makeCtx({ cpu: { pc: 0x0700, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });
  assert(mgr.evaluate(ctxC).length === 0, "OR: neither branch fires at 0x0700");
});

// ========================
// Scenario 7: Structured predicate + VICE-syntax produce same callback
// ========================
check("7. Structured predicate and VICE-syntax produce equivalent hit", () => {
  // Structured predicate: pc == 0x05b7
  const structFn = compilePredicate({ kind: "pc", pc: 0x05b7 });

  // VICE syntax: "pc == 0x05b7"
  const viceFn = parseViceExpression("pc == 0x05b7");

  // Also test mem deref: "@0x0763 == 0x11"
  const viceMem = parseViceExpression("@0x0763 == 0x11");

  // Also test bitwise: "a & 0x80"
  const viceBit = parseViceExpression("a & 0x80");

  // Also test complex: "(a > 0x10) && (x < 0x20)"
  const viceComplex = parseViceExpression("(a > 0x10) && (x < 0x20)");

  const matchCtx = makeCtx({ cpu: { pc: 0x05b7, a: 0x90, x: 0x10, y: 0, sp: 0xfd, flags: 0x20 }, mem: (a) => a === 0x0763 ? 0x11 : 0 });
  const noMatchCtx = makeCtx({ cpu: { pc: 0x05b8, a: 0x05, x: 0x30, y: 0, sp: 0xfd, flags: 0x20 }, mem: () => 0 });

  assert(structFn(matchCtx), "struct pc match");
  assert(viceFn(matchCtx), "vice pc match");
  assert(!structFn(noMatchCtx), "struct pc no match");
  assert(!viceFn(noMatchCtx), "vice pc no match");

  assert(viceMem(matchCtx), "@0x0763==0x11 match");
  assert(!viceMem(noMatchCtx), "@0x0763==0x11 no match");

  assert(viceBit(matchCtx), "a & 0x80 → 0x90 & 0x80 = non-zero");
  assert(!viceBit(noMatchCtx), "a & 0x80 → 0x05 & 0x80 = 0");

  assert(viceComplex(matchCtx), "(a>0x10)&&(x<0x20): a=0x90>0x10 AND x=0x10<0x20");
  assert(!viceComplex(noMatchCtx), "(a>0x10)&&(x<0x20): a=0x05 fails");
});

// ========================
// Scenario 8: Hit-limit auto-disables
// ========================
check("8. Hit-limit auto-disables after N hits", () => {
  const mgr = new BreakpointManager();
  mgr.add({
    id: "hl1",
    predicate: { kind: "pc", pc: 0x0800 },
    action: "log",
    enabled: true,
    hitLimit: 2,
  });

  const ctx = makeCtx({ cpu: { pc: 0x0800, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });

  // Hit 1.
  const h1 = mgr.evaluate(ctx);
  assert(h1.length === 1, "hit 1 should fire");
  assert(mgr.get("hl1")?.enabled, "still enabled after hit 1");

  // Hit 2.
  const h2 = mgr.evaluate(ctx);
  assert(h2.length === 1, "hit 2 should fire");
  assert(!mgr.get("hl1")?.enabled, "disabled after hit 2 (limit reached)");

  // Hit 3 — disabled, should not fire.
  const h3 = mgr.evaluate(ctx);
  assert(h3.length === 0, "hit 3: disabled, should not fire");

  // Audit log should contain the disable entry.
  assert(mgr.auditLog.length === 1, `expected 1 audit entry, got ${mgr.auditLog.length}`);
  assert(mgr.auditLog[0].id === "hl1", "audit entry for hl1");
});

// ========================
// Scenario 9: Callback timeout disables
// ========================
check("9. Callback timeout disables breakpoint", () => {
  const mgr = new BreakpointManager({ defaultCallbackTimeoutMs: 0 }); // 0ms = always timeout
  mgr.add({
    id: "to1",
    predicate: {
      kind: "callback",
      fn: (ctx) => {
        // Simulate a slow callback by just returning true — but
        // since timeout is 0ms any callback exceeds it.
        return ctx.cpu.pc === 0x0800;
      },
    },
    action: "halt",
    enabled: true,
    callbackTimeoutMs: 0, // force timeout on first eval
  });

  const ctx = makeCtx({ cpu: { pc: 0x0800, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });

  // First eval: callback fires but timeout check may or may not trigger
  // (0ms is technically possible in practice with modern JS JIT).
  // We rely on: after two evaluations with 0ms budget, it *must* have
  // exceeded the budget at least once on a cold JIT path.
  // For determinism, we override `performance.now` simulation:
  // Instead set a very small timeout and run an actual slow callback.

  // Create a new manager with explicit 0ms but an artificially slow fn.
  const mgr2 = new BreakpointManager({ defaultCallbackTimeoutMs: 1 });
  mgr2.add({
    id: "slow1",
    predicate: {
      kind: "callback",
      fn: (ctx) => {
        // Spin for > 1ms.
        const end = Date.now() + 5; // 5ms spin
        while (Date.now() < end) { /* spin */ }
        return true;
      },
    },
    action: "halt",
    enabled: true,
    callbackTimeoutMs: 1,
  });

  const hits = mgr2.evaluate(ctx);
  assert(hits.length === 0, "slow callback should not produce a hit (timeout disables)");
  assert(!mgr2.get("slow1")?.enabled, "slow callback breakpoint should be disabled");
  assert(mgr2.auditLog.length === 1, "audit log should have 1 entry");
  assert(mgr2.auditLog[0].reason.includes("budget"), "audit reason mentions budget");
});

// ========================
// Scenario 10: All-fire on same cycle
// ========================
check("10. All-fire on same cycle: two breakpoints both fire", () => {
  const mgr = new BreakpointManager();
  const fired = [];
  mgr.add({
    id: "fire1",
    predicate: { kind: "pc", pc: 0x0800 },
    action: "log",
    enabled: true,
  });
  mgr.add({
    id: "fire2",
    predicate: { kind: "register", reg: "a", valueEq: 0x42 },
    action: "log",
    enabled: true,
  });

  const ctx = makeCtx({
    cycle: 9999,
    cpu: { pc: 0x0800, a: 0x42, x: 0, y: 0, sp: 0xfd, flags: 0x20 },
  });
  const hits = mgr.evaluate(ctx);

  // Both must fire on the same cycle.
  assert(hits.length === 2, `expected 2 hits (all-fire), got ${hits.length}`);
  const ids = hits.map((h) => h.id).sort();
  assert(ids[0] === "fire1" && ids[1] === "fire2", `expected fire1+fire2, got ${ids}`);
  assert(hits[0].cycle === 9999 && hits[1].cycle === 9999, "both hits at same cycle");
});

// ========================
// VICE syntax parser edge cases
// ========================
check("VICE syntax: ignore-count (setIgnoreCount)", () => {
  const mgr = new BreakpointManager();
  mgr.addPc("ic1", 0x0800);
  mgr.setIgnoreCount("ic1", 2); // skip first 2 hits

  const ctx = makeCtx({ cpu: { pc: 0x0800, a: 0, x: 0, y: 0, sp: 0xfd, flags: 0x20 } });

  // First 2 evaluations: skipped.
  assert(mgr.evaluate(ctx).length === 0, "ignore 1");
  assert(mgr.evaluate(ctx).length === 0, "ignore 2");
  // Third: fires.
  assert(mgr.evaluate(ctx).length === 1, "fire after ignore exhausted");
});

// ========================
// Summary
// ========================
console.log("");
console.log(`Results: ${pass} PASS, ${fail} FAIL`);
if (failures.length > 0) {
  console.log("\nFailed scenarios:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
