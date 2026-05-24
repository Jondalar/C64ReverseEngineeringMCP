import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const carts = process.argv.slice(2).map(a => { const [file, out] = a.split("="); return { file, out }; });
for (const c of carts) {
  const p = resolve(c.file); if (!existsSync(p)) { console.log(`SKIP ${c.file}`); continue; }
  const { session, sessionId } = startIntegratedSession({ mode:"true-drive", useMicrocodedCpu:true, vicRenderer:"literal-port", drive1541:"vice" });
  try {
    const ctrl = new RuntimeController(sessionId, session, () => {});
    session.runFor(2_000_000, { cycleBudget: 2_000_000 });
    await ingestMedia(ctrl, { kind:"crt", bytes:new Uint8Array(readFileSync(p)), name:c.file, resetPolicy:"power-cycle" });
    const cart = session.kernel.c64Bus.getCartridge();
    session.runFor(20_000_000, { cycleBudget: 20_000_000 });
    session.renderToPng(`samples/screenshots/cart/${c.out}.png`);
    console.log(`OK ${c.out} type=${cart.getMapperType()} PC=$${session.c64Cpu.pc.toString(16)} → ${c.out}.png`);
  } catch (e) { console.log(`ERR ${c.out}: ${e.message}`); } finally { stopIntegratedSession(sessionId); }
}
