// Spec 425 follow-up — capture VIC tearing/flicker stages
// Scramble: spam SPACE to advance through credits
// Polarbear: F7 to enter title

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

function snap(session, label) {
  const lv_vic = session.vic;
  const cia2 = session.cia2;
  const cpu = session.c64Cpu;
  const d011 = lv_vic.regs[0x11] ?? 0;
  const d016 = lv_vic.regs[0x16] ?? 0;
  const d018 = lv_vic.regs[0x18] ?? 0;
  const ecm = (d011 >> 6) & 1;
  const bmm = (d011 >> 5) & 1;
  const mcm = (d016 >> 4) & 1;
  console.log(`  [${label}] PC=$${cpu.pc.toString(16).padStart(4,"0")} D011=$${d011.toString(16).padStart(2,"0")} D016=$${d016.toString(16).padStart(2,"0")} D018=$${d018.toString(16).padStart(2,"0")} mode=${(ecm<<2)|(bmm<<1)|mcm} cia2pa=$${(cia2.pra & cia2.ddra).toString(16).padStart(2,"0")}`);
}

async function runGame(diskPath, name, advanceFn) {
  const { session } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
  });
  console.log(`=== ${name} ===`);
  session.resetCold("pal-default");
  session.runFor(5_000_000, { cycleBudget: 5_000_000 });
  await mountMedia(session, 8, resolve(diskPath));
  session.typeText('LOAD"*",8,1\r');
  session.runFor(60_000_000, { cycleBudget: 60_000_000 });
  session.renderToPng(`/tmp/${name}-01-loaded.png`);
  snap(session, "loaded");
  session.typeText("RUN\r");
  session.runFor(30_000_000, { cycleBudget: 30_000_000 });
  session.renderToPng(`/tmp/${name}-02-run30s.png`);
  snap(session, "run30s");
  // Game-specific advance
  await advanceFn(session, name);
  session.runFor(20_000_000, { cycleBudget: 20_000_000 });
  session.renderToPng(`/tmp/${name}-04-late.png`);
  snap(session, "late");
}

// Scramble: spam SPACE every 2s for 30s to skip credits
async function advanceScramble(session, name) {
  for (let i = 0; i < 15; i++) {
    session.keyboard.setKeyDown("SPACE");
    session.runFor(200_000, { cycleBudget: 200_000 });
    session.keyboard.setKeyUp("SPACE");
    session.runFor(1_800_000, { cycleBudget: 1_800_000 });
    if (i % 5 === 4) {
      session.renderToPng(`/tmp/${name}-03-space${i}.png`);
      snap(session, `space${i}`);
    }
  }
}

// Polarbear: F7 hold ~100ms
async function advancePolarbear(session, name) {
  // Wait for title screen to settle
  session.runFor(20_000_000, { cycleBudget: 20_000_000 });
  session.renderToPng(`/tmp/${name}-02b-title.png`);
  snap(session, "title");
  session.keyboard.setKeyDown("F7");
  session.runFor(100_000, { cycleBudget: 100_000 });
  session.keyboard.setKeyUp("F7");
  session.runFor(20_000_000, { cycleBudget: 20_000_000 });
  session.renderToPng(`/tmp/${name}-03-postF7.png`);
  snap(session, "postF7");
}

await runGame("samples/scramble_infinity.d64", "scr", advanceScramble);
await runGame("samples/POLARBEAR.d64", "pb", advancePolarbear);
process.exit(0);
