// One door for a .feature file: `c64re scenario run` and the MCP tool `runtime_feature_run` both call
// `runFeatures`, so the script and the LLM get the same answer from the same code.
//
// A scenario with no variant line runs on one private machine, as it always did. A scenario with variant
// lines runs the baseline (no fix) and every variant, each on a private machine of its own from the same
// origin with the same steps; the `Then` lines decide PASS/FAIL per run, and the memory the variant
// changed against the baseline is listed beside the verdict as what it did on the side. The run is kept
// as the project's candidate record.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { findProjectRoot } from "../project-root.js";
import { BASELINE, parseFeature, type Scenario, type VariantDecl } from "../project-knowledge/scenario-gherkin.js";
import type { SandboxCheckResult, SandboxPatch, SandboxRunResult, SeriesResult, MemoryRead } from "../reel/run-sandbox.js";
import type { InputRecord } from "../reel/input-offset.js";
import { formatInputs, formatSeries } from "../reel/probe-report.js";
import type { SweepResult } from "../reel/sweep.js";
import type { RunResult, SideEffect, VariantTarget } from "../candidates/store.js";

export type Verdict = "PASS" | "FAIL" | "UNCHECKED" | "SKIP" | "ERROR";

/** One machine's run inside a scenario that has variants. */
export interface RunReport {
  /** `baseline` or the variant's name. */
  readonly name: string;
  readonly verdict: Verdict;
  /** Why, for a FAIL on a wait and for ERROR. */
  readonly reason?: string;
  readonly checks: readonly SandboxCheckResult[];
  /** What differs from the baseline at the end of the run. Absent for the baseline and when nothing could be compared. */
  readonly sideEffects?: readonly SideEffect[];
  readonly sideEffectBytes?: number;
  readonly endCycle?: number;
  readonly pc?: number;
  readonly elapsedMs: number;
  /** In a test: what the baseline was required to do (`Then the baseline fails|passes`). Only on the baseline run. */
  readonly expected?: "fails" | "passes";
}

export interface ScenarioResult {
  readonly file: string;
  readonly line: number;
  readonly scenario: string;
  /** Without variants: this run's. With variants: PASS when a variant passed, ERROR when every run did, else FAIL. */
  readonly verdict: Verdict;
  /** Why, for SKIP and ERROR. */
  readonly reason?: string;
  readonly checks: readonly SandboxCheckResult[];
  /** The `Then` lines written in prose: reported, never judged. */
  readonly unchecked: readonly { line?: number; text: string }[];
  readonly model?: string;
  readonly elapsedMs: number;
  /** The offset every input step used, when an offset option was set. */
  readonly inputs?: readonly InputRecord[];
  /** `I read the series …` steps, as they came back. */
  readonly series?: readonly SeriesResult[];
  /** With sweep: one run per offset. */
  readonly sweep?: Omit<SweepResult, "runs"> & { readonly runs: readonly { offset: number; verdict: string; error?: string; checks: readonly SandboxCheckResult[] }[] };
  /** `I set the anchor` steps of this run. */
  readonly anchors?: readonly { name: string; file: string; cycle: number; pc: number }[];
  /** With variants: `test` when the scenario says what its baseline must do, else `trial` (a fix to choose between). */
  readonly mode?: "test" | "trial";
  /** With variants: the baseline first, then each variant in the order written. */
  readonly runs?: readonly RunReport[];
  /** With variants: the candidate record this run is kept in. */
  readonly candidate?: string;
  /** With variants: why no candidate record was kept, when none was. */
  readonly candidateNote?: string;
}

/** How input is placed in the frame, from the command line. */
export interface InputPlacement { inputOffsetCycles?: number; jitterSeed?: number; sweep?: number }

export interface FeatureRunOptions {
  /** Files or directories. */
  readonly paths?: readonly string[];
  /** Feature text passed inline; resolved against `project`. */
  readonly text?: string;
  /** Only scenarios whose name contains this. */
  readonly scenario?: string;
  /** The project media, fixes and anchors are looked up in (default: found by walking up from each file; a file in none resolves its names against the cwd and records nothing). */
  readonly project?: string;
  /** Machines at once (default min(4, CPUs)). */
  readonly jobs?: number;
  readonly placement?: InputPlacement;
  /** Replace an anchor that a `I set the anchor` step names and that already exists. */
  readonly replaceAnchors?: boolean;
  /** Called as each scenario completes (the command line prints from it). */
  readonly onResult?: (r: ScenarioResult) => void;
  /** Called for each line that did not parse. */
  readonly onParseError?: (message: string) => void;
}

export interface FeatureRun {
  readonly parseErrors: readonly string[];
  readonly results: readonly ScenarioResult[];
  /** 0: every scenario did what it should; 1: one did not; 2: a line did not parse, or every run failed to run. */
  readonly exitCode: 0 | 1 | 2;
}

