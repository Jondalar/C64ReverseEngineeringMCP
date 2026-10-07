#!/usr/bin/env node
// Spec 889 — the C64U backend against the UE2 emulator (a whole Ultimate in software).
//
// NOT in gates.yml: it needs the emulator binary, the TRX firmware and trxmon.u2a, which
// live outside this repo. It SKIPS LOUDLY when any is missing — a check that quietly
// asserts nothing is worse than one that is absent.
//
// It starts `ue2emu` headless with its own flash image in a temp directory, `--net user`,
// and host forwards for REST (guest 80), the app (guest 4312) and the ident (guest UDP 64)
// on FREE ports of 127.0.0.1. trxmon.u2a sits on a `--usb-dir` volume, so it is
// `/Usb0/trxmon.u2a` on the device. Nothing here touches the LAN, port 4312 on this machine
// or a daemon this script did not start; the emulator is killed on the way out.
//
//   1  UDP ident (hostfwd) → trx64 {core TRX2, board C64U}; no rpc: our core, no trxmon
//   2  probe: core-no-monitor + start_monitor; REST start from the device path; probe: offered
//   3  select: ping trx64-runtime/2 / backend c64u, PAUSED on start → continue
//   4  RPC pass-through: session/state, read_memory, monitor/exec, break_add/del wrapping,
//      pause/step/continue, checkpoint/list, runtime/reverse_step; refusals by name
//   5  REST: text typed on the keyboard reaches BASIC (read back from screen RAM)
//   6  the gate: a PRG with no pass is refused, with a pass it runs on the device
//      (run_prg → $C000 written) — the exact bytes went over REST
//   7  trxmon/quit → "trxmon not running", REST still answers, no fallback
//
//   UE2EMU_DIR=/path/to/u64-emulator node scripts/e2e-889-ue2emu.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMU = process.env.UE2EMU_DIR ?? "/Users/alex/Development/u64-emulator";
const bin = join(EMU, "target/release/ue2emu");
const elf = join(EMU, "run/trx/ultimate-f2a26eae.elf");
const u2a = join(EMU, "run/trx/trxmon-f2a26eae.u2a");
const roms = join(EMU, "firmware/1541ultimate/roms");
const missing = [bin, elf, u2a, join(roms, "chars.bin")].filter((p) => !existsSync(p));
if (missing.length) {
  console.log(`Spec 889 — against the UE2 emulator\n\n  SKIPPED — missing: ${missing.join(", ")}\n  (set UE2EMU_DIR to a u64-emulator checkout with a release build and run/trx/*)`);
  process.exit(0);
}
if (!existsSync(join(ROOT, "dist/runtime/backend.js"))) { console.error("dist is not built — npm run build:mcp"); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const rejects = async (p) => { try { await p; return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

const work = mkdtempSync(join(tmpdir(), "c64re-889-ue2-"));
const usb = join(work, "usb");
mkdirSync(usb);
copyFileSync(u2a, join(usb, "trxmon.u2a"));
writeFileSync(join(work, "smoke.cfg"), "[User Interface Settings]\nNavigation Style=Quick Search\n[U64 Specific Settings]\nSystem Mode=PAL\n");
const restPort = await freePort(), rpcPort = await freePort(), udpPort = await freePort();

console.log("Spec 889 — the C64U backend against the UE2 emulator\n");
console.log(`  emulator: ${bin}\n  forwards: REST 127.0.0.1:${restPort}→80, app :${rpcPort}→4312, ident udp :${udpPort}→64\n  work dir: ${work}`);
const log = [];
const emu = spawn(bin, [
  "run", "--headless", "--board", "c64u", "--trx-io", "--firmware", elf, "--roms", roms,
  "--flash", join(work, "flash.bin"), "--c64-roms", "--settings", join(work, "smoke.cfg"),
  "--usb-dir", usb, "--usb-dir-work", join(work, "usbwork"),
  "--net", "user", "--web-port", "0",
  "--hostfwd", `tcp:127.0.0.1:${restPort}:80,tcp:127.0.0.1:${rpcPort}:4312,udp:127.0.0.1:${udpPort}:64`,
  "--monitor-dir", work, "--max-seconds", "600",
], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
emu.stdout.on("data", (d) => log.push(d.toString()));
emu.stderr.on("data", (d) => log.push(d.toString()));
const stopEmu = async () => { try { emu.kill("SIGTERM"); } catch { /* gone */ } await sleep(500); try { emu.kill("SIGKILL"); } catch { /* gone */ } };

const be = await dist("runtime/backend.js");
const disc = await dist("runtime/c64u/discovery.js");
const pass_ = await dist("runtime/emulator-pass.js");
const { ProjectKnowledgeService } = await dist("project-knowledge/service.js");
const proj = join(work, "proj");
mkdirSync(proj);
new ProjectKnowledgeService(proj).initProject({ name: "ue2" });

try {
  head("1  the device boots and answers (UDP ident, REST)");
  let info;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${restPort}/v1/info`, { signal: AbortSignal.timeout(3000) }); if (r.ok) { info = await r.json(); break; } } catch { /* still booting */ }
    if (emu.exitCode !== null) break;
    await sleep(1000);
  }
  check(!!info, "GET /v1/info answers through the forward", info ? `${info.product} ${info.firmware_version}` : log.join("").slice(-300));
  if (!info) throw new Error("the emulated device never answered");
  check(info.trx64?.core === "TRX2" && info.trx64.board === "C64U" && info.trx64.rpc === undefined, "/v1/info: trx64 {core TRX2, board C64U}, no rpc", JSON.stringify(info.trx64));
  const found = await disc.discoverUltimates({ targets: [{ address: "127.0.0.1", port: udpPort }], timeoutMs: 4000 });
  check(found.length === 1 && found[0].ident.trx64?.core === "TRX2", "the UDP ident answers with the same trx64 field", found[0] ? found[0].ident.hostname : "no answer");

  head("2  probe, start trxmon over REST");
  const p1 = await be.probeHost({ host: "127.0.0.1", restPort });
  check(p1.outcome === "core-no-monitor" && p1.action === "start_monitor" && !p1.selectable, "probe: our core, trxmon not running — Start monitor offered", p1.reason);
  const e1 = await rejects(be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort }, { rpcPort }));
  check(/trxmon not running on 127\.0\.0\.1 — start it/.test(e1 ?? ""), "select without trxmon: refused with the way out");
  const st = await be.startMonitorOn({ host: "127.0.0.1", restPort, trxmonPath: "/Usb0/trxmon.u2a" });
  check(st.started === true && /\/Usb0\/trxmon\.u2a/.test(st.note), "PUT /v1/apps:run_file?app=/Usb0/trxmon.u2a&action=serve", st.note);
  const p2 = await be.probeHost({ host: "127.0.0.1", restPort, rpcPort });
  check(p2.outcome === "offered" && p2.selectable && p2.ping?.backend === "c64u", "probe: offered — ping answered trx64-runtime/2, backend c64u", p2.reason);
  const st2 = await be.startMonitorOn({ host: "127.0.0.1", restPort, trxmonPath: "/Usb0/trxmon.u2a" });
  check(st2.started === false && /already running/.test(st2.note), "a second start is 423 = already running", st2.note);

  head("3  select, PAUSED on start");
  const sel = await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort }, { rpcPort });
  check(sel.identity.device.runtimeVersion === "trx64-runtime/2" && /^trxmon /.test(sel.identity.device.trxmonVersion ?? "") && sel.identity.device.board === "C64U", "identity: board C64U, trx64-runtime/2, trxmon version", `${sel.identity.device.trxmonVersion}; ${sel.identity.device.capabilities}`);
  const d = be.runtimeDaemon;
  const s0 = await d.state("shared");
  check(s0.runState === "running" && sel.notes.some((n) => /debug\/continue/.test(n)), "trxmon started paused; select continued it", sel.notes.join(" | "));
  check(s0.cpu && typeof s0.cpu.pc === "number" && s0.backend === "c64u" && s0.model === "c64-pal", "session/state in the daemon's shape (cpu, backend c64u, model)");

  head("4  the app's RPC through the backend");
  const mem = await d.readMemoryRange("shared", 0x0000, 4);
  check(mem.bytes?.length === 4 && mem.bytes[0] === 0x2f && mem.bytes[1] === 0x37, "session/read_memory: the processor port $2F/$37", JSON.stringify(mem.bytes));
  const mon = await d.monitorExec("shared", "r");
  check(typeof mon.output === "string" && /ADDR AC XR YR SP/.test(mon.output), "monitor/exec r → the monitor's register text");
  const e2 = await rejects(d.call("debug/break_add", {}));
  check(/needs `pc`/.test(e2 ?? ""), "break_add without pc: refused by the backend, nothing sent");
  const add = await d.call("debug/break_add", { pc: 0xc000 });
  check(add.breakpoints?.some((b) => b.addr === 0xc000), "break_add pc=$C000 on the device");
  check(/needs `id`/.test((await rejects(d.call("debug/break_del", {}))) ?? ""), "break_del without id: refused");
  const del = await d.call("debug/break_del", { all: true });
  check(del.breakpoints?.length === 0, "break_del all:true deletes them on request");
  const pz = await d.pause("shared");
  check(pz.runState === "paused" && pz.stop?.reason === "pause", "debug/pause");
  const sp = await d.call("debug/step", {});
  check(sp.stop?.reason === "step" && sp.pc !== pz.pc, "debug/step moves the PC", `${pz.pc} → ${sp.pc}`);
  const rs = await d.call("runtime/reverse_step", {});
  check(typeof rs.pc === "number" && rs.stepsTaken === 1, "runtime/reverse_step (the ring)", `pc ${rs.pc}`);
  const cps = await d.checkpointList("shared");
  check(Array.isArray(cps.checkpoints) && cps.checkpoints.length > 0, "checkpoint/list: the device's ring has anchors", `${cps.checkpoints.length}`);
  const res = await d.resume("shared");
  check(res.runState === "running", "debug/continue");
  const regs = await d.apiCall("shared", "monitorRegisters", []);
  check(typeof regs.pc === "number", "api/call monitorRegisters → session/state cpu");
  for (const m of ["trace/start_domains", "snapshot/dump", "runtime/overlay_run", "sandbox/run"]) {
    const e = await rejects(d.call(m, {}));
    check(e?.startsWith(`${m}: `) && / — /.test(e), `${m}: refused by name, with the way out`);
  }
  const s1 = await be.activeIdentity();
  check(s1.kind === "c64u" && /127\.0\.0\.1/.test(s1.label), "the identity names the device");

  head("5  REST: typing reaches BASIC");
  await d.pause("shared");
  const ty = await d.typeText("shared", "print 6*7\r");
  check(ty.queued === 10 && ty.afterRest?.debugState?.runState === "paused", "session/type: 10 taps, and debug/state re-read after it (§7)", `${ty.queued}`);
  await d.resume("shared");
  await sleep(4000);
  const scr = await d.readMemoryRange("shared", 0x0400, 1000);
  const text = Buffer.from(scr.bytes ?? []).toString("latin1");
  const rows = []; for (let r = 0; r < 25; r++) rows.push(Array.from((scr.bytes ?? []).slice(r * 40, r * 40 + 40), (c) => String.fromCharCode(c < 32 ? c + 64 : c)).join("").trimEnd());
  check(rows.some((r) => /PRINT 6\*7/.test(r)) && rows.some((r) => /^\s*42\s*$/.test(r)), "screen RAM shows PRINT 6*7 and its answer 42", rows.filter((r) => r.trim()).join(" / ").slice(0, 120));
  void text;

  head("6  the gate, on a real (emulated) device");
  const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
  const PRG = Buffer.from([...stub, 0x78, 0xa9, 0x5a, 0x8d, 0x00, 0xc0, 0x4c, 0x13, 0x08]); // SEI · $C000 := $5A · JMP *
  const prgPath = join(proj, "input", "mark.prg");
  mkdirSync(join(proj, "input"), { recursive: true });
  writeFileSync(prgPath, PRG);
  d.setProjectDir(proj);
  const eg = await rejects(d.runPrg("shared", prgPath));
  check(/mark\.prg \(sha256 [0-9a-f]{8}…\) has no green emulator run in this project/.test(eg ?? ""), "run_prg of a PRG with no pass: refused, names file + hash", eg?.slice(0, 80));
  const before = await d.readMemoryRange("shared", 0xc000, 1);
  check(before.bytes[0] !== 0x5a, "…and $C000 is untouched on the device", `$${before.bytes[0].toString(16)}`);
  pass_.recordEmulatorPass(proj, { media: [{ name: "mark.prg", bytes: new Uint8Array(PRG) }], steps: ["I wait 20 frames"], checks: [{ text: "Then $C000 is $5A", afterSteps: 1, actual: "$5a", pass: true }] });
  const run = await d.runPrg("shared", prgPath);
  check(run.loadAddress === 0x0801 && /RUN/.test(run.action), "with a recorded pass the PRG runs: POST runners:run_prg", run.action);
  await sleep(3000);
  const after = await d.readMemoryRange("shared", 0xc000, 1);
  check(after.bytes[0] === 0x5a, "$C000 = $5A on the device: the exact bytes ran", `$${after.bytes[0].toString(16)}`);

  head("7  trxmon gone");
  await d.call("trxmon/quit", {});
  await sleep(1500);
  const eq = await rejects(d.state("shared"));
  check(/^trxmon not running on 127\.0\.0\.1 — start it/.test(eq ?? ""), "after trxmon/quit: \"trxmon not running on <host> — start it or select the emulator\"", eq);
  const dr = await d.driveStatus("shared");
  check(dr.drive === "a", "REST still answers (drive status)");
  check(be.activeBackend().kind === "c64u", "…and nothing fell back to the emulator");
  const re = await be.startMonitorOn({ host: "127.0.0.1", restPort, trxmonPath: "/Usb0/trxmon.u2a" });
  await sleep(1500);
  const again = await rejects(d.state("shared"));
  check(re.started === true && again === undefined, "start again: the next call reconnects", again ?? "");
} catch (e) {
  check(false, "harness", e instanceof Error ? e.stack : String(e));
} finally {
  try { await be.selectBackend({ kind: "emulator" }); } catch { /* released */ }
  await stopEmu();
  if (fail) console.log(`\n  emulator console tail:\n${log.join("").split("\n").slice(-15).map((l) => "    " + l).join("\n")}\n  kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}  Spec 889 UE2: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
