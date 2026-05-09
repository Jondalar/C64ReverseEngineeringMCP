#!/usr/bin/env node
// Spec 298 — literal port driven by REAL KERNAL boot via parallel
// onCycle hook. Saves a PNG so user can visually verify the literal
// port renders the same READY screen as VICE x64sc would.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";

const { startIntegratedSession } = await import(`${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const { vicii } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);
const { vicii_init, vicii_reset, vicii_bind_ram } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii.js`);
const { vicii_cycle } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-cycle.js`);
const { setFetchHost } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-fetch.js`);
const { setIrqHost } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-irq.js`);
const { vicii_monitor_colreg_store } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-draw-cycle.js`);
const { rgbaToPng } = await import(`${REPO}/dist/runtime/headless/peripherals/png-writer.js`);
const { PALETTES } = await import(`${REPO}/dist/runtime/headless/vic/palettes.js`);

const args = process.argv.slice(2);
const scenario = args[0] || "ready";
const diskArg = args[1];

console.log(`smoke-vic-298-literal-real-boot scenario=${scenario}`);

const sessionOpts = diskArg
    ? { diskPath: resolvePath(diskArg), mode: "true-drive", useMicrocodedCpu: true }
    : { diskPath: `${REPO}/samples/synthetic/1block.g64`, mode: "true-drive", useMicrocodedCpu: true };

const { session: s } = startIntegratedSession(sessionOpts);
s.resetCold("pal-default");

// 1. Bind literal port to session resources
vicii_bind_ram(s.c64Bus.ram);

// Color RAM in C64Bus.io at offset 0x0800
const colorRamView = new Uint8Array(s.c64Bus.io.buffer, s.c64Bus.io.byteOffset + 0x0800, 0x400);

setFetchHost({
    mem_chargen_rom_ptr: s.c64Bus.charRom,
    mem_color_ram_vicii: colorRamView,
    export_ultimax_phi1: 0,
    export_ultimax_phi2: 0,
    ultimax_romh_phi1_read: () => null,
    ultimax_romh_phi2_read: () => null,
    reg_pc: 0,
});
setIrqHost({
    maincpu_set_irq: () => {},
    maincpu_set_irq_clk: () => {},
    maincpu_clk: () => 0,
    interrupt_cpu_status_int_new: () => 0,
});

vicii_init();
vicii_reset();

// Share regs[] BY REFERENCE so we don't copy 64 bytes per cycle (= the
// big perf cost). Both VicIIVice and literal port now read/write the
// same array.
vicii.regs = s.vic.regs;

// 2. Capture framebuffer line-by-line
const FB_W = 65 * 8;
const FB_H = 312;
const fbColors = new Uint8Array(FB_W * FB_H);
let lastRasterLine = -1;
let onCycleCount = 0;

// Track previous color reg values so we only trigger
// vicii_monitor_colreg_store on actual changes
const prevColRegs = new Uint8Array(0x10);
s.vic.onCycle = (raster_y, raster_cycle, _clk) => {
    onCycleCount++;
    // regs[] shared by reference (set above) — no copy per cycle.
    // Mirror color reg writes into cregs lookup table
    // (= would be triggered by vicii-mem.c on $D020-$D02E writes per VICE)
    for (let r = 0x20; r <= 0x2e; r++) {
        const v = s.vic.regs[r] & 0x0f;
        if (v !== prevColRegs[r - 0x20]) {
            prevColRegs[r - 0x20] = v;
            vicii_monitor_colreg_store(r, v);
        }
    }
    // Bind VIC bank from CIA2 PA (CIA2 PRA & DDRA bits 0-1 inverted)
    const cia2Pa = (s.cia2.pra & s.cia2.ddra) & 0xff;
    const bank = (~cia2Pa) & 0x03;
    vicii.vbank_phi1 = bank * 0x4000;
    vicii.vbank_phi2 = bank * 0x4000;

    vicii_cycle();

    // On line wrap, copy dbuf to framebuffer
    if (vicii.raster_line !== lastRasterLine) {
        if (lastRasterLine >= 0 && lastRasterLine < FB_H) {
            for (let x = 0; x < FB_W && x < vicii.dbuf.length; x++) {
                fbColors[lastRasterLine * FB_W + x] = vicii.dbuf[x];
            }
        }
        lastRasterLine = vicii.raster_line;
    }
};

