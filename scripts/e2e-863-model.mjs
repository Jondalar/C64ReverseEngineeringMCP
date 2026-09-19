#!/usr/bin/env node
// Spec 863 — the hermetic half of the C64RE side: no runtime, no ROMs, no media.
//
// What the Live tab asks before it switches, how the selector lists the runtime's rows,
// how a scenario names its model and is refused on another, how the VIC view turns a frame
// header into rows and columns (a wrapped NTSC window included), and how a project's model
// reaches the runtime's command line. The daemon half — the switch on a running program,
// `runtime_session_start { model }`, hold_frames on NTSC, a real NTSC frame in the VIC view,
// the workspace launcher — is `scripts/smoke-863-ntsc.mjs`.
//
//   node scripts/e2e-863-model.mjs     (needs `npm run build:mcp`)

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mm = await import("../dist/runtime/machine-model.js");
const fg = await import("../dist/runtime/frame-geometry.js");
const { resolveDaemonSpawn } = await import("../dist/runtime/resolve-daemon-spawn.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
const { projectMachineModel } = await import("../dist/project-knowledge/machine-model.js");
const { parseFeature, waitCycles } = await import("../dist/project-knowledge/scenario-gherkin.js");
const { recordScenario } = await import("../dist/reel/record-scenario.js");

let pass = 0, fail = 0;
const check = (cond, msg, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const PAL = 19_656;
const NTSC = 17_095;

console.log("Spec 863 — models as the runtime reports them (hermetic)\n");

// ── the machine's identity ───────────────────────────────────────────────────────────
{
  let threw = "";
  try { mm.machineIdentity({ c64Cycles: 1, cpu: {} }); } catch (e) { threw = e.message; }
  check(/cyclesPerFrame/.test(threw) && /model/.test(threw),
    "a state without the identity fields is refused by name — never read as PAL", threw.slice(0, 90));
  const id = mm.machineIdentity({
    model: "c64-ntsc", videoStandard: "ntsc", chip: "6567R8", cyclesPerLine: 65, linesPerFrame: 263,
    cyclesPerFrame: NTSC, cpuHz: 1022730, frameRate: 59.826, canvas: { width: 384, height: 247 },
  });
  check(id.cyclesPerFrame === NTSC && id.canvas?.height === 247, "the identity carries frame, clock and canvas");
  check(/c64-ntsc \(NTSC, VIC-II 6567R8\): 65 × 263 = 17095 cycles\/frame/.test(mm.describeMachine(id)),
    "and describes itself the way the tools print it", mm.describeMachine(id));
}

// ── the selector and the confirmation ────────────────────────────────────────────────
const rows = [
  { name: "c64-pal", aliases: ["pal", "c64"], title: "C64 PAL", default: true, runs: true, missing: [], videoStandard: "pal", cyclesPerLine: 63, linesPerFrame: 312, cyclesPerFrame: PAL, cpuHz: 985248, frameRate: 50.12 },
  { name: "c64-ntsc", aliases: ["ntsc"], title: "C64 NTSC", runs: true, missing: [], videoStandard: "ntsc", cyclesPerLine: 65, linesPerFrame: 263, cyclesPerFrame: NTSC, cpuHz: 1022730, frameRate: 59.83 },
  { name: "c64c-pal", aliases: ["c64c"], title: "C64C PAL", runs: false, missing: ["6526A CIA", "custom-IC glue logic"] },
];
{
  const choices = mm.modelChoices(rows);
  check(choices.length === rows.length, "the selector lists every row the runtime has — none hidden");
  const c = choices.find((x) => x.name === "c64c-pal");
  check(c?.disabled === true && /needs 6526A CIA, custom-IC glue logic/.test(c.label),
    "a row that cannot run is disabled and says what it lacks", c?.label);
  check(!choices.find((x) => x.name === "c64-ntsc").disabled, "a row that runs is selectable");
  check(mm.findModelRow(rows, "NTSC")?.name === "c64-ntsc" && mm.sameModel(rows, "c64", "c64-pal"),
    "an alias names its row, case-insensitive");

  const conf = mm.switchConfirmation("c64-pal", rows[1]);
  const body = conf.body.join(" ");
  check(/next frame/i.test(body), "§7.1 the confirmation says the switch happens at the next frame");
  check(/keeps its state/.test(body) && /CPU, RAM, CIAs, SID/.test(body), "  that the running program keeps its state");
  check(/standard it detected at boot/.test(body) && /\$02A6/.test(body), "  and the standard it detected at boot");
  check(/power-cycle/.test(body) && /clean NTSC/.test(body), "  and what a clean start would do instead");
  const off = mm.switchConfirmation("c64-pal", rows[1], false);
  check(/powers on as C64 NTSC/.test(off.body.join(" ")), "a machine that is off simply powers on as the model");
}

// ── scenarios name their model ───────────────────────────────────────────────────────
{
  const why = mm.scenarioModelRefusal("boot", "c64-pal", "c64-ntsc", rows);
  check(!!why && /recorded on c64-pal/.test(why) && /this machine is c64-ntsc/.test(why),
    "§7.3 a PAL recording on NTSC is refused, naming both", why?.slice(0, 90));
  check(mm.scenarioModelRefusal("boot", "pal", "c64-pal", rows) === undefined, "the same model under an alias is not refused");
  check(mm.scenarioModelRefusal("boot", undefined, "c64-ntsc", rows) === undefined, "a hand-written scenario without a model runs anywhere");

  const s = parseFeature("# model: c64-ntsc\nScenario: s\n  Given a bare machine\n  When I wait 10 frames\n  And I wait 500 cycles\n  Then ok\n").scenarios[0];
  check(s?.model === "c64-ntsc", "a `# model:` header before the scenario is read");
  const [w1, w2] = s.steps;
  check(waitCycles(w1, NTSC) === 10 * NTSC && waitCycles(w1, PAL) === 10 * PAL && waitCycles(w2, NTSC) === 500,
    "`I wait N frames` is N frames of whichever machine runs it; cycles are cycles");

  const r = recordScenario(
    [{ cycle: 50 * NTSC, kind: "key", source: "human", method: "session/type", detail: { text: "RUN\r" } }],
    { model: "c64-ntsc", cyclesPerFrame: NTSC, name: "rec", armedAtCycle: 0, endCycle: 80 * NTSC, origin: { kind: "bare", why: "-" } },
  );
  const back = parseFeature(r.text).scenarios[0];
  check(back?.model === "c64-ntsc" && /I wait 50 frames/.test(r.text) && /I wait 30 frames/.test(r.text),
    "the recorder writes the model and counts in the recorded machine's frames");
}

// ── the Export tab's seconds: the recorded machine's clock ───────────────────────────
{
  const running = mm.machineIdentity({ model: "c64-pal", cyclesPerLine: 63, linesPerFrame: 312, cyclesPerFrame: PAL, cpuHz: 985248, frameRate: 50.12 });
  const rec = mm.scenarioDuration(60 * NTSC, "c64-ntsc", rows, running);
  check(rec.basis === "recorded" && rec.text === "1.0s on c64-ntsc" && rec.cpuHz === 1022730,
    "a scenario recorded on NTSC is timed by the NTSC clock while the machine is PAL", rec.text);
  const alias = mm.scenarioDuration(10 * PAL, "pal", rows, running);
  check(alias.basis === "recorded" && alias.clockOf === "c64-pal" && alias.text === "0.2s on c64-pal", "  an alias names its row's clock", alias.text);
  const plain = mm.scenarioDuration(985248, null, rows, running);
  check(plain.basis === "running" && plain.text === "1.0s on c64-pal", "  a scenario that names no model replays on — and is timed by — the running machine", plain.text);
  const old = mm.scenarioDuration(985248, undefined, rows, running);
  check(old.basis === "fallback" && /\?$/.test(old.text), "  a runtime too old to name the model falls back to the running clock, marked", old.text);
  const unknown = mm.scenarioDuration(5000, "c64-secam", rows, running);
  check(unknown.basis === "cycles" && unknown.text === "5000 cycles on c64-secam", "  a model the runtime does not describe stays in cycles", unknown.text);
  const tab = readFileSync(join(ROOT, "ui/src/workbench/tabs/Export.tsx"), "utf8");
  check(/scenarioDuration\(s\.cycleBudget, s\.model, rows, machine\)/.test(tab) && /does not say which model a scenario was recorded on/.test(tab),
    "the Export tab times each scenario by its recorded model and says when it cannot");
}

// ── the VIC view's geometry ──────────────────────────────────────────────────────────
{
  const palHeader = { cyclesPerLine: 63, linesPerFrame: 312, firstLine: 0, fbOrigin: { x: 104, y: 16 },
    displayWindow: { firstLine: 16, lastLine: 287, wraps: false, width: 384, height: 272 } };
  const palX = Array.from({ length: 63 }, (_, i) => (i + 1 >= 15 && i + 1 <= 62 ? (i + 1 - 15) * 8 : null));
  const p = fg.frameGeometry(palHeader, palX);
  check(p.lineOfRow(0) === 16 && p.rowOfLine(51) === 35 && p.rowOfLine(300) === null && p.height === 272,
    "PAL: the picture is lines 16..287, row = line - 16 (as before)");
  check(p.blankLeft === 14 && p.blankRight === 1, "PAL: blanking is cycles 1–14 and 63 — read from cycleX, as before");
  check(fg.cycleColumn(p, palX, 1, 4).x === -56 && fg.cycleColumn(p, palX, 63, 4).x === 384,
    "PAL: the blanking columns sit where the view always drew them");

  const ntscHeader = { cyclesPerLine: 65, linesPerFrame: 263, firstLine: 12, fbOrigin: { x: 104, y: 28 },
    displayWindow: { firstLine: 28, lastLine: 274, wraps: true, width: 384, height: 247 } };
  const ntscX = Array.from({ length: 65 }, (_, i) => (i + 1 >= 15 && i + 1 <= 62 ? (i + 1 - 15) * 8 : null));
  const g = fg.frameGeometry(ntscHeader, ntscX);
  check(g.cyclesPerLine === 65 && g.linesPerFrame === 263 && g.height === 247, "§7.4 NTSC: 65 cycles × 263 lines, a 247-row picture");
  check(g.lineOfRow(0) === 28 && g.lineOfRow(234) === 262 && g.lineOfRow(235) === 0 && g.lineOfRow(246) === 11,
    "§7.4 the wrapped window: rows run lines 28..262, then 0..11 at the bottom");
  check(g.rowOfLine(5) === 240 && g.fbRowOfLine(5) === 268 && g.lineOfFbRow(268) === 5 && g.rowOfLine(20) === null,
    "  line 5 is row 240, drawn into framebuffer row 268; line 20 is outside the picture");
  check(g.blankLeft === 14 && g.blankRight === 3, "  NTSC's two extra cycles are blanking the view draws beside the picture");
  const cols = new Set(Array.from({ length: 65 }, (_, i) => fg.cycleColumn(g, ntscX, i + 1, 4).x));
  check(cols.size === 65, "  every cycle has its own column");
  let threw = "";
  try { fg.frameGeometry({ which: "displayed", verified: true }); } catch (e) { threw = e.message; }
  check(/cyclesPerLine, linesPerFrame, fbOrigin, displayWindow/.test(threw), "a header without geometry is refused by name, not drawn as PAL");
}

// ── a project remembers its model, and the runtime is started as it ─────────────────
const proj = mkdtempSync(join(tmpdir(), "c64re-863-e2e-"));
try {
  const svc = new ProjectKnowledgeService(proj);
  svc.initProject({ name: "863" });
  check(projectMachineModel(proj) === "c64-pal", "§7.2 project_init stamps c64-pal into a project it creates");
  svc.initProject({ name: "863", machineModel: "c64-ntsc" });
  svc.initProject({ name: "863" });
  const raw = JSON.parse(readFileSync(join(proj, "knowledge", "project.json"), "utf8"));
  check(raw.machine?.model === "c64-ntsc", "  machine_model sets it; a later re-init without it keeps it");
  let bad = "";
  try { svc.initProject({ name: "863", machineModel: "not a model!" }); } catch (e) { bad = e.message; }
  check(/not a model name/.test(bad) && projectMachineModel(proj) === "c64-ntsc", "  a name that cannot be a model is refused, nothing written");

  // The spawn plan, with a stand-in binary so no runtime is needed.
  process.env.C64RE_RUNTIME_BIN = process.execPath;
  delete process.env.C64RE_RUNTIME_BIN_ARGS;
  const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: "4999" });
  const at = plan.args.indexOf("--model");
  check(at >= 0 && plan.args[at + 1] === "c64-ntsc" && plan.modelFrom === "project",
    "§7.2 every spawn of the project's runtime carries --model from project.json", plan.args.slice(4).join(" "));
  const explicit = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: "4999", model: "c64-paln" });
  check(explicit.args[explicit.args.indexOf("--model") + 1] === "c64-paln" && explicit.modelFrom === "caller", "  a caller's model wins");
  process.env.C64RE_RUNTIME_BIN_ARGS = "--video pal";
  const fromArgs = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: proj, port: "4999" });
  check(!fromArgs.args.includes("--model") && fromArgs.modelFrom === "args", "  a model already in the runtime args wins over both");
  delete process.env.C64RE_RUNTIME_BIN_ARGS;
  const none = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "4999" });
  check(!none.args.includes("--model") && none.model === undefined, "  no project model, no --model: the runtime's own default");
  delete process.env.C64RE_RUNTIME_BIN;
} finally {
  rmSync(proj, { recursive: true, force: true });
}

