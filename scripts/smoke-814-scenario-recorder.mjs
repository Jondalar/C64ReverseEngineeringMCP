// Spec 814 — the recorder: play it once, get the file.
//
// The promise is a round trip, so that is what this gates: a journal the daemon
// stamped goes in, a `.feature` comes out, the PARSER reads it back, and the steps
// are the ones that happened. Eyeballing the text would pass on a file the executor
// cannot run — which is exactly the failure the "only emit what the parser accepts"
// rule exists to prevent.
//
// Run after build:mcp.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeature, stripTrailingComment, authorOfComment, decodeKeys, PAL_CYCLES_PER_FRAME }
  from "../dist/project-knowledge/scenario-gherkin.js";
import { STEP_KINDS, PREDICATE_KINDS } from "../dist/project-knowledge/scenario-gherkin.js";
import { VOCABULARY, completions, keyTokens, missingKinds } from "../dist/project-knowledge/scenario-vocabulary.js";
import { recordScenario, encodeKeys } from "../dist/reel/record-scenario.js";
import { runScenario } from "../dist/reel/run-scenario.js";

let pass = 0, fail = 0;
const ok = (cond, what, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`); }
};

const F = PAL_CYCLES_PER_FRAME;
const MEDIUM = { kind: "medium", path: "game.d64", why: "a medium is mounted" };

// ── §9.1b a trailing comment is not part of the line ─────────────────────────
ok(stripTrailingComment("  And I wait 5 frames   # by: llm").text === "  And I wait 5 frames",
   "1 a trailing comment is stripped off the step");
ok(stripTrailingComment('  And I type "LOAD{QUOTE}#1{QUOTE}"').comment === undefined,
   "2 a # INSIDE quotes is not a comment — it is a C64 command");
ok(authorOfComment("by: llm") === "llm" && authorOfComment("by: human") === "human",
   "3 the by-mark names its author");
ok(authorOfComment("targets: finding/f-1") === undefined, "4 and any other comment has no author");

// §10 — the mark is a comment, not a dialect: all three parse to the SAME step.
{
  const one = (line) => {
    const r = parseFeature(`Scenario: s\n  Given a bare machine\n  When ${line}\n  Then it works\n`);
    return { issues: r.issues, step: r.scenarios[0]?.steps[0] };
  };
  const bare = one("I wait 5 frames");
  const human = one("I wait 5 frames   # by: human");
  const llm = one("I wait 5 frames   # by: llm");
  ok(bare.issues.length === 0 && human.issues.length === 0 && llm.issues.length === 0,
     "5 a marked line parses", JSON.stringify(human.issues));
  ok(JSON.stringify(bare.step) === JSON.stringify(human.step) &&
     JSON.stringify(bare.step) === JSON.stringify(llm.step),
     "6 and parses to the identical step, mark or no mark");
}

// ── §9.1 the vocabulary is the parser's, not a second list ───────────────────
ok(missingKinds().length === 0,
   "7 the vocabulary covers every step and predicate kind the parser has", missingKinds().join(", "));
ok(STEP_KINDS.length === 6 && PREDICATE_KINDS.length === 7,
   "8 and the kind lists are the ones the TYPES are checked against");
{
  let bad = [];
  for (const v of VOCABULARY) {
    const src = v.section === "header" && !/^Scenario:/.test(v.sample)
      ? `${v.sample}\nScenario: s\n  Given a bare machine\n  When I wait 1 frames\n  Then it works\n`
      : v.section === "header"
      ? `${v.sample}\n  Given a bare machine\n  When I wait 1 frames\n  Then it works\n`
      : v.section === "given"
      ? `Scenario: s\n  Given a bare machine\n  ${v.sample.replace(/^Given /, "And ")}\n  When I wait 1 frames\n  Then it works\n`
      : v.section === "criterion"
      ? `Scenario: s\n  Given a bare machine\n  When I wait 1 frames\n  ${v.sample}\n`
      : `Scenario: s\n  Given a bare machine\n  ${v.sample}\n  Then it works\n`;
    const r = parseFeature(src);
    if (r.issues.length) bad.push(`${v.form} → ${r.issues[0].message}`);
  }
  ok(bad.length === 0, "9 every sample form in the vocabulary PARSES", bad[0]);
}
ok(completions().length === VOCABULARY.length, "10 the editor's completions come from that same table");
ok(keyTokens().includes("{RETURN}") && keyTokens().includes("{QUOTE}"),
   "11 and the key tokens come from the parser's own token table");
ok(decodeKeys("{RETURN}") === "\r" && decodeKeys("{NOPE}") === "{NOPE}",
   "12 an unknown token is left visible, never silently swallowed");

// ── §3 journal → steps, round trip through the parser ────────────────────────
{
  const journal = [
    { cycle: 0, kind: "key", source: "human", method: "session/type", detail: { text: 'LOAD"*",8,1\r' } },
    { cycle: 300 * F, kind: "insert", source: "human", method: "media/mount", detail: { path: "side2.d64" } },
    { cycle: 400 * F, kind: "joystick", source: "llm", method: "session/joystick_set", detail: { port: 2, down: true, fire: true } },
    { cycle: 403 * F, kind: "joystick", source: "llm", method: "session/joystick_clear", detail: {} },
  ];
  const r = recordScenario(journal, {
    name: "boot to the menu",
    armedAtCycle: 0,
    endCycle: 500 * F,
    origin: MEDIUM,
    anchors: [{ cycle: 280 * F, predicate: "the drive is idle" }],
    captures: [{ cycle: 450 * F, label: "title" }],
  });
  const parsed = parseFeature(r.text);
  ok(parsed.issues.length === 0, "13 the emitted file parses", JSON.stringify(parsed.issues[0] ?? ""));
  const s = parsed.scenarios[0];
  const kinds = s.steps.map((x) => x.kind).join(",");
  ok(s.origin.kind === "medium" && s.origin.path === "game.d64",
     "14 the Given comes from the session, so the file is self-contained");
  ok(s.steps.some((x) => x.kind === "type" && x.keys === 'LOAD"*",8,1\r'),
     "15 a typed line survives the round trip byte for byte", kinds);
  ok(s.steps.some((x) => x.kind === "insert" && x.path === "side2.d64"),
     "16 an insert is recorded as an insert");
  const held = s.steps.find((x) => x.kind === "joystick");
  ok(held && held.port === 2 && held.frames === 3 && held.directions.join("+") === "down+fire",
     "17 a press and its release become ONE hold with a duration",
     held ? `${held.port}/${held.frames}/${held.directions}` : "none");
  ok(s.steps.some((x) => x.kind === "capture" && x.label === "title"),
     "18 a shot taken during the recording becomes an I capture step");
  ok(s.steps.some((x) => x.kind === "waitUntil" && x.predicate.kind === "driveIdle"),
     "19 a gap with an observation in it is written as a STATE ANCHOR", kinds);
  ok(s.steps.some((x) => x.kind === "wait"),
     "20 and a gap with none is written as a plain wait", kinds);
  ok(/# by: human/.test(r.text) && /# by: llm/.test(r.text),
     "21 every step says who made it");
  ok(r.warnings.length === 0, "22 and nothing was lost", r.warnings[0]);

  // §5.4 — drop what the LLM did, and what is left still parses.
  const withoutLlm = r.text.split("\n")
    .filter((l) => authorOfComment(stripTrailingComment(l).comment) !== "llm")
    .join("\n");
  const after = parseFeature(withoutLlm);
  ok(after.issues.length === 0 && after.scenarios[0].steps.every((x) => x.kind !== "joystick"),
     "23 dropping the LLM's lines leaves a scenario that still parses",
     JSON.stringify(after.issues[0] ?? ""));

  // The recorder can also do it itself, and says what it left out.
  const onlyHuman = recordScenario(journal, {
    name: "mine", armedAtCycle: 0, endCycle: 500 * F, origin: MEDIUM, only: "human",
  });
  ok(parseFeature(onlyHuman.text).issues.length === 0 &&
     !/joystick/.test(onlyHuman.text) &&
     onlyHuman.warnings.some((w) => /LLM/.test(w)),
     "24 recording only one party's half is offered, and it warns that the replay may break");
}

// The anchor's timeout is not the measurement — a machine a little slower must
// still pass.
{
  const r = recordScenario(
    [{ cycle: 100 * F, kind: "key", source: "human", method: "session/type", detail: { text: "A" } }],
    { name: "t", armedAtCycle: 0, endCycle: 120 * F, origin: MEDIUM,
      anchors: [{ cycle: 60 * F, predicate: "the drive is idle" }] },
  );
  const w = parseFeature(r.text).scenarios[0].steps.find((x) => x.kind === "waitUntil");
  ok(w && w.timeoutFrames > 60, "25 an anchor's timeout has room in it, or a good day goes red",
     String(w?.timeoutFrames));
}

// A press still held at the end, and a clock that runs backwards (a mount
// power-cycles the machine) — both are said out loud rather than emitted as
// nonsense.
{
  const r = recordScenario(
    [{ cycle: 10 * F, kind: "joystick", source: "human", method: "session/joystick_set", detail: { port: 1, right: true } }],
    { name: "t", armedAtCycle: 0, endCycle: 30 * F, origin: MEDIUM },
  );
  ok(r.warnings.some((w) => /still held/.test(w)), "26 a press left held is reported", r.warnings[0]);
  const r2 = recordScenario(
    [
      { cycle: 100 * F, kind: "insert", source: "human", method: "media/mount", detail: { path: "a.d64" } },
      { cycle: 2 * F, kind: "key", source: "human", method: "session/type", detail: { text: "R" } },
    ],
    { name: "t", armedAtCycle: 0, endCycle: 20 * F, origin: MEDIUM },
  );
  ok(parseFeature(r2.text).issues.length === 0 && /power-cycled/.test(r2.text),
     "27 a clock that restarts mid-recording is noted, not emitted as a huge wait");
}

// A raw matrix key cannot be replayed as text, and the recorder says so instead of
// inventing a keyboard layout.
{
  const r = recordScenario(
    [{ cycle: F, kind: "key", source: "human", method: "session/key_down", detail: { key: "F7" } }],
    { name: "t", armedAtCycle: 0, endCycle: 5 * F, origin: MEDIUM },
  );
  ok(r.warnings.some((w) => /raw key press/.test(w)), "28 a raw key press is reported, not guessed at");
  ok(parseFeature(r.text).issues.length === 0, "29 and what it did emit still parses");
}

// An empty recording still produces a parseable file — with a warning, because a
// file that silently does nothing is worse than one that says it does nothing.
{
  const r = recordScenario([], { name: "t", armedAtCycle: 0, endCycle: 0, origin: MEDIUM });
  ok(parseFeature(r.text).issues.length === 0 && r.warnings.length === 1,
     "30 an empty recording is a parseable file that says it is empty");
}

ok(encodeKeys('LOAD"*"\r') === "LOAD{QUOTE}*{QUOTE}{RETURN}",
   "31 quotes and returns are written as tokens, so the line stays readable");
ok(decodeKeys(encodeKeys('LOAD"*",8,1\r')) === 'LOAD"*",8,1\r',
   "32 and encode/decode is a round trip");

// ── §10 the whole promise: a recording REPLAYS ───────────────────────────────
//
// Everything above is text. This is the part that matters: take a recorded
// journal, emit the scenario, and hand it to the executor 812 built. A bare
// machine, because a sample disk is not in this repo — the medium path is the same
// code with a different Given.
{
  const journal = [
    { cycle: 120 * F, kind: "key", source: "human", method: "session/type", detail: { text: 'PRINT"HI"\r' } },
  ];
  const r = recordScenario(journal, {
    name: "type into basic",
    armedAtCycle: 0,
    endCycle: 200 * F,
    origin: { kind: "bare", why: "nothing mounted" },
    captures: [{ cycle: 190 * F, label: "after" }],
  });
  // The recorder writes the Given it was told; the executor needs the machine to
  // have booted before it types, which is what the leading wait already is.
  const scenario = parseFeature(r.text).scenarios[0];
  ok(scenario.steps[0].kind === "wait", "33 the recording starts by waiting out the boot it recorded");
  const run = await runScenario(scenario, { budgetSeconds: 300 });
  ok(run.shots.length === 1 && run.shots[0].label === "after",
     "34 the recorded scenario RUNS and produces the capture it names",
     `${run.shots.length} shot(s)`);
  ok(run.shots[0].indices.length > 0 && run.width === 384 && run.height === 272,
     "35 and the picture is a real frame off the video chip",
     `${run.width}x${run.height}, ${run.shots[0].indices.length} bytes`);
}

// ── §6 saving ────────────────────────────────────────────────────────────────
//
// The overlay refuses a red parse, and so does the endpoint. Not distrust of the
// client: the file is what OTHER people will run, and the party that writes a file
// is the party that has to be sure of it.
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-814-"));
  const port = 4300 + Math.floor(Math.random() * 900);
  const srv = spawn(process.execPath, [
    "dist/workspace-ui/server.js", "--api-only", "--port", String(port), "--project", dir,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("server did not start")), 15000);
      srv.stdout.on("data", (b) => { if (/listening/.test(String(b))) { clearTimeout(t); res(); } });
      srv.on("exit", (c) => { clearTimeout(t); rej(new Error(`server exited ${c}`)); });
    });
    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/scenario/save`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };

    const good = "Scenario: s\n  Given a bare machine\n  When I wait 5 frames\n  Then it works\n";
    const okSave = await post({ name: "recorded-run", text: good });
    ok(okSave.status === 200 && /scenarios[/\\]recorded-run\.feature$/.test(okSave.body.path ?? ""),
       "36 a scenario that parses is saved under the project's scenarios/", JSON.stringify(okSave.body));
    ok(readFileSync(join(dir, "scenarios", "recorded-run.feature"), "utf8") === good,
       "37 and the bytes on disk are the bytes that were reviewed");

    const bad = await post({ name: "broken", text: "Scenario: s\n  Given a bare machine\n  When I fly to the moon\n" });
    ok(bad.status === 400 && /line 3/.test(bad.body.error ?? ""),
       "38 saving with a parse error is REFUSED, and the message names the line", bad.body.error);

    const escape = await post({ name: "../../etc/passwd", text: good });
    ok(escape.status === 200 && !/\.\./.test(escape.body.path ?? ""),
       "39 a name is a filename, so a save cannot climb out of the project", escape.body.path);
  } finally {
    srv.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${fail ? "RED" : "GREEN"} spec 814: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
