// Spec 297b — Cycle-pumped pixel emission renderer (standard text mode 0).
//
// Wires 296a-1 (Φ1 fetch primitive), 296a-2 (cycle table), 296a-3
// (display pipe), 296a-4 (line-renderer reference) into VicIIVice via
// the 297a `onCycle` hook. Each cycle does:
//
//   1. Look up CYCLE_TAB_PAL[cycle.phase]
//   2. Φ1 fetch (if FetchG: chargen via fetch_phi1; if Idle: idle gfx)
//   3. Φ2 fetch (if mayFetchC + bad_line: matrix into vbuf/cbuf)
//   4. Emit 8 pixels into the framebuffer using display pipe (mode 0)
//   5. End-of-cycle: pipe stage advance + samplePipe0 + sampleVmode11
//
// Modes 1-7 deferred to 297c-g (decoder branches in emitPixelMode0).
// Sprites + collision + border deferred to 297h-j.
// Mid-cycle reg writes via raster_changes lane bridge = 297k.
//
// Default behavior unchanged: cycle-pumped renderer is OPT-IN via
// installCyclePumpedRenderer(session). When not installed, snapshot
// renderer (= vice-rasterized) remains active.

import {
  CYCLE_TAB_PAL, PHI1_FETCH_G, PHI1_IDLE, PHI1_SPR_PTR, PHI1_SPR_DMA1,
  type CycleEntry,
} from "./cycle-table-pal.js";
import {
  newDisplayPipeState, advancePipeStages, latchPipeRegs, samplePipe0,
  shiftGbufOnePixel, sampleVmode11, sampleVmode16, holdVmode16Pipe2,
  type DisplayPipeState,
} from "./display-pipe.js";
import { fetchPhi1, fetchIdleGfx, type FetchPhi1Context } from "./fetch-phi1.js";
import {
  VISIBLE_X, VISIBLE_Y, VISIBLE_W, VISIBLE_H, type VicFramebuffer,
} from "../peripherals/vic-renderer.js";
import {
  newSpriteEngine, loadSpriteRegs, loadSpriteDmaByte, onLineStart as spriteOnLineStart,
  type SpriteEngine,
} from "./sprite-cycle.js";
import {
  newBorderState, onLineStartBorder, applyMainBorderCheck, isInBorder,
  type BorderState,
} from "./border-state.js";
import {
  newSpriteCollisionState, type SpriteCollisionState,
} from "./sprite-collision-latch.js";
import { compositePixel } from "./cycle-pixel-composite.js";

/** Session shape consumed by the renderer (decoupled from IntegratedSession). */
interface SessionLike {
  vic: {
    onCycle?: (raster_y: number, raster_cycle: number, clk: number) => void;
    regs: Uint8Array;
    raster_y: number;
    raster_cycle: number;
    bad_line: boolean;
    vbank_phi1: number;
    vaddr_chargen_mask_phi1: number;
    vaddr_chargen_value_phi1: number;
  };
  c64Bus: { ram: Uint8Array; charRom: Uint8Array; io: Uint8Array };
  framebuffer: VicFramebuffer;
}

/** Per-line/per-frame state owned by the renderer. */
interface RendererState {
  pipe: DisplayPipeState;
  // 40-entry video matrix populated by Φ2 FetchC + drained by Φ1 FetchG
  vbuf: Uint8Array;
  cbuf: Uint8Array;
  vmli: number;
  vc: number;
  vcbase: number;
  rc: number;        // 0..7 within character row
  idleState: boolean;
  // Sprite + border + collision (= full pipeline integration in 297l)
  sprites: SpriteEngine[];
  border: BorderState;
  collision: SpriteCollisionState;
  /** Per-sprite DMA byte counter (resets at SPR_PTR cycle for that sprite). */
  spriteDmaByteIdx: number[];
  /** Sprite data pointer (= byte read at SPR_PTR cycle, scaled × 64). */
  spriteDataPtr: number[];
  /** Last seen raster_y so we trigger onLineStart only on change. */
  lastRasterY: number;
}

