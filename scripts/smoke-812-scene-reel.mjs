// Spec 812 smoke — a written capture scenario, end to end.
//
// Runs the real tool handler, which parses the Gherkin, spawns its own private
// machine, walks the steps and assembles the reel. No disk image is needed: a bare
// machine booting to READY exercises the whole path, and the repo cannot carry
// someone else's medium. Point C64RE_SMOKE_DISK at a .d64/.g64 for the richer run.
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

// ---- the notation, checked without a machine -------------------------------
const { parseFeature, parseStep, decodeKeys } = await import(`${ROOT}/dist/project-knowledge/scenario-gherkin.js`);

{
  const r = parseFeature(
    'Scenario: reel\n  Given the disk "side1.g64"\n' +
      '  When I wait 170 frames\n  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"\n' +
      "  And I wait until the drive is idle within 8000 frames\n" +
      '  And I capture "title"\n  And I hold joystick 2 down and fire for 3 frames\n' +
      '  And I capture "menu"\n  Then the reel has at least 2 screens\n',
  );
  ok(r.issues.length === 0, "1 a capture scenario parses", r.issues.map((i) => i.message).join("; "));
  const s = r.scenarios[0];
  ok(s?.origin?.kind === "medium" && s.origin.path === "side1.g64", "2 Given binds a medium");
  ok(s?.steps.length === 6, "3 six driven steps", String(s?.steps.length));
  ok(s?.steps[1]?.keys === 'LOAD"*",8,1\r', "4 {QUOTE} and {RETURN} decode");
  ok(s?.steps[4]?.frames === 3 && s.steps[4].directions.join("+") === "down+fire", "5 a press states its duration");
  ok(s?.criteria.length === 1, "6 Then is a criterion, not a step");
}

ok(decodeKeys("A{SPACE}B{RETURN}") === "A B\r", "7 named keys decode");
ok(
  /within N frames/.test(parseStep("I wait until the drive is idle")?.error ?? ""),
  "8 a predicate without a timeout is refused",
);
ok(
  /at least one frame/.test(parseStep("I hold joystick 2 fire for 0 frames")?.error ?? ""),
  "9 a press shorter than a frame is refused",
);
ok(parseStep("I capture") ? /quoted label/.test(parseStep("I capture").error ?? "") : false, "10 a capture needs a label");
ok(parseStep("Bloomsday") === undefined, "11 a non-step falls through to the criterion classifier");

// ---- the encoder, checked against a decoder that is not ours ---------------
const { encode, encodeWithin, parseStructure } = await import(`${ROOT}/dist/reel/gif89a.js`);
{
  const pal = new Uint8Array(48).map((_, i) => (i * 17) & 0xff);
  const px = 384 * 272;
  const mk = (phase) => ({
    indices: Uint8Array.from({ length: px }, (_, i) => (((i * 13 + i / 31 + phase * 977) | 0) % 16) & 0x0f),
  });
  const bytes = encode(384, 272, pal, [mk(0), mk(1), mk(2)], 70);
  const s = parseStructure(bytes);
  ok(s.width === 384 && s.height === 272, "12 the reel is the machine's canvas");
  ok(s.frames === 3 && s.paletteEntries === 16, "13 three frames, sixteen colours, nothing quantized");
  ok(s.disposals.every((d) => d === 2) && s.loopsForever, "14 hard cuts, looping");
  const naive = (() => { let n = 0; for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) n++; return n; })();
  ok(naive >= s.frames, "15 a naive 21 F9 scan is not a frame count", `scan found ${naive}, blocks say ${s.frames}`);

  const clamped = encodeWithin(384, 272, pal, [mk(0), mk(1), mk(2), mk(3), mk(4)], 70, Math.floor(bytes.length * 0.9));
  ok(clamped.bytes.length <= Math.floor(bytes.length * 0.9), "16 the byte ceiling is a ceiling");
  ok(!clamped.dropped.includes(0) && !clamped.dropped.includes(4), "17 the opening and closing frames go last");
}

// ---- the tool, end to end --------------------------------------------------
const { resolveTrx64Cli } = await import(`${ROOT}/dist/sandbox/trx64cli.js`);
const daemonBin = resolveTrx64Cli().replace(/trx64cli(\.exe)?$/, "trx64-daemon$1");
if (!existsSync(daemonBin)) {
  console.log(`\n  [skip] runtime binary absent at ${daemonBin}`);
  console.log(`\n${fail === 0 ? "GREEN (notation + encoder only)" : "RED"} spec 812 smoke: ${pass} pass, ${fail} fail.`);
  process.exit(fail === 0 ? 0 : 1);
}