// 3. Run KERNAL boot (= ~3.5M cycles to READY)
console.log("Running KERNAL boot...");
s.runFor(5_000_000, { cycleBudget: 5_000_000 });

// For motm/MM scenarios, also type LOAD"*",8,1 + run more
if (scenario === "motm" || scenario === "mm") {
    console.log("Typing LOAD command...");
    s.typeText('LOAD"*",8,1\r', 80_000, 80_000);
    console.log("Running game boot (~120s simulation)...");
    let total = 0;
    while (total < 120_000_000) {
        s.runFor(50_000, { cycleBudget: 2_000_000 });
        total += 2_000_000;
    }
}

console.log("Done. dbuf_offset=", vicii.dbuf_offset, "raster_line=", vicii.raster_line);
console.log("onCycle invocations:", onCycleCount);
console.log("session c64Cpu cycles:", s.c64Cpu.cycles);
console.log("session vic.regs[0x11]=$"+s.vic.regs[0x11].toString(16),
            "[0x16]=$"+s.vic.regs[0x16].toString(16),
            "[0x18]=$"+s.vic.regs[0x18].toString(16),
            "[0x21]=$"+s.vic.regs[0x21].toString(16));
console.log("literal vicii.regs[0x11]=$"+vicii.regs[0x11].toString(16),
            "vicii.vborder=", vicii.vborder, "main_border=", vicii.main_border,
            "bad_line=", vicii.bad_line, "allow_bad_lines=", vicii.allow_bad_lines);
console.log("literal vicii.dbuf[0..16]:", Array.from(vicii.dbuf.slice(0, 16)));
// Screen RAM at $0400 - dump first 80 bytes (= rows 0+1)
let sr = "screen RAM $0400-$044F: ";
for (let i = 0; i < 80; i++) sr += s.c64Bus.ram[0x0400+i].toString(16).padStart(2,"0") + " ";
console.log(sr);
console.log("CIA2 pra=$"+s.cia2.pra.toString(16), "ddra=$"+s.cia2.ddra.toString(16),
            "→ vbank=$"+vicii.vbank_phi1.toString(16));

// 4. Render PNG
const palette = PALETTES.colodore;
const rgba = new Uint8Array(FB_W * FB_H * 4);
for (let i = 0; i < FB_W * FB_H; i++) {
    const cIdx = fbColors[i] & 0x0f;
    const [r, g, b] = palette[cIdx];
    const off = i * 4;
    rgba[off] = r;
    rgba[off + 1] = g;
    rgba[off + 2] = b;
    rgba[off + 3] = 0xff;
}
const outDir = `${REPO}/samples/screenshots/literal-port`;
mkdirSync(outDir, { recursive: true });
const pngPath = `${outDir}/${scenario}.png`;
const pngBytes = rgbaToPng(FB_W, FB_H, rgba);
writeFileSync(pngPath, pngBytes);
console.log(`Wrote PNG: ${pngPath} (${pngBytes.length} bytes, ${FB_W}×${FB_H})`);

// 5. Sanity: count lit pixels
let lit = 0;
for (let i = 0; i < fbColors.length; i++) if (fbColors[i] !== 0) lit++;
console.log(`Non-zero pixels: ${lit} / ${fbColors.length}`);

if (lit > 5000) {
    console.log("PASS: literal port produced rendered output");
    process.exit(0);
} else {
    console.log("FAIL: literal port produced almost-empty framebuffer");
    process.exit(1);
}
