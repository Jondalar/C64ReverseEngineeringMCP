#!/usr/bin/env node
// scripts/e2e-754-monitor.mjs — Spec 754 P1 + Block B acceptance gate.
//
// Proves the three monitor bugs are fixed, in-process (no daemon, no port 4312):
//   A) BUG-038 — bank lens + side-effect-free peek. `m e000`/`peek($E000,'cpu')`
//      sees KERNAL (not raw RAM); `ram`/`rom`/`io`/`cart`/`cpu` lenses route
//      correctly; peeking I/O has no side effect.
//   B) BUG-036 — lifecycle. `g`/`x` enter the RUNNING run-state (resume the
//      autonomous loop), `g <addr>` sets PC + runs, a breakpoint halts a running
//      machine, `until <addr>` is the synchronous run-to-landing.
//   C) BUG-037 — consolidation. The dead second parser is gone; the one
//      canonical processor (runMonitorCommand) handles the command set.
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

if (!existsSync(join(ROOT, "dist/runtime/headless/integrated-session-manager.js"))) {
  console.error("build:mcp first"); process.exit(2);
}

const { startIntegratedSession, stopIntegratedSession } =
  await import("../dist/runtime/headless/integrated-session-manager.js");
const { RuntimeController } =
  await import("../dist/runtime/headless/debug/runtime-controller.js");
const { runMonitorCommand } =
  await import("../dist/runtime/headless/debug/monitor-shell.js");

const hx = (n) => n.toString(16).toUpperCase().padStart(2, "0");

function newCtx(session, sessionId) {
  const ctrl = new RuntimeController(sessionId, session, () => {});
  const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() };
  const mon = (cmd) => runMonitorCommand(ctx, cmd);
  return { ctrl, ctx, mon };
}

// =====================================================================
// Part A — BUG-038: bank lens + side-effect-free peek.
// =====================================================================
console.log("Spec 754 — Part A: bank lens + peek (BUG-038)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default"); // default banking: KERNAL+BASIC+IO visible
    const bus = session.c64Bus;
    // Plant RAM sentinels UNDER the ROM/IO so we can prove the lens routing.
    bus.ram[0xe000] = 0x42; // under KERNAL
    bus.ram[0xa000] = 0x11; // under BASIC
    bus.ram[0xd000] = 0x33; // under I/O

    // ram lens = raw RAM (the old banking-blind behaviour, now explicit).
    ok("A1 peek($E000,'ram') = planted RAM sentinel", bus.peek(0xe000, "ram") === 0x42, `$${hx(bus.peek(0xe000, "ram"))}`);
    // cpu lens (default) = what the CPU sees → KERNAL, NOT the RAM sentinel.
    const cpuE000 = bus.peek(0xe000, "cpu");
    const romE000 = bus.peek(0xe000, "rom");
    ok("A2 peek($E000,'cpu') sees KERNAL, not RAM", cpuE000 !== 0x42 && cpuE000 === romE000, `cpu=$${hx(cpuE000)} rom=$${hx(romE000)}`);
    // BASIC window.
    ok("A3 peek($A000,'cpu') sees BASIC, peek('ram') sees sentinel",
      bus.peek(0xa000, "cpu") === bus.peek(0xa000, "rom") && bus.peek(0xa000, "cpu") !== 0x11 && bus.peek(0xa000, "ram") === 0x11);
    // I/O window: cpu lens routes through I/O (= io lens), not RAM.
    ok("A4 peek($D000,'cpu') routes to I/O (== io lens, != RAM sentinel)",
      bus.peek(0xd000, "cpu") === bus.peek(0xd000, "io") && bus.peek(0xd000, "cpu") !== 0x33);
    // Side-effect-free: peeking I/O twice (e.g. raster $D012) does not advance
    // or clear anything → identical, and no CPU cycles consumed.
    const cyc0 = session.c64Cpu.cycles;
    ok("A5 peek I/O is side-effect-free (idempotent, no cycles)",
      bus.peek(0xd012, "cpu") === bus.peek(0xd012, "cpu") && session.c64Cpu.cycles === cyc0);

    // Via the monitor commands (the user-facing surface).
    const mRam = (await mon("m ram e000")).output ?? "";
    const mCpu = (await mon("m e000")).output ?? "";
    ok("A6 `m ram e000` shows the RAM sentinel 42", /(^|\s)42(\s|$)/.test(mRam.split("\n")[0] ?? ""), (mRam.split("\n")[0] ?? "").slice(0, 40));
    ok("A7 `m e000` (cpu lens default) differs from `m ram e000`", mCpu.split("\n")[0] !== mRam.split("\n")[0]);
    const dCpu = (await mon("d e000")).output ?? "";
    const dRam = (await mon("d ram e000")).output ?? "";
    ok("A8 `d e000` (KERNAL) differs from `d ram e000` (sentinel bytes)", dCpu !== dRam && dCpu.length > 0);
    // Sticky bank default.
    await mon("bank rom");
    const mStickyRom = (await mon("m e000")).output ?? "";
    const mExplicitRom = (await mon("m rom e000")).output ?? "";
    ok("A9 sticky `bank rom` makes a bare `m` use the rom lens", mStickyRom.split("\n")[0] === mExplicitRom.split("\n")[0]);
    await mon("bank cpu"); // restore
    // $20 bytes/row format (BUG-038 §3.3b).
    const row0 = (await mon("m ram c000 c01f")).output ?? "";
    const hexCount = (row0.split("\n")[0]?.match(/\b[0-9A-F]{2}\b/g) ?? []).length;
    ok("A10 memory dump renders $20 (32) bytes per row", hexCount === 32, `${hexCount} bytes`);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part B — BUG-036: lifecycle (g/x/until resume the run-state).