const { registerSceneReelTool } = await import(`${ROOT}/dist/server-tools/scene-reel.js`);
const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
    return { update() {}, remove() {}, enable() {}, disable() {} };
  },
};
const work = mkdtempSync(join(tmpdir(), "c64re-812-"));
registerSceneReelTool(server, {
  projectDir: () => work,
  toolsDir: () => join(ROOT, "pipeline"),
  readTextFile: (p) => readFileSync(p, "utf8"),
  cliResultToContent: (r) => ({ content: [{ type: "text", text: r.stdout }] }),
  tryRegisterKnowledgeArtifacts: () => ({ message: "" }),
});
ok(tools.has("runtime_scene_reel"), "18 the tool registers");

const call = async (args) => {
  const r = await tools.get("runtime_scene_reel").handler(args, {});
  return r.content.map((c) => c.text).join("\n");
};

const disk = process.env.C64RE_SMOKE_DISK;
const given = disk && existsSync(disk) ? `  Given the disk "${disk}"\n` : "  Given a bare machine\n";
const FEATURE =
  "Scenario: smoke reel\n" +
  given +
  "  When I wait 170 frames\n" +
  '  And I capture "ready"\n' +
  '  And I type "PRINT{SPACE}6502{RETURN}"\n' +
  "  And I wait 60 frames\n" +
  '  And I capture "printed"\n' +
  "  And I hold joystick 2 fire for 3 frames\n" +
  '  And I capture "after-joy"\n' +
  "  Then the reel has at least 3 screens\n" +
  "  And the reel is at most 512000 bytes\n";

const out = join(work, "reel.gif");
const report = await call({ feature: FEATURE, out_path: out, save_feature_to: join(work, "reel.feature") });

ok(existsSync(out), "19 a reel file is produced", out);
ok(/REEL smoke reel/.test(report), "20 the report names the scenario");
ok(/3 frames · 384x272/.test(report), "21 three frames at the machine's canvas");
ok(/captures \(the cycle each one landed on/.test(report), "22 the report carries per-capture cycles");
ok(/PASS\s+the reel has at least 3 screens/.test(report), "23 a machine-checkable Then is checked");
ok(existsSync(join(work, "reel.feature")), "24 the scenario is kept, so the reel can be rebuilt");

const bytes = readFileSync(out);
ok(bytes.subarray(0, 6).toString("latin1") === "GIF89a", "25 it is a GIF89a");
ok(bytes[bytes.length - 1] === 0x3b, "26 it ends with the GIF trailer");

const out2 = join(work, "reel2.gif");
await call({ feature: FEATURE, out_path: out2 });
ok(Buffer.compare(readFileSync(out), readFileSync(out2)) === 0, "27 the same scenario produces the same bytes");

const noShot = await call({
  feature: 'Scenario: nothing\n  Given a bare machine\n  When I wait 10 frames\n  Then it did something\n',
  out_path: join(work, "no.gif"),
});
ok(/captures nothing/.test(noShot), "28 a scenario that captures nothing is refused");
ok(!existsSync(join(work, "no.gif")), "29 and leaves no file claiming otherwise");

const badPred = await call({
  feature:
    'Scenario: impossible\n  Given a bare machine\n' +
    "  When I wait until the CPU reaches $FFFF within 30 frames\n" +
    '  And I capture "never"\n  Then it happened\n',
  out_path: join(work, "never.gif"),
});
ok(/did not happen within 30 frames/.test(badPred), "30 a predicate that never fires fails loudly");

// The private machine must END ITSELF. Asserted on the sandbox's OWN port — a
// count of every daemon on the host would also see the human's live session and
// anyone else's scratch instance, which is how a check ends up measuring the
// wrong thing and passing anyway.
const { SandboxSession } = await import(`${ROOT}/dist/reel/sandbox-session.js`);
{
  const box = await SandboxSession.start({ budgetMs: 30_000 });
  const port = box.port;
  const listening = async () => {
    const cp = await import("node:child_process");
    return cp.execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null | grep -c LISTEN || true`, { encoding: "utf8" }).trim();
  };
  ok(Number(await listening()) === 1, "31 a sandbox holds its own port while it lives", `port ${port}`);
  await box.close();
  await new Promise((r) => setTimeout(r, 400));
  ok(Number(await listening()) === 0, "32 and lets go of it when it ends", `port ${port}`);
}


rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "GREEN" : "RED"} spec 812 smoke: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
