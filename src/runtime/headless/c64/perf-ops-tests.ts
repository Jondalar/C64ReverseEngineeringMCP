// Sprint 110 (Specs 133-136) v1 — perf + ops tests.

import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { makeBudgetTracker, checkBudget } from "../perf/budgets.js";
import { saveSnapshotFile, loadSnapshotFile } from "../perf/snapshot-file.js";
import { SAFE_SKIP_REGISTRY, newSafeSkipCounter, recordSkip } from "../perf/safe-skips.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M8.1 — budget tracker ---

export function runBudgetTrackerTest(): CheckResult[] {
  const out: CheckResult[] = [];

  // Cycle budget.
  let t = makeBudgetTracker({ unit: "cycles", amount: 1000 }, 0, 0);
  let c = checkBudget(t, 500, 0);
  out.push(check("cycle 500/1000: not exhausted", c.exhausted === false && c.remaining === 500));
  c = checkBudget(t, 1000, 0);
  out.push(check("cycle 1000/1000: exhausted", c.exhausted === true && c.remaining === 0));
  c = checkBudget(t, 1500, 0);
  out.push(check("cycle 1500/1000: exhausted negative remaining",
    c.exhausted === true && c.remaining < 0));

  // Instruction budget.
  t = makeBudgetTracker({ unit: "instructions", amount: 100 }, 0, 0);
  c = checkBudget(t, 99999, 50);
  out.push(check("instr 50/100: not exhausted", c.exhausted === false));
  c = checkBudget(t, 99999, 100);
  out.push(check("instr 100/100: exhausted", c.exhausted === true));

  // Frame budget at 19656 cyc/frame default.
  t = makeBudgetTracker({ unit: "frames", amount: 2 }, 0, 0);
  c = checkBudget(t, 19656, 0);
  out.push(check("frame 1/2: not exhausted", c.exhausted === false));
  c = checkBudget(t, 39312, 0);
  out.push(check("frame 2/2: exhausted", c.exhausted === true));

  return out;
}

// --- M8.2 — snapshot file save/load ---

export function runSnapshotFileTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const dir = mkdtempSync(resolvePath(tmpdir(), "spec134-"));
  try {
    const path = resolvePath(dir, "snap.json");
    const payload = { cpu: { pc: 0x4242, sp: 0xff }, ram: "BASE64_PLACEHOLDER" };
    saveSnapshotFile(path, payload, {
      cyclesAtSave: 12345,
      diskPath: "samples/x.g64",
      mode: "true-drive",
      includeTraces: false,
    });
    out.push(check("file written", existsSync(path) && statSync(path).size > 0));

    const loaded = loadSnapshotFile<typeof payload>(path);
    out.push(check("header.version = 1", loaded.header.version === 1));
    out.push(check("header.cyclesAtSave round-trip", loaded.header.cyclesAtSave === 12345));
    out.push(check("header.mode round-trip", loaded.header.mode === "true-drive"));
    out.push(check("payload.cpu.pc round-trip", loaded.payload.cpu.pc === 0x4242));

    // Bad version rejected.
    writeFileSync(path, JSON.stringify({ header: { version: 99 }, payload: {} }));
    let threw = false;
    try { loadSnapshotFile(path); } catch { threw = true; }
    out.push(check("unknown version rejected", threw));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

// --- M8.3 — safe-skip registry ---

export function runSafeSkipsTest(): CheckResult[] {
  const out: CheckResult[] = [];
  out.push(check("registry has at least 2 entries", SAFE_SKIP_REGISTRY.length >= 2));
  // KERNAL kbd idle pattern.
  const kbd = SAFE_SKIP_REGISTRY.find((p) => p.name === "kernal-kbd-idle");
  out.push(check("kernal-kbd-idle entry present", !!kbd));
  if (kbd) {
    out.push(check("kbd matcher hits $E5CD",  kbd.pcMatcher(0xE5CD) === true));
    out.push(check("kbd matcher hits $E5E0",  kbd.pcMatcher(0xE5E0) === true));
    out.push(check("kbd matcher misses $E5CC", kbd.pcMatcher(0xE5CC) === false));
    out.push(check("kbd isIdle: ramAt00C5=64", kbd.isIdle({ pc: 0xE5CD, ramAt0291: 0, ramAt00C5: 64 }) === true));
    out.push(check("kbd isIdle: ramAt00C5=5",  kbd.isIdle({ pc: 0xE5CD, ramAt0291: 0, ramAt00C5: 5 }) === false));
  }
  // Counter math.
  const counter = newSafeSkipCounter();
  recordSkip(counter, "kernal-kbd-idle", 100);
  recordSkip(counter, "basic-ready-loop", 250);
  recordSkip(counter, "kernal-kbd-idle", 50);
  out.push(check("totalSkipped = 400", counter.totalSkipped === 400));
  out.push(check("kbd subtotal = 150", counter.byName.get("kernal-kbd-idle") === 150));
  return out;
}

// --- M8.4 — CI profile doc presence ---

export function runCiProfileDocTest(): CheckResult[] {
  const out: CheckResult[] = [];
  out.push(check("docs/ci-profile.md exists", existsSync("docs/ci-profile.md")));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllPerfOpsTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M8.1 budget tracker",  runner: runBudgetTrackerTest },
    { name: "M8.2 snapshot file",   runner: runSnapshotFileTest },
    { name: "M8.3 safe skips",      runner: runSafeSkipsTest },
    { name: "M8.4 CI profile doc",  runner: runCiProfileDocTest },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
