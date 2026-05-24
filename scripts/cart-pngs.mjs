// Spec 713 — boot each real cartridge sample and render a screen PNG (visual
// proof the faithful mappers actually run a real cart, not just attach). Own
// session per cart (NOT the live :4312 backend).
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const carts = [
  { file: "samples/AccoladeComics_TRX+1D_EF.crt", out: "easyflash_accolade" },
  { file: "samples/yeti_mountain_GMOD2.crt",      out: "gmod2_yeti" },
  { file: "samples/im3_MAGICDESK.crt",            out: "magicdesk_im3" },
  { file: "samples/lykia_MEGABYTER.crt",          out: "megabyter_lykia" },
];

for (const c of carts) {
  const p = resolve(c.file);
  if (!existsSync(p)) { console.log(`SKIP ${c.file}`); continue; }
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind: "crt", bytes: new Uint8Array(readFileSync(p)), name: c.file, resetPolicy: "power-cycle" });
    // boot ~3s
    session.runFor(15_000_000, { cycleBudget: 15_000_000 });
    const png = `samples/screenshots/cart/${c.out}.png`;
    session.renderToPng(png);
    console.log(`OK  ${c.out}  PC=$${session.cpuPc?.toString(16) ?? "?"}  → ${png}`);
  } catch (e) {
    console.log(`ERR ${c.out}: ${e.message}`);
  } finally {
    stopIntegratedSession(sessionId);
  }
}
