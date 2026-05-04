// Spec 115 (M3.7) v1 — multi-drive shape validation tests.
//
// v1 ships the API shape + validation + `multiDriveDeferred` reporting.
// Runtime instantiates only the primary (device-8) drive; device-9
// runtime wiring tracked under M3.7 v2 follow-up.

import { startIntegratedSession } from "../integrated-session-manager.js";
import { validateDrives, MULTI_DRIVE_MAX, MULTI_DRIVE_VALID_IDS } from "../integrated-session.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

const FIXTURE_G64 = "samples/synthetic/1byte.g64";
const FIXTURE_D64 = "samples/synthetic/1byte.d64";

// --- M3.7d — validation paths ---

export function runValidationTest(): CheckResult[] {
  const out: CheckResult[] = [];

  out.push(check("constants exposed: MAX=2",
    MULTI_DRIVE_MAX === 2));
  out.push(check("constants exposed: valid IDs = [8,9]",
    MULTI_DRIVE_VALID_IDS.length === 2 && MULTI_DRIVE_VALID_IDS[0] === 8 && MULTI_DRIVE_VALID_IDS[1] === 9));

  const r1 = validateDrives([]);
  out.push(check("empty drives[] rejected",
    r1.ok === false && (r1 as { error: string }).error.includes("at least one")));

  const r2 = validateDrives([{ id: 8, disk: "a.g64" }, { id: 9, disk: "b.g64" }, { id: 10, disk: "c.g64" } as never]);
  out.push(check("3rd drive rejected (max 2)",
    r2.ok === false && (r2 as { error: string }).error.includes("max 2")));

  const r3 = validateDrives([{ id: 10, disk: "a.g64" }]);
  out.push(check("id=10 rejected",
    r3.ok === false && (r3 as { error: string }).error.includes("id must be 8 or 9")));

  const r4 = validateDrives([{ id: 8, disk: "a.g64" }, { id: 8, disk: "b.g64" }]);
  out.push(check("duplicate id rejected",
    r4.ok === false && (r4 as { error: string }).error.includes("duplicate")));

  const r5 = validateDrives([{ id: 8, disk: "" }]);
  out.push(check("empty disk path rejected",
    r5.ok === false && (r5 as { error: string }).error.includes("disk path missing")));

  const r6 = validateDrives([{ id: 8, disk: "a.g64" }]);
  out.push(check("single drive 8 valid", r6.ok === true));

  const r7 = validateDrives([{ id: 8, disk: "a.g64" }, { id: 9, disk: "b.g64" }]);
  out.push(check("two drives 8+9 valid", r7.ok === true));

  return out;
}

// --- M3.7a — session manager folds drives[] → primary ---

export function runSessionManagerFoldTest(): CheckResult[] {
  const out: CheckResult[] = [];

  // Single-element drives[]: behaves like legacy diskPath.
  const r1 = startIntegratedSession({
    diskPath: "/unused-overridden",
    drives: [{ id: 8, disk: FIXTURE_G64 }],
    mode: "true-drive",
  });
  out.push(check("single-drive[]: session starts ok",
    typeof r1.sessionId === "string" && r1.sessionId.length > 0));
  out.push(check("single-drive[]: deferred list empty",
    r1.session.multiDriveDeferred.length === 0));
  out.push(check("single-drive[]: diskPath set to primary",
    r1.session.diskPath.endsWith("1byte.g64"),
    `diskPath=${r1.session.diskPath}`));

  // Two-drive: device 9 deferred.
  const r2 = startIntegratedSession({
    diskPath: "/unused-overridden",
    drives: [
      { id: 8, disk: FIXTURE_G64 },
      { id: 9, disk: FIXTURE_D64 },
    ],
    mode: "true-drive",
  });
  out.push(check("two-drive[]: session starts ok",
    typeof r2.sessionId === "string"));
  out.push(check("two-drive[]: device-9 deferred",
    r2.session.multiDriveDeferred.length === 1
      && r2.session.multiDriveDeferred[0]!.id === 9
      && r2.session.multiDriveDeferred[0]!.disk.endsWith("1byte.d64")));
  out.push(check("two-drive[]: primary=device 8",
    r2.session.diskPath.endsWith("1byte.g64")));

  // Drive 9 first → still valid; primary becomes drive 8 if present.
  const r3 = startIntegratedSession({
    diskPath: "/unused",
    drives: [
      { id: 9, disk: FIXTURE_D64 },
      { id: 8, disk: FIXTURE_G64 },
    ],
    mode: "true-drive",
  });
  out.push(check("order-independent: primary still device 8 when both present",
    r3.session.diskPath.endsWith("1byte.g64")));
  out.push(check("order-independent: device-9 deferred",
    r3.session.multiDriveDeferred.length === 1 && r3.session.multiDriveDeferred[0]!.id === 9));

  return out;
}

// --- M3.7d — invalid configs throw at session start ---

export function runInvalidConfigsThrowTest(): CheckResult[] {
  const out: CheckResult[] = [];

  function expectThrow(label: string, cb: () => unknown, fragment: string): CheckResult {
    try {
      cb();
      return { label, pass: false, detail: "expected throw, got success" };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      return { label, pass: msg.includes(fragment), detail: msg };
    }
  }

  out.push(expectThrow("id=10 throws",
    () => startIntegratedSession({
      diskPath: "/unused",
      drives: [{ id: 10, disk: FIXTURE_G64 } as never],
      mode: "true-drive",
    } as never),
    "id must be 8 or 9"));

  out.push(expectThrow("3 drives throws",
    () => startIntegratedSession({
      diskPath: "/unused",
      drives: [
        { id: 8, disk: FIXTURE_G64 },
        { id: 9, disk: FIXTURE_D64 },
        { id: 8, disk: FIXTURE_G64 } as never,
      ],
      mode: "true-drive",
    } as never),
    "max 2"));

  out.push(expectThrow("duplicate id throws",
    () => startIntegratedSession({
      diskPath: "/unused",
      drives: [
        { id: 8, disk: FIXTURE_G64 },
        { id: 8, disk: FIXTURE_D64 },
      ],
      mode: "true-drive",
    } as never),
    "duplicate"));

  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllMultiDriveTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M3.7d validateDrives()",         runner: runValidationTest },
    { name: "M3.7a session manager fold",      runner: runSessionManagerFoldTest },
    { name: "M3.7d invalid configs throw",     runner: runInvalidConfigsThrowTest },
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
