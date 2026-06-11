#!/usr/bin/env node
// BUG-045 probe — monitor `swapcrt`: hot-swap the cartridge in the frozen
// machine (no reset). Same mapper type → banking continuation carried
// (bank + control register), flash = NEW build. Dirty old cart persisted
// first. Different type → fresh boot-state registers.
process.env.C64RE_CART_AUTOPERSIST = "0";
import { readFileSync, writeFileSync, statSync } from "node:fs";
const D = new URL("../dist", import.meta.url).pathname;
const { startIntegratedSession, stopIntegratedSession } = await import(`${D}/runtime/headless/integrated-session-manager.js`);
const { RuntimeController } = await import(`${D}/runtime/headless/debug/runtime-controller.js`);
const { ingestMedia } = await import(`${D}/runtime/headless/media/ingress.js`);
const { runMonitorCommand } = await import(`${D}/runtime/headless/debug/monitor-shell.js`);

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

function crtHeader(hwType, label) {
  const head = Buffer.alloc(0x40);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(0x40, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16); head.writeUInt8(0, 0x18); head.writeUInt8(1, 0x19);
  head.write(label, 0x20, "ascii");
  return head;
}
function chipBlock(bank, loadAddress, data) {
  const c = Buffer.alloc(0x10 + 0x2000);
  c.write("CHIP", 0, "ascii"); c.writeUInt32BE(0x10 + 0x2000, 4);
  c.writeUInt16BE(0, 8); c.writeUInt16BE(bank, 10); c.writeUInt16BE(loadAddress, 12); c.writeUInt16BE(0x2000, 14);
  data.copy(c, 0x10);
  return c;
}
function buildEf(label, loFill, hiFill) {
  const hi = Buffer.alloc(0x2000, hiFill);
  hi[0] = 0x78; hi[1] = 0x4c; hi[2] = 0x01; hi[3] = 0xe0; // SEI; JMP $E001
  for (let i = 0x1ffa; i <= 0x1fff; i += 2) { hi[i] = 0x00; hi[i + 1] = 0xe0; }
  // 8 banks so a carried bank 7 still reads build content (not erased 0xff).
  const chips = [];
  for (let b = 0; b < 8; b++) {
    chips.push(chipBlock(b, 0x8000, Buffer.alloc(0x2000, loFill)));
    chips.push(chipBlock(b, 0xa000, b === 0 ? hi : Buffer.alloc(0x2000, hiFill)));
  }
  return Buffer.concat([crtHeader(32, label), ...chips]);
}
const A = "/tmp/swapcrt-A.crt", B = "/tmp/swapcrt-B.crt", G2 = "/tmp/swapcrt-G2.crt";
writeFileSync(A, buildEf("BUILD-A", 0xa1, 0xa7));
writeFileSync(B, buildEf("BUILD-B", 0xb2, 0xb7));
writeFileSync(G2, Buffer.concat([crtHeader(60, "G2"), chipBlock(0, 0x8000, Buffer.alloc(0x2000, 0xff))]));

const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const ctrl = new RuntimeController(sessionId, session, () => {});
const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() };
const mon = (cmd) => runMonitorCommand(ctx, cmd);
await ingestMedia(ctrl, { kind: "crt", bytes: new Uint8Array(readFileSync(A)), name: "swapcrt-A.crt", resetPolicy: "power-cycle", backingPath: A }, {});
ctrl.pause();
const bus = session.c64Bus;

// Freeze-state setup: bank 7, ultimax+LED, one flash write (A dirty).
bus.write(0xde00, 0x07); bus.write(0xde02, 0x85); bus.notifyCartridgeLinesChanged();
bus.write(0xe555, 0xaa); bus.write(0xeaaa, 0x55); bus.write(0xe555, 0xa0); bus.write(0xe000, 0x42);
const mtimeA0 = statSync(A).mtimeMs;

const r = await mon(`swapcrt "${B}"`);
const out = r.output ?? r.error ?? "";
gate("swapcrt runs", /swapped: easyflash .* -> easyflash/.test(out), out.split("\n")[1]);
gate("dirty old build persisted first", /persisted old cart/.test(out) && statSync(A).mtimeMs > mtimeA0);
gate("banking carried (bank=7 ctrl=$85)", /carried banking: bank=7 ctrl=\$85/.test(out));
const nc = bus.getCartridge();
gate("new cart live: currentBank=7", nc.getState().currentBank === 7);
gate("still ultimax (lines from carried ctrl)", bus.isUltimax() === true);
gate("flash content = BUILD B", nc.peek(0x8000, bus.getBankInfo()) === 0xb2, `lo[0]=${nc.peek(0x8000, bus.getBankInfo())?.toString(16)}`);
gate("UI source name updated", bus.getCartridgeMedia()?.name === "swapcrt-B.crt");
gate("cartPath retargeted (savecrt hits B now)", session.cartPath === B, session.cartPath);
const io = await mon("io de00");
gate("io de00 after swap: Bank 7, LED on", /Bank: 7, LED on/.test(io.output ?? ""), (io.output ?? "").split("\n").pop());

const r2 = await mon(`swapcrt "${G2}"`);
const out2 = r2.output ?? "";
gate("type change -> fresh boot-state registers", /-> gmod2 /.test(out2) && /fresh boot-state registers/.test(out2));
gate("gmod2 live at bank 0", bus.getCartridge().getState().currentBank === 0);

const r3 = await mon("swapcrt");
gate("usage error without file", /usage: swapcrt/.test(r3.error ?? ""));

stopIntegratedSession(sessionId);
console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
