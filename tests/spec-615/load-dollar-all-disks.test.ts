// LOAD"$",8 on multiple disks — verify CMP fix is general, not POLARBEAR-only.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

// expectError = true for disks where copy-protection makes
// drive-error the correct outcome (must match LEGACY1541 baseline).
const DISKS: { path: string; expectError?: boolean }[] = [
  { path: "samples/POLARBEAR.d64" },
  { path: "samples/motm.g64" },
  { path: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64" },
  { path: "samples/impossible_mission_ii[epyx_1987](!).g64" },
  { path: "samples/last_ninja_remix_s1[system3_1991].g64" },
  { path: "samples/scramble_infinity.d64" },
  { path: "samples/synthetic/blank.d64" },
  // the_pawn_s1.g64: deliberate header CRC fault (Magnetic Scrolls
  // copy protection). Drive ROM correctly returns ?FILE NOT FOUND
  // — symmetric with LEGACY1541 baseline → PASS.
  { path: "samples/the_pawn_s1.g64", expectError: true },
];

function decodeScreen(ram: Uint8Array): string {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i]! & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}

const results: { disk: string; pass: boolean; finalPc: string; screenLast2: string }[] = [];

for (const entry of DISKS) {
  const disk = entry.path;
  const expectError = entry.expectError === true;
  const diskPath = resolvePath(import.meta.dirname, "..", "..", disk);
  let sessionId: string | null = null;
  let result = { disk, pass: false, finalPc: "?", screenLast2: "" };
  try {
    const r = startIntegratedSession({
      mode: "true-drive",
      useMicrocodedCpu: true,
      vicRenderer: "literal-port",
      drive1541: "vice",
    });
    sessionId = r.sessionId;
    const session = r.session;
    await mountMedia(session, 8, diskPath);
    session.resetCold("pal-default");
    session.runFor(2_000_000);
    session.typeText('LOAD"$",8\r', 80_000, 80_000);
    const PAL_HZ = 985_248;
    const target = session.c64Cpu.cycles + 60 * PAL_HZ;
    while (session.c64Cpu.cycles < target) session.runFor(500_000);

    const screen = decodeScreen((session.c64Bus as { ram: Uint8Array }).ram);
    const hasErr = /FILE NOT FOUND|ERROR/.test(screen);
    const hasLoading = /LOADING/.test(screen);
    result.finalPc = `$${session.c64Cpu.pc.toString(16)}`;
    result.pass = expectError ? hasErr : (hasLoading && !hasErr);

    // Grab last 3 non-blank lines for context.
    const lines: string[] = [];
    for (let row = 0; row < 25; row++) {
      const line = screen.slice(row * 40, row * 40 + 40).trimEnd();
      if (line.length > 0) lines.push(line);
    }
    result.screenLast2 = lines.slice(-3).join(" | ");
  } catch (e) {
    result.finalPc = `err: ${(e as Error).message.slice(0, 60)}`;
  } finally {
    if (sessionId) stopIntegratedSession(sessionId);
  }
  results.push(result);
  console.log(`${result.pass ? "GREEN" : "RED  "}  ${disk.padEnd(80)}  PC=${result.finalPc}  | ${result.screenLast2}`);
}

const green = results.filter((r) => r.pass).length;
console.log(`\nSummary: ${green}/${results.length} disks loaded directory successfully`);
