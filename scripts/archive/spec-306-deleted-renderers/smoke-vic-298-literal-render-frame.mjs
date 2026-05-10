#!/usr/bin/env node
// Spec 298 — literal port standalone "render 1 frame" PNG smoke.
//
// Drives the literal-port pipeline (vicii_init + vicii_reset +
// vicii_cycle × 19,656) with a hand-built BASIC READY screen layout
// + real C64 chargen ROM. Reads vicii.dbuf and saves as PNG.
//
// User can visually verify the output looks like a real C64 BASIC
// screen with text + cursor block.
//
// This DOES NOT need the CPU — we just preset RAM, regs, and let the
// VIC chip cycle for one frame. This is the smallest end-to-end
// correctness check before the bigger 298k integration spec wires
// the literal port into IntegratedSession + KERNAL/motm/MM PNG diff.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";

// Load literal-port modules
const { vicii } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);
const { vicii_init, vicii_reset, vicii_bind_ram } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii.js`);
const { vicii_cycle } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-cycle.js`);
const { setFetchHost } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-fetch.js`);
const { setIrqHost } = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-irq.js`);
const { rgbaToPng } = await import(`${REPO}/dist/runtime/headless/peripherals/png-writer.js`);
const { PALETTES } = await import(`${REPO}/dist/runtime/headless/vic/palettes.js`);

console.log("smoke-vic-298-literal-render-frame");

// 1. Boot the literal port
const ram = new Uint8Array(0x10000);
vicii_bind_ram(ram);

const charRom = readFileSync(`${REPO}/resources/roms/chargen-901225-01.bin`);
const colorRam = new Uint8Array(0x400);
const ultimaxNo = () => null;
setFetchHost({
    mem_chargen_rom_ptr: charRom,
    mem_color_ram_vicii: colorRam,
    export_ultimax_phi1: 0,
    export_ultimax_phi2: 0,
    ultimax_romh_phi1_read: ultimaxNo,
    ultimax_romh_phi2_read: ultimaxNo,
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

// 2. Set VIC regs to typical KERNAL READY display state
vicii.regs[0x11] = 0x1b;  // DEN=1, RSEL=1, mode=text, ysmooth=3
vicii.regs[0x16] = 0x08;  // CSEL=1, MCM=0, xsmooth=0
vicii.regs[0x18] = 0x14;  // screen=$0400, chargen=$1000
vicii.regs[0x20] = 0x0e;  // border = light blue
vicii.regs[0x21] = 0x06;  // background = blue
// Color RAM = light blue everywhere
colorRam.fill(0x0e);

// 3. Lay out READY screen text
//    Line 1: "**** COMMODORE 64 BASIC V2 ****"
//    Line 3: "64K RAM SYSTEM 38911 BASIC BYTES FREE"
//    Line 5: "READY."
//    Line 6: cursor (= reverse space $A0 at col 0)
const SCREEN_BASE = 0x0400;
function putStr(row, col, s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // ASCII → C64 screen code (uppercase + digits)
        let sc;
        if (c === 0x20) sc = 0x20;          // space
        else if (c >= 0x40 && c <= 0x5f) sc = c - 0x40;  // 'A'..'Z'
        else if (c >= 0x30 && c <= 0x39) sc = c;          // digits
        else if (c === 0x2a) sc = 0x2a;  // '*'
        else if (c === 0x2e) sc = 0x2e;  // '.'
        else sc = 0x20;
        ram[SCREEN_BASE + row * 40 + col + i] = sc;
    }
}
putStr(1, 4, "**** COMMODORE 64 BASIC V2 ****");
putStr(3, 1, "64K RAM SYSTEM 38911 BASIC BYTES FREE");
putStr(5, 0, "READY.");
ram[SCREEN_BASE + 6 * 40 + 0] = 0xa0;  // cursor block

// 4. Run 1 PAL frame = 19,656 cycles
const TOTAL = 19_656;
for (let c = 0; c < TOTAL; c++) {
    vicii_cycle();
}

console.log("dbuf_offset after frame:", vicii.dbuf_offset);
console.log("Sample dbuf[0..16]:", Array.from(vicii.dbuf.slice(0, 16)));
console.log("Sample dbuf[1024..1040]:", Array.from(vicii.dbuf.slice(1024, 1040)));

// 5. Convert dbuf (= per-pixel color indices, 65 cycles × 8 = 520 px wide)
//    into RGBA PNG using palette. dbuf is 65*8 = 520 wide × 1 line. We
//    actually need to capture dbuf for ALL lines, not just last. dbuf
//    is overwritten per line. To capture full screen we'd need to hook
//    end-of-line and copy out.
//
//    For 1-frame visual smoke we just dump LAST line of dbuf. To get
//    a full-frame PNG we need a frame buffer. For now: output what
//    dbuf has at frame end (= probably some line near 311).
//
//    Better: hook between cycles and accumulate into 65*8 × 312 frame.
//    Easy fix: copy dbuf at each end-of-line marker.

const FB_W = 65 * 8;  // 520
const FB_H = 312;
const fbColors = new Uint8Array(FB_W * FB_H);

// Re-run, this time capturing dbuf per line
vicii_reset();
vicii.regs[0x11] = 0x1b;
vicii.regs[0x16] = 0x08;
vicii.regs[0x18] = 0x14;
vicii.regs[0x20] = 0x0e;
vicii.regs[0x21] = 0x06;

// Copy line N of dbuf into fbColors at row N
let lastRasterLine = -1;
for (let c = 0; c < TOTAL; c++) {
    vicii_cycle();
    if (vicii.raster_line !== lastRasterLine) {
        // Line changed — copy previous line's dbuf
        if (lastRasterLine >= 0 && lastRasterLine < FB_H) {
            for (let x = 0; x < FB_W && x < vicii.dbuf.length; x++) {
                fbColors[lastRasterLine * FB_W + x] = vicii.dbuf[x];
            }
        }
        lastRasterLine = vicii.raster_line;
    }
}

// 6. Convert color indices → RGBA via colodore palette
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

// 7. Save PNG
const outDir = `${REPO}/samples/screenshots/literal-port`;
mkdirSync(outDir, { recursive: true });
const pngPath = `${outDir}/ready-screen.png`;
const pngBytes = rgbaToPng(FB_W, FB_H, rgba);
writeFileSync(pngPath, pngBytes);
console.log(`Wrote PNG: ${pngPath} (${pngBytes.length} bytes, ${FB_W}×${FB_H})`);

// 8. Quick sanity check: count non-bg pixels in expected text rows
const bgPalette = palette[0x06]; // blue
let textPixels = 0;
for (let y = 50; y < 250; y++) {
    for (let x = 32; x < 360; x++) {
        const idx = fbColors[y * FB_W + x];
        if (idx === 0x0e) textPixels++; // light blue text
    }
}
console.log(`Light blue text pixels in visible band (y 50-250): ${textPixels}`);

if (textPixels > 1000) {
    console.log("PASS: literal port rendered text characters");
    process.exit(0);
} else {
    console.log("FAIL: literal port did not render expected text (got <1000 fg px)");
    process.exit(1);
}
