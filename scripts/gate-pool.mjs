#!/usr/bin/env node
/**
 * scripts/gate-pool.mjs <steps.tsv> — the scheduler behind scripts/gate.sh.
 *
 * steps.tsv: one step per line, `name <TAB> mode <TAB> command`, in the workflow's order.
 * mode is `serial`, `parallel` or `runtime` (from the `# gate:` tag above the step in gates.yml).
 *
 *   1. the leading `serial` steps (install-free build, leak baseline) run one by one, in order;
 *   2. every `parallel` and `runtime` step runs in a worker pool of GATE_JOBS (default min(6, cpus));
 *      at most GATE_RUNTIME_JOBS (default 3) `runtime` steps at once;
 *   3. the remaining `serial` steps run one by one, in the workflow's order — the last step of the
 *      workflow (the leak check) stays last.
 *
 * Each step's output goes to its own log and is printed in one piece when the step ends, under a
 * header with its number and duration, so output of steps that ran side by side never interleaves
 * and nothing is truncated. The first failure stops new launches; steps already running finish; the
 * gate then names every step that failed. Exit 0 only when every step passed.
 *
 * A parallel/runtime step gets a TMPDIR and a C64RE_STATE_DIR of its own (its `processes/` is the
 * run's shared ledger, so the leak check still sees every process any step left), and
 * C64RE_GATE_STEP. Serial steps share the run's state dir, as before.
 */
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const file = process.argv[2];
const steps = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l, i) => {
    const [name, mode, ...cmd] = l.split("\t");
    return { n: i + 1, name, mode, cmd: cmd.join("\t") };
  });
const total = steps.length;
const JOBS = Math.max(1, Number(process.env.GATE_JOBS) || Math.min(6, cpus().length));
const RT_JOBS = Math.max(1, Number(process.env.GATE_RUNTIME_JOBS) || 3);
const RUN = process.env.GATE_RUN_DIR;
const SHARED_STATE = process.env.C64RE_STATE_DIR;
const logs = join(RUN, "logs");
mkdirSync(logs, { recursive: true });

const t0 = Date.now();
const results = []; // {n,name,sec,rc}
let failed = null;
const failures = [];
const out = (s) => process.stderr.write(s);

// GATE_WATCH=1 (serial profiling only): which repo files a step wrote and which TCP ports it
// listened on, written to <run>/watch.tsv. This is how a step is proved safe to tag `parallel`.
const WATCH = process.env.GATE_WATCH === "1";
const listeners = () => {
  const r = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  return new Set((r.stdout || "").split("\n").filter((l) => l.startsWith("n")).map((l) => l.replace(/^n.*:/, "")));
};
const changedSince = (marker) =>
  execFileSync("sh", ["-c", `find . \\( -path ./node_modules -o -path ./.git -o -path ./ui/node_modules -o -path ./.claude -o -path ./.gitnexus \\) -prune -o -type f -newer ${marker} -print | head -20`], { encoding: "utf8" })
    .split("\n").filter(Boolean);

