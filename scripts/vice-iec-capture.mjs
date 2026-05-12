#!/usr/bin/env node
// Spec 143 — VICE binmon → BusAccessEvent JSONL capture.
//
// Drives x64sc with -binarymonitor (NO -warp per Q10), sets four
// checkpoints (read+write × c64 $DD00 + drive $1800), captures hits
// into the same Spec 142 schema.
//
// Usage:
//   npm run trace:motm-vice -- [--id motm] [--port 6502] [--budget-ms 300000]
//                              [--max-events 2000]
//                              [--vice /Applications/vice-arm64-gtk3-3.10/bin/x64sc]
//                              [--no-autostart] [--basic-ready-wait <s>] [--no-run]
//
// --no-autostart mode:
//   Replaces -autostart with -8 (attach disk without auto-boot). After VICE
//   starts, waits --basic-ready-wait seconds (default 4) for BASIC READY prompt,
//   then injects LOAD"*",8,1\n via VICE binmon keyboardFeed (CMD 0x72). Waits 5 s
//   for KERNAL LOAD to begin. Then injects RUN\n after 10 s (unless --no-run).
//   This mirrors the headless boot sequence exactly (headless-swimlane-capture.mjs).
//
// Output: traces/<id>_vice_<ts>.jsonl
//
// ─────────────────────────────────────────────────────────────────────────────
// SWIMLANE MODE  (--swimlane flag)
// ─────────────────────────────────────────────────────────────────────────────
//
// Adds --swimlane flag that captures a wider per-event row containing complete
// chip-state snapshots from both C64 and 1541 sides at every sync-point.
//
// Sync-point triggers (8 checkpoints):
//   c64-r-DD00  C64 read  CIA2 PA  ($DD00) — IEC bus C64 side
//   c64-w-DD00  C64 write CIA2 PA  ($DD00)
//   c64-r-DC0D  C64 read  CIA1 ICR ($DC0D) — KERNAL serial timer IRQ
//   c64-w-DC0D  C64 write CIA1 ICR ($DC0D)
//   drv-r-1800  Drive read  VIA1 PRB ($1800) — IEC bus drive side
//   drv-w-1800  Drive write VIA1 PRB ($1800)
//   drv-r-1C00  Drive read  VIA2 PRB ($1C00) — head/motor (completeness)
//   drv-w-1C00  Drive write VIA2 PRB ($1C00)
//
// Output file: traces/<id>_swimlane_<ts>/vice.jsonl
//
// Row schema:
// {
//   "ts":    <c64_cycle>,        // maincpu clock counter (from getCpuHistory)
//   "tdrv":  <drive_cycle>,      // drive cpu clock counter
//   "src":   "<event-tag>",      // one of the 8 tags above
//   "addr":  <hit-addr>,         // $DD00, $DC0D, $1800, or $1C00
//   "value": <byte-on-bus>,      // byte at addr (post-event state)
//   "c64":  { "pc","a","x","y","sp","p" },
//   "vic":  { "raster","ctrl1","irq","imr" },
//   "cia1": { "pra","prb","icr","imr","ta","tb","cra","crb" },
//   "cia2": { "pra","prb","icr","imr","ta","tb","cra","crb" },
//   "iec":  { "atn","clk","data","srq" },   // 1=line low (asserted), 0=high
//   "drv":  { "pc","a","x","y","sp","p" },
//   "via1": { "pra","prb","ifr","ier","pcr","acr" },
//   "via2": { "pra","prb","ifr","ier" }
// }
//
// IEC pin derivation (VICE-faithful — follows c64iec.c + via1d1541.c):
//
//   C64 side (c64cia2.c store_ciapa, line 150):
//     tmp = ~cia2_pa                     // CIA2 PA output bits are inverted
//     cpu_bus = ((tmp<<2)&0x80)          // bit5 of tmp → bit7: DATA_OUT_L
//             | ((tmp<<2)&0x40)          // bit4 of tmp → bit6: CLK_OUT_L
//             | ((tmp<<1)&0x10)          // bit3 of tmp → bit4: ATN_OUT_L
//
//   IEC line state (wired-AND, open-collector, active-low):
//     ATN  line low (active) when ATN_OUT_L bit set in cpu_bus, i.e.
//          when cia2_pa bit3 == 0 (PA bit 3 pulled low = ATN asserted)
//     CLK  line low when C64 or drive drives it low.
//     DATA line low when C64, drive, or ATNA-gate drives it low.
//
//   We report 1=line low (asserted/active), 0=line high (released):
//     atn  = 1 if cia2_pa bit3 == 0   (ATN is C64-only, bit3 of PA)
//     clk  = 1 if cia2_pa bit6 == 0   (CLK_IN: 0 means line is low)
//     data = 1 if cia2_pa bit7 == 0   (DATA_IN: 0 means line is low)
//     srq  = 0                         (not accessible via binmon)
//
//   Drive side (via1d1541.c read_prb, line 335):
//     via1_prb_raw = ((via1.PRB & 0x1a) | drv_port) ^ 0x85
//     After XOR 0x85: bit0=DATA_IN, bit2=CLK_IN, bit7=ATN_IN
//     (0x85 = 0b10000101 inverts bit7+bit2+bit0)
//
//   Note: VICE binmon readMemory returns the post-XOR byte for drive $1800
//   (it goes through the via read handler). So via1.prb from readMemory IS
//   the value the drive 6502 saw: bit0=DATA, bit2=CLK, bit7=ATN (active=0).
//
// Limitations:
//   - tdrv cycle obtained from getCpuHistory(1, MEMSPACE_DRIVE); approximation.
//   - cia1.icr / cia2.icr from readMemory: for ICR, reading via side-effect
//     (read clears latch) — we use bankId=0 which goes through memory map.
//     This is a known limitation; consider it snapshot-only, not functional read.
//   - SRQ line (srq) not accessible from binmon; always 0 in output.
//   - at_boundary: VICE checkpoint fires at the ACCESS cycle; approximately
//     at instruction boundary for the accessing instruction.
//
// Limitations (Q11 doc):
//   - at_boundary approximated (instruction_pc == checkpoint_pc heuristic).
//   - phase = undefined (VICE binmon doesn't expose microcode step).
//   - cycle_c64/cycle_drive from CLK register (R7) per memspace.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const id = args.id ?? "motm";
const port = Number(args.port ?? 6502);
const budgetMs = Number(args["budget-ms"] ?? 300_000);
const maxEvents = Number(args["max-events"] ?? 2000);
const vicePath = args.vice ?? "/Applications/vice-arm64-gtk3-3.10/bin/x64sc";
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;
const swimlane = Boolean(args.swimlane);

