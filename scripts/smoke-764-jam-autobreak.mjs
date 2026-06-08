// Spec 764 P1 — JAM auto-break smoke. A KIL ($02) opcode must auto-pause the
// RuntimeController and broadcast debug/stopped{reason:"jam", pc, opcode} exactly
// once per episode (re-armed on run()/reset). Run from repo root: node scripts/smoke-764-jam-autobreak.mjs
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const jamCount = () => events.filter((e) => e.method === "debug/stopped" && e.payload?.stop?.reason === "jam").length;
let ok = true;
const check = (name, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) ok = false; };

const { sessionId, session } = startIntegratedSession({});
session.runFor(2000); // settle past reset

session.c64Bus.write(0xC000, 0x02); // KIL
session.c64Cpu.pc = 0xC000;

const ctrl = new RuntimeController(sessionId, session, (method, payload) => events.push({ method, payload }));
ctrl.run();
await sleep(250);

const jam = events.find((e) => e.method === "debug/stopped" && e.payload?.stop?.reason === "jam");
check("JAM broadcast exactly once", jamCount() === 1);
check("runState paused", ctrl.runState === "paused");
check("stop pc = $C000", jam?.payload?.stop?.pc === 0xC000);
check("stop opcode = $02", jam?.payload?.stop?.opcode === 0x02);
check("cpu jammed", session.c64Cpu.jammed === true);

events.length = 0;
ctrl.run();
await sleep(150);
check("re-run while jammed → fires once more", jamCount() === 1);

session.c64Cpu.reset();
session.runFor(2000);
events.length = 0;
ctrl.run();
await sleep(150);
check("after reset → no jam", jamCount() === 0);

console.log(ok ? "\nsmoke-764 PASS" : "\nsmoke-764 FAIL");
process.exit(ok ? 0 : 1);
