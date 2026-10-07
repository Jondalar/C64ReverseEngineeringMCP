// Spec 889 §4b — the gate: hardware only after the emulator said yes.
//
// A medium reaches a C64 Ultimate only once it has passed in the emulator. "Passed" is a run
// on a private emulator machine whose `Then` checks ALL held, with at least one check (a
// prose-only run, or a run with no checks, passes nothing). The pass is recorded against the
// SHA-256 of the medium's BYTES — a changed build is another medium and needs its own pass —
// together with the schedule, the checks, the time and the TRX64 version, under the project's
// knowledge directory so it outlives the session.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REQUIRED_TRX64_VERSION } from "./setup-recipe.js";

export interface EmulatorPass {
  readonly sha256: string;
  /** The medium's file name, for the refusal and the record. */
  readonly name: string;
  /** The `.feature` scenario, when the run came from one. */
  readonly scenario?: string;
  /** The step lines of the schedule, as written. */
  readonly steps: readonly string[];
  readonly checks: readonly { text: string; line?: number; afterSteps: number; actual: string }[];
  /** ISO time the pass was recorded. */
  readonly at: string;
  readonly runtimeVersion: string;
}

interface PassFile { version: 1; passes: EmulatorPass[] }

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function passesFilePath(projectDir: string): string {
  return join(projectDir, "knowledge", "emulator-passes.json");
}

function readPasses(projectDir: string): PassFile {
  const p = passesFilePath(projectDir);
  if (!existsSync(p)) return { version: 1, passes: [] };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as PassFile;
    return j && Array.isArray(j.passes) ? { version: 1, passes: j.passes } : { version: 1, passes: [] };
  } catch {
    // A file that does not parse passes nothing. It is not overwritten here: that would
    // destroy the record of what had passed. recordEmulatorPass refuses the same way.
    throw new Error(`${p} does not parse — fix or remove it; until then no medium counts as having passed`);
  }
}

/** What a run must show to count: every check passed, and there was at least one. */
export function runCountsAsPass(checks: readonly { pass: boolean }[]): boolean {
  return checks.length >= 1 && checks.every((c) => c.pass);
}

/**
 * Record one green run for each medium it exercised. Same medium + same scenario/steps
 * replaces its earlier record (the latest run is the evidence); anything else adds.
 */
export function recordEmulatorPass(
  projectDir: string,
  run: {
    media: readonly { name: string; bytes: Uint8Array }[];
    scenario?: string;
    steps: readonly string[];
    checks: readonly { text: string; line?: number; afterSteps: number; actual: string; pass: boolean }[];
  },
): EmulatorPass[] {
  if (!runCountsAsPass(run.checks)) return [];
  const file = readPasses(projectDir);
  const at = new Date().toISOString();
  const made: EmulatorPass[] = [];
  for (const m of run.media) {
    const rec: EmulatorPass = {
      sha256: sha256Hex(m.bytes),
      name: m.name,
      scenario: run.scenario,
      steps: [...run.steps],
      checks: run.checks.map(({ text, line, afterSteps, actual }) => ({ text, line, afterSteps, actual })),
      at,
      runtimeVersion: REQUIRED_TRX64_VERSION,
    };
    const key = (p: EmulatorPass) => `${p.sha256}\u0000${p.scenario ?? p.steps.join("\n")}`;
    const i = file.passes.findIndex((p) => key(p) === key(rec));
    if (i >= 0) file.passes[i] = rec; else file.passes.push(rec);
    made.push(rec);
  }
  if (made.length === 0) return [];
  const p = passesFilePath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, p);
  return made;
}

export function findEmulatorPass(projectDir: string, sha256: string): EmulatorPass | undefined {
  return readPasses(projectDir).passes.find((p) => p.sha256 === sha256);
}

/**
 * The gate. Undefined = the bytes have a recorded green emulator pass; otherwise the refusal
 * text of §4b, naming the file and what is missing.
 */
export function gateRefusal(args: { name: string; bytes: Uint8Array; projectDir: string | undefined }): string | undefined {
  const sha = sha256Hex(args.bytes);
  const short = `${sha.slice(0, 8)}…`;
  if (!args.projectDir) {
    return `${args.name} (sha256 ${short}) has no green emulator run: no C64RE project could be resolved to look in — ` +
      `a pass is recorded in the project's knowledge/ (\`c64re scenario run scenarios/<name>.feature\`, or runtime_sandbox_run with at least one Then check), and the C64 Ultimate takes only bytes that have one`;
  }
  let pass: EmulatorPass | undefined;
  try { pass = findEmulatorPass(args.projectDir, sha); }
  catch (e) { return `${args.name} (sha256 ${short}): ${e instanceof Error ? e.message : String(e)}`; }
  if (pass) return undefined;
  return `${args.name} (sha256 ${short}) has no green emulator run in this project — ` +
    `\`c64re scenario run scenarios/<name>.feature\` first (or runtime_sandbox_run with at least one Then check). ` +
    `A changed build is a new medium and needs its own pass; the emulator backend has no gate.`;
}

/**
 * The one door both runners use after a run on a private emulator machine: when the run's
 * checks all passed (and there was one), record a pass for every medium it exercised — the
 * one it started from and each one a step inserted. Soft: a failure to record is reported to
 * the caller as text, never thrown into the run's own verdict.
 */
export function recordPassForRun(args: {
  projectDir: string;
  mediaPath?: string;
  steps: readonly { kind: string; text: string; path?: string }[];
  resolveMedium?: (named: string) => string;
  scenario?: string;
  checks: readonly { text: string; line?: number; afterSteps: number; actual: string; pass: boolean }[];
}): { recorded: EmulatorPass[]; note?: string } {
  if (!runCountsAsPass(args.checks)) return { recorded: [] };
  if (!existsSync(join(args.projectDir, "knowledge"))) {
    return { recorded: [], note: `no C64RE project at ${args.projectDir} (no knowledge/ directory): the green run was not recorded for the C64 Ultimate gate` };
  }
  try {
    const paths = new Set<string>();
    if (args.mediaPath) paths.add(args.mediaPath);
    for (const s of args.steps) {
      if (s.kind === "insert" && typeof s.path === "string") paths.add(args.resolveMedium ? args.resolveMedium(s.path) : s.path);
    }
    const media = [...paths].filter((p) => existsSync(p)).map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, bytes: new Uint8Array(readFileSync(p)) }));
    if (media.length === 0) return { recorded: [], note: "no medium file to record a pass against (a bare machine run)" };
    const recorded = recordEmulatorPass(args.projectDir, { media, scenario: args.scenario, steps: args.steps.map((s) => s.text), checks: args.checks });
    return { recorded };
  } catch (e) {
    return { recorded: [], note: `the green run could not be recorded for the C64 Ultimate gate: ${e instanceof Error ? e.message : String(e)}` };
  }
}