// Manifest lookup
const manifest = JSON.parse(readFileSync(join(repoRoot, "samples/test-manifest.json"), "utf-8"));
const entry = manifest.entries.find((e) => e.id === id);
if (!entry) {
  console.error(`Manifest entry not found: id=${id}`);
  process.exit(2);
}
const diskPath = join(repoRoot, "samples", entry.file);
if (!existsSync(diskPath)) {
  console.error(`Disk image not found: ${diskPath}`);
  process.exit(2);
}

const noAutostart = Boolean(args["no-autostart"]);
const basicReadyWait = Number(args["basic-ready-wait"] ?? 4) * 1000;  // ms
const noRun = Boolean(args["no-run"]);

const tsTag = new Date().toISOString().replace(/[:.]/g, "-");

let outPath;
if (args.out) {
  outPath = resolve(projectDir, args.out);
} else if (swimlane) {
  // Swimlane: dedicated sub-directory, file named vice.jsonl
  const swimDir = join(projectDir, "traces", `swimlane_${id}_${tsTag}`);
  mkdirSync(swimDir, { recursive: true });
  outPath = join(swimDir, "vice.jsonl");
} else {
  outPath = join(projectDir, "traces", `${id}_vice_${tsTag}.jsonl`);
}
mkdirSync(dirname(outPath), { recursive: true });

console.error(swimlane ? `Spec 143 VICE swimlane capture` : `Spec 143 VICE capture`);
console.error(`Manifest: ${entry.id} (${entry.family})`);
console.error(`Disk: ${diskPath}`);
console.error(`VICE: ${vicePath}`);
console.error(`Output: ${outPath}`);
console.error(`Budget: ${budgetMs} ms  Max events: ${maxEvents}`);
if (swimlane) console.error(`Mode: SWIMLANE (full chip-state per sync-point)`);
if (noAutostart) console.error(`Boot: --no-autostart (attach-only + manual LOAD/RUN via keyboardFeed; BASIC wait=${basicReadyWait/1000}s${noRun ? " --no-run" : ""})`);