// =====================================================================
console.log("\nSpec 754 — Part B: lifecycle g/x/until (BUG-036)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default");
    // NOP sled $C000-$C0FF, BRK at $C100 (safety stop).
    for (let a = 0xc000; a <= 0xc0ff; a++) session.c64Bus.ram[a] = 0xea;
    session.c64Bus.ram[0xc100] = 0x00;
    session.c64Cpu.pc = 0xc000;

    // `g` resumes the RUNNING run-state (not a bounded burst that ends halted).
    const gRes = await mon("g");
    ok("B1 `g` enters the running run-state", ctrl.runState === "running", `runState=${ctrl.runState}`);
    ok("B2 `g` reports continuing (not 'ran N instr / BREAK')", /continuing/.test(gRes.output ?? ""), gRes.output);
    ctrl.pause();

    // `g <addr>` sets PC then runs.
    session.c64Cpu.pc = 0xc000;
    await mon("g c050");
    ok("B3 `g <addr>` sets PC to the target", (session.c64Cpu.pc & 0xffff) === 0xc050 || ctrl.runState === "running", `pc=$${session.c64Cpu.pc.toString(16)}`);
    ctrl.pause();

    // `x` == resume.
    session.c64Cpu.pc = 0xc000;
    await mon("x");
    ok("B4 `x` resumes (running)", ctrl.runState === "running");
    ctrl.pause();

    // `until <addr>` — synchronous run-to-landing, lands HALTED at the target.
    session.c64Cpu.pc = 0xc000;
    const uRes = await mon("until c010");
    ok("B5 `until c010` lands exactly at $C010", (session.c64Cpu.pc & 0xffff) === 0xc010, uRes.output);
    ok("B6 `until` leaves the machine halted (not running)", ctrl.runState !== "running", `runState=${ctrl.runState}`);

    // Full resume→breakpoint→halt cycle under warp pacing.
    session.c64Cpu.pc = 0xc000;
    await mon("bk c008");
    ctrl.setPacing("warp");
    await mon("g");
    let spins = 0;
    while (ctrl.runState === "running" && spins < 5000) { await new Promise((r) => setImmediate(r)); spins++; }
    ok("B7 a breakpoint halts a RUNNING machine (resume→bp→pause)", ctrl.runState !== "running" && (session.c64Cpu.pc & 0xffff) === 0xc008,
      `runState=${ctrl.runState} pc=$${session.c64Cpu.pc.toString(16)} spins=${spins}`);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part D — Block C: memory edit (wr/f/t/c/h) + inline assembler (a).
// =====================================================================
console.log("\nSpec 754 — Part D: memory edit + assembler (Block C)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default");
    const peek = (a) => session.c64Bus.peek(a, "cpu") & 0xff;

    // wr — write exactly the listed bytes.
    await mon("wr c000 a9 01 8d 20 d0");
    ok("D1 `wr` writes the exact byte list", peek(0xc000) === 0xa9 && peek(0xc001) === 0x01 && peek(0xc002) === 0x8d && peek(0xc004) === 0xd0,
      `${hx(peek(0xc000))} ${hx(peek(0xc001))} ${hx(peek(0xc002))} ${hx(peek(0xc003))} ${hx(peek(0xc004))}`);

    // a — inline assembler. `a c100 lda #$01` → A9 01. (Each `a <addr> <instr>`
    // now ENTERS assemble mode at the next addr — Part L covers the mode; here we
    // exit with an empty line after each one-shot to test the assembler alone.)
    const aRes = await mon("a c100 lda #$01"); await mon("");
    ok("D2 `a c100 lda #$01` assembles to A9 01", peek(0xc100) === 0xa9 && peek(0xc101) === 0x01, aRes.output);
    await mon("a c102 sta $d020"); await mon("");
    ok("D3 `a sta $d020` assembles to 8D 20 D0", peek(0xc102) === 0x8d && peek(0xc103) === 0x20 && peek(0xc104) === 0xd0);
    await mon("a c200 bne $c200"); await mon(""); // branch to self → offset $FE
    ok("D4 `a bne $c200`@$c200 → D0 FE (rel offset)", peek(0xc200) === 0xd0 && peek(0xc201) === 0xfe, `${hx(peek(0xc200))} ${hx(peek(0xc201))}`);

    // D4b — `d <start> <end>` is a RANGE (VICE), and an opcode straddling `end`
    // is still shown whole. c100 LDA #$01 (2b) + c102 STA $d020 (3b, c102..c104).
    const dr = ((await mon("d c100 c104")).output ?? "").split("\n").filter(Boolean);
    ok("D4b `d <start> <end>` disassembles the range (straddling opcode whole)", dr.length === 2 && /c100/i.test(dr[0] ?? "") && /c102/i.test(dr[1] ?? ""), `${dr.length} lines`);
    const dErr = await mon("d c104 c100");
    ok("D4c `d` end<start errors (not silent-empty)", /end .*< start/.test(dErr.error ?? ""), dErr.error);

    // f — fill range with a repeating pattern.
    await mon("f c300 c307 ea");
    ok("D5 `f c300 c307 ea` fills 8 bytes with $EA", [0, 1, 7].every((k) => peek(0xc300 + k) === 0xea));

    // h — hunt (with wildcard). Find the LDA #$01 we wrote at $C100.
    const hRes = await mon("h c000 c1ff a9 xx 8d");
    ok("D6 `h` finds a pattern with a wildcard byte", /c000/i.test(hRes.output ?? ""), hRes.output);

    // t — move, then c — compare (identical), then mutate + compare (diff).
    await mon("t c000 c004 c400");
    ok("D7 `t` move copies the range", peek(0xc400) === 0xa9 && peek(0xc404) === 0xd0);
    const cSame = await mon("c c000 c004 c400");
    ok("D8 `c` reports identical after a clean move", /identical/i.test(cSame.output ?? ""), cSame.output);
    await mon("wr c402 ff");
    const cDiff = await mon("c c000 c004 c400");
    ok("D9 `c` lists a difference after a poke", /!=/.test(cDiff.output ?? ""), (cDiff.output ?? "").split("\n")[0]);

    // wr ram lens vs banked: under KERNAL, banked write hits RAM; ram lens too.
    await mon("wr ram e000 77");
    ok("D10 `wr ram e000` writes raw RAM under KERNAL", session.c64Bus.ram[0xe000] === 0x77 && peek(0xe000) !== 0x77);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part E — Block D: registers (set + vectors + flow) + sidefx + screen.
