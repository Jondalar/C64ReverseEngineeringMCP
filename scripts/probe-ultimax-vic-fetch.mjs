#!/usr/bin/env node
// BUG-041 repro — ultimax VIC fetch lane (viciisc/vicii-fetch.c:56/84).
// Display off → every VIC phi1 fetch is idle ($3FFF) or DRAM refresh ($3Fxx),
// both inside the (addr & $3fff) >= $3000 ultimax window. Per mapper the lane
// must read a DIFFERENT source:
//   EF    → hi-flash bank offset $1000-$1FFF  (marker 0xA7 baked into .crt)
//   GMOD2 → RAM $1000-$1FFF via mem_read_without_ultimax (marker 0x5C)
//   GMOD3 → fall-through, VIC's own RAM mapping $3Fxx     (marker 0x3C)
// Flash in the GMOD carts is filled 0xA7 as a decoy: if the lane misroutes to
// the generic flash arm, 0xA7 shows up and the negative gates go RED.
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";
import { ingestMedia } from "../dist/runtime/headless/media/ingress.js";
import { vicii } from "../dist/runtime/headless/vic/literal/vicii-types.js";

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

function crtHeader(hwType) {
  const head = Buffer.alloc(0x40);
  head.write("C64 CARTRIDGE   ", 0, "ascii");
  head.writeUInt32BE(0x40, 0x10); head.writeUInt16BE(0x0100, 0x14);
  head.writeUInt16BE(hwType, 0x16); head.writeUInt8(0, 0x18); head.writeUInt8(1, 0x19);
  head.write("ULTIVIC", 0x20, "ascii");
  return head;
}
function chip(bank, loadAddress, data) {
  const c = Buffer.alloc(0x10 + 0x2000);
  c.write("CHIP", 0, "ascii"); c.writeUInt32BE(0x10 + 0x2000, 4);
  c.writeUInt16BE(0, 8); c.writeUInt16BE(bank, 10); c.writeUInt16BE(loadAddress, 12); c.writeUInt16BE(0x2000, 14);
  data.copy(c, 0x10);
  return c;
}

// EF: lo bank 0 = 0xff; hi bank 0 = loop at $E000, marker 0xA7 in $1000-$1FF9,
// vectors NMI/RESET/IRQ = $E000.
function buildEfCrt() {
  const hi = Buffer.alloc(0x2000, 0xa7);
  hi[0x0000] = 0x78; hi[0x0001] = 0x4c; hi[0x0002] = 0x01; hi[0x0003] = 0xe0; // SEI; JMP $E001
  for (let i = 0x1ffa; i <= 0x1fff; i += 2) { hi[i] = 0x00; hi[i + 1] = 0xe0; }
  return new Uint8Array(Buffer.concat([crtHeader(32), chip(0, 0x8000, Buffer.alloc(0x2000, 0xff)), chip(0, 0xa000, hi)]));
}
function buildPlainCrt(hwType) { // roml-only bank 0, flash decoy-marked 0xA7
  return new Uint8Array(Buffer.concat([crtHeader(hwType), chip(0, 0x8000, Buffer.alloc(0x2000, 0xa7))]));
}

const NEW = () => startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });

async function setup(crtBytes, name) {
  const { session, sessionId } = NEW();
  const ctrl = new RuntimeController(sessionId, session, () => {});
  await ingestMedia(ctrl, { kind: "crt", bytes: crtBytes, name, resetPolicy: "power-cycle" }, {});
  ctrl.pause();
  const bus = session.c64Bus;
  bus.write(0xd011, 0x00); bus.write(0xd015, 0x00); // display + sprites off
  bus.write(0xdc0d, 0x7f); bus.write(0xdd0d, 0x7f); // CIA IRQs off
  return { session, sessionId, bus };
}

function sample(session, chunks = 200, instrPerChunk = 50) {
  session.runFor(3000); // settle: let the current frame run out of display state
  const seen = new Set();
  for (let i = 0; i < chunks; i++) {
    session.runFor(instrPerChunk);
    seen.add(vicii.last_read_phi1 & 0xff);
  }
  return seen;
}
const fmt = (s) => [...s].map((v) => v.toString(16).padStart(2, "0")).join(",");

// --- EF: VIC lane reads hi flash ---------------------------------------------
{
  const { session, sessionId, bus } = await setup(buildEfCrt(), "ef-ultivic.crt");
  bus.write(0xde00, 0x00); bus.write(0xde02, 0x05); // bank 0, ultimax
  bus.notifyCartridgeLinesChanged();
  session.c64Cpu.pc = 0xe000; // SEI loop in flash
  const seen = sample(session);
  gate("EF: session in ultimax", bus.isUltimax() === true);
  gate("EF: VIC phi1 lane sees hi-flash marker 0xA7", seen.has(0xa7), fmt(seen));
  stopIntegratedSession(sessionId);
}

// --- GMOD2: VIC lane = mem_read_without_ultimax($1Fxx) -----------------------
{
  const { session, sessionId, bus } = await setup(buildPlainCrt(60), "gmod2-ultivic.crt");
  bus.ram[0x0200] = 0x78; bus.ram[0x0201] = 0x4c; bus.ram[0x0202] = 0x01; bus.ram[0x0203] = 0x02; // SEI; JMP $0201
  bus.ram.fill(0x5c, 0x1f00, 0x2000);                                     // marker
  bus.write(0xde00, 0xc0); // ultimax, bank 0
  bus.notifyCartridgeLinesChanged();
  session.c64Cpu.pc = 0x0200;
  const seen = sample(session);
  gate("GMOD2: session in ultimax", bus.isUltimax() === true);
  gate("GMOD2: VIC phi1 lane sees RAM $1Fxx marker 0x5C", seen.has(0x5c), fmt(seen));
  gate("GMOD2: VIC phi1 lane does NOT see flash decoy 0xA7", !seen.has(0xa7), fmt(seen));
  stopIntegratedSession(sessionId);
}

// --- GMOD3: VIC lane falls through to its own RAM mapping --------------------
{
  const { session, sessionId, bus } = await setup(buildPlainCrt(62), "gmod3-ultivic.crt");
  bus.ram[0x0200] = 0x78; bus.ram[0x0201] = 0x4c; bus.ram[0x0202] = 0x01; bus.ram[0x0203] = 0x02;
  bus.ram.fill(0x5c, 0x1f00, 0x2000); // decoy: gmod2-arm would surface this
  for (let b = 0; b < 4; b++) bus.ram.fill(0x3c, b * 0x4000 + 0x3f00, b * 0x4000 + 0x4000); // all VIC banks
  bus.write(0xde08, 0x20); // vectors=1, bit6=0 → ultimax
  bus.notifyCartridgeLinesChanged();
  session.c64Cpu.pc = 0x0200;
  const seen = sample(session);
  gate("GMOD3: session in ultimax", bus.isUltimax() === true);
  gate("GMOD3: VIC phi1 lane sees own-RAM $3Fxx marker 0x3C", seen.has(0x3c), fmt(seen));
  gate("GMOD3: VIC phi1 lane does NOT see flash decoy 0xA7", !seen.has(0xa7), fmt(seen));
  gate("GMOD3: VIC phi1 lane does NOT take the GMOD2 arm (0x5C)", !seen.has(0x5c), fmt(seen));
  stopIntegratedSession(sessionId);
}

console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