// Clean any prior x64sc on this port
try {
  const { execSync } = await import("node:child_process");
  execSync(`pkill -9 -f x64sc || true`, { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
} catch {}

// Spawn VICE
const viceArgs = [
  "-default",
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  ...(noAutostart
    // Attach disk without auto-boot; BASIC will reach READY prompt on its own.
    ? ["-8", diskPath]
    // Default: autostart loads and runs the first file automatically.
    : ["-autostart", diskPath]
  ),
];
console.error(`Spawning: ${vicePath} ${viceArgs.join(" ")}`);
const child = spawn(vicePath, viceArgs, { stdio: ["ignore", "ignore", "ignore"] });
await new Promise((r) => setTimeout(r, 2500));

const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");

const client = new ViceMonitorClient({ host: "127.0.0.1", port });
let connected = false;
for (let i = 0; i < 12; i++) {
  try { await client.connect(2000); connected = true; break; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!connected) {
  console.error("Could not connect to VICE binmon");
  child.kill("SIGKILL");
  process.exit(1);
}

const MEMSPACE_C64   = 0x00;
const MEMSPACE_DRIVE = 0x01;
const REG_PC = 3;
const REG_A  = 0;
const REG_X  = 1;
const REG_Y  = 2;
const REG_SP = 4;
const REG_SR = 5;  // status/processor flags

// VICE doesn't expose a single global CLK register. Use getCpuHistory(1)
// per side which returns `clock: string` per item.
async function getClock(memspace) {
  try {
    const hist = await client.getCpuHistory(1, memspace);
    if (hist.length > 0) return Number(hist[0].clock);
  } catch {}
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SWIMLANE helpers
// ─────────────────────────────────────────────────────────────────────────────

// Read a range of bytes from VICE memory and return as an array.
// bankId=0 = current bank (default); goes through memory map (side-effecting).
async function readBytes(startAddr, endAddr, memspace) {
  const buf = await client.readMemory(startAddr, endAddr, 0, memspace);
  const result = [];
  for (let i = 0; i <= endAddr - startAddr; i++) result.push(buf[i] ?? 0);
  return result;
}

function regsToMap(regs) {
  const m = {};
  for (const r of regs) m[r.id] = r.value;
  return m;
}

// Derive IEC pin state from CIA2 PA register value.
// Follows VICE c64cia2.c + c64iec.c faithfully.
//
// CIA2 PA bit layout (as documented in c64cia2.c lines 157-162):
//   Bit 3  Serial Bus ATN Signal Output  (0 = line pulled low = ATN asserted)
//   Bit 4  Serial Bus Clock Pulse Output (0 = line pulled low)
//   Bit 5  Serial Bus Data Output        (0 = line pulled low)
//   Bit 6  Serial Bus Clock Pulse Input  (0 = CLK line is low)
//   Bit 7  Serial Bus Data Input         (0 = DATA line is low)
//
// We report 1 = line low/asserted (active), 0 = line high/released (idle).
// The C64 cannot see ATN_IN (ATN is output-only from C64 perspective).
function iecFromCia2Pa(cia2Pra) {
  // ATN:  line low when C64 drives it low (PA bit3 = 0 → ATN asserted)
  const atn  = ((cia2Pra >> 3) & 1) ^ 1;   // 1=line low
  // CLK:  CIA2 PA bit6 reflects CLK_IN from the line (0 = line is low)
  const clk  = ((cia2Pra >> 6) & 1) ^ 1;   // 1=line low
  // DATA: CIA2 PA bit7 reflects DATA_IN from the line (0 = line is low)
  const data = ((cia2Pra >> 7) & 1) ^ 1;   // 1=line low
  // SRQ:  not wired into CIA2 PA in standard 1541 config; always 0
  const srq  = 0;
  return { atn, clk, data, srq };
}

// Capture full chip state for a swimlane row.
// Called while VICE is paused at a checkpoint.
async function captureSwimlaneFull(src, hitAddr, hitMemspace) {
  // ── Clocks ──────────────────────────────────────────────────────────────
  const [ts, tdrv] = await Promise.all([
    getClock(MEMSPACE_C64),
    getClock(MEMSPACE_DRIVE),
  ]);

  // ── C64 CPU registers ────────────────────────────────────────────────────
  const c64Regs = regsToMap(await client.getRegisters(MEMSPACE_C64));
  const c64 = {
    pc: (c64Regs[REG_PC] ?? 0) & 0xffff,
    a:  (c64Regs[REG_A]  ?? 0) & 0xff,
    x:  (c64Regs[REG_X]  ?? 0) & 0xff,
    y:  (c64Regs[REG_Y]  ?? 0) & 0xff,
    sp: (c64Regs[REG_SP] ?? 0) & 0xff,
    p:  (c64Regs[REG_SR] ?? 0) & 0xff,
  };

  // ── Drive CPU registers ──────────────────────────────────────────────────
  const drvRegs = regsToMap(await client.getRegisters(MEMSPACE_DRIVE));
  const drv = {
    pc: (drvRegs[REG_PC] ?? 0) & 0xffff,
    a:  (drvRegs[REG_A]  ?? 0) & 0xff,
    x:  (drvRegs[REG_X]  ?? 0) & 0xff,
    y:  (drvRegs[REG_Y]  ?? 0) & 0xff,
    sp: (drvRegs[REG_SP] ?? 0) & 0xff,
    p:  (drvRegs[REG_SR] ?? 0) & 0xff,
  };

  // ── VIC-II: $D011 ctrl1, $D012 raster, $D019 irq, $D01A imr ─────────────
  // Reading these via memory map; $D012 = current raster line (low 8 bits).
  // High bit of raster is in $D011 bit 7.
  const vicBytes = await readBytes(0xd011, 0xd01a, MEMSPACE_C64);
  // vicBytes[0]=$D011, [1]=$D012 raster_lo, [8]=$D019 irq, [9]=$D01A imr
  const ctrl1    = vicBytes[0] ?? 0;
  const rasterLo = vicBytes[1] ?? 0;
  const rasterHi = (ctrl1 >> 7) & 1;
  const vic = {
    raster: (rasterHi << 8) | rasterLo,
    ctrl1,
    irq: vicBytes[8] ?? 0,   // $D019 IRQ status
    imr: vicBytes[9] ?? 0,   // $D01A IRQ enable mask
  };

  // ── CIA1 ($DC00–$DC0F): pra prb icr imr ta tb cra crb ───────────────────
  // Register layout (MOS 6526):
  //   $DC00 PRA, $DC01 PRB, $DC02 DDRA, $DC03 DDRB,
  //   $DC04 TA_LO, $DC05 TA_HI, $DC06 TB_LO, $DC07 TB_HI,
  //   $DC08 TOD_10, $DC09 TOD_SEC, $DC0A TOD_MIN, $DC0B TOD_HR,
  //   $DC0C SDR, $DC0D ICR, $DC0E CRA, $DC0F CRB
  // NOTE: Reading $DC0D (ICR) via readMemory IS side-effecting (clears latch).
  //       We accept this limitation — it is documented above.
  const cia1Bytes = await readBytes(0xdc00, 0xdc0f, MEMSPACE_C64);
  const cia1 = {
    pra: cia1Bytes[0x00] ?? 0,
    prb: cia1Bytes[0x01] ?? 0,
    icr: cia1Bytes[0x0d] ?? 0,   // reading this clears latch — see limitation note
    imr: cia1Bytes[0x0d] ?? 0,   // approximation: ICR read gives both status+mask bits
    ta:  ((cia1Bytes[0x05] ?? 0) << 8) | (cia1Bytes[0x04] ?? 0),
    tb:  ((cia1Bytes[0x07] ?? 0) << 8) | (cia1Bytes[0x06] ?? 0),
    cra: cia1Bytes[0x0e] ?? 0,
    crb: cia1Bytes[0x0f] ?? 0,
  };

  // ── CIA2 ($DD00–$DD0F) ────────────────────────────────────────────────────
  const cia2Bytes = await readBytes(0xdd00, 0xdd0f, MEMSPACE_C64);
  const cia2Pra = cia2Bytes[0x00] ?? 0;
  const cia2 = {
    pra: cia2Pra,
    prb: cia2Bytes[0x01] ?? 0,
    icr: cia2Bytes[0x0d] ?? 0,   // side-effecting read — see limitation note
    imr: cia2Bytes[0x0d] ?? 0,   // approximation
    ta:  ((cia2Bytes[0x05] ?? 0) << 8) | (cia2Bytes[0x04] ?? 0),
    tb:  ((cia2Bytes[0x07] ?? 0) << 8) | (cia2Bytes[0x06] ?? 0),
    cra: cia2Bytes[0x0e] ?? 0,
    crb: cia2Bytes[0x0f] ?? 0,
  };

  // ── IEC pin state (derived from CIA2 PA — VICE-faithful formula) ──────────
  const iec = iecFromCia2Pa(cia2Pra);

  // ── VIA1 ($1800–$180F in drive memspace) ─────────────────────────────────
  // VIA 6522 register layout:
  //   $1800 ORB/IRB (PRB), $1801 ORA/IRA (PRA), $1802 DDRB, $1803 DDRA,
  //   $1804 T1C_L, $1805 T1C_H, $1806 T1L_L, $1807 T1L_H,
  //   $1808 T2C_L, $1809 T2C_H, $180A SR, $180B ACR,
  //   $180C PCR, $180D IFR, $180E IER, $180F ORA2 (no handshake)
  // NOTE: $1800 read via readMemory goes through via read_prb() handler →
  //       returns the XOR-0x85 composed byte (what the drive 6502 would see).
  //       This is VICE-faithful: it IS the bus state snapshot.
  const via1Bytes = await readBytes(0x1800, 0x180f, MEMSPACE_DRIVE);
  const via1 = {
    pra: via1Bytes[0x01] ?? 0,   // $1801 ORA/IRA
    prb: via1Bytes[0x00] ?? 0,   // $1800 ORB/IRB (composed, post-XOR — bus state)
    ifr: via1Bytes[0x0d] ?? 0,   // $180D IFR
    ier: via1Bytes[0x0e] ?? 0,   // $180E IER
    pcr: via1Bytes[0x0c] ?? 0,   // $180C PCR
    acr: via1Bytes[0x0b] ?? 0,   // $180B ACR
  };

  // ── VIA2 ($1C00–$1C0F in drive memspace) — head/motor ────────────────────
  const via2Bytes = await readBytes(0x1c00, 0x1c0f, MEMSPACE_DRIVE);
  const via2 = {
    pra: via2Bytes[0x01] ?? 0,   // $1C01 ORA/IRA
    prb: via2Bytes[0x00] ?? 0,   // $1C00 ORB/IRB (stepper + motor + sync)
    ifr: via2Bytes[0x0d] ?? 0,   // $1C0D IFR
    ier: via2Bytes[0x0e] ?? 0,   // $1C0E IER
  };

  // ── Value byte at the hit address ────────────────────────────────────────
  const hitBuf = await client.readMemory(hitAddr, hitAddr, 0, hitMemspace);
  const value = hitBuf[0] ?? 0;

  return { ts, tdrv, src, addr: hitAddr, value, c64, vic, cia1, cia2, iec, drv, via1, via2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// --no-autostart boot: manual LOAD + optional RUN via VICE binmon keyboardFeed
// (CMD 0x72). Mirrors headless-swimlane-capture.mjs Phase A exactly:
//   2.5M-cycle idle → LOAD"*",8,1\n → 2M-cycle KERNAL LOAD → RUN\n
//
// We use wall-clock waits (not cycle counts) because VICE runs real-time.
// Timings calibrated to match headless 2.5 M-cycle pre-LOAD gap at ~1 MHz:
//   basicReadyWait (default 4 s) ≈ 2.5M cycles  → BASIC READY prompt
//   5 s  ≈ KERNAL LOAD in flight (give drive time to respond)
//   10 s ≈ LOAD complete, safe to RUN
//
// VICE binmon keyboardFeed: binary monitor command 0x72 (CMD_KEYBOARD_FEED).
// Text is C64-charset PETSCII. LOAD and RUN are plain ASCII so Buffer.from()
// is sufficient; newline (\n = 0x0D in PETSCII, but VICE keyboardFeed treats
// 0x0A / '\n' as RETURN because it converts via host keyboard).
// ─────────────────────────────────────────────────────────────────────────────
if (noAutostart) {
  // 1. Ensure VICE is running (-8 attach starts VICE running, but if binmon
  //    connected while VICE is in a stopped state, kick it loose.
  //    Wrapped in try/catch so it is safe if VICE is already running.
  try { await client.resume(); } catch { /* already running — fine */ }

  // 2. Wait for BASIC to reach READY prompt (calibrated to ~2.5M cycles).
  console.error(`[no-autostart] Waiting ${basicReadyWait / 1000}s for BASIC READY…`);
  await new Promise((r) => setTimeout(r, basicReadyWait));

  // 3. Inject LOAD"*",8,1 + RETURN. PETSCII RETURN = $0D (CR), NOT $0A (LF).
  //    VICE keyboardFeed (CMD 0x72) writes raw bytes into the C64 keyboard
  //    buffer ($0277-$0280); KERNAL keyboard reader expects PETSCII so RETURN
  //    must be $0D. ASCII \n (0x0A) is treated as a stray char and KERNAL
  //    ignores or echoes it without executing the command (user observed
  //    "LOAD\"*\",8,1RUN" appearing on screen with no LOAD execution).
  const loadCmd = Buffer.from('LOAD"*",8,1\r', "ascii");
  console.error(`[no-autostart] Injecting: LOAD"*",8,1<CR>`);
  await client.keyboardFeed(loadCmd);

  // 4. NO RUN command for motm-class loaders: murder.prg loader is loaded with
  //    secondary address 1 (=load-with-load-addr) and KERNAL LOAD itself jumps
  //    to the loaded code's start when the PRG starts with $02DC etc — actually
  //    LOAD",8,1 puts BASIC at READY and prints READY. SYS or RUN normally
  //    needed BUT for this disk the murder.prg auto-runs because it's a
  //    "RUN-when-loaded" stub. User confirmed: only LOAD"*",8,1<CR> needed,
  //    no RUN.  Keep --no-run flag accepted for compatibility but ignore RUN
  //    injection unconditionally in --no-autostart path now that we know the
  //    correct boot recipe. If a future title needs explicit RUN, reintroduce
  //    via separate flag.
  if (!noRun) {
    console.error(`[no-autostart] (skipping RUN — motm loader auto-runs)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional arming: wait for drive PC to enter window before enabling
// R/W checkpoints. Symmetric with headless PC-window filter so both
// sides capture the same logical phase.
// In --no-autostart mode the capture starts from KERNAL LOAD phase (boot),
// not from a custom-loader entrypoint, so the motm arm window ($042F-$044C)
// would cause a 3-minute timeout. Disable arm by default when --no-autostart
// is set unless --arm-pc-start is explicitly provided.
const armPcStart = args["arm-pc-start"] !== undefined
  ? Number(args["arm-pc-start"])
  : (noAutostart ? 0 : (id === "motm" ? 0x042F : 0));
const armPcEnd = args["arm-pc-end"] !== undefined ? Number(args["arm-pc-end"]) : (id === "motm" ? 0x044C : 0);

// Optional C64-side arm (e.g. JMP $4000 = AB.prg entry for motm boot).
const armC64PcStart = args["arm-c64-pc-start"] !== undefined ? Number(args["arm-c64-pc-start"]) : 0;
const armC64PcEnd   = args["arm-c64-pc-end"]   !== undefined ? Number(args["arm-c64-pc-end"])   : armC64PcStart;

if (armC64PcStart > 0) {
  console.error(`Arming on C64 PC range $${armC64PcStart.toString(16)}-$${armC64PcEnd.toString(16)} (memspace=0)`);
  await client.setCheckpoint({
    startAddress: armC64PcStart, endAddress: armC64PcEnd,
    stopWhenHit: true, enabled: true, operation: 0x04, memspace: MAIN_MEMSPACE,
  });
  let armSeq = client.currentEventSequence;
  try { await client.resume(); } catch {}
  let armed = false;
  const armDeadline = Date.now() + 180_000;
  while (!armed && Date.now() < armDeadline) {
    let ev;
    try {
      ev = await client.waitForCheckpointOrStop(armSeq, 30_000);
    } catch {
      console.error(`C64 arm timeout — exiting`);
      child.kill("SIGKILL");
      process.exit(1);
    }
    armSeq = ev.sequence;
    if (ev.kind === "checkpoint") {
      const cRegs = await client.getRegisters(MAIN_MEMSPACE);
      const cpc = (cRegs.find((r) => r.id === REG_PC)?.value ?? 0) & 0xffff;
      if (cpc >= armC64PcStart && cpc <= armC64PcEnd) {
        console.error(`C64-armed at PC=$${cpc.toString(16)}`);
        armed = true;
        break;
      }
      await client.resume();
    } else if (ev.kind === "stopped") {
      try { await client.resume(); } catch {}
    }
  }
  if (!armed) {
    console.error(`C64 arm window never hit — exiting (LOAD likely never completed)`);
    child.kill("SIGKILL");
    process.exit(1);
  }
}

if (armPcStart > 0) {
  console.error(`Arming on drive PC range $${armPcStart.toString(16)}-$${armPcEnd.toString(16)} (memspace=1)`);
  // Set exec checkpoint that pauses VICE when drive PC enters window.
  await client.setCheckpoint({
    startAddress: armPcStart, endAddress: armPcEnd,
    stopWhenHit: true, enabled: true, operation: 0x04, memspace: MEMSPACE_DRIVE,
  });
  // Resume VICE, wait for the arm hit.
  // Wrapped in try/catch: in --no-autostart mode VICE may already be running.
  let armSeq = client.currentEventSequence;
  try { await client.resume(); } catch { /* already running — fine */ }
  let armed = false;
  const armDeadline = Date.now() + 180_000;
  while (!armed && Date.now() < armDeadline) {
    let ev;
    try {
      ev = await client.waitForCheckpointOrStop(armSeq, 30_000);
    } catch {
      console.error(`Arm timeout — exiting`);
      child.kill("SIGKILL");
      process.exit(1);
    }
    armSeq = ev.sequence;
    if (ev.kind === "checkpoint") {
      const dRegs = await client.getRegisters(MEMSPACE_DRIVE);
      const dpc = (dRegs.find((r) => r.id === REG_PC)?.value ?? 0) & 0xffff;
      if (dpc >= armPcStart && dpc <= armPcEnd) {
        console.error(`Armed at drive PC=$${dpc.toString(16)}`);
        armed = true;
        break;
      }
      await client.resume();
    } else if (ev.kind === "stopped") {
      try { await client.resume(); } catch {}
    }
  }
  if (!armed) {
    console.error(`Arm window never hit — exiting`);
    child.kill("SIGKILL");
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Set checkpoints
// ─────────────────────────────────────────────────────────────────────────────
//
// operation: 0x01=load(read), 0x02=store(write), 0x03=read+write, 0x04=exec
//
// LEGACY mode (no --swimlane): 2 checkpoints — c64 $DD00 r+w, drive $1800 r+w
// SWIMLANE mode (--swimlane):  8 checkpoints — 4 addresses × r + w separately
//                               to get accurate src tag (r vs w).

let checkpoints; // Array of { cpNum, src, addr, memspace }
let cp_c64_legacy, cp_drive_legacy; // Legacy mode checkpoint numbers

if (!swimlane) {
  // ── LEGACY: 2 checkpoints (original behavior) ──────────────────────────
  cp_c64_legacy = await client.setCheckpoint({
    startAddress: 0xdd00, endAddress: 0xdd00,
    stopWhenHit: true, enabled: true, operation: 0x03, memspace: MEMSPACE_C64,
  });
  cp_drive_legacy = await client.setCheckpoint({
    startAddress: 0x1800, endAddress: 0x1800,
    stopWhenHit: true, enabled: true, operation: 0x03, memspace: MEMSPACE_DRIVE,
  });
  console.error(`Checkpoints: c64=${cp_c64_legacy.checkpointNumber} drive=${cp_drive_legacy.checkpointNumber}`);
} else {
  // ── SWIMLANE: 8 checkpoints ────────────────────────────────────────────
  //   Separate read/write so we get precise "r" vs "w" in src tag.
  checkpoints = [];

  async function addCp(addr, op, src, memspace) {
    const cp = await client.setCheckpoint({
      startAddress: addr, endAddress: addr,
      stopWhenHit: true, enabled: true, operation: op, memspace,
    });
    checkpoints.push({ cpNum: cp.checkpointNumber, src, addr, memspace });
    return cp;
  }

  // C64 side ($DD00 CIA2 PA — IEC bus)
  await addCp(0xdd00, 0x01, "c64-r-DD00", MEMSPACE_C64);
  await addCp(0xdd00, 0x02, "c64-w-DD00", MEMSPACE_C64);
  // C64 side ($DC0D CIA1 ICR — KERNAL serial timer IRQ)
  await addCp(0xdc0d, 0x01, "c64-r-DC0D", MEMSPACE_C64);
  await addCp(0xdc0d, 0x02, "c64-w-DC0D", MEMSPACE_C64);
  // Drive side ($1800 VIA1 PRB — IEC bus drive side)
  await addCp(0x1800, 0x01, "drv-r-1800", MEMSPACE_DRIVE);
  await addCp(0x1800, 0x02, "drv-w-1800", MEMSPACE_DRIVE);
  // Drive side ($1C00 VIA2 PRB — head/motor)
  await addCp(0x1c00, 0x01, "drv-r-1C00", MEMSPACE_DRIVE);
  await addCp(0x1c00, 0x02, "drv-w-1C00", MEMSPACE_DRIVE);

  console.error(`Swimlane checkpoints: ${checkpoints.map(c => `${c.cpNum}=${c.src}`).join(" ")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event loop
// ─────────────────────────────────────────────────────────────────────────────

const events = [];
const t0 = Date.now();
let seq = 0;
let exitReason = "max-events";

let lastSeq = client.currentEventSequence;
await client.resume();

while (events.length < maxEvents && (Date.now() - t0) < budgetMs) {
  const remaining = budgetMs - (Date.now() - t0);
  let ev;
  try {
    ev = await client.waitForCheckpointOrStop(lastSeq, Math.min(remaining, 10_000));
  } catch (e) {
    console.error(`Wait timeout / error: ${e?.message ?? e}`);
    exitReason = "wait-timeout";
    break;
  }
  lastSeq = ev.sequence;
  if (ev.kind === "stopped") {
    // VICE-side pause (autostart finished, user closed window, etc.).
    // Resume and continue.
    try { await client.resume(); } catch {}
    continue;
  }
  if (ev.kind === "jam") {
    console.error(`CPU JAM at pc=$${(ev.pc ?? 0).toString(16)} — stopping`);
    exitReason = "jam";
    break;
  }
  if (ev.kind !== "checkpoint") {
    console.error(`Unexpected event: ${ev.kind} — stopping`);
    break;
  }
  const cpNum = ev.checkpoint?.checkpointNumber;

  // ── SWIMLANE path ──────────────────────────────────────────────────────
  if (swimlane) {
    const cpInfo = checkpoints.find(c => c.cpNum === cpNum);
    if (!cpInfo) {
      // Unknown checkpoint (e.g. the arm checkpoint) — resume.
      await client.resume();
      continue;
    }
    const row = await captureSwimlaneFull(cpInfo.src, cpInfo.addr, cpInfo.memspace);
    appendFileSync(outPath, JSON.stringify(row) + "\n");
    events.push(row);
    if (events.length % 10 === 0) {
      console.error(`  [${events.length}] ts=${row.ts} tdrv=${row.tdrv} src=${row.src} val=$${row.value.toString(16).padStart(2,"0")}`);
    }
    await client.resume();
    continue;
  }

  // ── LEGACY path (original Spec 143 behavior) ───────────────────────────
  const cp = ev.checkpoint;
  const isC64 = cp.checkpointNumber === cp_c64_legacy.checkpointNumber;
  const memspace = isC64 ? MEMSPACE_C64 : MEMSPACE_DRIVE;
  const addr = isC64 ? 0xdd00 : 0x1800;
  // VICE checkpoint operation field tells us R or W. 1=load(read), 2=store(write).
  const op = (cp.operation === 2) ? "write" : "read";

  // Get registers + memory
  const regs = await client.getRegisters(memspace);
  const pc = (regs.find((r) => r.id === REG_PC)?.value ?? 0) & 0xffff;
  const cycle_c64 = await getClock(MEMSPACE_C64);
  const cycle_drive = await getClock(MEMSPACE_DRIVE);

  // Get memory byte at addr (post-event state — for write: what was written;
  // for read: current value, which equals what was read assuming no
  // mutation between).
  const mem = await client.readMemory(addr, addr, 0, memspace);
  const value = mem[0] ?? 0;

  // For drive events: dump VIA1 IFR/IER/PCR
  let via1;
  if (!isC64) {
    const viaMem = await client.readMemory(0x180d, 0x180e, 0, MEMSPACE_DRIVE);
    const pcrMem = await client.readMemory(0x180c, 0x180c, 0, MEMSPACE_DRIVE);
    via1 = { ifr: viaMem[0] ?? 0, ier: viaMem[1] ?? 0, pcr: pcrMem[0] ?? 0 };
  }

  // For IEC line state: read drive_port via VICE iecbus_drive_port hack
  // not exposed; approximate from c64 $DD00 readback.
  const dd00Mem = isC64 ? mem : await client.readMemory(0xdd00, 0xdd00, 0, MEMSPACE_C64);
  const dd00 = dd00Mem[0] ?? 0;
  // CIA2 PA bits: bit3=ATN_OUT (=ATN driven low), bit4=CLK_OUT, bit5=DATA_OUT,
  // bit6=CLK_IN, bit7=DATA_IN. For raw line state we use the IN bits:
  const atn = (dd00 & 0x08) ? 0 : 1;  // approximate (no direct ATN_IN bit, infer from c64 output)
  const clkLine = (dd00 & 0x40) ? 1 : 0;
  const dataLine = (dd00 & 0x80) ? 1 : 0;

  const event = {
    cycle_c64,
    cycle_drive,
    side: isC64 ? "c64" : "drive",
    op,
    addr,
    value,
    pc,
    at_boundary: true, // VICE checkpoint hits at access cycle = approximately boundary
    iec: {
      atn,
      clk: clkLine,
      data: dataLine,
      c64_atn: (dd00 & 0x08) ? 0 : 1,
      c64_clk: (dd00 & 0x10) ? 0 : 1,
      c64_data: (dd00 & 0x20) ? 0 : 1,
      drv_clk: 1,  // placeholder — VICE doesn't easily expose drv_data
      drv_data: 1, // (would need iecbus_t struct dump via direct addr)
      drv_atn_ack: 1,
    },
    via1,
    seq: seq++,
    vice_approx: { iec_drv_state: true, at_boundary: true },
  };
  appendFileSync(outPath, JSON.stringify(event) + "\n");
  events.push(event);

  await client.resume();
}

console.error(``);
console.error(`Captured ${events.length} events in ${Date.now() - t0} ms`);
console.error(`Exit: ${exitReason}`);
console.error(`Output: ${outPath}`);

await client.close();
await new Promise((r) => setTimeout(r, 300));
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
child.kill("SIGKILL");
