#!/usr/bin/env node
// BUG-044 probe — VICE-shaped monitor `io` command + write-only cart register
// shadows on the peek lane:
//   m de00 / m io de00 / m cart de00  → EF register shadows (VICE easyflash_io1_peek)
//   io / io 1 / io <addr>             → per-device hex + semantic dump
//   EF/GMOD2/GMOD3 dumpIoState        → 1:1 VICE *_dump text shape
import { readFileSync } from "node:fs";
const D = new URL("../dist", import.meta.url).pathname;
const { startIntegratedSession, stopIntegratedSession } = await import(`${D}/runtime/headless/integrated-session-manager.js`);
const { RuntimeController } = await import(`${D}/runtime/headless/debug/runtime-controller.js`);
const { ingestMedia } = await import(`${D}/runtime/headless/media/ingress.js`);
const { runMonitorCommand } = await import(`${D}/runtime/headless/debug/monitor-shell.js`);
const SRC = new URL("../samples/AccoladeComics_TRX+1D_EF.crt", import.meta.url).pathname;

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

function crtHeader(hwType) {
  const head = Buffer.alloc(0x40);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(0x40, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16); head.writeUInt8(0, 0x18); head.writeUInt8(1, 0x19);
  head.write("IOVERB", 0x20, "ascii");
  return head;
}
function chipBlock(bank, loadAddress, data) {
  const c = Buffer.alloc(0x10 + 0x2000);
  c.write("CHIP", 0, "ascii"); c.writeUInt32BE(0x10 + 0x2000, 4);
  c.writeUInt16BE(0, 8); c.writeUInt16BE(bank, 10); c.writeUInt16BE(loadAddress, 12); c.writeUInt16BE(0x2000, 14);
  data.copy(c, 0x10);
  return c;
}
const buildPlainCrt = (hw) => new Uint8Array(Buffer.concat([crtHeader(hw), chipBlock(0, 0x8000, Buffer.alloc(0x2000, 0xa7))]));

const NEW = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
async function setup(crtBytes, name) {
  const { session, sessionId } = NEW();
  const ctrl = new RuntimeController(sessionId, session, () => {});
  await ingestMedia(ctrl, { kind: "crt", bytes: crtBytes, name, resetPolicy: "power-cycle" }, {});
  ctrl.pause();
  const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() };
  return { session, sessionId, bus: session.c64Bus, mon: (cmd) => runMonitorCommand(ctx, cmd) };
}

// --- EF -----------------------------------------------------------------------
{
  const { sessionId, bus, mon } = await setup(new Uint8Array(readFileSync(SRC)), "ac.crt");
  bus.write(0xde00, 0x07);            // bank 7
  bus.write(0xde02, 0x85);            // LED on + mode 5 (ultimax)
  bus.notifyCartridgeLinesChanged();

  const m1 = await mon("m io de00 de02");
  gate("m io de00: EF register shadows (07 07 85)", /07 07 85/i.test(m1.output ?? ""), (m1.output ?? m1.error ?? "").trim());
  const m2 = await mon("m cart de00 de02");
  gate("m cart de00: cart lens shows the same shadows", /07 07 85/i.test(m2.output ?? ""), (m2.output ?? "").trim());
  const m3 = await mon("m de00 de02");
  gate("m de00 (cpu lens): VICE parity — shadows, not open bus", /07 07 85/i.test(m3.output ?? ""), (m3.output ?? "").trim());

  const io0 = await mon("io");
  gate("io: lists VIC-II/SID/CIA1/CIA2/EASYFLASH blocks",
    ["VIC-II:", "SID:", "CIA1:", "CIA2:", "EASYFLASH (IO1):", "EASYFLASH (IO2):"].every((t) => (io0.output ?? "").includes(t)));
  gate("io: bare form has NO details", !(io0.output ?? "").includes("Mode:"));
  const io1 = await mon("io de00");
  gate("io de00: EF details (VICE easyflash_io1_dump shape)",
    /Mode: Ultimax, Bank: 7, LED on, jumper off/.test(io1.output ?? "") && /EAPI found: (yes|no)/.test(io1.output ?? ""),
    (io1.output ?? io1.error ?? "").split("\n").slice(-2).join(" | "));
  gate("io de00: only the EF block", !(io1.output ?? "").includes("VIC-II:"));
  const ioAll = await mon("io 1");
  gate("io 1: all devices with details ('No details available.' for chips)",
    (ioAll.output ?? "").includes("No details available.") && /Mode: Ultimax/.test(ioAll.output ?? ""));
  const h = await mon("help");
  gate("help lists io", /io \[1\|addr\]/.test(h.output ?? ""));
  stopIntegratedSession(sessionId);
}

// --- GMOD2 ---------------------------------------------------------------------
{
  const { sessionId, bus, mon } = await setup(buildPlainCrt(60), "g2.crt");
  bus.write(0xde00, 0xc0 | 0x03); // ultimax + bank 3 (+ CS)
  bus.notifyCartridgeLinesChanged();
  const io = await mon("io de00");
  gate("GMOD2 io de00: gmod2_dump shape",
    /GAME\/EXROM status: Ultimax \(Flash mode\)/.test(io.output ?? "") && /ROM bank: 3/.test(io.output ?? "") && /EEPROM CS: 1/.test(io.output ?? ""),
    (io.output ?? io.error ?? "").split("\n").slice(-3).join(" | "));
  stopIntegratedSession(sessionId);
}

// --- GMOD3 ---------------------------------------------------------------------
{
  const { sessionId, bus, mon } = await setup(buildPlainCrt(62), "g3.crt");
  bus.write(0xde00, 0x05); // bank 5 (reg $de00-$de07 low bits)
  bus.write(0xde08, 0x20); // vectors=1, bit6=0 → ultimax
  bus.notifyCartridgeLinesChanged();
  const io = await mon("io de00");
  gate("GMOD3 io de00: gmod3_dump shape",
    /status: 8k Game/.test(io.output ?? "") && /ROM bank: 5/.test(io.output ?? "") && /hw vectors are enabled/.test(io.output ?? ""),
    (io.output ?? io.error ?? "").split("\n").slice(-4).join(" | "));
  stopIntegratedSession(sessionId);
}

console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
