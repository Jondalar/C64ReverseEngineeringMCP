// Spec 900 — `c64re scenario run`: a project's .feature files, run and judged with no
// agent in the loop, so `make` and CI can call them.
//
// It is a door, not a second runner: every scenario goes through the same private-machine
// runner `runtime_sandbox_run` uses (a fresh daemon per scenario, the machine stopped
// between steps, so the same file gives the same bytes), and every `Then` is decided by
// that runner's one evaluator. What this file adds is only what a command line needs —
// finding the files, resolving their media, the verdict per scenario, and an exit code.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { findProjectRoot } from "../project-root.js";
import { parseFeature, type Scenario } from "../project-knowledge/scenario-gherkin.js";
import type { SandboxCheckResult } from "../reel/run-sandbox.js";

type Verdict = "PASS" | "FAIL" | "UNCHECKED" | "SKIP" | "ERROR";

interface ScenarioResult {
  readonly file: string;
  readonly line: number;
  readonly scenario: string;
  readonly verdict: Verdict;
  /** Why, for SKIP and ERROR. */
  readonly reason?: string;
  readonly checks: readonly SandboxCheckResult[];
  /** The `Then` lines written in prose: reported, never judged. */
  readonly unchecked: readonly { line?: number; text: string }[];
  readonly model?: string;
  readonly elapsedMs: number;
}

const USAGE = [
  "c64re scenario run <file.feature|dir>… [--scenario <name>] [--json] [--project <dir>] [--jobs N]",
  "",
  "  Runs every scenario on a fresh private machine and decides its Then lines.",
  "  One line per scenario: PASS, FAIL, UNCHECKED (no Then in the check notation yet),",
  "  SKIP (starts from a mark, or asks for a capture), ERROR (the run itself failed).",
  "  Exit 1 on any FAIL or ERROR.",
  "",
  "  Checks (the `I wait until` predicates, said as facts):",
  "    Then $8EF2 is $01                 Then $40 is $26 $40 $26 $40 $26 $55",
  "    Then $B0 is not $00               Then $8EF2 is one of $01, $02",
  "    Then $8EF2@ram is $01             (lens: cpu, ram, io, rom, cart)",
  "    Then the CPU is at $0812          Then the screen shows \"READY.\"",
  "  A Then is decided where it stands: after the steps written above it.",
  "",
  "  --scenario <name>  only scenarios whose name contains this",
  "  --json             one JSON document on stdout",
  "  --project <dir>    where media and the machine model are looked up (default: found",
  "                     by walking up from each file, else the current directory)",
  "  --jobs N           machines at once (default 1)",
];