// ── the Live tab, read as source and as the built bundle (no browser) ────────────────
{
  const src = (p) => readFileSync(join(ROOT, p), "utf8");
  // Comments may name the PAL numbers; code may not.
  const code = (p) => src(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const controls = code("ui/src/workbench/components/MachineControls.tsx");
  check(/id="wb-model-select"/.test(controls) && /modelChoices\(rows\)/.test(controls),
    "§7.1 the Live tab has a model selector filled from the runtime's rows (no list of its own)");
  const pick = controls.slice(controls.indexOf("const pickModel"), controls.indexOf("const confirmModel"));
  check(pick.length > 0 && !/switchMachineModel|session\/model/.test(pick) && /setPendingModel\(row\)/.test(pick),
    "  picking a row only ASKS — the switch is not sent from the selector");
  check(/switchMachineModel\(/.test(controls.slice(controls.indexOf("const confirmModel"))) && /id="wb-model-cancel" onClick=\{\(\) => setPendingModel\(null\)\}/.test(controls),
    "  the confirm button switches; cancel only closes the question");
  check(!/mode: "pal"|: "pal"\b/.test(controls), "  pacing is asked for as realtime, the model's own frame rate");
  const overlay = code("ui/src/workbench/components/ExploreOverlay.tsx");
  const strip = code("ui/src/workbench/components/VicLineView.tsx");
  const lit = (s) => ["FB_ORIGIN", "384", "272", "311", "312", "<= 63", "< 63", "(63", "62)", "span 63", "104"].filter((x) => s.includes(x));
  check(lit(overlay).length === 0 && /frameGeometry\(fmap\.frame/.test(overlay),
    "§7.4 the VIC view takes cycles, lines, origin and blanking from the frame header", lit(overlay).join(",") || "no PAL literal");
  check(lit(strip).length === 0 && /frameGeometry\(data\.frame\)/.test(strip),
    "  and so does the line strip", lit(strip).join(",") || "no PAL literal");
  check(!/width=\{384\}|const W = 384/.test(code("ui/src/workbench/tabs/Live.tsx")), "the Live canvas is the model's size, not 384×272");
  check(!/985248/.test(code("ui/src/workbench/tabs/Export.tsx")) && !/985248/.test(code("ui/src/workbench/components/InspectorPanel.tsx")),
    "the Export tab's seconds and the SID note names use the machine's clock");

  const dist = join(ROOT, "ui", "dist", "assets");
  let bundle = "";
  try { bundle = readdirSync(dist).filter((f) => /\.js$/.test(f)).map((f) => readFileSync(join(dist, f), "utf8")).join("\n"); } catch { /* not built */ }
  if (!bundle) {
    console.log("  SKIP  the built bundle — ui/dist is absent (npm run ui:build); the source checks above still ran");
  } else {
    const want = ["wb-model-select", "wb-model-confirm", "session/models", "session/model", "av/hello", "standard it detected at boot"];
    const missing = want.filter((w) => !bundle.includes(w));
    check(missing.length === 0, "the built bundle carries the selector, its question and the runtime routes", missing.join(",") || "all present");
  }
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-863-model: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
