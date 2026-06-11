#!/usr/bin/env node
// BUG-043 repro — monitor verb savecrt/savecrtstate: write live flash state to
// the mounted .crt on command. Auto-persist disabled so ONLY the verb writes.
process.env.C64RE_CART_AUTOPERSIST = "0";
import { readFileSync, copyFileSync, statSync, existsSync, rmSync } from "node:fs";
const D = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist";
const { startIntegratedSession, stopIntegratedSession } = await import(`${D}/runtime/headless/integrated-session-manager.js`);
const { RuntimeController } = await import(`${D}/runtime/headless/debug/runtime-controller.js`);
const { ingestMedia } = await import(`${D}/runtime/headless/media/ingress.js`);
const { runMonitorCommand } = await import(`${D}/runtime/headless/debug/monitor-shell.js`);

const SRC = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/AccoladeComics_TRX+1D_EF.crt";
const CRT = "/tmp/savecrt-test.crt";
const COPY = "/tmp/savecrt-copy.crt";
copyFileSync(SRC, CRT); if (existsSync(COPY)) rmSync(COPY);
const mtime0 = statSync(CRT).mtimeMs;

const failures = []; let passes = 0;
const gate = (n, ok, d) => { ok ? passes++ : failures.push(n); console.log(`  ${ok ? "PASS" : "RED "}  ${n}${d ? ` (${d})` : ""}`); };

const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
const ctrl = new RuntimeController(sessionId, session, () => {});
const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() };
const mon = (cmd) => runMonitorCommand(ctx, cmd);
await ingestMedia(ctrl, { kind: "crt", bytes: new Uint8Array(readFileSync(CRT)), name: "t.crt", resetPolicy: "power-cycle", backingPath: CRT }, {});
ctrl.pause();
const bus = session.c64Bus;
const cart = bus.getCartridge();

// flash 1 byte (ultimax window, AM29F040 program 0x4C -> AND 0x42 = 0x40)
cart.write(0xde00, 0x00, bus.getBankInfo());
cart.write(0xde02, 0x05, bus.getBankInfo());
bus.notifyCartridgeLinesChanged();
bus.write(0xe555, 0xaa); bus.write(0xeaaa, 0x55); bus.write(0xe555, 0xa0); bus.write(0xe000, 0x42);

const r1 = await mon("savecrt");
gate("savecrt writes the mounted .crt", /bytes -> /.test(r1.output ?? "") && statSync(CRT).mtimeMs > mtime0, r1.output ?? r1.error);
const a = readFileSync(SRC), b = readFileSync(CRT);
let diffs = [];
for (let i = 0; i < a.length && diffs.length < 5; i++) if (a[i] !== b[i]) diffs.push([i, a[i], b[i]]);
gate("exactly 1 byte diff, AND semantics 4c->40", diffs.length === 1 && diffs[0][1] === 0x4c && diffs[0][2] === 0x40,
  diffs.map(([i, x, y]) => `@${i} ${x.toString(16)}->${y.toString(16)}`).join(" "));

// Explicit command = always write (EF isWritableDirty stays true after the
// first program — VICE semantics; the skip path only guards never-written /
// non-writable carts). Idempotent: same bytes.
const bytesAfterFirst = readFileSync(CRT);
const r2 = await mon("savecrt");
gate("second savecrt is idempotent (same bytes)", /bytes -> /.test(r2.output ?? "") && Buffer.compare(readFileSync(CRT), bytesAfterFirst) === 0, r2.output ?? r2.error);

const r3 = await mon(`savecrt "${COPY}"`);
gate("savecrt \"<path>\" writes a copy even when clean", /bytes -> /.test(r3.output ?? "") && existsSync(COPY) && readFileSync(COPY).length === b.length, r3.output ?? r3.error);
gate("copy content = current state (matches mounted .crt)", Buffer.compare(readFileSync(COPY), b) === 0);

const r4 = await mon("savecrtstate");
gate("alias savecrtstate works", /skipped|bytes/.test((r4.output ?? "") + (r4.error ?? "")), r4.output ?? r4.error);

const r5 = await mon("help");
gate("help lists savecrt", /savecrt/.test(r5.output ?? ""));

stopIntegratedSession(sessionId);

// no-cart session
{
  const { session: s2, sessionId: id2 } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice" });
  const ctrl2 = new RuntimeController(id2, s2, () => {});
  const r = await runMonitorCommand({ session: s2, ctrl: ctrl2, sessionId: id2, memCursors: new Map(), disasmCursors: new Map() }, "savecrt");
  gate("no cart -> clear error", /no cartridge attached/.test(r.error ?? ""), r.error ?? r.output);
  stopIntegratedSession(id2);
}

console.log(`\n${passes} PASS, ${failures.length} RED${failures.length ? " — " + failures.join("; ") : ""}`);
process.exit(failures.length ? 1 : 0);