const INLINE = "(inline)";

/** The most machines at once a command line starts by default — the limit a sandbox session is held to. */
export const DEFAULT_JOBS = 4;

export function defaultJobs(): number {
  return Math.max(1, Math.min(DEFAULT_JOBS, cpus().length));
}

// ── what a variant changes besides what it was meant to ──────────────────────────────────────────
/** RAM in two reads (a read is capped at 32 KiB), then the I/O area — which carries the colour RAM and the cartridge's I/O windows. */
const SIDE_READS: readonly MemoryRead[] = [
  { label: "ram-lo", addr: 0x0000, len: 0x8000, lens: "ram" },
  { label: "ram-hi", addr: 0x8000, len: 0x8000, lens: "ram" },
  { label: "io", addr: 0xd000, len: 0x1000, lens: "io" },
];

/**
 * I/O bytes left out of the comparison. The raster, the SID's read-backs, the CIA timers and clocks move by
 * themselves from run to run. The rest are the chips' mirrors (the VIC repeats its 64 registers through $D3FF, the
 * SID its 32 through $D7FF, a CIA its 16 through $xxFF): one change would be listed sixteen times.
 */
const VOLATILE_IO: readonly (readonly [number, number])[] = [
  [0xd011, 0xd012], [0xd41b, 0xd41c], [0xdc04, 0xdc0f], [0xdd04, 0xdd0f],
  [0xd040, 0xd3ff], [0xd420, 0xd7ff], [0xdc10, 0xdcff], [0xdd10, 0xddff],
];

function differing(a: Uint8Array, b: Uint8Array, base: number, space: SideEffect["space"], masked: readonly (readonly [number, number])[]): SideEffect[] {
  const out: SideEffect[] = [];
  const skip = (addr: number): boolean => masked.some(([lo, hi]) => addr >= lo && addr <= hi);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const addr = base + i;
    if (a[i] === b[i] || skip(addr)) continue;
    const last = out[out.length - 1];
    if (last && last.to === addr - 1) last.to = addr;
    else out.push({ space, from: addr, to: addr });
  }
  return out;
}

function sideEffectsOf(base: SandboxRunResult, run: SandboxRunResult, ownRam: readonly (readonly [number, number])[]): SideEffect[] | undefined {
  if (base.reads.length < SIDE_READS.length || run.reads.length < SIDE_READS.length) return undefined;
  const ram = (r: SandboxRunResult): Uint8Array => { const u = new Uint8Array(0x10000); u.set(r.reads[0].bytes, 0); u.set(r.reads[1].bytes, 0x8000); return u; };
  return [
    ...differing(ram(base), ram(run), 0, "ram", ownRam),
    ...differing(base.reads[2].bytes, run.reads[2].bytes, 0xd000, "io", VOLATILE_IO),
  ];
}

const h4 = (n: number): string => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;

export function describeSideEffects(list: readonly SideEffect[], most = 6): string {
  const parts = list.slice(0, most).map((e) => {
    const bytes = e.to - e.from + 1;
    return `${e.space === "io" ? "io " : ""}${e.from === e.to ? h4(e.from) : `${h4(e.from)}-${h4(e.to)}`}, ${bytes} byte${bytes === 1 ? "" : "s"}`;
  });
  const more = list.length - Math.min(list.length, most);
  return parts.join("; ") + (more > 0 ? `; and ${more} more place${more === 1 ? "" : "s"}` : "");
}

// ── files ─────────────────────────────────────────────────────────────────────────────────────────
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

/**
 * Where a file's relative names resolve and whether that place is a project. The project is the one the same walk-up every
 * tool uses finds; a file in none resolves its names against the cwd, and nothing is recorded anywhere — the cwd is a place
 * to read from, never a project to write into.
 */
function projectFor(file: string): { dir: string; inProject: boolean } {
  const root = findProjectRoot(dirname(file));
  return root ? { dir: root, inProject: true } : { dir: process.cwd(), inProject: false };
}

export function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
}

/** A path as the project keeps it: relative to the project and forward-slashed when it lies inside, else as given. */
function projectPath(projectDir: string, abs: string): string {
  const r = relative(projectDir, abs);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r.split("\\").join("/") : abs;
}

// ── one scenario, prepared ────────────────────────────────────────────────────────────────────────
interface Unit { readonly name: string; readonly patches?: readonly SandboxPatch[]; readonly ownRam: readonly (readonly [number, number])[] }