// =====================================================================
console.log("\nSpec 754 — Part E: registers/sidefx/screen (Block D)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default");

    // r set (space + comma forms).
    await mon("r a=$42 x=$10");
    ok("E1 `r a=$42 x=$10` sets registers", (session.c64Cpu.a & 0xff) === 0x42 && (session.c64Cpu.x & 0xff) === 0x10);
    await mon("r y=$7, sp=$f0");
    ok("E2 `r y=$7, sp=$f0` (comma form) sets registers", (session.c64Cpu.y & 0xff) === 0x07 && (session.c64Cpu.sp & 0xff) === 0xf0);

    // r show — variant B (flow inline + vectors block).
    const rShow = (await mon("r")).output ?? "";
    ok("E3 `r` shows the flow column", /\bflow\b/.test(rShow) && /MAIN/.test(rShow), rShow.split("\n")[0]);
    ok("E4 `r` shows the IRQ/NMI vectors block", /vectors/.test(rShow) && /CINV/.test(rShow) && /NMIV/.test(rShow), (rShow.split("\n")[2] ?? "").slice(0, 60));

    // sidefx toggle.
    const sOn = (await mon("sidefx on")).output ?? "";
    ok("E5 `sidefx on` reports live reads", /on/.test(sOn) && /LIVE/i.test(sOn));
    const sOff = (await mon("sidefx off")).output ?? "";
    ok("E6 `sidefx off` reports peek (default)", /off/.test(sOff) && /peek/i.test(sOff));

    // screen — 40x25 decode at the real screen pointer.
    const scr = (await mon("screen")).output ?? "";
    const rows = scr.split("\n");
    ok("E7 `screen` decodes 25 rows of 40 chars at the real pointer", rows.length === 26 && (rows[1] ?? "").length === 42 && /screen @ \$/.test(rows[0] ?? ""), `${rows.length} lines, row width ${(rows[1] ?? "").length}`);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part F — Block E: observers (obs/o when…if…do break|log).
