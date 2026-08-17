// Spec 812 smoke — `runtime_scene_reel`, end to end.
//
// Runs the real tool handler against the real runtime binary and checks the file
// that comes out. No disk image is needed: a bare machine booting to READY
// exercises the whole path (scenario written → schedule executed → frames
// captured on frame boundaries → GIF89a assembled → artifacts registered), and
// the repo cannot carry someone else's medium. Point C64RE_SMOKE_DISK at a
// .d64/.g64 for the richer run.
//
//   node scripts/smoke-812-scene-reel.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (c, m, d = "") => {
  c ? pass++ : fail++;
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`);
};

console.log("Spec 812 smoke — runtime_scene_reel\n");

// The runtime binary is what actually runs the schedule; without it there is
// nothing to smoke, and saying so beats a green run that proved nothing.
const { resolveTrx64Cli } = await import(`${ROOT}/dist/sandbox/trx64cli.js`);
const cli = resolveTrx64Cli();
if (!existsSync(cli)) {
  console.log(`  [skip] runtime binary absent at ${cli}`);
  console.log("\nSKIPPED — build the runtime, then re-run.");
  process.exit(0);
}

// Capture the tool the way the inventory probe does: a stub server that keeps the
// handler instead of registering it.
const { registerSceneReelTool } = await import(`${ROOT}/dist/server-tools/scene-reel.js`);
const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
    return { update() {}, remove() {}, enable() {}, disable() {} };
  },
};

const work = mkdtempSync(join(tmpdir(), "c64re-812-"));
const ctx = {
  projectDir: () => work,
  toolsDir: () => join(ROOT, "pipeline"),
  readTextFile: (p) => readFileSync(p, "utf8"),
  cliResultToContent: (r) => ({ content: [{ type: "text", text: r.stdout }] }),
  tryRegisterKnowledgeArtifacts: () => ({ message: "" }),
};

registerSceneReelTool(server, ctx);
ok(tools.has("runtime_scene_reel"), "1 the tool registers");

const disk = process.env.C64RE_SMOKE_DISK;
if (disk && !existsSync(disk)) {
  console.log(`  [note] C64RE_SMOKE_DISK does not exist: ${disk} — running bare instead`);
}

const waypoints = [
  { wait: { frames: 170 } },
  { shot: { label: "ready" } },
  { type: { text: 'PRINT "TRX"\r' } },
  { wait: { frames: 60 } },
  { shot: { label: "printed" } },
  { joy: { port: 2, fire: true, frames: 3 } },
  { shot: { label: "after-joy" } },
];

const call = async (args) => {
  const t = tools.get("runtime_scene_reel");
  const r = await t.handler(args, {});
  return r.content.map((c) => c.text).join("\n");
};

const out = join(work, "reel.gif");
const textOut = await call({
  ...(disk && existsSync(disk) ? { media: disk } : {}),
  waypoints,
  out_path: out,
  name: "smoke-812",
  delay_ms: 700,
});

ok(existsSync(out), "2 a reel file is produced", out);
ok(/REEL smoke-812/.test(textOut), "3 the report names the reel");
ok(/3 frames · 384x272/.test(textOut), "4 three frames at the machine's own canvas");
ok(/shots \(the cycle each one landed on/.test(textOut), "5 the report carries per-shot cycles");
ok(existsSync(`${out}.scenario.json`), "6 the scenario is kept, so the reel can be rebuilt");
ok(existsSync(`${out}.manifest.json`), "7 a manifest is written");

// The header is the cheap structural check; the deep block walk lives in the
// runtime's own gate, which is where the encoder is.
const bytes = readFileSync(out);
ok(bytes.subarray(0, 6).toString("latin1") === "GIF89a", "8 it is a GIF89a");
ok(bytes[bytes.length - 1] === 0x3b, "9 it ends with the GIF trailer");
ok(bytes.length <= 512000, "10 within the CSDb byte ceiling", `${bytes.length} bytes`);

// Determinism: the same waypoints again must give the same bytes. This is the
// property the whole scenario format exists for.
const out2 = join(work, "reel2.gif");
await call({
  ...(disk && existsSync(disk) ? { media: disk } : {}),
  waypoints,
  out_path: out2,
  name: "smoke-812",
  delay_ms: 700,
});
ok(
  Buffer.compare(readFileSync(out), readFileSync(out2)) === 0,
  "11 the same schedule produces the same bytes",
);

// A schedule with nothing to capture is refused before anything runs.
const empty = await call({ waypoints: [{ wait: { frames: 1 } }], out_path: join(work, "no.gif") });
ok(/no `shot` waypoint/.test(empty), "12 a schedule with no shot is refused");
ok(!existsSync(join(work, "no.gif")), "13 and leaves no file claiming otherwise");

// A press with no stated duration is refused by the schema, not silently held.
const joySchema = tools.get("runtime_scene_reel").schema.waypoints;
const bad = joySchema.safeParse([{ joy: { port: 2, fire: true } }]);
ok(!bad.success, "14 a joystick press without `frames` does not typecheck");

rmSync(work, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "GREEN" : "RED"} spec 812 smoke: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
