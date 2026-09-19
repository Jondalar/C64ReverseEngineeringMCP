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
import { parseFeature, parseStep, holdIssues, stripTrailingComment, authorOfComment, decodeKeys }
  from "../dist/project-knowledge/scenario-gherkin.js";
import { STEP_KINDS, PREDICATE_KINDS } from "../dist/project-knowledge/scenario-gherkin.js";
import { VOCABULARY, completions, keyTokens, missingKinds } from "../dist/project-knowledge/scenario-vocabulary.js";
import { recordScenario, encodeKeys } from "../dist/reel/record-scenario.js";
import { runScenario } from "../dist/reel/run-scenario.js";
import { runSandbox } from "../dist/reel/run-sandbox.js";
import { SandboxSession } from "../dist/reel/sandbox-session.js";

let pass = 0, fail = 0;
const ok = (cond, what, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`); }
};

// The c64-pal frame, as a fixture: the recorder is handed the recorded machine's frame
// length (Spec 863) — here the PAL one, 312 × 63. The NTSC case is at the end.
const F = 19656;
const PAL = { model: "c64-pal", cyclesPerFrame: F };
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
ok(STEP_KINDS.length === 12 && PREDICATE_KINDS.length === 7,
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
  const r = recordScenario(journal, { ...PAL,
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
  const onlyHuman = recordScenario(journal, { ...PAL,
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
    { ...PAL, name: "t", armedAtCycle: 0, endCycle: 120 * F, origin: MEDIUM,
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
    { ...PAL, name: "t", armedAtCycle: 0, endCycle: 30 * F, origin: MEDIUM },
  );
  ok(r.warnings.some((w) => /still held/.test(w)), "26 a press left held is reported", r.warnings[0]);
  const r2 = recordScenario(
    [
      { cycle: 100 * F, kind: "insert", source: "human", method: "media/mount", detail: { path: "a.d64" } },
      { cycle: 2 * F, kind: "key", source: "human", method: "session/type", detail: { text: "R" } },
    ],
    { ...PAL, name: "t", armedAtCycle: 0, endCycle: 20 * F, origin: MEDIUM },
  );
  ok(parseFeature(r2.text).issues.length === 0 && /power-cycled/.test(r2.text),
     "27 a clock that restarts mid-recording is noted, not emitted as a huge wait");
  // A press is written when it is let go — after anything that happened while it was
  // held. That must not read as the clock running backwards.
  const r3 = recordScenario(
    [
      { cycle: 10 * F, kind: "joystick", source: "human", method: "session/joystick_set", detail: { port: 2, fire: true } },
      { cycle: 12 * F, kind: "key", source: "human", method: "session/type", detail: { text: "A" } },
      { cycle: 15 * F, kind: "joystick", source: "human", method: "session/joystick_clear", detail: { port: 2 } },
    ],
    { ...PAL, name: "t", armedAtCycle: 0, endCycle: 20 * F, origin: MEDIUM },
  );
  const order = parseFeature(r3.text).scenarios[0].steps.filter((x) => x.kind !== "wait").map((x) => x.kind).join(",");
  ok(!/power-cycled/.test(r3.text) && order === "joystickDown,type,joystickUp",
     "27b an input made while a press is held lands INSIDE it, and is not a power-cycle", order);
}

// A key pressed on the matrix is a HELD key with a duration — which is what a title
// that scans the keyboard itself needs, and what `I type` cannot express.
{
  const r = recordScenario(
    [
      { cycle: 10 * F, kind: "key", source: "human", method: "session/key_down", detail: { key: "SPACE" } },
      { cycle: 10 * F, kind: "key", source: "human", method: "session/key_down", detail: { key: "SPACE" } },
      { cycle: 14 * F, kind: "key", source: "human", method: "session/key_up", detail: { key: "SPACE" } },
      { cycle: 20 * F, kind: "key", source: "human", method: "session/key_down", detail: { key: "L" } },
      { cycle: 23 * F, kind: "key", source: "human", method: "session/release_keys", detail: {} },
    ],
    { ...PAL, name: "t", armedAtCycle: 0, endCycle: 30 * F, origin: MEDIUM },
  );
  const st = parseFeature(r.text).scenarios[0].steps.filter((x) => x.kind === "key");
  ok(st.length === 2, "28 a key press is recorded as a step, with the key that was pressed",
     r.text.split("\n").filter((l) => /hold the key/.test(l)).join(" | "));
  ok(st[0].keys[0] === "SPACE" && st[0].frames === 4,
     "29 held for exactly as long as it was held", st[0] && `${st[0].keys}/${st[0].frames}`);
  ok(st[1].keys[0] === "L" && st[1].frames === 3,
     "29b release_keys closes an open key too", st[1] && `${st[1].keys}/${st[1].frames}`);
  ok(r.warnings.length === 0, "29c and nothing is dropped or warned about", r.warnings[0]);
}
{
  // The host keyboard repeating is not a second press.
  const r = recordScenario(
    [
      { cycle: 5 * F, kind: "key", source: "human", method: "session/key_down", detail: { key: "J" } },
    ],
    { ...PAL, name: "t", armedAtCycle: 0, endCycle: 9 * F, origin: MEDIUM },
  );
  const st = parseFeature(r.text).scenarios[0].steps.filter((x) => x.kind === "key");
  ok(st.length === 1 && st[0].frames >= 1,
     "29d a key still down at the end becomes a real press, not a lost one");
  ok(r.warnings.some((w) => /still held/.test(w)), "29e and it says the end was not measured");
}
// A name that is not a C64 key is a parse error, not a silent no-press.
{
  const bad = parseFeature('Scenario: s\n  Given a bare machine\n  When I hold the key "ESCAPE" for 2 frames\n  Then it works\n');
  ok(bad.issues.some((i) => /ESCAPE is not a C64 key/.test(i.message)),
     "29f a key name that does not exist is caught by the parser", bad.issues[0]?.message?.slice(0, 40));
}
// And a .crt reads like a cart.
{
  const r = recordScenario([], { ...PAL,
    name: "t", armedAtCycle: 0, endCycle: F,
    origin: { kind: "medium", path: "brubaker.crt", why: "mounted" },
  });
  ok(/Given the cart "brubaker\.crt"/.test(r.text), "29g a cartridge is called a cart, not a disk");
}

// An empty recording still produces a parseable file — with a warning, because a
// file that silently does nothing is worse than one that says it does nothing.
{
  const r = recordScenario([], { ...PAL, name: "t", armedAtCycle: 0, endCycle: 0, origin: MEDIUM });
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
    // A HELD key, the thing that used to be dropped with a warning. On a bare machine
    // the KERNAL echoes it, so whether it arrived is visible on the screen.
    { cycle: 150 * F, kind: "key", source: "human", method: "session/key_down", detail: { key: "J" } },
    { cycle: 154 * F, kind: "key", source: "human", method: "session/key_up", detail: { key: "J" } },
  ];
  const r = recordScenario(journal, { ...PAL,
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

  // The held key ARRIVED. This is the check that matters: a step nobody can see the
  // effect of is a step that may quietly do nothing.
  const held = scenario.steps.find((x) => x.kind === "key");
  ok(held && held.keys[0] === "J" && held.frames === 4,
     "35b the held key survived the round trip with its duration", held && `${held.keys}/${held.frames}`);
  // Does the key actually ARRIVE? Nothing on a booted C64 screen contains a J, so
  // waiting for one after the hold is a direct test: if the press never reached the
  // matrix, this predicate times out and the run throws. A step whose effect nobody
  // checks is a step that may quietly do nothing.
  const withCheck = parseFeature(
    r.text.replace(
      /^(\s*)(And I capture "after")/m,
      '$1And I wait until the screen shows "J" within 200 frames\n$1$2',
    ),
  ).scenarios[0];
  let arrived = true, why = "";
  try { await runScenario(withCheck, { budgetSeconds: 300 }); }
  catch (e) { arrived = false; why = String(e && e.message).slice(0, 80); }
  ok(arrived, "35c and the held key REACHED the machine — the screen shows it", why);
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

// ── Spec 863 — a recording is timed in ITS machine's frames, and says which machine ──
{
  const N = 17095; // the c64-ntsc frame, 263 × 65
  const r = recordScenario(
    [
      { cycle: 100 * N, kind: "joystick", source: "human", method: "session/joystick_set", detail: { port: 2, fire: true } },
      { cycle: 103 * N, kind: "joystick", source: "human", method: "session/joystick_clear", detail: { port: 2 } },
    ],
    { model: "c64-ntsc", cyclesPerFrame: N, name: "ntsc", armedAtCycle: 0, endCycle: 150 * N, origin: MEDIUM },
  );
  const s = parseFeature(r.text).scenarios[0];
  ok(/# model: c64-ntsc/.test(r.text) && s?.model === "c64-ntsc",
     "40 the recording names the model it was made on, and the parser reads it back", s?.model);
  ok(/I wait 100 frames/.test(r.text) && /for 3 frames/.test(r.text),
     "41 its cycles become frames at the recorded machine's frame length (17095 on NTSC)");
  const w = s?.steps.find((x) => x.kind === "wait");
  ok(w && w.unit === "frames" && w.count === 100, "42 a wait keeps its unit — frames of whichever machine runs it", JSON.stringify(w));
  let threw = false;
  try { recordScenario([], { name: "t", armedAtCycle: 0, endCycle: 0, origin: MEDIUM, model: "c64-pal" }); } catch { threw = true; }
  ok(threw, "43 without a frame length the recorder refuses rather than assume one");
}

// ── a hold, and an input made WHILE something is held ───────────────────────
//
// Two things a replay has to get right about a press. A `hold … for N frames` runs the
// machine for its N frames, so the wait written after it is the recorded gap MINUS the
// hold — counted from where it began, every later input lands late by the hold's length.
// And a key pressed while the stick is held cannot be said as two `hold … for` steps at
// all: the first one runs its whole duration before the second can start. So a press
// something happens inside is written in two halves, `I start holding …` … `I release …`.

/** Where each input lands in a replay, in frames from the start: waits and holds move
 *  the clock, everything else happens where the clock is. */
const schedule = (steps) => {
  let t = 0;
  const out = [];
  for (const x of steps) {
    if (x.kind === "wait") t += x.count;
    else if (x.kind === "key" || x.kind === "joystick") { out.push(`${x.kind}Down@${t}`); t += x.frames; out.push(`${x.kind}Up@${t}`); }
    else if (x.kind === "waitUntil") throw new Error("schedule(): no anchors here");
    else out.push(`${x.kind}@${t}`);
  }
  return out.join(" ");
};
const joy = (cycle, port, dirs, source = "human") => ({
  cycle, kind: "joystick", source, method: dirs ? "session/joystick_set" : "session/joystick_clear",
  detail: dirs ? { port, ...Object.fromEntries(dirs.map((d) => [d, true])) } : { port },
});
const keyEv = (cycle, key, up, source = "human") => ({
  cycle, kind: "key", source, method: up ? "session/key_up" : "session/key_down", detail: { key },
});
const BARE = { kind: "bare", why: "the smoke" };
{
  // (a) a hold, then a key after a gap.
  const r = recordScenario(
    [joy(10 * F, 2, ["fire"]), joy(13 * F, 2), keyEv(20 * F, "J"), keyEv(22 * F, "J", true)],
    { ...PAL, name: "a", armedAtCycle: 0, endCycle: 30 * F, origin: BARE, captures: [{ cycle: 30 * F, label: "end" }] },
  );
  const sc = parseFeature(r.text).scenarios[0];
  ok(/I hold joystick 2 fire for 3 frames[^\n]*\n\s+And I wait 7 frames\n\s+And I hold the key "J" for 2 frames/.test(r.text),
     "44 the wait after a hold is the recorded gap MINUS the hold (10 frames apart, 3 held → wait 7)",
     r.text.split("\n").filter((l) => /wait|hold/.test(l)).map((l) => l.trim().replace(/\s+#.*/, "")).join(" | "));
  const got = schedule(sc.steps);
  ok(got === "joystickDown@10 joystickUp@13 keyDown@20 keyUp@22 capture@30",
     "45 so the replay puts every input on the frame it was recorded on — not a hold's length late", got);
}
{
  // (b) a key pressed while a joystick direction is held.
  const r = recordScenario(
    [joy(30 * F, 2, ["right"]), keyEv(32 * F, "K", false, "llm"), keyEv(34 * F, "K", true, "llm"), joy(38 * F, 2)],
    { ...PAL, name: "b", armedAtCycle: 0, endCycle: 40 * F, origin: BARE, captures: [{ cycle: 40 * F, label: "end" }] },
  );
  const sc = parseFeature(r.text).scenarios[0];
  const kinds = sc.steps.filter((x) => x.kind !== "wait").map((x) => x.kind).join(",");
  ok(kinds === "joystickDown,key,joystickUp,capture" &&
     /I start holding joystick 2 right/.test(r.text) && /I release joystick 2/.test(r.text) && /I hold the key "K" for 2 frames/.test(r.text),
     "46 a key pressed while the stick is held: the stick is written in two halves, the key inside keeps its duration", kinds);
  ok(schedule(sc.steps) === "joystickDown@30 keyDown@32 keyUp@34 joystickUp@38 capture@40",
     "47 and every input replays on its recorded frame", schedule(sc.steps));
  ok(r.warnings.length === 0 && parseFeature(r.text).issues.length === 0, "48 nothing warned, nothing the parser rejects", r.warnings[0]);
  // The two halves carry the PRESS's mark — the LLM held the stick, the human let go — so
  // dropping one party's lines never leaves half a press behind.
  const mixed = recordScenario(
    [joy(30 * F, 2, ["right"], "llm"), keyEv(32 * F, "K"), keyEv(34 * F, "K", true), joy(38 * F, 2, undefined, "human")],
    { ...PAL, name: "m", armedAtCycle: 0, endCycle: 40 * F, origin: BARE },
  );
  const noLlm = parseFeature(mixed.text.split("\n").filter((l) => authorOfComment(stripTrailingComment(l).comment) !== "llm").join("\n"));
  ok(noLlm.issues.length === 0 && noLlm.scenarios[0].steps.some((x) => x.kind === "key") && !noLlm.scenarios[0].steps.some((x) => /^joystick/.test(x.kind)),
     "48b dropping the LLM's lines drops both halves of its press, and what is left parses", JSON.stringify(noLlm.issues[0] ?? ""));
}
{
  // Two presses that cross each other both need their ends on lines of their own.
  const r = recordScenario(
    [keyEv(5 * F, "A"), joy(7 * F, 1, ["up"]), keyEv(9 * F, "A", true), joy(12 * F, 1)],
    { ...PAL, name: "x", armedAtCycle: 0, endCycle: 14 * F, origin: BARE },
  );
  const sc = parseFeature(r.text).scenarios[0];
  ok(schedule(sc.steps) === "keyDown@5 joystickDown@7 keyUp@9 joystickUp@12",
     "49 two presses that cross are both written in halves, each end where it was", schedule(sc.steps));
  // A single tap stays the simple form.
  const tap = recordScenario([joy(5 * F, 2, ["fire"]), joy(8 * F, 2)], { ...PAL, name: "t", armedAtCycle: 0, endCycle: 9 * F, origin: BARE });
  ok(/I hold joystick 2 fire for 3 frames/.test(tap.text) && !/start holding/.test(tap.text),
     "50 a press nothing happens inside stays `hold … for N frames`");
  // Still down at the stop, with something after it: released where the recording stopped.
  const held = recordScenario([joy(5 * F, 2, ["left"]), { cycle: 8 * F, kind: "key", source: "human", method: "session/type", detail: { text: "X" } }],
    { ...PAL, name: "h", armedAtCycle: 0, endCycle: 20 * F, origin: BARE });
  const hs = parseFeature(held.text).scenarios[0];
  ok(schedule(hs.steps) === "joystickDown@5 type@8 joystickUp@20" && held.warnings.some((w) => /still held/.test(w)),
     "51 a press still down at the stop with an input inside it is released where the recording stopped, and said", schedule(hs.steps));
  // A hold whose rounded length reaches past the next input writes no negative wait.
  const tight = recordScenario([joy(10 * F, 2, ["fire"]), joy(Math.round(12.6 * F), 2), keyEv(Math.round(12.8 * F), "J"), keyEv(15 * F, "J", true)],
    { ...PAL, name: "n", armedAtCycle: 0, endCycle: 16 * F, origin: BARE });
  const ts = parseFeature(tight.text);
  ok(ts.issues.length === 0 && /fire for 3 frames\s+# by: human\n\s+And I hold the key "J"/.test(tight.text),
     "52 a gap shorter than the rounded hold is no wait at all — never a negative one", tight.text.split("\n").filter((l) => /hold|wait/.test(l)).map((l) => l.trim().replace(/\s+#.*/, "")).join(" | "));
}

// Rounding to whole frames is made good by the next wait, never added up: every gap is
// written from where the REPLAY is.
{
  const typed = (cycle, text) => ({ cycle, kind: "key", source: "human", method: "session/type", detail: { text } });
  const at = [10.4, 20.8, 31.2, 41.6, 52].map((x) => Math.round(x * F));
  const r = recordScenario(at.map((c, i) => typed(c, String(i))), { ...PAL, name: "r", armedAtCycle: 0, endCycle: 60 * F, origin: BARE });
  const got = schedule(parseFeature(r.text).scenarios[0].steps);
  ok(got === "type@10 type@21 type@31 type@42 type@52",
     "53 inputs off the frame grid each land on their NEAREST frame (10.4, 20.8, 31.2, 41.6, 52 → 10, 21, 31, 42, 52) — no drift", got);
}
// A switch waits for the next raster wrap, and a machine on raster line 0 is already at
// one. A rounded-down wait that would end in a frame's first lines ends half a frame
// before the switch instead.
{
  const N = 17095;
  const S = 18 * F - 2; // the switch lands 8 frames less 2 cycles after the input before it
  const r = recordScenario(
    [{ cycle: 10 * F, kind: "key", source: "human", method: "session/type", detail: { text: "A" } },
     { cycle: S, kind: "model", source: "human", method: "session/model", detail: { name: "c64-ntsc", from: "c64-pal" } }],
    { ...PAL, cyclesPerFrameOf: { "c64-ntsc": N }, name: "s", armedAtCycle: 0, endCycle: S + 10 * N, origin: BARE },
  );
  const steps = parseFeature(r.text).scenarios[0].steps;
  const sw = steps.findIndex((x) => x.kind === "model");
  const waits = steps.slice(steps.findIndex((x) => x.kind === "type") + 1, sw).filter((x) => x.kind === "wait");
  const before = waits.map((x) => `${x.count} ${x.unit}`).join(" + ");
  const reached = 10 * F + waits.reduce((t, x) => t + (x.unit === "frames" ? x.count * F : x.count), 0);
  ok(reached === S - Math.floor(F / 2) && waits.some((x) => x.unit === "cycles"),
     "54 the wait before a switch that would end on a frame's first raster line ends half a frame before it, in frames and cycles", before);
  const e = recordScenario(
    [{ cycle: 10 * F, kind: "key", source: "human", method: "session/type", detail: { text: "A" } },
     { cycle: 18 * F + 9000, kind: "model", source: "human", method: "session/model", detail: { name: "c64-ntsc", from: "c64-pal" } }],
    { ...PAL, cyclesPerFrameOf: { "c64-ntsc": N }, name: "s", armedAtCycle: 0, endCycle: 18 * F + 9000 + 10 * N, origin: BARE },
  );
  ok(/I wait 8 frames\s*\n\s+And the machine switches to c64-ntsc/.test(e.text) && !/cycles/.test(e.text),
     "55 and where rounding down lands well inside the frame, it stays plain frames");
}

// The notation: the two halves, and a start is never a press without an end.
{
  const st = (l) => parseStep(l)?.step;
  const jd = st("I start holding joystick 2 down and fire");
  ok(jd?.kind === "joystickDown" && jd.port === 2 && jd.directions.join("+") === "down+fire", "56 `I start holding joystick 2 down and fire`", JSON.stringify(jd));
  ok(st("I release joystick 1")?.kind === "joystickUp" && st("I release joystick 1").port === 1, "57 `I release joystick 1`");
  const kd = st('I start holding the keys "L_SHIFT+A"');
  ok(kd?.kind === "keyDown" && kd.keys.join("+") === "L_SHIFT+A" && st('I release the key "SPACE"')?.kind === "keyUp",
     "58 `I start holding the key(s) …` / `I release the key …`");
  ok(/its end is its own line/.test(parseStep("I start holding joystick 2 fire for 3 frames")?.error ?? ""),
     "59 a start with a duration is an error that says which form to use");
  ok(/ESCAPE is not a C64 key/.test(parseStep('I start holding the key "ESCAPE"')?.error ?? "") &&
     /sideways is not a direction/.test(parseStep("I start holding joystick 2 sideways")?.error ?? ""),
     "60 key names and directions are checked the same way as in a hold");
  ok(/names what it lets go/.test(parseStep("I release everything")?.error ?? ""), "61 a release that names nothing is an error, not prose");

  const issues = (body) => parseFeature(`Scenario: s\n  Given a bare machine\n${body}\n  Then it works\n`).issues;
  const open = issues("  When I start holding joystick 2 right\n  And I wait 5 frames");
  ok(open.length === 1 && open[0].line === 3 && /never released/.test(open[0].message),
     "62 a start that is never released is an error on ITS line — a press with no end stays unwritable", JSON.stringify(open[0]));
  ok(/is not held/.test(issues('  When I release the key "A"')[0]?.message ?? ""), "63 releasing what is not held is an error");
  ok(/already held/.test(issues('  When I start holding the key "A"\n  And I start holding the key "A"\n  And I release the key "A"')[0]?.message ?? ""),
     "64 starting what is already held is an error");
  ok(/let it go before its release/.test(issues("  When I start holding joystick 2 up\n  And I hold joystick 2 fire for 3 frames\n  And I release joystick 2")[0]?.message ?? ""),
     "65 a timed hold of what a start is holding is an error — it would let go early");
  const good = parseFeature('Scenario: s\n  Given a bare machine\n  When I start holding joystick 2 right\n  And I wait 2 frames\n  And I hold the key "K" for 2 frames\n  And I wait 4 frames\n  And I release joystick 2\n  Then it works\n');
  ok(good.issues.length === 0 && good.scenarios[0].steps.length === 5, "66 the pair with an input between parses clean");
  const sandboxSteps = ["I start holding joystick 2 right", "I wait 2 frames"].map((l) => parseStep(l).step);
  ok(holdIssues(sandboxSteps).some((h) => /never released/.test(h.message)),
     "67 the same check guards a sandbox schedule, which has no file to hang it on");
}

// ── the acceptance: a recording replays with every input on the cycle it was recorded on ──
//
// Recorded on a private machine of this smoke's own — PAL, then switched to NTSC mid-run —
// with (a) a hold followed by a key after a gap and (b) a key pressed while the stick is
// held, on each model. It starts from a snapshot taken where the recorder was armed, so
// the replay starts from the same machine at the same cycle; the replay arms the machine's
// own journal, and the two journals are compared entry for entry, cycle for cycle.
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-814-rec-"));
  const snap = join(dir, "armed.c64re");
  const box = await SandboxSession.start({ model: "c64-pal", budgetMs: 300_000 });
  let jr, rows, fPal, fNtsc;
  try {
    await box.call("debug/pause", { source: "llm" });
    const st0 = await box.call("session/state");
    fPal = st0.cyclesPerFrame;
    let now = st0.c64Cycles, frame = fPal;
    const runTo = async (target) => {
      while (now < target) {
        const r = await box.call("session/run", { cycles: Math.min(frame, target - now) });
        now = r.c64Cycles;
      }
    };
    await runTo(now + 150 * frame); // boot to READY.
    await box.call("snapshot/dump", { path: snap });
    const armed = await box.call("session/input_journal", { arm: true });
    const A = armed.armedAtCycle;
    // An input at an exact frame from the arm, the way a person's lands on SOME cycle.
    const at = async (base, k, method, params) => { await runTo(base + k * frame); await box.call(method, { ...params, source: "human" }); };
    // PAL — (a) fire held 3 frames, then J after a gap; (b) the stick held right, K pressed inside it.
    await at(A, 10, "session/joystick_set", { port: 2, fire: true });
    await at(A, 13, "session/joystick_clear", { port: 2 });
    await at(A, 20, "session/key_down", { key: "J" });
    await at(A, 22, "session/key_up", { key: "J" });
    await at(A, 30, "session/joystick_set", { port: 2, right: true });
    await at(A, 32, "session/key_down", { key: "K" });
    await at(A, 34, "session/key_up", { key: "K" });
    await at(A, 38, "session/joystick_clear", { port: 2 });
    // A switch mid-frame: it happens at the next frame boundary.
    await runTo(A + 45 * frame + 7_000);
    const sw = await box.call("session/model", { name: "c64-ntsc", source: "human" });
    const S = sw.switchedAt?.c64Cycles ?? (await box.call("session/state")).c64Cycles;
    now = (await box.call("session/state")).c64Cycles;
    fNtsc = frame = (await box.call("session/state")).cyclesPerFrame;
    // NTSC — the same two shapes, in NTSC frames from the switch.
    await at(S, 5, "session/joystick_set", { port: 2, fire: true });
    await at(S, 8, "session/joystick_clear", { port: 2 });
    await at(S, 15, "session/key_down", { key: "L" });
    await at(S, 17, "session/key_up", { key: "L" });
    await at(S, 20, "session/joystick_set", { port: 2, left: true });
    await at(S, 22, "session/key_down", { key: "M" });
    await at(S, 24, "session/key_up", { key: "M" });
    await at(S, 28, "session/joystick_clear", { port: 2 });
    await runTo(S + 35 * frame);
    jr = await box.call("session/input_journal", { arm: false });
    rows = (await box.call("session/models")).models;
  } finally {
    await box.close();
  }
  const cyclesPerFrameOf = Object.fromEntries(rows.filter((r) => r.cyclesPerFrame).map((r) => [r.name, r.cyclesPerFrame]));
  const rec = recordScenario(jr.entries, {
    name: "hold, gap, key inside a hold — PAL then NTSC", model: jr.model, cyclesPerFrame: fPal, cyclesPerFrameOf,
    armedAtCycle: jr.armedAtCycle, endCycle: jr.cycle,
    origin: { kind: "snapshot", path: snap, why: "the machine as it was when the recorder was armed" },
    captures: [{ cycle: jr.cycle, label: "end" }],
  });
  const sc = parseFeature(rec.text).scenarios[0];
  const kinds = sc.steps.filter((x) => x.kind !== "wait").map((x) => x.kind).join(",");
  ok(jr.entries.length === 17 && rec.warnings.length === 0 &&
     kinds === "joystick,key,joystickDown,key,joystickUp,model,joystick,key,joystickDown,key,joystickUp,capture",
     "68 the recording: a hold, a key after it, a key inside a held stick — on PAL, a switch, the same on NTSC", kinds);
  let run, why = "";
  try { run = await runScenario(sc, { journal: true, budgetMs: 300_000 }); }
  catch (e) { why = String(e?.message ?? e).slice(0, 160); }
  ok(!!run?.journal, "69 the recorded scenario replays from its snapshot, with the machine's own journal armed", why);
  if (run?.journal) {
    const norm = (j, armedAt) => j.map((e) => `${e.method} ${JSON.stringify(e.detail)} +${e.cycle - armedAt}`);
    const want = norm(jr.entries, jr.armedAtCycle);
    const got = norm(run.journal.entries, run.journal.armedAtCycle);
    const first = want.findIndex((w, i) => w !== got[i]);
    ok(want.length === got.length && first < 0,
       "70 every input of the replay lands on the cycle it was recorded on — PAL, the switch, and NTSC after it",
       first < 0 ? `${got.length} entries` : `entry ${first}: recorded ${want[first]} | replayed ${got[first] ?? "(none)"}`);
    const swAt = jr.entries.findIndex((e) => e.kind === "model");
    ok(swAt > 0 && run.journal.entries[swAt]?.kind === "model" && run.machine.model === "c64-ntsc",
       "71 and the switch lands on the same frame boundary, the replay ending on NTSC");
  }
  rmSync(dir, { recursive: true, force: true });
}

// The sandbox runner performs the two halves too.
{
  const steps = ["I wait 150 frames", "I start holding joystick 2 right", "I wait 2 frames", 'I hold the key "K" for 2 frames', "I release joystick 2"]
    .map((l) => parseStep(l).step);
  let res, why = "";
  try { res = await runSandbox({ steps, screen: false, budgetMs: 120_000 }); } catch (e) { why = String(e?.message ?? e).slice(0, 120); }
  ok(res && res.log.some((l) => /I start holding joystick 2 right \(held until its release\)/.test(l)) &&
     res.log.some((l) => /I release joystick 2$/.test(l)),
     "72 a sandbox run starts and releases a hold as its own steps", why || res?.log.slice(-3).join(" | "));
}

console.log(`\n${fail ? "RED" : "GREEN"} spec 814: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
