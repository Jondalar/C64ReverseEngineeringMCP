#!/usr/bin/env node
// scripts/proof-canary-crt.mjs --cart ef|gmod2
//
// Spec 715 — CRT cartridge canary (earliest stable PASS). Inserts a REAL .crt
// sample through the UI-identical media-ingress path (power-cycle cold boot),
// runs the machine, and confirms the cartridge actually executed into a
// drawn intro/menu state — not a crash loop.
//
//   ef    : AccoladeComics_TRX+1D_EF.crt   (EasyFlash, flash040)
//   gmod2 : yeti_mountain_GMOD2.crt        (GMOD2, flash040 + m93c86 EEPROM)
//
// PASS = after power-cycle insert, the CPU left cycle 0 and ran a substantial
// number of cycles, PC is NOT in the $0000..$0002 crash loop, and the screen
// has drawn non-blank content (intro/startscreen/menu).
//
// NOT the 713/714.5 mapper matrix (that stays a focused subsystem gate).
// NO emulator change. Exit 0 = PASS, 1 = FAIL.

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const CARTS = {
  ef:    { file: "samples/AccoladeComics_TRX+1D_EF.crt", label: "EasyFlash (Accolade Comics)" },
  gmod2: { file: "samples/yeti_mountain_GMOD2.crt",      label: "GMOD2 (Yeti Mountain)" },
};

const argv = process.argv.slice(2);
const ci = argv.indexOf("--cart");
const cartKey = ci >= 0 ? argv[ci + 1] : null;
const cart = cartKey && CARTS[cartKey];
if (!cart) {
  console.error(`usage: proof-canary-crt.mjs --cart <${Object.keys(CARTS).join("|")}>`);
  process.exit(2);
}

let startIntegratedSession, stopIntegratedSession, ensureRuntimeController, ingestMedia;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js"));
  ({ ingestMedia } = await import("../dist/runtime/headless/media/ingress.js"));
} catch (e) {
  console.error("dist missing / import failed — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const crtPath = resolvePath(repoRoot, cart.file);
if (!existsSync(crtPath)) {
  console.error(`[canary-crt] sample missing (gitignored local-only): ${crtPath}`);
  process.exit(1);
}

function fail(reason, detail) {
  console.error("");
  console.error(`=== ${cart.label} canary RED ===`);
  console.error(`reason: ${reason}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function screenNonBlank(ram) {
  let n = 0;
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i] & 0x7f;
    if (c !== 0x20 && c !== 0x00) n++;
  }
  return n;
}

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});
try {
  const ctrl = ensureRuntimeController(sessionId, session, () => {});
  session.runFor(1_000_000, { cycleBudget: 1_000_000 }); // brief empty boot

  // UI-identical CRT insert: cartridge port = C64-internal cold boot.
  const bytes = new Uint8Array(readFileSync(crtPath));
  const r = await ingestMedia(ctrl, { kind: "crt", bytes, name: cart.file.split("/").pop(), resetPolicy: "power-cycle" });
  const mapperType = r?.mapperType ?? r?.type ?? cartKey;

  // Run the cold-booted cart deterministically.
  const PAL_HZ = 985_248;
  const startCyc = session.c64Cpu.cycles;
  let pcA = null, pcB = null;
  session.runFor(8 * PAL_HZ, { cycleBudget: 8 * PAL_HZ });
  pcA = session.c64Cpu.pc & 0xffff;
  session.runFor(2 * PAL_HZ, { cycleBudget: 2 * PAL_HZ });
  pcB = session.c64Cpu.pc & 0xffff;

  const advanced = session.c64Cpu.cycles - startCyc;
  const nonBlank = screenNonBlank(session.c64Bus.ram);

  if (advanced < 4 * PAL_HZ) fail("cart did not execute (CPU barely advanced)", `advanced=${advanced} cyc`);
  if (pcB <= 0x0002) fail("CPU in $0000..$0002 crash loop", `pcA=$${pcA.toString(16)} pcB=$${pcB.toString(16)}`);
  if (nonBlank < 16) fail("screen never drew intro/menu content", `nonBlank=${nonBlank} pcB=$${pcB.toString(16)}`);

  console.log(`=== Spec 715 — ${cart.label} canary (media-ingress power-cycle) ===`);
  console.log(`  PASS  CRT attached (${mapperType}), insert cold-boot paused=${r.paused}`);
  console.log(`  PASS  cart executed: +${advanced} cycles, PC=$${pcB.toString(16)} (not crash loop)`);
  console.log(`  PASS  screen drew content: ${nonBlank} non-blank cells`);
  console.log("");
  console.log(`GREEN: ${cartKey} reached a drawn intro/menu state. sample=${cart.file}`);
  process.exit(0);
} finally {
  try { stopIntegratedSession(sessionId); } catch {}
}
