// Sprint 107 (Specs 122-126) v1 — LLM debug stack tests.

import { TraceRegistry } from "../trace/channels.js";
import { buildEventIndex, findEventsByPc, findEventsByAddr } from "../trace/event-index.js";
import { parseScenario } from "../scenario/dsl.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M5.1 — channel registry ---

export function runChannelRegistryTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const reg = new TraceRegistry();
  out.push(check("default channel disabled", reg.isEnabled("iec") === false));

  reg.configure("iec", { mode: "ring", capacity: 16 });
  out.push(check("after configure: enabled", reg.isEnabled("iec") === true));

  for (let i = 0; i < 32; i++) {
    reg.publish("iec", i, { atn: i % 2 === 0 });
  }
  const ring = reg.getRing("iec");
  out.push(check("ring buffer respects capacity", ring.length === 16));
  out.push(check("ring keeps newest", ring[ring.length - 1]!.ts === 31));
  reg.closeAll();
  out.push(check("closeAll disables", reg.isEnabled("iec") === false));
  return out;
}

// --- M5.2 — event index ---

export function runEventIndexTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const dir = mkdtempSync(resolvePath(tmpdir(), "spec123-"));
  try {
    const path = resolvePath(dir, "trace.jsonl");
    const lines = [
      JSON.stringify({ ts: 100, channel: "cpu", data: { pc: 0xee13 } }),
      JSON.stringify({ ts: 101, channel: "cpu", data: { pc: 0xee14 } }),
      JSON.stringify({ ts: 102, channel: "cpu", data: { pc: 0xee13 } }),
      JSON.stringify({ ts: 103, channel: "io",  data: { kind: "w", addr: 0xd020, value: 0x06 } }),
      JSON.stringify({ ts: 104, channel: "io",  data: { kind: "r", addr: 0x90, value: 0x40 } }),
      JSON.stringify({ ts: 105, channel: "iec", data: { atn: false } }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const idx = buildEventIndex(path);
    out.push(check("pc $ee13 has 2 hits", (idx.pcOffsets.get(0xee13) ?? []).length === 2));
    out.push(check("pc $ee14 has 1 hit",  (idx.pcOffsets.get(0xee14) ?? []).length === 1));
    out.push(check("addr $d020 write has 1 hit",
      (idx.addrWriteOffsets.get(0xd020) ?? []).length === 1));
    out.push(check("addr $90 read has 1 hit",
      (idx.addrReadOffsets.get(0x90) ?? []).length === 1));
    out.push(check("iec channel has 1 event", idx.iecEdgeOffsets.length === 1));

    const r = findEventsByPc(path, idx, 0xee13);
    out.push(check("findEventsByPc returns 2 lines", r.totalHits === 2 && r.hits.length === 2));

    const r2 = findEventsByAddr(path, idx, 0xd020, "w");
    out.push(check("findEventsByAddr write $d020 returns 1", r2.totalHits === 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

// --- M5.4 — scenario DSL parse ---

export function runScenarioDslTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const text = JSON.stringify({
    version: 1,
    media: { disk: "samples/synthetic/1byte.g64" },
    resetProfile: "pal-default",
    mode: "true-drive",
    steps: [
      { atFrame: 30, kind: "type", text: "LOAD\"X\",8,1\r" },
    ],
    expect: [{ kind: "status90", bit: "EOI" }],
    artifacts: [{ kind: "screenPng", path: "/tmp/out.png" }],
    knowledge: true,
    findings: [{ title: "Boot loader at $02A7", addressRange: { start: 0x02A7, end: 0x0303 }, tags: ["loader"] }],
  });
  const scn = parseScenario(text);
  out.push(check("scenario.version === 1", scn.version === 1));
  out.push(check("scenario.media.disk parsed", scn.media.disk === "samples/synthetic/1byte.g64"));
  out.push(check("scenario.steps has 1 entry", scn.steps.length === 1));
  out.push(check("scenario.expect has status90 EOI",
    scn.expect?.[0]?.kind === "status90" && scn.expect[0].bit === "EOI"));
  out.push(check("scenario.artifacts has screenPng",
    scn.artifacts?.[0]?.kind === "screenPng"));
  out.push(check("scenario.knowledge true", scn.knowledge === true));
  out.push(check("scenario.findings 1 entry", (scn.findings ?? []).length === 1));

  // Bad version rejected.
  let threw = false;
  try { parseScenario(JSON.stringify({ version: 2, media: { disk: "x" }, steps: [] })); } catch { threw = true; }
  out.push(check("version != 1 rejected", threw));

  // Missing media rejected.
  threw = false;
  try { parseScenario(JSON.stringify({ version: 1, steps: [] })); } catch { threw = true; }
  out.push(check("missing media rejected", threw));

  return out;
}

// --- M5.3 swimlane (smoke: existing script preserved) ---

export function runSwimlaneSmokeTest(): CheckResult[] {
  const out: CheckResult[] = [];
  // Existing scripts/swimlane-diff.mjs handles the actual diff.
  // v1 smoke: assert the script file is present (sanity).
  out.push(check("scripts/swimlane-diff.mjs present",
    existsSync("scripts/swimlane-diff.mjs")));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllLlmDebugTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M5.1 channel registry",  runner: runChannelRegistryTest },
    { name: "M5.2 event index",        runner: runEventIndexTest },
    { name: "M5.3 swimlane smoke",     runner: runSwimlaneSmokeTest },
    { name: "M5.4 scenario DSL parse", runner: runScenarioDslTest },
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