function newRendererState(): RendererState {
  const sprites: SpriteEngine[] = [];
  for (let i = 0; i < 8; i++) sprites.push(newSpriteEngine(i));
  return {
    pipe: newDisplayPipeState(),
    vbuf: new Uint8Array(40),
    cbuf: new Uint8Array(40),
    vmli: 0,
    vc: 0,
    vcbase: 0,
    rc: 0,
    idleState: false,
    sprites,
    border: newBorderState(),
    collision: newSpriteCollisionState(),
    spriteDmaByteIdx: new Array(8).fill(0),
    spriteDataPtr: new Array(8).fill(0),
    lastRasterY: -1,
  };
}

function buildFetchCtx(session: SessionLike, ecmActive: boolean): FetchPhi1Context {
  const ram = session.c64Bus.ram;
  const charRom = session.c64Bus.charRom;
  const vic = session.vic;
  return {
    vbank_phi1: vic.vbank_phi1,
    vaddr_mask_phi1: 0x3fff,
    vaddr_offset_phi1: 0,
    vaddr_chargen_mask_phi1: vic.vaddr_chargen_mask_phi1,
    vaddr_chargen_value_phi1: vic.vaddr_chargen_value_phi1,
    ecmActive,
    readRamPhi1: (a) => ram[a & 0xffff]!,
    readChargenRom: (a) => charRom[a & 0xfff]!,
  };
}

function chargenBaseFromD018(d018: number): number {
  return ((d018 >> 1) & 0x07) * 0x800;
}
function screenBaseFromD018(d018: number): number {
  return ((d018 >> 4) & 0x0f) * 0x400;
}

function bitmapBaseFromD018(d018: number): number {
  return (d018 & 0x08) ? 0x2000 : 0x0000;
}

/** Compute combined video mode index (0..7) per VICE convention. */
export function computeVideoMode(d011: number, d016: number): number {
  const ecm = (d011 & 0x40) ? 1 : 0;
  const bmm = (d011 & 0x20) ? 1 : 0;
  const mcm = (d016 & 0x10) ? 1 : 0;
  return (ecm << 2) | (bmm << 1) | mcm;
}

/** Write one pixel by color index. */
function putPixel(fb: VicFramebuffer, x: number, y: number, colorIdx: number): void {
  if (x < 0 || x >= fb.width || y < 0 || y >= fb.height) return;
  const [r, g, b] = fb.palette[colorIdx & 0x0f]!;
  const off = (y * fb.width + x) * 4;
  fb.pixels[off] = r;
  fb.pixels[off + 1] = g;
  fb.pixels[off + 2] = b;
  fb.pixels[off + 3] = 0xff;
}

/**
 * Emit ONE pixel for the active video mode using current display pipe.
 * Mirrors viciisc/vicii-draw-cycle.c:227-295 inner loop (= mode-dispatch
 * with mc_flop awareness).
 *
 * Mode 0: std text — bit = MSB gbuf; pixel = bit ? cbuf : d021
 * Mode 1: mc text — cbuf bit 3 selects mc-vs-hires per cell
 *   - hires: like mode 0 with cbuf low 3 bits as fg
 *   - mc: 2-bit pairs from gbuf, lookup d021/d022/d023/cbuf-low3
 * Mode 2: std bmp — bit = MSB gbuf; pixel = bit ? vbuf>>4 : vbuf & 0xf
 * Mode 3: mc bmp — 2-bit pairs from gbuf, lookup d021/vbuf>>4/vbuf&0xf/cbuf
 * Mode 4: ECM text — bit = MSB gbuf; bg = ext-bg-color[(vbuf>>6) & 3]
 *                    fg = cbuf & 0xf; chargen addr ANDed with 0x39ff
 * Modes 5-7: illegal — pixel = palette[0] (= absolute black, per Spec 284)
 */