interface Prepared {
  readonly file: string;
  readonly scenario: Scenario;
  readonly projectDir: string;
  /** projectDir is a project (found or given), not just the cwd names resolve against. Only then is anything recorded into it. */
  readonly inProject: boolean;
  readonly startedAt: number;
  readonly resolveMedium: (named: string) => string;
  readonly mediaPath?: string;
  readonly model?: string;
  readonly checks: { check: SandboxCheckResult["check"]; afterSteps: number; text: string; line?: number }[];
  readonly unchecked: { line?: number; text: string }[];
  /** Present when the scenario has variants. */
  readonly variants?: { readonly candidateId: string; readonly list: { name: string; targets: VariantTarget[] }[]; readonly units: Unit[] };
  readonly cleanup: () => void;
  /** The feature text, when it was passed inline. */
  readonly inlineText?: string;
}

type Prep = { result: ScenarioResult } | { prep: Prepared };

async function prepare(file: string, text: string | undefined, scenario: Scenario, projectDir: string, inProject: boolean, reserved: Set<string>): Promise<Prep> {
  const startedAt = Date.now();
  const unchecked = scenario.criteria.filter((c) => !c.check).map((c) => ({ line: c.line, text: c.text }));
  const base = { file, line: scenario.line ?? 0, scenario: scenario.name, unchecked };
  const done = (verdict: Verdict, reason: string, extra: Partial<ScenarioResult> = {}): Prep =>
    ({ result: { ...base, verdict, reason, checks: [], elapsedMs: Date.now() - startedAt, ...extra } });
  const cleanups: (() => void)[] = [];
  const cleanup = (): void => { for (const c of cleanups.splice(0)) { try { c(); } catch { /* best effort */ } } };

  if (scenario.steps.some((s) => s.kind === "capture")) {
    return done("SKIP", "asks for a capture — that is a reel: runtime_scene_reel");
  }

  // A medium resolves beside the .feature file first, then in the project — the rule the reel uses for a
  // medium named mid-run, applied to the one it starts from as well. A fix does the same.
  const here = file === INLINE ? projectDir : dirname(file);
  const resolveMedium = (named: string): string => {
    if (isAbsolute(named)) return named;
    const beside = resolve(here, named);
    return existsSync(beside) ? beside : resolve(projectDir, named);
  };

  let mediaPath: string | undefined;
  if (scenario.origin.kind === "mark") {
    const { anchorFile, anchorFileRel } = await import("../anchors/file.js");
    const f = anchorFile(projectDir, scenario.origin.name);
    if (!existsSync(f)) {
      return done("SKIP", `starts from the mark "${scenario.origin.name}", which has no file (${anchorFileRel(scenario.origin.name)} is not in ${projectDir}) — an anchor set before anchors kept a file lives in the ring only. Set it again with runtime_anchor_set, or make it in a feature with \`And I set the anchor "${scenario.origin.name}"\`.`);
    }
    // The runtime lays the media an anchor carries out beside the file it opens. A copy of the file in
    // a folder of its own keeps that out of the project and keeps parallel machines off each other's disk.
    const dir = mkdtempSync(join(tmpdir(), "c64re-anchor-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mediaPath = join(dir, basename(f));
    copyFileSync(f, mediaPath);
  } else if (scenario.origin.kind === "medium") {
    mediaPath = resolveMedium(scenario.origin.path);
    if (!existsSync(mediaPath)) { cleanup(); return done("ERROR", `no such medium: ${mediaPath}`); }
  }

  const { projectMachineModel } = await import("../project-knowledge/machine-model.js");
  const model = scenario.model ?? projectMachineModel(projectDir);
  const checks = scenario.criteria.flatMap((c) =>
    c.check ? [{ check: c.check, afterSteps: c.afterSteps ?? scenario.steps.length, text: c.text, line: c.line }] : []);

  let variants: Prepared["variants"];
  if (scenario.variants.length > 0) {
    if (scenario.steps.some((s) => s.kind === "anchor")) {
      cleanup();
      return done("ERROR", "a scenario with variants cannot set an anchor: every machine would write the same file. Make the anchor in a scenario of its own, then start this one from it", { model });
    }
    try {
      variants = await assembleVariants(file, text, scenario, projectDir, here, cleanups, reserved);
    } catch (e) {
      cleanup();
      return done("ERROR", e instanceof Error ? e.message : String(e), { model });
    }
  }
  return {
    prep: {
      file, scenario, projectDir, inProject, startedAt, resolveMedium, mediaPath, model, checks, unchecked, variants, cleanup,
    },
  };
}

async function assembleVariants(
  file: string, _text: string | undefined, scenario: Scenario, projectDir: string, here: string, cleanups: (() => void)[], reserved: Set<string>,
): Promise<NonNullable<Prepared["variants"]>> {
  const { assembleTarget } = await import("../candidates/variant.js");
  const { findFeatureCandidate } = await import("../candidates/feature-record.js");
  const { listCandidates } = await import("../candidates/store.js");
  const known = findFeatureCandidate(projectDir, projectPath(projectDir, file === INLINE ? INLINE : file), scenario.name);
  // A new record takes the next number nobody has — and nobody in this run has either: two scenarios of one file
  // are prepared before either is saved.
  let candidateId = known?.id;
  if (!candidateId) {
    const used = new Set([...listCandidates(projectDir).map((c) => c.id), ...reserved]);
    for (let n = 1; ; n++) if (!used.has(`cand-${n}`)) { candidateId = `cand-${n}`; break; }
  }
  reserved.add(candidateId);
  const scratch = mkdtempSync(join(tmpdir(), "c64re-fix-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const list: { name: string; targets: VariantTarget[] }[] = [];
  for (const v of scenario.variants as readonly VariantDecl[]) {
    const targets: VariantTarget[] = [];
    for (const [i, t] of v.targets.entries()) {
      const beside = resolve(here, t.path);
      const source = isAbsolute(t.path) ? t.path : existsSync(beside) ? beside : resolve(projectDir, t.path);
      if (!existsSync(source)) throw new Error(`variant "${v.name}" (line ${t.line}): no such file: ${source}`);
      try {
        if (t.kind === "loads") {
          const { loadTarget } = await import("../candidates/variant.js");
          targets.push(loadTarget(projectDir, { addr: t.address, space: t.space, bank: t.bank, file: source }));
        } else {
          targets.push(await assembleTarget(projectDir, v.name, i, { addr: t.address!, space: t.space, bank: t.bank, source_path: source }, scratch));
        }
      } catch (e) {
        throw new Error(`variant "${v.name}" (line ${t.line}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    list.push({ name: v.name, targets });
  }
  const units: Unit[] = [{ name: BASELINE, patches: [], ownRam: [] }];
  for (const v of list) {
    units.push({
      name: v.name,
      patches: v.targets.map((t) => ({ space: t.space, ...(t.space === "ram" ? {} : { bank: t.bank ?? 0 }), addr: t.addr, bytes: t.bytes })),
      ownRam: v.targets.filter((t) => t.space === "ram").map((t) => [t.addr, Math.min(0xffff, t.addr + t.bytes.length - 1)] as const),
    });
  }
  return { candidateId, list, units };
}

// ── running ───────────────────────────────────────────────────────────────────────────────────────
type Raw = { run: SandboxRunResult } | { error: string };

function verdictOf(run: SandboxRunResult): { verdict: Verdict; reason?: string } {
  if (run.failedWait) return { verdict: "FAIL", reason: `wait until ${run.failedWait.what}: not within ${run.failedWait.frames} frames (${/PC now \$[0-9A-F]+/i.exec(run.failedWait.detail)?.[0] ?? "it did not happen"})` };
  const undecided = run.checks.find((c) => c.stopped);
  if (undecided) return { verdict: "ERROR", reason: undecided.actual };
  if (run.checks.some((c) => !c.pass)) return { verdict: "FAIL" };
  return { verdict: run.checks.length ? "PASS" : "UNCHECKED" };
}

async function sandboxOptions(p: Prepared, placement: InputPlacement, replaceAnchors: boolean, extra: Record<string, unknown> = {}) {
  const { anchorFile, ensureAnchorsDir } = await import("../anchors/file.js");
  let anchorScratch: string | undefined;
  return {
    // No projectDir: that is where the DAEMON keeps its scratch, and a scenario run must
    // not leave its copy-on-write media in the project it is testing.
    budgetMs: 600_000,
    model: p.model,
    mediaPath: p.mediaPath,
    startExactly: p.scenario.origin.kind === "mark",
    steps: p.scenario.steps,
    checks: p.checks,
    screen: false,
    resolveMedium: p.resolveMedium,
    anchors: {
      pathFor: (name: string) => {
        // No project: the anchor lives as long as this run, in a scratch directory — never in the cwd.
        if (!p.inProject && !anchorScratch) {
          const made = mkdtempSync(join(tmpdir(), "c64re-anchors-"));
          anchorScratch = made;
          process.once("exit", () => { try { rmSync(made, { recursive: true, force: true }); } catch { /* best effort */ } });
        }
        const home = p.inProject ? p.projectDir : anchorScratch!;
        ensureAnchorsDir(home);
        return anchorFile(home, name);
      },
      replace: replaceAnchors,
    },
    inputOffsetCycles: placement.inputOffsetCycles,
    jitterSeed: placement.jitterSeed,
    ...extra,
  };
}

async function runPlain(p: Prepared, placement: InputPlacement, replaceAnchors: boolean): Promise<ScenarioResult> {
  const base = { file: p.file, line: p.scenario.line ?? 0, scenario: p.scenario.name, unchecked: p.unchecked };
  const end = (verdict: Verdict, extra: Partial<ScenarioResult> = {}): ScenarioResult =>
    ({ ...base, verdict, checks: [], elapsedMs: Date.now() - p.startedAt, ...extra });
  try {
    const { runSandbox } = await import("../reel/run-sandbox.js");
    const options = await sandboxOptions(p, placement, replaceAnchors);

    // K runs, the input at K places in the frame; the scenario fails if any does.
    if (placement.sweep !== undefined) {
      const { runSweep } = await import("../reel/sweep.js");
      const w = await runSweep(options, placement.sweep, 2);
      const firstBad = w.runs.find((r) => r.verdict === "FAIL") ?? w.runs.find((r) => r.verdict === "ERROR");
      const verdict: Verdict = w.fail > 0 ? "FAIL" : w.error > 0 ? "ERROR" : "PASS";
      return end(verdict, {
        checks: firstBad?.checks ?? w.runs[0].checks, model: w.machine.model,
        sweep: { ...w, runs: w.runs.map((r) => ({ offset: r.offset, verdict: r.verdict, checks: r.checks, ...(r.error ? { error: r.error } : {}) })) },
        ...(w.error > 0 && w.fail === 0 ? { reason: `${w.error} offset(s) did not finish or were stopped: ${firstBad?.error ?? firstBad?.checks.find((c) => c.stopped)?.actual ?? "?"}` } : {}),
      });
    }

    const run = await runSandbox(options);
    const { verdict, reason } = verdictOf(run);
    // A PASS is the emulator's recorded yes for the bytes it ran: the C64 Ultimate backend takes only
    // media that have one. Soft: never changes the verdict. A run with the input moved off its usual
    // place is a probe, not the run of record.
    let note: string | undefined;
    if (verdict === "PASS" && placement.inputOffsetCycles === undefined && placement.jitterSeed === undefined) {
      const { recordPassForRun } = await import("../runtime/emulator-pass.js");
      const rec = !p.inProject ? { recorded: [], note: "no project: the green run was not recorded for the C64 Ultimate gate (give a project, or run inside one)" } : recordPassForRun({
        projectDir: p.projectDir, mediaPath: p.mediaPath, steps: p.scenario.steps, resolveMedium: p.resolveMedium, scenario: p.scenario.name, checks: run.checks,
      });
      note = rec.note;
    }
    const anchors = await afterAnchors(p, run);
    return end(verdict, {
      checks: run.checks, model: run.machine.model,
      ...(reason ? { reason } : note ? { reason: note } : {}),
      ...(run.inputs.length ? { inputs: run.inputs } : {}),
      ...(run.series.length ? { series: run.series } : {}),
      ...(anchors.length ? { anchors } : {}),
    });
  } catch (e) {
    return end("ERROR", { reason: e instanceof Error ? e.message : String(e), model: p.model });
  }
}

/** The anchors a run set are known to the project's graph from now on. */
async function afterAnchors(p: Prepared, run: SandboxRunResult): Promise<{ name: string; file: string; cycle: number; pc: number }[]> {
  if (run.anchorsSet.length === 0) return [];
  const { anchorFileRel } = await import("../anchors/file.js");
  const g = await import("../anchors/graph.js");
  const out = [];
  for (const a of run.anchorsSet) {
    const file = anchorFileRel(a.name);
    out.push({ name: a.name, file, cycle: a.cycle, pc: a.pc });
    if (p.inProject && g.projectHoldsGraph(p.projectDir)) {
      try {
        g.recordAnchor(p.projectDir, {
          name: a.name, cycle: a.cycle, frame: Math.floor(a.cycle / run.machine.cyclesPerFrame), file,
          why: `set by ${projectPath(p.projectDir, p.file)} (${p.scenario.name})`, setAt: new Date().toISOString(),
        });
      } catch { /* the file is the anchor; the node is the record of why */ }
    }
  }
  return out;
}

async function runUnit(p: Prepared, unit: Unit, placement: InputPlacement): Promise<Raw> {
  try {
    const { runSandbox } = await import("../reel/run-sandbox.js");
    const options = await sandboxOptions(p, placement, false, { patches: unit.patches, reads: SIDE_READS, waitTimeoutIsFailure: true });
    return { run: await runSandbox(options) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function finishVariants(p: Prepared, raws: Raw[]): Promise<ScenarioResult> {
  const v = p.variants!;
  const base = { file: p.file, line: p.scenario.line ?? 0, scenario: p.scenario.name, unchecked: p.unchecked };
  const baseline = raws[0];
  const reports: RunReport[] = v.units.map((u, i) => {
    const raw = raws[i];
    if ("error" in raw) return { name: u.name, verdict: "ERROR" as const, reason: raw.error, checks: [], elapsedMs: 0 };
    const { verdict, reason } = verdictOf(raw.run);
    const side = i > 0 && "run" in baseline ? sideEffectsOf(baseline.run, raw.run, u.ownRam) : undefined;
    return {
      name: u.name, verdict, ...(reason ? { reason } : {}), checks: raw.run.checks,
      ...(side ? { sideEffects: side, sideEffectBytes: side.reduce((n, e) => n + e.to - e.from + 1, 0) } : {}),
      endCycle: raw.run.endCycle, pc: raw.run.pc, elapsedMs: raw.run.elapsedMs,
    };
  });
  const variantReports = reports.slice(1);
  const firstRun = raws.find((r): r is { run: SandboxRunResult } => "run" in r);
  const expect = p.scenario.baselineExpect;
  if (expect) {
    // A test of a build: every variant must pass AND the baseline must do what the scenario says. Nothing here is a
    // choice between fixes, so no candidate is kept.
    const problems: string[] = [];
    let verdict: Verdict = "PASS";
    const worse = (v: Verdict): void => { if (verdict === "PASS" || (verdict === "FAIL" && v === "ERROR")) verdict = v; };
    const b = reports[0];
    if (b.verdict === "ERROR") {
      worse("ERROR");
      problems.push(`the baseline did not run: ${b.reason ?? "?"}`);
    } else if (expect === "fails" && b.verdict !== "FAIL") {
      worse("FAIL");
      problems.push(`baseline should fail but ${b.verdict === "PASS" ? "passed" : `came out ${b.verdict}`}: the start state already shows these facts, the test cannot see the change`);
    } else if (expect === "passes" && b.verdict !== "PASS") {
      worse("FAIL");
      problems.push(`baseline should pass but ${b.verdict === "FAIL" ? "failed" : `came out ${b.verdict}`}: the start state does not show these facts, so the change would not be what made them true or false`);
    }
    for (const r of variantReports) {
      if (r.verdict === "PASS") continue;
      worse(r.verdict === "ERROR" ? "ERROR" : "FAIL");
      const bad = r.checks.filter((c) => !c.pass);
      problems.push(`${r.name} ${r.verdict === "ERROR" ? "did not run" : "failed"}: ${r.reason ?? (bad.length ? bad.map((c) => `line ${c.line ?? "?"}: ${c.text} — ${c.stopped ? "" : "got "}${c.actual}`).join(" | ") : r.verdict === "UNCHECKED" ? "no check in the scenario decides anything" : "?")}`);
    }
    const shown = reports.map((r, i) => (i === 0 ? { ...r, expected: expect } : r));
    return {
      ...base, verdict, checks: [], model: firstRun?.run.machine.model ?? p.model, elapsedMs: Date.now() - p.startedAt,
      mode: "test", ...(problems.length ? { reason: problems.join("; ") } : {}), runs: shown,
    };
  }
  const verdict: Verdict = variantReports.some((r) => r.verdict === "PASS") ? "PASS"
    : reports.every((r) => r.verdict === "ERROR") ? "ERROR" : "FAIL";
  let candidate: string | undefined;
  let candidateNote: string | undefined;
  try {
    if (!p.inProject) throw new Error("no project to keep it in (give one, or run inside one)");
    const { recordFeatureRun } = await import("../candidates/feature-record.js");
    const rec = await recordFeatureRun(p.projectDir, {
      id: v.candidateId,
      feature: { path: p.file === INLINE ? INLINE : projectPath(p.projectDir, p.file), scenario: p.scenario.name, line: p.scenario.line ?? 0, ...(p.file === INLINE && p.inlineText ? { text: p.inlineText } : {}) },
      anchor: p.scenario.origin.kind === "mark" ? p.scenario.origin.name : "",
      variants: v.list,
      baseline: toRecord(reports[0]),
      results: Object.fromEntries(variantReports.map((r) => [r.name, toRecord(r)])),
    });
    candidate = rec.id;
    if (rec.note) candidateNote = rec.note;
  } catch (e) {
    candidateNote = `no candidate record kept: ${e instanceof Error ? e.message : String(e)}`;
  }
  return {
    ...base, verdict, checks: [], model: firstRun?.run.machine.model ?? p.model, elapsedMs: Date.now() - p.startedAt,
    mode: "trial", runs: reports, ...(candidate ? { candidate } : {}), ...(candidateNote ? { candidateNote } : {}),
  };
}

function toRecord(r: RunReport): RunResult {
  return {
    verdict: r.verdict === "SKIP" ? "ERROR" : r.verdict,
    ...(r.reason ? { reason: r.reason } : {}),
    checks: r.checks.map((c) => ({ ...(c.line === undefined ? {} : { line: c.line }), text: c.text, pass: c.pass, actual: c.actual })),
    ...(r.sideEffects ? { sideEffects: [...r.sideEffects] } : {}),
    ...(r.endCycle === undefined ? {} : { cycles: r.endCycle }),
    ...(r.pc === undefined ? {} : { pc: r.pc }),
    ranAt: new Date().toISOString(),
  };
}

// ── the door ──────────────────────────────────────────────────────────────────────────────────────
export function exitCodeOf(results: readonly ScenarioResult[], parseErrors: readonly string[]): 0 | 1 | 2 {
  if (parseErrors.length > 0) return 2;
  if (results.length > 0 && results.every((r) => r.verdict === "ERROR")) return 2;
  const fine = (r: ScenarioResult): boolean => r.verdict === "PASS" || r.verdict === "UNCHECKED" || r.verdict === "SKIP";
  return results.every(fine) ? 0 : 1;
}

export async function runFeatures(opts: FeatureRunOptions): Promise<FeatureRun> {
  const work: { file: string; text: string | undefined; scenario: Scenario; projectDir: string; inProject: boolean }[] = [];
  const parseErrors: string[] = [];
  const sources: { file: string; text: string; projectDir: string; inProject: boolean }[] = [];
  if (opts.text !== undefined) {
    sources.push({ file: INLINE, text: opts.text, projectDir: opts.project ? resolve(opts.project) : process.cwd(), inProject: !!opts.project });
  } else {
    const files = (opts.paths ?? []).flatMap((p) => featureFiles(resolve(p)));
    if (files.length === 0) throw new Error(`no .feature files under ${(opts.paths ?? []).join(", ")}`);
    for (const file of files) sources.push({ file, text: readFileSync(file, "utf8"), ...(opts.project ? { projectDir: resolve(opts.project), inProject: true } : (({ dir, inProject }) => ({ projectDir: dir, inProject }))(projectFor(file))) });
  }
  // A line that does not parse is reported and counts as a failure of the run — but the
  // scenarios around it that did parse still run: one bad line in one file of twenty-five
  // must not hide what the other twenty-four say.
  for (const s of sources) {
    const { scenarios, issues } = parseFeature(s.text, s.file === INLINE ? undefined : s.file);
    const where = s.file === INLINE ? INLINE : rel(s.file);
    for (const i of issues) { const m = `${where}:${i.line}: ${i.message}`; parseErrors.push(m); opts.onParseError?.(m); }
    for (const scenario of scenarios) {
      if (opts.scenario && !scenario.name.toLowerCase().includes(opts.scenario.toLowerCase())) continue;
      work.push({ file: s.file, text: s.file === INLINE ? s.text : undefined, scenario, projectDir: s.projectDir, inProject: s.inProject });
    }
  }

  const placement = opts.placement ?? {};
  const replace = opts.replaceAnchors === true;
  const jobs = Math.max(1, Math.min(opts.jobs ?? defaultJobs(), cpus().length));
  const results: ScenarioResult[] = new Array(work.length);
  const emit = (i: number, r: ScenarioResult): void => { results[i] = r; opts.onResult?.(r); };

  // Prepare in order (assembling is quick and its failure is the scenario's), then run every machine of every
  // scenario through one pool.
  const tasks: (() => Promise<void>)[] = [];
  const reserved = new Set<string>();
  for (const [i, w] of work.entries()) {
    const prep = await prepare(w.file, w.text, w.scenario, w.projectDir, w.inProject, reserved);
    if ("result" in prep) { emit(i, prep.result); continue; }
    const p: Prepared = w.text === undefined ? prep.prep : { ...prep.prep, inlineText: w.text };
    if (!p.variants) {
      tasks.push(async () => {
        try {
          emit(i, await runPlain(p, placement, replace));
        } finally { p.cleanup(); }
      });
      continue;
    }
    if (placement.sweep !== undefined) {
      p.cleanup();
      emit(i, { file: p.file, line: p.scenario.line ?? 0, scenario: p.scenario.name, unchecked: p.unchecked, verdict: "ERROR", checks: [], elapsedMs: 0, reason: "a sweep and variants are two questions: sweep the input placement of the fix that passed, in a scenario of its own" });
      continue;
    }
    const raws: Raw[] = new Array(p.variants.units.length);
    let left = p.variants.units.length;
    for (const [k, unit] of p.variants.units.entries()) {
      tasks.push(async () => {
        raws[k] = await runUnit(p, unit, placement);
        if (--left === 0) {
          try { emit(i, await finishVariants(p, raws)); } finally { p.cleanup(); }
        }
      });
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = tasks[next++];
      if (!t) return;
      await t();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));

  return { parseErrors, results, exitCode: exitCodeOf(results, parseErrors) };
}

// ── reading the result ────────────────────────────────────────────────────────────────────────────
export function renderScenario(r: ScenarioResult): string[] {
  const where = `${rel(r.file)}:${r.line}`;
  const out: string[] = [];
  if (r.runs) {
    out.push(`${where}  ${r.scenario}`);
    const width = Math.max(...r.runs.map((x) => x.name.length));
    for (const x of r.runs) {
      const bad = x.checks.filter((c) => !c.pass);
      const detail = x.verdict === "PASS" || x.verdict === "UNCHECKED"
        ? `${x.checks.length} checked${x.sideEffects && x.sideEffects.length ? `  (also changed: ${describeSideEffects(x.sideEffects)})` : ""}`
        : x.reason ?? (bad.length ? bad.map((c) => `line ${c.line ?? "?"}: ${c.text} — ${c.stopped ? "" : "got "}${c.actual}`).join(" | ") : "");
      const want = x.expected ? ` (required to ${x.expected === "fails" ? "fail" : "pass"})` : "";
      out.push(`${x.verdict.padEnd(5)} ${x.name.padEnd(width)}  ${detail}${want}`.trimEnd());
      if (x.verdict === "FAIL" && x.sideEffects && x.sideEffects.length) {
        out.push(`      (also changed: ${describeSideEffects(x.sideEffects)})`);
      }
    }
    if (r.mode === "test") out.push(`${r.verdict} ${r.verdict === "PASS" ? "test of the build" : r.reason ?? ""}`.trimEnd());
    if (r.candidate) out.push(`→ candidate ${r.candidate} (${where})`);
    if (r.candidateNote) out.push(`  ${r.candidateNote}`);
    for (const u of r.unchecked) out.push(`  ? line ${u.line ?? "?"}: ${u.text}`);
    return out;
  }
  const tally = r.verdict === "PASS" || r.verdict === "FAIL" || r.verdict === "UNCHECKED"
    ? `  (${r.checks.length} checked, ${r.unchecked.length} unchecked, ${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  out.push(`${r.verdict.padEnd(9)} ${where}  ${r.scenario}${tally}`);
  if (r.reason) out.push(`          ${r.reason}`);
  if (r.sweep) {
    for (const w of r.sweep.runs) {
      const bad = w.checks.filter((c) => !c.pass);
      out.push(
        `          offset ${String(w.offset).padEnd(6)} ${w.verdict}` +
        (w.error ? `  ${w.error}` : bad.map((c) => `\n            line ${c.line ?? "?"}: ${c.text} — ${c.stopped ? "" : "got "}${c.actual}`).join("")),
      );
    }
    if (r.sweep.firstFailing !== undefined) {
      out.push(`          first failing offset: ${r.sweep.firstFailing} (replay: --input-offset ${r.sweep.firstFailing})`);
    }
  } else {
    for (const c of r.checks) {
      if (!c.pass) out.push(`          line ${c.line ?? "?"}: ${c.text} — ${c.stopped ? "" : "got "}${c.actual}`);
    }
  }
  for (const i of formatInputs(r.inputs ?? [])) out.push(`          ${i}`);
  for (const s of r.series ?? []) for (const l of formatSeries(s)) out.push(`          ${l}`);
  for (const a of r.anchors ?? []) out.push(`          anchor "${a.name}" -> ${a.file} (cycle ${a.cycle}, PC ${h4(a.pc)})`);
  for (const u of r.unchecked) out.push(`          ? line ${u.line ?? "?"}: ${u.text}`);
  return out;
}

export function renderSummary(run: FeatureRun): string {
  const count = (v: Verdict): number => run.results.filter((r) => r.verdict === v).length;
  return `${run.results.length} scenario(s): ${count("PASS")} pass, ${count("FAIL")} fail, ` +
    `${count("UNCHECKED")} unchecked, ${count("SKIP")} skipped, ${count("ERROR")} error` +
    (run.parseErrors.length ? `; ${run.parseErrors.length} line(s) did not parse` : "");
}

/** The whole answer as text: what the command line prints, line for line. */
export function renderFeatureRun(run: FeatureRun): string {
  return [
    ...run.parseErrors.map((e) => `PARSE     ${e}`),
    ...run.results.flatMap((r) => renderScenario(r)),
    "",
    renderSummary(run),
  ].join("\n");
}

/** The answer as data: the same document the command line prints with --json. */
export function featureRunJson(run: FeatureRun): { parseErrors: readonly string[]; results: readonly ScenarioResult[]; exitCode: number } {
  return { parseErrors: run.parseErrors, results: run.results, exitCode: run.exitCode };
}

