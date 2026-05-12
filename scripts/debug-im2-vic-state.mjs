// Debug IM2 VIC internal state — vborder, idle_state, dbuf snapshots
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
await mountMedia(session, 8, resolve("samples/impossible_mission_ii[epyx_1987](!).g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");
session.runFor(60_000_000, { cycleBudget: 60_000_000 });

// Now in-game. Inspect VIC internal state.
// Access vicii_t via dynamic import — it's the literal port's global.
const litTypes = await import("../dist/runtime/headless/vic/literal/vicii-types.js");
const vicii = litTypes.vicii;
console.log("--- VIC internal state ---");
console.log(`raster_line=${vicii.raster_line} raster_cycle=${vicii.raster_cycle}`);
console.log(`vborder=${vicii.vborder} main_border=${vicii.main_border}`);
console.log(`idle_state=${vicii.idle_state}`);
console.log(`vc=${vicii.vc} vmli=${vicii.vmli} rc=${vicii.rc}`);
console.log(`vbank_phi1=$${vicii.vbank_phi1.toString(16)} vbank_phi2=$${vicii.vbank_phi2.toString(16)}`);
console.log(`vaddr_mask_phi2=$${vicii.vaddr_mask_phi2.toString(16)}`);
console.log(`vaddr_chargen_mask_phi2=$${vicii.vaddr_chargen_mask_phi2.toString(16)} value=$${vicii.vaddr_chargen_value_phi2.toString(16)}`);
console.log(`gbuf=$${vicii.gbuf.toString(16).padStart(2,"0")} dbuf_offset=${vicii.dbuf_offset}`);
console.log(`bad_line=${vicii.bad_line} allow_bad_lines=${vicii.allow_bad_lines}`);
// Step a bit more, then re-check at a known bad-line raster (y & 7 == YSCROLL=3 in IM2)
// IM2 D011=$3b → YSCROLL=3
console.log("--- step until bad-line trigger ---");
let badLineHits = 0;
let matrixFetchProof = false;
for (let n = 0; n < 100_000; n++) {
  session.runFor(1, { cycleBudget: 1 });
  if (vicii.bad_line) {
    badLineHits++;
    if (badLineHits === 1) {
      console.log(`first bad_line at raster_line=${vicii.raster_line} raster_cycle=${vicii.raster_cycle} vc=${vicii.vc}`);
    }
    // After fetch should run, check vbuf
    if (badLineHits > 1 && vicii.vbuf[0] !== 0) {
      matrixFetchProof = true;
      console.log(`vbuf populated! [0..7]: ${Array.from(vicii.vbuf.slice(0,8)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
      console.log(`cbuf [0..7]: ${Array.from(vicii.cbuf.slice(0,8)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
      break;
    }
  }
}
console.log(`bad_line hits: ${badLineHits}, matrix-fetch confirmed: ${matrixFetchProof}`);

// Inspect draw_cycle state
const drawCycle = await import("../dist/runtime/headless/vic/literal/vicii-draw-cycle.js");
const st = drawCycle.vicii_get_draw_cycle_state();
console.log(`vmode11_pipe=${st.vmode11_pipe} vmode16_pipe=${st.vmode16_pipe} vmode16_pipe2=${st.vmode16_pipe2}`);
console.log(`gbuf_reg=$${st.gbuf_reg.toString(16)} gbuf_pixel_reg=${st.gbuf_pixel_reg} gbuf_mc_flop=${st.gbuf_mc_flop}`);
console.log(`vbuf_reg=$${st.vbuf_reg.toString(16)} cbuf_reg=$${st.cbuf_reg.toString(16)} dmli=${st.dmli}`);
console.log(`gbuf_pipe0_reg=$${st.gbuf_pipe0_reg.toString(16)} gbuf_pipe1_reg=$${st.gbuf_pipe1_reg.toString(16)}`);
console.log(`vbuf_pipe0_reg=$${st.vbuf_pipe0_reg.toString(16)} vbuf_pipe1_reg=$${st.vbuf_pipe1_reg.toString(16)}`);

// Now step through one full frame, log vborder + main_border transitions
console.log("--- frame trace: vborder/main_border transitions ---");
let lastVborder = -1, lastMainBorder = -1;
let trans = 0;
let displayLines = 0;
for (let n = 0; n < 100_000 && trans < 20; n++) {
  session.runFor(1, { cycleBudget: 1 });
  if (vicii.vborder !== lastVborder || vicii.main_border !== lastMainBorder) {
    console.log(`  raster=${vicii.raster_line}.${vicii.raster_cycle} vborder=${vicii.vborder} main_border=${vicii.main_border}`);
    lastVborder = vicii.vborder;
    lastMainBorder = vicii.main_border;
    trans++;
  }
  if (vicii.vborder === 0 && vicii.main_border === 0 && vicii.raster_cycle === 15) displayLines++;
}
console.log(`display lines seen with vborder=main_border=0 @cycle 15: ${displayLines}`);
// Color RAM lives at c64Bus.io[0x0800..0x0bff]
const colorRamView = new Uint8Array(session.c64Bus.io.buffer, session.c64Bus.io.byteOffset + 0x0800, 0x400);
console.log(`color RAM[0..16]: ${Array.from(colorRamView.slice(0, 16)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
console.log(`color RAM[40..56]: ${Array.from(colorRamView.slice(40, 56)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
console.log(`color RAM[200..216]: ${Array.from(colorRamView.slice(200, 216)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
console.log(`ram[$E000..$E020]: ${Array.from(session.c64Bus.ram.slice(0xE000, 0xE020)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
console.log(`ram[$EB44..$EB60]: ${Array.from(session.c64Bus.ram.slice(0xEB44, 0xEB60)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);

// Dump cbuf + vbuf
console.log(`vbuf[0..7]: ${Array.from(vicii.vbuf.slice(0, 8)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
console.log(`cbuf[0..7]: ${Array.from(vicii.cbuf.slice(0, 8)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);

console.log(`dbuf.length=${vicii.dbuf.length}`);
// Inspect literalPortFb (= 520x312 accumulated framebuffer)
const fb = session.literalPortFb;
const fbStable = session.literalPortFbStable;
console.log(`fb=${fb?.length} stable=${fbStable?.length}`);
const src = fbStable ?? fb;
if (src) {
  console.log("--- fb samples (each row = 520 bytes) ---");
  for (const row of [60, 100, 150, 200]) {
    const start = row * 520;
    const sample = Array.from(src.slice(start + 50, start + 90)).map(b=>b.toString(16).padStart(2,"0")).join(" ");
    console.log(`  row ${row} @50..90: ${sample}`);
  }
  // Count distinct colors in fb
  const colors = new Set();
  for (let i = 0; i < src.length; i++) colors.add(src[i]);
  console.log(`distinct colors: ${Array.from(colors).sort((a,b)=>a-b).map(c=>"$"+c.toString(16)).join(" ")}`);
}
process.exit(0);
