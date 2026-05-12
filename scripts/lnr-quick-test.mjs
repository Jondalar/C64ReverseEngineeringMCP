// Quick post-RAM-init-change verification with per-game flush.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const which = process.argv[2] ?? "all";

const games = {
  motm: {
    disk: "samples/motm.g64",
    runMs: 180_000, expect: pc => pc === 0xb7bf || pc === 0xb7bd, label: "motm" },
  mm: {
    disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
    runMs: 180_000, expect: pc => pc >= 0x500 && pc <= 0x7ff, label: "MM s1" },
  lnr: {
    disk: "samples/last_ninja_remix_s1[system3_1991].g64",
    runMs: 200_000, expect: pc => pc !== 0xE5CF && pc !== 0xE5D4, label: "LNR s1" },
};

async function runOne(g) {
  const t0 = Date.now();
  const { session } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
    driveDispatchMode: "vice-whole-instruction",
  });
  session.resetCold("pal-default");
  session.runFor(5_000_000);
  await mountMedia(session, 8, resolve(g.disk));
  session.typeText('LOAD"*",8,1\r');
  session.runFor(60_000_000);
  session.typeText("RUN\r");
  session.runFor(g.runMs / 1000 * 1_000_000);
  const pc = session.c64Cpu.pc;
  const cyc = session.c64Cpu.cycles;
  const ok = g.expect(pc);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`[${ok ? "PASS" : "FAIL"}] ${g.label} pc=$${pc.toString(16)} cyc=${cyc} (${dt}s)\n`);
  return ok;
}

const list = which === "all" ? ["motm", "mm", "lnr"] : [which];
for (const k of list) await runOne(games[k]);
process.exit(0);
