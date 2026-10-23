// `c64re scenario run` — a project's .feature files, run and judged with no agent in the loop, so `make`
// and CI can call them.
//
// It is a door, not a second runner: `runFeatures` (feature-run.ts) is the one function the MCP tool
// `runtime_feature_run` calls too, so the script and the LLM get the same answer. Every scenario goes
// through the same private-machine runner `runtime_sandbox_run` uses (a fresh daemon per machine, stopped
// between steps, so the same file gives the same bytes), and every `Then` is decided by that runner's one
// evaluator. What this file adds is only what a command line needs — arguments, the lines as they
// complete, and an exit code.

import {
  defaultJobs, featureRunJson, renderScenario, renderSummary, runFeatures, type InputPlacement,
} from "./feature-run.js";

const USAGE = [
  "c64re scenario run <file.feature|dir>… [--scenario <name>] [--json] [--project <dir>] [--jobs N] [--replace-anchors]",
  "",
  "  Runs every scenario on a fresh private machine and decides its Then lines.",
  "  One line per scenario: PASS, FAIL, UNCHECKED (no Then in the check notation yet),",
  "  SKIP (starts from a mark that has no file, or asks for a capture), ERROR (the run itself failed).",
  "  Exit 0 when every scenario did what it should, 1 when one did not, 2 when a line did not",
  "  parse or every run failed to run.",
  "",
  "  Starting point:   Given the mark \"before_lift\"   (the file runtime_anchor_set wrote, or",
  "                    a scenario made with: And I set the anchor \"before_lift\")",
  "                    Given the snapshot \"states/lift.c64re\"   (also: the disk / cart \"x\")",
  "  Fixes to try:     And variant \"fix1\" assembles \"fixes/fix1.tas\" at $0A20",
  "                    And variant \"fix2\" assembles \"fixes/fix2.tas\" at roml bank 3 $9100",
  "  Built bytes:      And variant \"build\" loads \"build/trainer.prg\"            (a PRG: its own address)",
  "                    And variant \"build\" loads \"build/trainer.prg\" at $0900   (placed elsewhere, header skipped)",
  "                    And variant \"build\" loads \"build/patch.bin\" at $47A5     (headerless: `at` is required)",
  "                    And variant \"build\" loads \"build/bank3.bin\" at roml bank 3 $8000",
  "  A scenario with variants runs the baseline (no fix) and each variant on a machine of its own;",
  "  the Then lines decide each one and the memory a variant changed besides is listed.",
  "",
  "  Two modes:",
  "    trial  (no baseline line) PASS when ANY variant passes; the run is kept as a candidate in the",
  "           project. For choosing between fixes. JSON \"mode\": \"trial\".",
  "    test   (a baseline line)  Then the baseline fails   (the start state must NOT show the facts)",
  "                              Then the baseline passes  (it must)",
  "           PASS only when EVERY variant passes all its Then lines AND the baseline does what the",
  "           line says; the report names the part that failed. No candidate is kept. JSON \"mode\": \"test\".",
  "           A test needs a variant (there is nothing to compare otherwise). Run the whole folder of",
  "           tests after every build.",
  "  Exit 0 when every scenario did what it should (in a trial: a variant passed).",
  "",
  "  Without `c64re` on PATH, from a checkout:   node <checkout>/dist/cli.js scenario run <dir>",
  "",
  "  Checks (the `I wait until` predicates, said as facts):",
  "    Then $8EF2 is $01                 Then $40 is $26 $40 $26 $40 $26 $55",
  "    Then $B0 is not $00               Then $8EF2 is one of $01, $02",
  "    Then $8EF2@ram is $01             (lens: cpu, ram, io, rom, cart)",
  "    Then the CPU is at $0812          Then the screen shows \"READY.\"",
  "  A Then is decided where it stands: after the steps written above it. One with a window",
  "  (below) is decided over those frames, and the machine ends where the window did.",
  "",
  "  --scenario <name>  only scenarios whose name contains this",
  "  --json             one JSON document on stdout",
  "  --project <dir>    where media and the machine model are looked up (default: found",
  "                     by walking up from each file, else the current directory)",
  "  --jobs N           machines at once (default: the CPU count, at most 4)",
  "  --replace-anchors  let `And I set the anchor` overwrite an anchor that already exists",
  "",
  "  Where in the frame the input lands (a runtime with cycle-exact input is needed):",
  "  --input-offset N   every input step presses N cycles past the point it would have",
  "  --jitter-seed S    every input step gets its own offset in the frame, from this seed",
  "  --sweep K          run each scenario K times, input spread evenly across one frame;",
  "                     one PASS/FAIL per offset and the first failing one to replay",
  "",
  "  Over a window of frames:",
  "    Then $D01C@io is $04 throughout the next 600 frames [at raster line 250]",
  "    And I read the series \"$D01C:1@io\", \"$D029@io\" every frame for 600 frames",
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
  const offsetArg = opt("--input-offset");
  const seedArg = opt("--jitter-seed");
  const sweepArg = opt("--sweep");
  const num = (name: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    if (!/^-?\d+$/.test(v)) throw new Error(`${name} needs a whole number, got "${v}"`);
    return Number(v);
  };
  const placement: InputPlacement = {
    inputOffsetCycles: num("--input-offset", offsetArg),
    jitterSeed: num("--jitter-seed", seedArg),
    sweep: num("--sweep", sweepArg),
  };
  const json = args.includes("--json");
  const replaceAnchors = args.includes("--replace-anchors");
  const paths = args.filter((a) => a !== "--json" && a !== "--replace-anchors");
  const unknown = paths.find((a) => a.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}`);
  if (paths.length === 0) throw new Error("no .feature file or directory given");
  const jobs = jobsArg === undefined ? defaultJobs() : Math.max(1, Number(jobsArg) || 1);

  const run = await runFeatures({
    paths, scenario: only, project: projectArg, jobs, placement, replaceAnchors,
    ...(json ? {} : {
      onParseError: (m: string) => console.log(`PARSE     ${m}`),
      onResult: (r) => { for (const l of renderScenario(r)) console.log(l); },
    }),
  });
  if (json) console.log(JSON.stringify(featureRunJson(run), null, 2));
  else console.log(`\n${renderSummary(run)}`);
  if (run.exitCode !== 0) process.exitCode = run.exitCode;
}