function runStep(step) {
  return new Promise((done) => {
    const start = Date.now();
    let marker, seen, timer;
    if (WATCH) {
      marker = join(RUN, `marker-${step.n}`);
      writeFileSync(marker, "");
      seen = new Set();
      const base = listeners();
      timer = setInterval(() => { for (const p of listeners()) if (!base.has(p)) seen.add(p); }, 400);
    }
    const env = { ...process.env, C64RE_GATE_STEP: step.name };
    if (step.mode !== "serial") {
      const priv = join(RUN, "step", String(step.n));
      mkdirSync(join(priv, "tmp"), { recursive: true });
      mkdirSync(join(priv, "state"), { recursive: true });
      mkdirSync(join(SHARED_STATE, "processes"), { recursive: true });
      try { symlinkSync(join(SHARED_STATE, "processes"), join(priv, "state", "processes")); } catch {}
      env.TMPDIR = join(priv, "tmp");
      env.C64RE_STATE_DIR = join(priv, "state");
    }
    const log = join(logs, `${step.n}.log`);
    const ws = createWriteStream(log);
    const child = spawn("sh", ["-c", step.cmd], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(ws, { end: false });
    child.stderr.pipe(ws, { end: false });
    child.on("close", (rc, sig) => {
      ws.end(() => {
        const sec = (Date.now() - start) / 1000;
        if (WATCH) {
          clearInterval(timer);
          const files = changedSince(marker).filter((f) => !f.includes(RUN));
          writeFileSync(join(RUN, "watch.tsv"), `${step.n}\t${step.name}\t${[...seen].join(",")}\t${files.join(" ")}\n`, { flag: "a" });
        }
        const code = rc ?? 128;
        results.push({ n: step.n, name: step.name, sec, rc: code, mode: step.mode });
        const body = readFileSync(log, "utf8");
        out(`\n[${step.n}/${total}] ${step.name}  (${step.mode}, ${sec.toFixed(1)}s${code ? `, EXIT ${code}${sig ? " " + sig : ""}` : ""})\n`);
        out(body.endsWith("\n") || body === "" ? body : body + "\n");
        if (code !== 0) {
          failures.push(step);
          if (!failed) failed = step;
        }
        if (step.mode !== "serial") rmSync(join(RUN, "step", String(step.n), "tmp"), { recursive: true, force: true });
        done();
      });
    });
  });
}

async function serial(list) {
  for (const s of list) {
    if (failed) return;
    await runStep(s);
  }
}

async function pool(list) {
  const queue = [...list];
  let running = 0;
  let rtRunning = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (!failed && running < JOBS) {
        const i = queue.findIndex((s) => s.mode !== "runtime" || rtRunning < RT_JOBS);
        if (i < 0) break;
        const [s] = queue.splice(i, 1);
        running++;
        if (s.mode === "runtime") rtRunning++;
        runStep(s).then(() => {
          running--;
          if (s.mode === "runtime") rtRunning--;
          pump();
        });
      }
      if (running === 0 && (failed || queue.length === 0)) resolve();
    };
    pump();
  });
}

// A leading serial step is one before the first non-serial step; the workflow's last step stays last.
const firstPar = steps.findIndex((s) => s.mode !== "serial");
const head = firstPar < 0 ? steps : steps.slice(0, firstPar);
const rest = firstPar < 0 ? [] : steps.slice(firstPar);
let par = rest.filter((s) => s.mode !== "serial");
// Longest first, from the last run's timings (a step never seen before goes first): the pool then ends
// with the short steps instead of waiting on one long one that started late.
const prev = new Map();
try {
  for (const l of readFileSync(process.env.GATE_TIMINGS_IN ?? "", "utf8").split("\n").filter(Boolean)) {
    const [, sec, , , name] = l.split("\t");
    prev.set(name, Number(sec));
  }
} catch {}
par = par.map((s, i) => ({ s, i })).sort((a, b) => (prev.get(b.s.name) ?? 1e9) - (prev.get(a.s.name) ?? 1e9) || a.i - b.i).map((x) => x.s);
const tail = rest.filter((s) => s.mode === "serial");

out(`\n=== gate pool: ${head.length} leading serial, ${par.length} in the pool (${JOBS} workers, ${RT_JOBS} for runtime), ${tail.length} trailing serial ===\n`);
await serial(head);
if (!failed) await pool(par);
if (!failed) await serial(tail);

const elapsed = Math.round((Date.now() - t0) / 1000);
const slow = [...results].sort((a, b) => b.sec - a.sec).slice(0, 10);
out(`\n--- ${results.length}/${total} steps ran, ${elapsed}s wall, ${Math.round(results.reduce((a, r) => a + r.sec, 0))}s of step time; slowest:\n`);
for (const r of slow) out(`    ${r.sec.toFixed(1).padStart(6)}s  [${r.n}] ${r.name}  (${r.mode})\n`);
writeFileSync(join(RUN, "timings.tsv"), results.sort((a, b) => a.n - b.n).map((r) => [r.n, r.sec.toFixed(2), r.rc, r.mode, r.name].join("\t")).join("\n") + "\n");

if (failed) {
  out(`\n=== gate RED at step ${failed.n}/${total} after ${elapsed}s ===\n`);
  for (const f of failures) out(`    [${f.n}] ${f.name}\n        re-run it alone:  ${f.cmd}\n`);
  out("\n");
  process.exit(1);
}