export async function runScenarioCli(argv: string[]): Promise<void> {
  if (argv[0] !== "run" || argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE.join("\n"));
    if (argv[0] !== "run" && !argv.includes("--help") && !argv.includes("-h")) process.exitCode = 2;
    return;
  }

  const args = argv.slice(1);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const only = opt("--scenario");
  const projectArg = opt("--project");
  const jobsArg = opt("--jobs");
  const json = args.includes("--json");
  const paths = args.filter((a) => a !== "--json");
  const unknown = paths.find((a) => a.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}`);
  if (paths.length === 0) throw new Error("no .feature file or directory given");
  const jobs = Math.max(1, Math.min(Number(jobsArg ?? 1) || 1, cpus().length));

  const files = paths.flatMap((p) => featureFiles(resolve(p)));
  if (files.length === 0) throw new Error(`no .feature files under ${paths.join(", ")}`);

  // A line that does not parse is reported and counts as a failure of the run — but the
  // scenarios around it that did parse still run: one bad line in one file of twenty-five
  // must not hide what the other twenty-four say.
  const work: { file: string; scenario: Scenario; projectDir: string }[] = [];
  const parseErrors: string[] = [];
  for (const file of files) {
    const { scenarios, issues } = parseFeature(readFileSync(file, "utf8"), file);
    for (const i of issues) parseErrors.push(`${rel(file)}:${i.line}: ${i.message}`);
    const projectDir = projectArg ? resolve(projectArg) : projectFor(file);
    for (const scenario of scenarios) {
      if (only && !scenario.name.toLowerCase().includes(only.toLowerCase())) continue;
      work.push({ file, scenario, projectDir });
    }
  }
  if (!json) for (const e of parseErrors) console.log(`PARSE     ${e}`);

  const results: ScenarioResult[] = new Array(work.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= work.length) return;
      results[i] = await runOne(work[i].file, work[i].scenario, work[i].projectDir);
      if (!json) printResult(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, work.length) }, worker));

  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  const bad = count("FAIL") + count("ERROR");
  if (json) {
    console.log(JSON.stringify({ parseErrors, results }, null, 2));
  } else {
    console.log(
      `\n${results.length} scenario(s): ${count("PASS")} pass, ${count("FAIL")} fail, ` +
        `${count("UNCHECKED")} unchecked, ${count("SKIP")} skipped, ${count("ERROR")} error` +
        (parseErrors.length ? `; ${parseErrors.length} line(s) did not parse` : ""),
    );
  }
  if (bad > 0 || parseErrors.length > 0) process.exitCode = 1;
}

async function runOne(file: string, scenario: Scenario, projectDir: string): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const unchecked = scenario.criteria.filter((c) => !c.check).map((c) => ({ line: c.line, text: c.text }));
  const base = { file, line: scenario.line ?? 0, scenario: scenario.name, unchecked };
  const end = (verdict: Verdict, extra: Partial<ScenarioResult> = {}): ScenarioResult =>
    ({ ...base, verdict, checks: [], elapsedMs: Date.now() - startedAt, ...extra });

  if (scenario.origin.kind === "mark") {
    return end("SKIP", { reason: `starts from the mark "${scenario.origin.name}" — a mark lives in the shared session, not in a private machine` });
  }
  if (scenario.steps.some((s) => s.kind === "capture")) {
    return end("SKIP", { reason: "asks for a capture — that is a reel: runtime_scene_reel" });
  }

  // A medium resolves beside the .feature file first, then in the project — the rule the
  // reel uses for a medium named mid-run, applied to the one it starts from as well.
  const resolveMedium = (named: string): string => {
    if (isAbsolute(named)) return named;
    const beside = resolve(dirname(file), named);
    return existsSync(beside) ? beside : resolve(projectDir, named);
  };
  const mediaPath = scenario.origin.kind === "medium" ? resolveMedium(scenario.origin.path) : undefined;
  if (mediaPath && !existsSync(mediaPath)) return end("ERROR", { reason: `no such medium: ${mediaPath}` });

  const { projectMachineModel } = await import("../project-knowledge/machine-model.js");
  const model = scenario.model ?? projectMachineModel(projectDir);
  const checks = scenario.criteria.flatMap((c) =>
    c.check ? [{ check: c.check, afterSteps: c.afterSteps ?? scenario.steps.length, text: c.text, line: c.line }] : []);

  try {
    const { runSandbox } = await import("../reel/run-sandbox.js");
    const run = await runSandbox({
      // No projectDir: that is where the DAEMON keeps its scratch, and a scenario run must
      // not leave its copy-on-write media in the project it is testing.
      budgetMs: 600_000,
      model,
      mediaPath,
      steps: scenario.steps,
      checks,
      screen: false,
      resolveMedium,
    });
    const verdict: Verdict = run.checks.some((c) => !c.pass) ? "FAIL" : run.checks.length ? "PASS" : "UNCHECKED";
    // Spec 889 §4b — a PASS is the emulator's recorded yes for the bytes it ran: the C64
    // Ultimate backend takes only media that have one. Soft: never changes the verdict.
    let note: string | undefined;
    if (verdict === "PASS") {
      const { recordPassForRun } = await import("../runtime/emulator-pass.js");
      const rec = recordPassForRun({
        projectDir, mediaPath, steps: scenario.steps, resolveMedium, scenario: scenario.name, checks: run.checks,
      });
      note = rec.note;
    }
    return end(verdict, { checks: run.checks, model: run.machine.model, ...(note ? { reason: note } : {}) });
  } catch (e) {
    return end("ERROR", { reason: e instanceof Error ? e.message : String(e), model });
  }
}

function printResult(r: ScenarioResult): void {
  const where = `${rel(r.file)}:${r.line}`;
  const tally = r.verdict === "PASS" || r.verdict === "FAIL" || r.verdict === "UNCHECKED"
    ? `  (${r.checks.length} checked, ${r.unchecked.length} unchecked, ${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  console.log(`${r.verdict.padEnd(9)} ${where}  ${r.scenario}${tally}`);
  if (r.reason) console.log(`          ${r.reason}`);
  for (const c of r.checks) {
    if (!c.pass) console.log(`          line ${c.line ?? "?"}: ${c.text} — got ${c.actual}`);
  }
  for (const u of r.unchecked) console.log(`          ? line ${u.line ?? "?"}: ${u.text}`);
}

function featureFiles(path: string): string[] {
  if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => {
      const p = join(path, d.name);
      if (d.isDirectory()) return featureFiles(p);
      return d.name.endsWith(".feature") ? [p] : [];
    });
}

/** The project a file belongs to — the same walk-up every tool uses — else the cwd. */
function projectFor(file: string): string {
  return findProjectRoot(dirname(file)) ?? process.cwd();
}

function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
}