export function emitPixel(
  fb: VicFramebuffer, x: number, y: number,
  pipe: DisplayPipeState, mode: number,
  d021: number, d022: number, d023: number, d024: number,
): void {
  if (x < 0 || x >= fb.width || y < 0 || y >= fb.height) return;
  const bit = (pipe.gbuf.reg >> 7) & 1;

  switch (mode) {
    case 0: { // std text
      putPixel(fb, x, y, bit ? (pipe.cbuf.reg & 0x0f) : (d021 & 0x0f));
      return;
    }
    case 1: { // mc text
      const isMc = (pipe.cbuf.reg & 0x08) !== 0;
      if (!isMc) {
        putPixel(fb, x, y, bit ? (pipe.cbuf.reg & 0x07) : (d021 & 0x0f));
      } else {
        // 2-bit pair: gbuf top 2 bits selected per mc_flop boundary
        const pair = (pipe.gbuf.reg >> 6) & 0x03;
        let c;
        switch (pair) {
          case 0: c = d021; break;
          case 1: c = d022; break;
          case 2: c = d023; break;
          default: c = pipe.cbuf.reg & 0x07; break;
        }
        putPixel(fb, x, y, c & 0x0f);
      }
      return;
    }
    case 2: { // std bmp — vbuf high nibble = fg, low nibble = bg
      const fg = (pipe.vbuf.reg >> 4) & 0x0f;
      const bg = pipe.vbuf.reg & 0x0f;
      putPixel(fb, x, y, bit ? fg : bg);
      return;
    }
    case 3: { // mc bmp
      const pair = (pipe.gbuf.reg >> 6) & 0x03;
      let c;
      switch (pair) {
        case 0: c = d021; break;
        case 1: c = (pipe.vbuf.reg >> 4) & 0x0f; break;
        case 2: c = pipe.vbuf.reg & 0x0f; break;
        default: c = pipe.cbuf.reg & 0x0f; break;
      }
      putPixel(fb, x, y, c & 0x0f);
      return;
    }
    case 4: { // ECM text
      const extBg = [d021, d022, d023, d024];
      const bg = extBg[(pipe.vbuf.reg >> 6) & 0x03]!;
      putPixel(fb, x, y, bit ? (pipe.cbuf.reg & 0x0f) : (bg & 0x0f));
      return;
    }
    case 5: case 6: case 7: // illegal modes — palette[0] (absolute black)
      putPixel(fb, x, y, 0);
      return;
  }
}

/**
 * Install the cycle-pumped renderer onto a session. Wires VicIIVice.
 * onCycle hook to drive per-cycle Φ1/Φ2 fetch + 8-pixel emission.
 *
 * Returns an `uninstall()` callback so callers can revert to the
 * snapshot path.
 */
