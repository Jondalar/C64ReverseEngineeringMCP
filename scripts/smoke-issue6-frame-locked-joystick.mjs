// Issue #6 — a joystick press held for a stated number of FRAMES.
//
// On the live session the machine free-runs in wall-clock time between two tool
// calls, so `set` → `run` → `clear` as three separate calls cannot land a press
// inside a poll routine's sampling window. Titles that gate their own $DC00 read
// behind a raster-frame wait then see the press 0 times, or 5, at random, and no
// cycle_budget from the calling side fixes that.
//
// `runtime_joystick { hold_frames }` measures the press in MACHINE time: the
// machine is paused around it, advances exactly the frames asked for with the
// state applied, then releases. This gate drives the REAL tool handler against a
// sandbox daemon (C64RE_RUNTIME_ENDPOINT) and checks the contract at the port:
// asserted for the whole window, released after, exact cycle count, run state
// restored. The shared session is never touched.
import { SandboxSession } from "../dist/reel/sandbox-session.js";
import { PAL_CYCLES_PER_FRAME } from "../dist/project-knowledge/scenario-gherkin.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("issue #6 — a press measured in frames, not in wall-clock time\n");

const box = await SandboxSession.start({ budgetSeconds: 420 });
process.env.C64RE_RUNTIME_ENDPOINT = `ws://127.0.0.1:${box.port}`;

// Register the real tool against a stub server, then call its handler.
const tools = new Map();
const server = { tool(name, _d, _s, h) { tools.set(name, h); return { update() {}, remove() {}, enable() {}, disable() {} }; } };
const { registerHeadlessTools } = await import("../dist/server-tools/headless.js");
registerHeadlessTools(server, {
  projectDir: () => process.cwd(),
  toolsDir: () => process.cwd(),
  readTextFile: () => "",
  cliResultToContent: (r) => ({ content: [{ type: "text", text: String(r?.stdout ?? "") }] }),
  tryRegisterKnowledgeArtifacts: () => ({ message: "" }),
});
const joystick = tools.get("runtime_joystick");
ok(typeof joystick === "function", "1 runtime_joystick is registered");

const SID = "integrated-1";
const text = (r) => r.content.map((c) => c.text).join("\n");
const state = () => box.call("session/state");
const dc00 = async () => {
  const out = await box.call("monitor/exec", { command: "m dc00 dc00" });
  const s = (out?.output ?? "").toString();
  const m = s.match(/dc00\s+([0-9a-f]{2})/i);
  return m ? parseInt(m[1], 16) : -1;
};

try {
  await box.call("debug/pause", { source: "gate" });
  await box.call("session/run", { cycles: PAL_CYCLES_PER_FRAME * 180 }); // boot to READY
  const idle = await dc00();
  ok(idle === 0x7f, "2 the port reads idle before the press", `$${idle.toString(16)}`);

  // ── the frame-locked hold, through the real tool ───────────────────────────
  const before = (await state()).c64Cycles;
  const res = await joystick({ session_id: SID, down: true, hold_frames: 4 }, {});
  const after = (await state()).c64Cycles;
  const advanced = after - before;

  // Instruction granularity: a run stops on the instruction that crosses the cap,
  // so the window can overshoot by a few cycles — never by a frame, and never by an
  // amount that depends on how fast the caller made the next call.
  const drift = advanced - 4 * PAL_CYCLES_PER_FRAME;
  ok(drift >= 0 && drift < 16, "3 the machine advanced exactly the frames asked for",
     `${advanced} cycles = ${(advanced / PAL_CYCLES_PER_FRAME).toFixed(4)} frames, +${drift} cycles of instruction granularity`);
  ok(/held down for 4 frame/.test(text(res)), "4 the result says what was held and for how long",
     text(res).split("\n")[0]);
  ok(/measured in machine time/.test(text(res)), "5 and why that is the point");
  ok(await dc00() === 0x7f, "6 the press is RELEASED when the call returns");

  // ── the port must be asserted for the WHOLE window, not just at its edges ──
  // Drive the same hold by hand in slices and sample between them.
  await box.call("debug/pause", { source: "gate" });
  await box.call("session/joystick_set", { port: 2, down: true, source: "gate" });
  const samples = [];
  for (let i = 0; i < 4; i++) {
    await box.call("session/run", { cycles: PAL_CYCLES_PER_FRAME });
    samples.push(await dc00());
  }
  await box.call("session/joystick_clear", { port: 2, source: "gate" });
  ok(samples.every((v) => v === 0x7d), "7 DOWN is asserted on every frame of the window",
     samples.map((v) => `$${v.toString(16)}`).join(" "));
  await box.call("session/run", { cycles: PAL_CYCLES_PER_FRAME });
  ok(await dc00() === 0x7f, "8 and released after it");

  // ── fire, and a one-frame tap ─────────────────────────────────────────────
  const b2 = (await state()).c64Cycles;
  await joystick({ session_id: SID, fire: true, hold_frames: 1 }, {});
  const tap = (await state()).c64Cycles - b2;
  ok(tap - PAL_CYCLES_PER_FRAME >= 0 && tap - PAL_CYCLES_PER_FRAME < 16, "9 a one-frame tap advances one frame", `${tap} cycles`);
  ok(await dc00() === 0x7f, "10 the tap is released too");

  // ── port 1 is reachable ───────────────────────────────────────────────────
  const p1 = await joystick({ session_id: SID, left: true, hold_frames: 2, port: 1 }, {});
  ok(/port 1/.test(text(p1)), "11 port 1 is reachable", text(p1).split("\n")[0]);

  // ── the machine is left as it was found ───────────────────────────────────
  ok((await state()).runState !== "running", "12 a paused machine is left paused");

  await box.call("debug/continue", { source: "gate" });
  await new Promise((r) => setTimeout(r, 150));
  const wasRunning = (await state()).runState === "running";
  await joystick({ session_id: SID, up: true, hold_frames: 2 }, {});
  await new Promise((r) => setTimeout(r, 150));
  const stillRunning = (await state()).runState === "running";
  ok(wasRunning && stillRunning, "13 a running machine is running again afterwards",
     `before=${wasRunning} after=${stillRunning}`);

  // ── the bare set mode still behaves as it always did ──────────────────────
  await box.call("debug/pause", { source: "gate" });
  const bare = await joystick({ session_id: SID, right: true }, {});
  ok(/free-runs between calls/.test(text(bare)), "14 the bare set mode says why it is the weaker one");
  ok(await dc00() === 0x77, "15 and it leaves the direction held", `$${(await dc00()).toString(16)}`);
  await box.call("session/joystick_clear", { port: 2, source: "gate" });
} finally {
  await box.close();
}

console.log(`\n${fail ? "RED" : "GREEN"} issue #6 frame-locked joystick: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
