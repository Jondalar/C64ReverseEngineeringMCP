// Pawn copy-protection symmetry check: compare LEGACY1541 vs vice1541
// screen + final PC after LOAD"$",8 on the_pawn_s1.g64. If both
// modes show the same "drive error" path → pass.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

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

function nonblankLines(screen: string): string[] {
  const lines: string[] = [];
  for (let row = 0; row < 25; row++) {
    const ln = screen.slice(row * 40, row * 40 + 40).trimEnd();
    if (ln.length > 0) lines.push(ln);
  }
  return lines;
}

async function runMode(mode: "vice" | "legacy"): Promise<{ screen: string; pc: string }> {
  const r = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: mode as any,
  });
  const session = r.session;
  await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "..", "samples/the_pawn_s1.g64"));
  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const target = session.c64Cpu.cycles + 60 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(500_000);
  const screen = decodeScreen((session.c64Bus as { ram: Uint8Array }).ram);
  const pc = `$${session.c64Cpu.pc.toString(16)}`;
  stopIntegratedSession(r.sessionId);
  return { screen, pc };
}

const vice = await runMode("vice");
const legacy = await runMode("legacy");

console.log(`vice   PC=${vice.pc}    lines: ${nonblankLines(vice.screen).slice(-4).join(" | ")}`);
console.log(`legacy PC=${legacy.pc}  lines: ${nonblankLines(legacy.screen).slice(-4).join(" | ")}`);

const viceErr = /FILE NOT FOUND|ERROR/.test(vice.screen);
const legacyErr = /FILE NOT FOUND|ERROR/.test(legacy.screen);
console.log(`vice   error-on-screen: ${viceErr}`);
console.log(`legacy error-on-screen: ${legacyErr}`);
console.log(`symmetric: ${viceErr === legacyErr ? "YES" : "NO"}`);