export function installCyclePumpedRenderer(session: SessionLike): { uninstall: () => void } {
  const state = newRendererState();
  const prev = session.vic.onCycle;

  // Cycle pump: invoked once per raster_cycle (= 8 pixels).
  session.vic.onCycle = (raster_y, raster_cycle, _clk) => {
    // Cycle 1..63 (1-based per CYCLE_TAB_PAL); raster_cycle is 0-based,
    // so cycle = raster_cycle + 1.
    const cycle = raster_cycle + 1;
    if (cycle < 1 || cycle > 63) return;
    const phi1Idx = (cycle - 1) * 2;
    const phi1: CycleEntry = CYCLE_TAB_PAL[phi1Idx]!;
    const phi2: CycleEntry = CYCLE_TAB_PAL[phi1Idx + 1]!;

    const d011 = session.vic.regs[0x11]!;
    const d016 = session.vic.regs[0x16]!;
    const d018 = session.vic.regs[0x18]!;
    const d020 = session.vic.regs[0x20]! & 0x0f;
    const d021 = session.vic.regs[0x21]! & 0x0f;
    const d022 = session.vic.regs[0x22]! & 0x0f;
    const d023 = session.vic.regs[0x23]! & 0x0f;
    const d024 = session.vic.regs[0x24]! & 0x0f;
    const d025 = session.vic.regs[0x25]! & 0x0f;
    const d026 = session.vic.regs[0x26]! & 0x0f;
    const d015 = session.vic.regs[0x15]!;
    const d017 = session.vic.regs[0x17]!;
    const d01b = session.vic.regs[0x1b]!;
    const d01c = session.vic.regs[0x1c]!;
    const d01d = session.vic.regs[0x1d]!;
    const d010 = session.vic.regs[0x10]!;
    const ecmActive = (d011 & 0x40) !== 0;
    const bmm = (d011 & 0x20) !== 0;
    const mode = computeVideoMode(d011, d016);
    const fetchCtx = buildFetchCtx(session, ecmActive);

    // -------- Per-line setup (raster_y change → border + sprites onLineStart) --------
    if (raster_y !== state.lastRasterY) {
      state.lastRasterY = raster_y;
      onLineStartBorder(state.border, raster_y, d011);
      // Sync sprite regs from VIC for all 8 sprites
      for (let s = 0; s < 8; s++) {
        const xLow = session.vic.regs[s * 2]!;
        const yPos = session.vic.regs[s * 2 + 1]!;
        const xMsb = (d010 >> s) & 1;
        loadSpriteRegs(state.sprites[s]!,
          xLow, xMsb, yPos,
          (d015 >> s & 1) !== 0,
          (d017 >> s & 1) !== 0,
          (d01b >> s & 1) !== 0,
          (d01c >> s & 1) !== 0,
          (d01d >> s & 1) !== 0,
          session.vic.regs[0x27 + s]!,
        );
      }
      for (let s = 0; s < 8; s++) spriteOnLineStart(state.sprites[s]!, raster_y);
    }

    // -------- Per-cycle main border check --------
    applyMainBorderCheck(state.border, cycle, "phi1", d016);
    applyMainBorderCheck(state.border, cycle, "phi2", d016);

    // -------- Φ1 fetch --------
    let newGbuf: number | null = null;
    if (phi1.phi1 === PHI1_FETCH_G) {
      let fetchAddr: number;
      if (bmm) {
        // Bitmap fetch: bitmap_base + (vc * 8) + rc
        // (vicii-fetch.c:178 — g_fetch_addr bitmap branch)
        const bitmapBase = bitmapBaseFromD018(d018);
        fetchAddr = bitmapBase + state.vc * 8 + (state.rc & 7);
      } else {
        // Char-mode fetch: chargen_base + char*8 + rc
        const chargenBase = chargenBaseFromD018(d018);
        const charCode = state.vbuf[state.vmli] ?? 0;
        const charY = state.rc & 7;
        fetchAddr = chargenBase + charCode * 8 + charY;
      }
      // ECM masks bits 9, 10 of the graphics fetch addr per VICE
      // vicii-fetch.c:178 (`a &= 0x39ff`).
      if (ecmActive) fetchAddr = fetchAddr & 0x39ff;
      newGbuf = fetchPhi1(fetchCtx, fetchAddr);
    } else if (phi1.phi1 === PHI1_IDLE) {
      newGbuf = fetchIdleGfx(fetchCtx);
    } else if (phi1.phi1 === PHI1_SPR_PTR) {
      // Sprite pointer fetch: read pointer at $07F8+spriteN within VIC bank
      // (= screen_base_ptr + 0x3f8 + sprite_num).
      const screenBase = screenBaseFromD018(d018);
      const spriteN = phi1.phi1SpriteNum;
      const ptrAddr = screenBase + 0x3f8 + spriteN;
      const ptr = fetchPhi1(fetchCtx, ptrAddr);
      state.spriteDataPtr[spriteN] = ptr * 64;  // sprite data = pointer × 64
      state.spriteDmaByteIdx[spriteN] = 0;
      // SprPtr cycles also implicitly fetch sprite data byte 0 in same cycle?
      // No — SprPtr ↔ SprDma0 is the same Φ1 cycle in cycle table marked
      // SprPtr (= ptr+data0). Per VICE we model both as one Φ1 fetch each.
      // Read data byte 0 immediately after pointer:
      if ((d015 >> spriteN & 1) !== 0) {
        const dataByte0 = fetchPhi1(fetchCtx, state.spriteDataPtr[spriteN]! + 0);
        loadSpriteDmaByte(state.sprites[spriteN]!, 0, dataByte0);
        state.spriteDmaByteIdx[spriteN] = 1;
      }
    } else if (phi1.phi1 === PHI1_SPR_DMA1) {
      // Sprite DMA1+DMA2: fetch bytes 1 + 2 of sprite data.
      const spriteN = phi1.phi1SpriteNum;
      if ((d015 >> spriteN & 1) !== 0) {
        const dataByte1 = fetchPhi1(fetchCtx, state.spriteDataPtr[spriteN]! + 1);
        const dataByte2 = fetchPhi1(fetchCtx, state.spriteDataPtr[spriteN]! + 2);
        loadSpriteDmaByte(state.sprites[spriteN]!, 1, dataByte1);
        loadSpriteDmaByte(state.sprites[spriteN]!, 2, dataByte2);
      }
    }

    // VICE vicii-fetch.c:267-270: vmli + vc advance HERE (after Φ1
    // FetchG, before Φ2 FetchC) so Φ2's matrix store goes to the
    // NEXT cell index.
    if (phi1.phi1 === PHI1_FETCH_G && session.vic.bad_line) {
      state.vmli = (state.vmli + 1) & 0x3f;
      state.vc = (state.vc + 1) & 0x3ff;
    }

    // -------- Φ2 fetch --------
    let newVbuf: number | null = null;
    let newCbuf: number | null = null;
    if (phi2.mayFetchC && session.vic.bad_line) {
      const screenBase = screenBaseFromD018(d018);
      newVbuf = session.c64Bus.ram[(screenBase + state.vc) & 0xffff]! & 0xff;
      // Color RAM lives at $D800-$DBFF (= io[0x0800..]).
      newCbuf = session.c64Bus.io[0x0800 + state.vc]! & 0x0f;
      state.vbuf[state.vmli] = newVbuf;
      state.cbuf[state.vmli] = newCbuf;
    }

    // -------- Pixel emit (mode 0 only for 297b) --------
    // Per-cycle pixel offset in the framebuffer: cycle 1..63 maps to
    // pixel x 0..504. xpos comes from cycle table xposDiv8 column.
    // For 297b we use simple cycle-1-aligned linear mapping
    // (= raster_cycle * 8 ... + 8). This matches our existing
    // VISIBLE_X/Y inset (= 32, 51) so display window lands at
    // pixel x = 32+0..319 for cycles 17..56 PAL.
    const xLine = raster_cycle * 8;
    const yPix = raster_y;
    if (phi1.visible || phi2.visible) {
      // Active display row in the visible band only.
      if (yPix >= VISIBLE_Y && yPix < VISIBLE_Y + VISIBLE_H) {
        for (let i = 0; i < 8; i++) {
          if (i === state.pipe.xscroll_pipe) latchPipeRegs(state.pipe);
          if (i === 4) sampleVmode16(state.pipe, d016);
          if (i === 7) holdVmode16Pipe2(state.pipe);
          if (isInBorder(state.border)) {
            // Border pixel = $D020.
            const fb = session.framebuffer;
            const [rB, gB, bB] = fb.palette[d020]!;
            const off = (yPix * fb.width + (xLine + i)) * 4;
            fb.pixels[off] = rB;
            fb.pixels[off + 1] = gB;
            fb.pixels[off + 2] = bB;
            fb.pixels[off + 3] = 0xff;
          } else {
            // Composite gfx + sprites + collision (= 297i).
            compositePixel(
              session.framebuffer, xLine + i, yPix, state.pipe, mode,
              d021, d022, d023, d024, d025, d026,
              state.sprites, state.collision,
            );
          }
          shiftGbufOnePixel(state.pipe);
        }
      }
    }

    // -------- End-of-cycle: pipe stage advance + new pipe0 sample --------
    advancePipeStages(state.pipe);
    samplePipe0(
      state.pipe,
      phi1.visible || phi2.visible,
      false,           // vborder = 297j
      d016,
      newGbuf,
      newVbuf,
      newCbuf,
    );
    sampleVmode11(state.pipe, d011);

    // -------- Line/frame state advance --------
    if (cycle === 14 && phi2.updateVc) {
      // Cycle 14 Φ2 = UpdateVc per VICE
      // (= reset vmli at end of badline window; vcbase carry).
      state.vmli = 0;
    }
    if (cycle === 58 && phi2.updateRc) {
      // Cycle 58 Φ2 = UpdateRc
      if (state.idleState && session.vic.bad_line) state.idleState = false;
      if (!state.idleState) {
        if (state.rc === 7) {
          state.idleState = true;
          state.vcbase = state.vc;
        } else {
          state.rc = (state.rc + 1) & 7;
        }
      }
    }
    if (raster_cycle === 0) {
      // New line — for non-bad lines, vc resets from vcbase.
      if (!session.vic.bad_line) state.vc = state.vcbase;
    }
    void d020; // border color = 297j
  };

  return {
    uninstall() {
      session.vic.onCycle = prev;
    },
  };
}