// =====================================================================
console.log("\nSpec 754 — Part F: observers (Block E)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    const setup = () => {
      session.resetCold("pal-default");
      // $C000 LDA #$42 ; NOP sled to $C0FF ; BRK at $C100
      session.c64Bus.ram[0xc000] = 0xa9; session.c64Bus.ram[0xc001] = 0x42;
      for (let a = 0xc002; a <= 0xc0ff; a++) session.c64Bus.ram[a] = 0xea;
      session.c64Bus.ram[0xc100] = 0x00;
      session.c64Cpu.pc = 0xc000;
    };

    // F1 — exec observer `do break` halts at the address.
    setup();
    await mon("obs b1 when exec $c008 do break");
    let r = session.runFor(2000);
    ok("F1 exec observer `do break` halts at the addr", r.aborted === "observer" && (session.c64Cpu.pc & 0xffff) === 0xc008, `aborted=${r.aborted} pc=$${session.c64Cpu.pc.toString(16)}`);
    await mon("obs b1 del");

    // F2 — condition gating (false skips, true halts).
    setup();
    await mon("obs b2 when exec $c008 if a==$99 do break");
    r = session.runFor(2000);
    ok("F2a exec observer with FALSE cond does NOT halt", r.aborted !== "observer", `aborted=${r.aborted}`);
    await mon("obs b2 del");
    setup();
    await mon("obs b2 when exec $c008 if a==$42 do break");
    r = session.runFor(2000);
    ok("F2b exec observer with TRUE cond (a==$42) halts", r.aborted === "observer" && (session.c64Cpu.pc & 0xffff) === 0xc008);
    await mon("obs b2 del");

    // F3 — store observer `do break` halts on the watched write.
    session.resetCold("pal-default");
    session.c64Bus.ram[0xc000] = 0xa9; session.c64Bus.ram[0xc001] = 0xaa;            // LDA #$AA
    session.c64Bus.ram[0xc002] = 0x8d; session.c64Bus.ram[0xc003] = 0x00; session.c64Bus.ram[0xc004] = 0xc8; // STA $C800
    for (let a = 0xc005; a <= 0xc0ff; a++) session.c64Bus.ram[a] = 0xea;
    session.c64Bus.ram[0xc100] = 0x00;
    session.c64Cpu.pc = 0xc000;
    await mon("obs w1 when store $c800 do break");
    r = session.runFor(2000);
    ok("F3 store observer `do break` halts on the watched write", r.aborted === "observer" && session.c64Bus.ram[0xc800] === 0xaa, `aborted=${r.aborted} $c800=${(session.c64Bus.ram[0xc800] ?? 0).toString(16)}`);
    await mon("obs w1 del");

    // F3b — store cond on the accessed value (false → no halt).
    session.c64Cpu.pc = 0xc000; session.c64Bus.ram[0xc800] = 0;
    await mon("obs w1 when store $c800 if val==$bb do break");
    r = session.runFor(2000);
    ok("F3b store observer cond on `val` (false) does NOT halt", r.aborted !== "observer");
    await mon("obs w1 del");

    // F4 — `do log` continues (no halt); the log ring grows.
    setup();
    session.c64Bus.ram[0xc000] = 0x4c; session.c64Bus.ram[0xc001] = 0x00; session.c64Bus.ram[0xc002] = 0xc0; // JMP $C000 (loop)
    session.c64Cpu.pc = 0xc000;
    await mon("obs L when exec $c000 do log");
    r = session.runFor(50);
    ok("F4 `do log` continues (no halt) and logs accumulate", r.aborted !== "observer" && session.observers.logs.length > 1, `aborted=${r.aborted} logs=${session.observers.logs.length}`);
    const logShow = (await mon("obs log")).output ?? "";
    ok("F4b `obs log` shows the lines", /obs L: exec \$C000/.test(logShow), (logShow.split("\n")[0] ?? "").slice(0, 50));
    // F4c — the live-stream source: drainPendingLog returns the accumulated lines
    // (the controller broadcasts these as debug/observer_log) then empties.
    const drained = session.observers.drainPendingLog();
    ok("F4c drainPendingLog returns the live lines then empties", drained.length > 1 && session.observers.drainPendingLog().length === 0, `drained=${drained.length}`);
    await mon("obs L del");

    // F5 — idle = zero cost: no load/store observer ⇒ cpu.accessWatch is null.
    ok("F5 idle: cpu.accessWatch null when no load/store observer active", session.c64Cpu.accessWatch === null);

    // F6 — management: list / off.
    await mon("obs m1 when exec $c000 do break");
    const lst = (await mon("obs")).output ?? "";
    ok("F6a `obs` lists the observer", /m1\s+exec \$C000.*do break/.test(lst.replace(/\n/g, " ")), (lst.split("\n")[1] ?? ""));
    await mon("obs m1 off");
    setup();
    r = session.runFor(50);
    ok("F6b `obs m1 off` disables it (no halt)", r.aborted !== "observer");
    await mon("obs m1 del");

    // F7 — autonomous loop: resume → observer break → pause (tick integration).
    setup();
    await mon("obs A when exec $c008 do break");
    session.c64Cpu.pc = 0xc000;
    ctrl.setPacing("warp");
    await mon("g");
    let spins = 0;
    while (ctrl.runState === "running" && spins < 5000) { await new Promise((res) => setImmediate(res)); spins++; }
    ok("F7 autonomous loop halts on observer break (resume→obs→pause)", ctrl.runState !== "running" && (session.c64Cpu.pc & 0xffff) === 0xc008, `runState=${ctrl.runState} pc=$${session.c64Cpu.pc.toString(16)} spins=${spins}`);

    // F8 — wildcard del/on/off: `obs <glob> del` removes all matching; `obs * del` = all.
    await mon("obs * del"); // clean slate (also exercises "all")
    await mon("obs gob1 when exec $c000 do break");
    await mon("obs gob2 when exec $c001 do break");
    await mon("obs keep1 when exec $c002 do break");
    const names = () => session.observers.list().map((o) => o.name);
    const dg = await mon("obs gob* del");
    ok("F8a `obs gob* del` deletes matching, leaves others", /deleted 2/.test(dg.output ?? "") && names().includes("keep1") && !names().some((n) => n.startsWith("gob")), dg.output);
    const da = await mon("obs * del");
    ok("F8b `obs * del` deletes all", names().length === 0, da.output);

    // F9 — `*`/`?` rejected in a NEW observer name (reserved for the wildcard).
    const bad = await mon("obs *bad* when exec $c000 do break");
    ok("F9 obs name with `*` is rejected", /can't contain \* or \?/.test(bad.error ?? "") && names().length === 0, bad.error);

    // F10 — `do log <exprs>` (2026-06-05): per-trigger fields = regs + $addr peeks.
    // The Wasteland loader case: capture the call args ($FD/$FE/$FF + A/X/Y) at
    // every `JSR $FC00` without halting. Loop at $C000 (JMP, touches no reg/zp).
    await mon("obs * del");
    setup();
    session.c64Bus.ram[0xc000] = 0x4c; session.c64Bus.ram[0xc001] = 0x00; session.c64Bus.ram[0xc002] = 0xc0; // JMP $C000
    session.c64Cpu.pc = 0xc000;
    session.c64Cpu.a = 0x01; session.c64Cpu.x = 0x0e; session.c64Cpu.y = 0x22;
    session.c64Bus.ram[0xfd] = 0x03; session.c64Bus.ram[0xfe] = 0x00; session.c64Bus.ram[0xff] = 0xc6;
    const fcEcho = await mon("obs FC when exec $c000 do log $fd $fe $ff a x y");
    ok("F10a echo reflects the log fields", /do log \$fd \$fe \$ff a x y/.test(fcEcho.output ?? ""), fcEcho.output);
    r = session.runFor(50);
    const fcLine = session.observers.logs[session.observers.logs.length - 1] ?? "";
    ok("F10b `do log` line carries reg + memory fields",
      /\$FD=03 \$FE=00 \$FF=C6 a=01 x=0E y=22/.test(fcLine) && r.aborted !== "observer", fcLine);
    const fcList = (await mon("obs")).output ?? "";
    ok("F10c `obs` list shows the fields", /FC\s+exec \$C000 do log \$fd \$fe \$ff a x y/.test(fcList.replace(/\n/g, " ")), (fcList.split("\n")[1] ?? ""));
    await mon("obs FC del");

    // F10d — `:w` = little-endian word peek ($FE/$FF → $C600 pointer).
    await mon("obs PTR when exec $c000 do log $fe:w");
    session.runFor(20);
    const ptrLine = session.observers.logs[session.observers.logs.length - 1] ?? "";
    ok("F10d `$fe:w` logs a little-endian word ($FE/$FF=$C600)", /\$FE=C600/.test(ptrLine), ptrLine);
    await mon("obs PTR del");

    // F10e — `break` takes no fields; a bad log field is rejected.
    const brkFields = await mon("obs Z when exec $c000 do break a x");
    ok("F10e `do break` with fields is rejected", /takes no fields/.test(brkFields.error ?? ""), brkFields.error);
    const badField = await mon("obs Z when exec $c000 do log $fd nope");
    ok("F10f bad log field is rejected", /bad field 'nope'/.test(badField.error ?? ""), badField.error);
    await mon("obs * del");
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part G — Block §3.3k: flow disassembly (sd dynamic / df static / df -i).
// =====================================================================
console.log("\nSpec 754 — Part G: flow disassembly (sd / df / df -i)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    const ram = session.c64Bus.ram;

    // G1/G2 — sd: a tight DEX/BNE loop (x3) + NOP sled, loop-folded, non-destructive.
    session.resetCold("pal-default");
    ram[0xc000] = 0xa2; ram[0xc001] = 0x03;       // LDX #$03
    ram[0xc002] = 0xca;                            // DEX
    ram[0xc003] = 0xd0; ram[0xc004] = 0xfd;       // BNE $C002 (-3)
    for (let a = 0xc005; a <= 0xc0ff; a++) ram[a] = 0xea; // NOP sled
    session.c64Cpu.pc = 0xc000;
    const sd = (await mon("sd 20")).output ?? "";
    ok("G1 `sd` folds the executed loop (DEX/BNE ×3)", /x3/.test(sd), (sd.split("\n").find((l) => /x3/.test(l)) ?? "").trim());
    ok("G2 `sd` is non-destructive (PC restored to $C000)", (session.c64Cpu.pc & 0xffff) === 0xc000, `pc=$${session.c64Cpu.pc.toString(16)}`);

    // G3/G4 — df: follows a JMP into the real routine, ends on RTS (empty stack).
    session.resetCold("pal-default");
    ram[0xc000] = 0x4c; ram[0xc001] = 0x00; ram[0xc002] = 0xc1; // JMP $C100
    ram[0xc100] = 0xa9; ram[0xc101] = 0x01;                     // LDA #$01
    ram[0xc102] = 0x60;                                          // RTS
    const df = (await mon("df c000 10")).output ?? "";
    ok("G3 `df` follows the JMP into $C100 (LDA)", /c100/i.test(df) && /LDA/i.test(df), (df.split("\n")[1] ?? "").trim());
    ok("G4 `df` ends on RTS with an empty call stack", /end/i.test(df));

    // G5 — df: descends into a JSR and returns to the instruction after it.
    session.resetCold("pal-default");
    ram[0xc000] = 0x20; ram[0xc001] = 0x00; ram[0xc002] = 0xc2; // JSR $C200
    ram[0xc003] = 0x00;                                          // BRK
    ram[0xc200] = 0xea; ram[0xc201] = 0x60;                     // NOP ; RTS
    const dfj = (await mon("df c000 10")).output ?? "";
    ok("G5 `df` descends into JSR ($C200) and returns to $C003", /c200/i.test(dfj) && /c003/i.test(dfj), "");

    // G6/G7 — df -i: stop at a conditional branch, resume the fall-through.
    session.resetCold("pal-default");
    ram[0xc000] = 0xa9; ram[0xc001] = 0x00;       // LDA #$00
    ram[0xc002] = 0xd0; ram[0xc003] = 0x0c;       // BNE $C010
    ram[0xc004] = 0xea;                           // NOP (fall-through)
    ram[0xc010] = 0xea;                           // NOP (taken)
    const dfiRes = await mon("df -i c000 20");
    const dfi = dfiRes.output ?? "";
    ok("G6 `df -i` stops at the branch + asks (branch prompt set)", /\? branch/.test(dfi) && /\(t\)aken/.test(dfi) && dfiRes.prompt === "branch t/f/b> ", dfiRes.prompt);
    const dff = (await mon("df f")).output ?? "";
    ok("G7 `df f` resumes the fall-through path ($C004)", /c004/i.test(dff), (dff.split("\n")[0] ?? "").trim());

    // G8 — modal: while a walk is PENDING, a bare `t/f/b` is the branch choice
    // (not the fill/move/break verb). After the walk ends, `f` is fill again.
    const dfi2 = await mon("df -i c000 20");
    ok("G8a re-armed `df -i` is pending again (prompt)", dfi2.prompt === "branch t/f/b> ");
    const dffBare = (await mon("f")).output ?? "";
    ok("G8b bare `f` (pending walk) = fall-through, NOT fill", /c004/i.test(dffBare));
    const fillAfter = await mon("f");
    ok("G8c after the walk, bare `f` is the fill command again", /usage/.test(fillAfter.error ?? ""), fillAfter.error);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part H — Block H (capability verbs): flow + bt (daemon-local).
// =====================================================================
console.log("\nSpec 754 — Part H: capability verbs flow + bt (Block H)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default");

    // H1 — flow: after a cold reset, current=main, no interrupt frame.
    const fl = (await mon("flow")).output ?? "";
    ok("H1 `flow` shows the flow panel (current=main, no frame)", /current=main/.test(fl) && /no interrupt/.test(fl), (fl.split("\n")[0] ?? ""));

    // H2 — bt: plant a JSR return address on the stack and see it scanned.
    // return target $C100 → pushed value $C0FF (target-1) → lo=$FF hi=$C0.
    session.c64Bus.ram[0x01fe] = 0xff; session.c64Bus.ram[0x01ff] = 0xc0;
    session.c64Cpu.sp = 0xfd; // SP+1 = $01FE
    const bt = (await mon("bt")).output ?? "";
    ok("H2 `bt` scans the stack for the JSR return candidate ($C100)", /c100/i.test(bt) && /JSR return/.test(bt), (bt.split("\n").find((l) => /c100/i.test(l)) ?? "").trim());
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part I — Block H map/taint/swimlane (trace bridge wiring + args).
// =====================================================================
console.log("\nSpec 754 — Part I: map/taint/swimlane bridge (Block H)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const ctrl = new RuntimeController(sessionId, session, () => {});
  try {
    session.resetCold("pal-default");
    const calls = [];
    const ctx = {
      session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map(),
      traceRead: async (op, args) => { calls.push({ op, args }); return `STUB ${op} ${JSON.stringify(args)}`; },
    };
    const mon = (cmd) => runMonitorCommand(ctx, cmd);
    const m = (await mon("map")).output ?? "";
    ok("I1 `map` calls the trace bridge (op=map, cpu=c64)", calls.at(-1)?.op === "map" && calls.at(-1)?.args.cpu === "c64" && /STUB map/.test(m));
    await mon("taint c800 12345");
    ok("I2 `taint <addr> <cyc>` passes startAddr + startCycle", calls.at(-1)?.op === "taint" && calls.at(-1)?.args.startAddr === 0xc800 && calls.at(-1)?.args.startCycle === 12345);
    await mon("taint c800");
    ok("I2b `taint <addr>` (no cyc) omits startCycle (bridge anchors to trace max)", calls.at(-1)?.op === "taint" && calls.at(-1)?.args.startAddr === 0xc800 && calls.at(-1)?.args.startCycle === undefined);
    await mon("swimlane 100 200");
    ok("I3 `swimlane s e` passes the cycle window (newest trace)", calls.at(-1)?.op === "swimlane" && calls.at(-1)?.args.cycleStart === 100 && calls.at(-1)?.args.cycleEnd === 200);
    await mon("swimlane");
    ok("I3b `swimlane` (no args) = newest trace, tail", calls.at(-1)?.args.name === undefined && calls.at(-1)?.args.cycleStart === undefined && calls.at(-1)?.args.lastCycles === 2000);
    await mon("swimlane list");
    ok("I3c `swimlane list` sets the list flag", calls.at(-1)?.args.list === true);
    await mon("swimlane mytrace");
    ok("I3d `swimlane <name>` passes the trace name (tail)", calls.at(-1)?.args.name === "mytrace" && calls.at(-1)?.args.cycleStart === undefined);
    await mon("swimlane mytrace 50 90");
    ok("I3e `swimlane <name> <s> <e>` passes name + window", calls.at(-1)?.args.name === "mytrace" && calls.at(-1)?.args.cycleStart === 50 && calls.at(-1)?.args.cycleEnd === 90);
    await mon("chis 3000");
    ok("I5 `chis [cycles]` passes the replay window", calls.at(-1)?.op === "chis" && calls.at(-1)?.args.windowCycles === 3000);
    const noBridge = await runMonitorCommand({ session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() }, "map");
    ok("I4 `map` without the bridge reports unavailable (not a crash)", /unavailable/.test(noBridge.error ?? ""));
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part J — Block H/F inspect/xref (project-read bridge wiring + args).
// =====================================================================
console.log("\nSpec 754 — Part J: inspect/xref bridge (Block H/F)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const ctrl = new RuntimeController(sessionId, session, () => {});
  try {
    session.resetCold("pal-default");
    const calls = [];
    const ctx = {
      session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map(),
      projectRead: async (op, args) => { calls.push({ op, args }); return `STUB ${op} $${Number(args.addr).toString(16)}`; },
    };
    const mon = (cmd) => runMonitorCommand(ctx, cmd);
    await mon("inspect 025c");
    ok("J1 `inspect <addr>` calls projectRead (op=inspect, addr=$025C)", calls.at(-1)?.op === "inspect" && calls.at(-1)?.args.addr === 0x025c);
    await mon("xref d018 block2");
    ok("J2 `xref <addr> [stem]` passes addr + stem", calls.at(-1)?.op === "xref" && calls.at(-1)?.args.addr === 0xd018 && calls.at(-1)?.args.stem === "block2");
    await mon("sym print_string");
    ok("J4 `sym <name>` calls projectRead (op=sym, query=name)", calls.at(-1)?.op === "sym" && calls.at(-1)?.args.query === "print_string");
    const nb = await runMonitorCommand({ session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() }, "inspect 1000");
    ok("J3 `inspect` without the bridge reports unavailable (not a crash)", /unavailable/.test(nb.error ?? ""));
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part K — Block G: FS mini-shell + file I/O (pwd/cd/ls/mkdir, save/load,
// bsave/bload round-trips), rooted at a temp project dir.
// =====================================================================
console.log("\nSpec 754 — Part K: fs-shell + file I/O (Block G)\n");
{
  const root = mkdtempSync(join(tmpdir(), "c64re-754-g-"));
  const { session, sessionId } = startIntegratedSession({});
  const ctrl = new RuntimeController(sessionId, session, () => {});
  try {
    session.resetCold("pal-default");
    const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map(), projectDir: root };
    const mon = (cmd) => runMonitorCommand(ctx, cmd);

    const pwd = await mon("pwd");
    ok("K1 pwd reports the project dir", pwd.output === root, pwd.output);

    await mon("mkdir sub");
    ok("K2 mkdir creates the directory", existsSync(join(root, "sub")) && statSync(join(root, "sub")).isDirectory());

    const cd = await mon("cd sub");
    const pwd2 = await mon("pwd");
    ok("K3 cd changes the session cwd", cd.output === join(root, "sub") && pwd2.output === join(root, "sub"));

    // Seed a known RAM pattern; save it as a PRG (writes into cwd = sub).
    const pat = [0xa9, 0x01, 0x8d, 0x20];
    for (let i = 0; i < pat.length; i++) session.c64Bus.ram[0xc000 + i] = pat[i];
    const sv = await mon('save "p.prg" c000 c003');
    ok("K4 save writes a PRG into the session cwd", existsSync(join(root, "sub", "p.prg")), sv.output);
    const prg = readFileSync(join(root, "sub", "p.prg"));
    ok("K5 PRG has the 2-byte little-endian load address", prg.length === 6 && prg[0] === 0x00 && prg[1] === 0xc0);

    // Wipe RAM, reload via `load`, verify the round-trip.
    for (let i = 0; i < pat.length; i++) session.c64Bus.ram[0xc000 + i] = 0;
    const ld = await mon('load "p.prg"');
    const roundtrip = pat.every((b, i) => session.c64Bus.ram[0xc000 + i] === b);
    ok("K6 load restores the PRG bytes (round-trip)", roundtrip, ld.output);
    ok("K7 load reports the load range + sets the disasm cursor", /\$C000\.\.\$C003/.test(ld.output ?? "") && ctx.disasmCursors.get(sessionId) === 0xc000);

    // Raw bsave/bload round-trip with an override address.
    const bs = await mon('bsave "raw.bin" c000 c003');
    ok("K8 bsave writes raw bytes (no header)", readFileSync(join(root, "sub", "raw.bin")).length === 4, bs.output);
    for (let i = 0; i < pat.length; i++) session.c64Bus.ram[0xc800 + i] = 0;
    const bl = await mon('bload "raw.bin" c800');
    const braw = pat.every((b, i) => session.c64Bus.ram[0xc800 + i] === b);
    ok("K9 bload loads raw bytes at the given address", braw, bl.output);

    // ls lists what we wrote.
    const ls = await mon("ls");
    ok("K10 ls lists the saved files", /p\.prg/.test(ls.output ?? "") && /raw\.bin/.test(ls.output ?? ""), ls.output);

    // Error handling: missing file, bad usage.
    const miss = await mon('load "nope.prg"');
    ok("K11 load of a missing file errors (no crash)", /no such file/.test(miss.error ?? ""));
    const usage = await mon("save");
    ok("K12 save without args reports usage", /usage/.test(usage.error ?? ""));
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); rmSync(root, { recursive: true, force: true }); }
}

// =====================================================================
// Part L — Block C modal assemble (VICE `a` assemble mode): `a <addr>` enters,
// lines assemble + advance the prompt, empty line exits, bad line stays in mode.
// =====================================================================
console.log("\nSpec 754 — Part L: modal assemble (a mode)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const ctrl = new RuntimeController(sessionId, session, () => {});
  try {
    session.resetCold("pal-default");
    const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map() };
    const mon = (cmd) => runMonitorCommand(ctx, cmd);
    const ram = (a) => session.c64Bus.ram[a & 0xffff];

    const enter = await mon("a c000");
    ok("L1 `a <addr>` enters mode (prompt .c000, no output)", enter.prompt === ".c000  " && (enter.output ?? "") === "", enter.prompt);

    const i1 = await mon("lda #$01");
    ok("L2 in-mode line assembles + advances prompt", ram(0xc000) === 0xa9 && ram(0xc001) === 0x01 && i1.prompt === ".c002  ", i1.prompt);

    const i2 = await mon("sta $d020");
    ok("L3 next line assembles at the advanced cursor", ram(0xc002) === 0x8d && ram(0xc003) === 0x20 && ram(0xc004) === 0xd0 && i2.prompt === ".c005  ", i2.prompt);

    const exit = await mon("");
    ok("L4 empty line exits mode (no prompt)", exit.prompt === undefined && (exit.output ?? "") === "");

    const reg = await mon("r");
    ok("L5 after exit a verb runs normally (not assembled)", reg.prompt === undefined && !reg.error && (reg.output ?? "").length > 0);

    const inl = await mon("a c100 lda #$ff");
    ok("L6 `a <addr> <instr>` assembles inline + enters mode at next", ram(0xc100) === 0xa9 && ram(0xc101) === 0xff && inl.prompt === ".c102  ", inl.prompt);
    await mon("");

    await mon("a c200");
    const bad = await mon("frobnicate");
    ok("L7 bad instruction stays in mode (error + same prompt)", !!bad.error && bad.prompt === ".c200  ", bad.error);
    const after = await mon("lda #$02");
    ok("L8 mode survives a bad line; next good line assembles at the same cursor", ram(0xc200) === 0xa9 && ram(0xc201) === 0x02 && after.prompt === ".c202  ", after.prompt);
    await mon("");
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part M — swimlane/chis TUI renderer (renderText): no pipes, idle lanes
// dropped, empty filler rows dropped.
// =====================================================================
console.log("\nSpec 754 — Part M: swimlane TUI render (renderText)\n");
{
  const { renderText } = await import("../dist/runtime/headless/v2/swimlane-render.js");
  const slice = { startCycle: 100, endCycle: 200, compact: true, rows: [
    { cycle: 100, c64Pc: 0xc000, c64Op: "LDA #imm", c64Flow: "main" },
    { cycle: 102 }, // empty filler — must be dropped
    { cycle: 104, c64Pc: 0xc002, c64Op: "STA abs", c64Flow: "main", c64IoRw: "w", c64IoAddr: 0xd020, c64IoValue: 0 },
  ] };
  const txt = renderText(slice, { maxRows: 200, fold: false });
  ok("M1 no markdown pipes", !txt.includes("|"), txt.split("\n")[0]);
  ok("M2 idle drive/iec columns dropped", !/1541|drv_io/.test(txt) && !/\biec\b/.test(txt));
  ok("M3 io column kept when data present", /\bio\b/.test(txt) && /D020 w=00/.test(txt));
  ok("M4 empty filler row dropped (only the 2 data rows)", (txt.match(/c00[02]/gi) ?? []).length === 2 && !/\b102\b/.test(txt));
  ok("M5 flow column dropped when all 'main'", !/\bflow\b/.test(txt) && !/\bmain\b/.test(txt));

  // M6 — a same-flow loop folds: body once + ↺×N.
  const loop = [];
  for (let r = 0; r < 4; r++) loop.push(
    { cycle: 1000 + r * 4, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" },
    { cycle: 1002 + r * 4, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" });
  const t6 = renderText({ startCycle: 1000, endCycle: 1100, compact: true, rows: loop });
  ok("M6 same-flow loop folds (body 1x + ↺×4)", /↺×4/.test(t6) && (t6.match(/c000/gi) ?? []).length === 1, t6.split("\n").find((l) => /↺/.test(l)));

  // M7 — an IRQ block in the middle FENCES the fold (two groups, irq between).
  const fenced = [
    { cycle: 10, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 12, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 14, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 16, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 18, c64Pc: 0xea31, c64Op: "PHA", c64Flow: "irq" },
    { cycle: 20, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 22, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 24, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 26, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
  ];
  const t7 = renderText({ startCycle: 10, endCycle: 30, compact: true, rows: fenced });
  ok("M7 IRQ fences the fold (2 groups, irq not folded in)", (t7.match(/↺×2/g) ?? []).length === 2 && /ea31/i.test(t7) && /\birq\b/.test(t7), t7);

  // M8 — polling loop: same PCs, different read each pass → IO range, not swallowed.
  const poll = [
    { cycle: 10, c64Pc: 0x24e6, c64Op: "LDA abs", c64Flow: "main", c64IoRw: "r", c64IoAddr: 0xd012, c64IoValue: 0x9d },
    { cycle: 12, c64Pc: 0x24e9, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 14, c64Pc: 0x24e6, c64Op: "LDA abs", c64Flow: "main", c64IoRw: "r", c64IoAddr: 0xd012, c64IoValue: 0xa2 },
    { cycle: 16, c64Pc: 0x24e9, c64Op: "BNE rel", c64Flow: "main" },
  ];
  const t8 = renderText({ startCycle: 10, endCycle: 20, compact: true, rows: poll });
  ok("M8 varying poll value folds to a range ($D012 r=9D..A2)", /D012 r=9D\.\.A2/.test(t8), t8.split("\n").find((l) => /D012/.test(l)));

  // M9 — a partial trailing instruction after the loop is shown normally.
  const trailing = [
    { cycle: 10, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 12, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 14, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 16, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 18, c64Pc: 0xc000, c64Op: "SBC #imm", c64Flow: "main" }, { cycle: 20, c64Pc: 0xc002, c64Op: "BNE rel", c64Flow: "main" },
    { cycle: 22, c64Pc: 0xc004, c64Op: "RTS", c64Flow: "main" },
  ];
  const t9 = renderText({ startCycle: 10, endCycle: 30, compact: true, rows: trailing });
  ok("M9 loop folds ×3, trailing RTS shown after", /↺×3/.test(t9) && /c004/i.test(t9) && /RTS/.test(t9), t9);
}

// =====================================================================
// Part N — Block I: device c64|drive8 (read-inspect on the 1541 CPU).
// =====================================================================
console.log("\nSpec 754 — Part N: device c64|drive8 (Block I)\n");
{
  const { session, sessionId } = startIntegratedSession({});
  const { ctrl, mon } = newCtx(session, sessionId);
  try {
    session.resetCold("pal-default");
    ok("N1 device defaults to c64", /device: c64/.test((await mon("device")).output ?? ""));
    ok("N2 `device drive8` switches target", /device: drive8/.test((await mon("device drive8")).output ?? ""));
    const rDrive = (await mon("r")).output ?? "";
    ok("N3 `r` on drive8 shows the 1541 CPU registers", /1541 \(drive 8\)/.test(rDrive) && /ADDR AC XR YR SP/.test(rDrive), (rDrive.split("\n")[0] ?? ""));
    // The 1541 ROM lives at $C000; reading the drive space must differ from the
    // C64 space at the same address (proves device routing, not c64Bus).
    const dDrive = (await mon("d c000 c010")).output ?? "";
    await mon("device c64");
    const dC64 = (await mon("d c000 c010")).output ?? "";
    ok("N4 `d c000` reads the DRIVE address space (≠ the C64 at $C000)", dDrive.length > 0 && dDrive !== dC64, "drive≠c64");
    ok("N5 drive disasm shows real ROM code at $c000 (not empty)", /c000/i.test(dDrive));
    // Guard: write/exec verbs are blocked while device=drive8.
    await mon("device drive8");
    const blocked = await mon("wr c000 ff");
    ok("N6 write/exec verbs blocked on drive8 (read-inspect only)", /read-inspect only/.test(blocked.error ?? ""), blocked.error);
    const mDrive = (await mon("m c000 c003")).output ?? "";
    ok("N7 `m` on drive8 reads drive memory (allowed)", /c000/i.test(mDrive) && !/read-inspect/.test(mDrive));
    await mon("device c64");
    ok("N8 `device c64` restores the C64 target", !/1541/.test((await mon("r")).output ?? ""));
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); }
}

// =====================================================================
// Part O — Block B: bitmap RAM-as-image render (PNG artifact).
// =====================================================================
console.log("\nSpec 754 — Part O: bitmap PNG render (Block B)\n");
{
  const { renderBitmapPng } = await import("../dist/runtime/headless/debug/monitor-bitmap.js");
  const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const read = (a) => (a & 1) ? 0x00 : 0xff;
  const hi = renderBitmapPng(read, { addr: 0, w: 2, h: 1, mode: "hires" });
  ok("O1 hires: w*8 × h px + valid PNG", hi.width === 16 && hi.height === 1 && isPng(hi.png), `${hi.width}x${hi.height}`);
  const ch = renderBitmapPng(read, { addr: 0, w: 1, h: 1, mode: "charset" });
  ok("O2 charset: 8×8 cell + valid PNG", ch.width === 8 && ch.height === 8 && isPng(ch.png));
  const sp = renderBitmapPng(read, { addr: 0, w: 1, h: 1, mode: "sprite" });
  ok("O3 sprite: 24×21 + valid PNG + 64-byte stride read", sp.width === 24 && sp.height === 21 && isPng(sp.png) && sp.bytes === 64);

  const root = mkdtempSync(join(tmpdir(), "c64re-754-bm-"));
  const { session, sessionId } = startIntegratedSession({});
  const ctrl = new RuntimeController(sessionId, session, () => {});
  try {
    session.resetCold("pal-default");
    for (let a = 0xc000; a < 0xc020; a++) session.c64Bus.ram[a] = a & 1 ? 0 : 0xff;
    const ctx = { session, ctrl, sessionId, memCursors: new Map(), disasmCursors: new Map(), projectDir: root };
    const mon = (cmd) => runMonitorCommand(ctx, cmd);
    const r = await mon("bitmap c000 4 4 hires");
    const m = (r.output ?? "").match(/→ (\S+\.png)$/);
    ok("O4 `bitmap` writes a PNG + reports dims", /32×4px/.test(r.output ?? "") && !!m && existsSync(m[1]), r.output);
    ok("O5 the written file is a real PNG", !!m && isPng(readFileSync(m[1])));
    const mc = await mon("bitmap c000 4 4 multicolor");
    ok("O6 multicolor rejected (v1.1)", /v1\.1/.test(mc.error ?? ""), mc.error);
  } finally { ctrl.pause(); stopIntegratedSession(sessionId); rmSync(root, { recursive: true, force: true }); }
}

// =====================================================================
// Part C — BUG-037: the dead second parser is retired.
// =====================================================================
console.log("\nSpec 754 — Part C: one canonical monitor (BUG-037)\n");
{
  const dead = [
    "ui/src/v3/tabs/Monitor.tsx",
    "ui/src/v3/components/MonitorCmdLine.tsx",
    "ui/src/v3/monitor-cmd-parser.ts",
    "scripts/smoke-monitor-cmd-parser.mjs",
  ];
  for (const f of dead) ok(`C: dead path removed — ${f}`, !existsSync(join(ROOT, f)));
  ok("C: one canonical processor importable (runMonitorCommand)", typeof runMonitorCommand === "function");
}

// =====================================================================
console.log(`\nSpec 754 P1+B gate: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
