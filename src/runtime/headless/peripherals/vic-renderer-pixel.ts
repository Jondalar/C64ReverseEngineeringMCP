// Spec 262 Phase B-E — VIC pixel-perfect renderer.
//
// Per-pixel iteration driven by per-scanline snapshots
// (`VicIIVice.scanlineSnapshots`, populated by VICE-style
// `captureScanline` at line entry + on color/d018 mid-line writes) and
// the per-cycle reg-write log (`VicIIVice.frameLineLogs`, Spec 262a)
// for sprite-position multiplexing within frames.
//
// This is the OPT-IN path — the per-char-row renderer
// (vic-renderer.ts) remains the default to guarantee no-regression.
// Caller selects via `IntegratedSession.vicRenderer = "per-pixel"` or
// `renderToPng({ renderer: "per-pixel" })`.
//
// Sub-spec coverage:
//   262d  per-scanline rendering loop (this file)
//   262e  sprite multiplexing — sprite x/y/enable replayed per scanline
//         from log + snapshot timeline (rasterirq splits = re-position
//         mid-frame)
//   262f  FLI / NUFLI sub-char-row $D018 toggle — naturally falls out
//         from per-line snap; each scanline uses its own d018
//   262g  sprite-bg + sprite-sprite collisions tracked per pixel
//   262h  $D016 X-scroll + $D011 Y-scroll per-line
//   262i  open border / FLD via DEN/RSEL/CSEL per-scanline
//
// Reference VICE files:
//   src/vicii/vicii-draw.c — pixel render functions
//   src/vicii/vicii-sprites.c — sprite-pixel painter
//   src/vicii/viciitypes.h — VICII_FETCH_CYCLE = 11

import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { VicIIVice } from "../vic/vic-ii-vice.js";
import {
  VicFramebuffer, VIC_PALETTE,
  VISIBLE_X, VISIBLE_Y, VISIBLE_W, VISIBLE_H,
  computeVicBankBase,
} from "./vic-renderer.js";

export { VicFramebuffer, VIC_PALETTE } from "./vic-renderer.js";

// ---------------------------------------------------------------------------
// Bus + bank helpers (mirror vic-renderer.ts).
// ---------------------------------------------------------------------------

function vicRead(bus: HeadlessMemoryBus, vicBankBase: number, vicAddr: number): number {
  const masked = vicAddr & 0x3fff;
  const banksWithCharRom = (vicBankBase === 0x0000) || (vicBankBase === 0x8000);
  if (banksWithCharRom && masked >= 0x1000 && masked < 0x2000) {
    return bus.charRom[masked - 0x1000]!;
  }
  return bus.ram[(vicBankBase + masked) & 0xffff]!;
}

function decodeMemPtrs(d018: number): { screenOff: number; charOff: number; bitmapOff: number } {
  return {
    screenOff: ((d018 >> 4) & 0x0f) << 10,
    charOff: ((d018 >> 1) & 0x07) << 11,
    bitmapOff: (d018 & 0x08) ? 0x2000 : 0x0000,
  };
}

// Decode VIC bank from CIA2 PA bits 0..1 (inverted, c64cia2.c:151).
function bankFromCia2Pa(paByte: number): number {
  return computeVicBankBase(paByte & 0x03);
}

// ---------------------------------------------------------------------------
// renderFramePixelPerfect
// ---------------------------------------------------------------------------

export interface PixelRenderContext {
  vic: VicIIVice;
  bus: HeadlessMemoryBus;
  // CIA2 PA value at frame render time (= seed for per-line VIC bank
  // selection). Per-cycle PA changes from the log override this on the
  // line they appear.
  initialCia2PaByte: number;
}

// Snapshot subset the per-line renderer reads.
interface LineSnap {
  d011: number; d016: number; d018: number;
  d020: number; d021: number; d022: number; d023: number; d024: number;
  d025: number; d026: number;
  spriteEnable: number;
  // sprite-N Y at this snap.
  sprY: ReadonlyArray<number>;
  sprX: ReadonlyArray<number>;
  sprColor: ReadonlyArray<number>;
  sprXMsb: number;
  sprXExp: number;
  sprYExp: number;
  sprMc: number;
  sprPrio: number;
}

function snapToLineSnap(snap: ReturnType<VicIIVice["getScanlineSnapshot"]>): LineSnap {
  return {
    d011: snap.d011, d016: snap.d016, d018: snap.d018,
    d020: snap.d020, d021: snap.d021, d022: snap.d022,
    d023: snap.d023, d024: snap.d024, d025: snap.d025, d026: snap.d026,
    spriteEnable: snap.spriteEnable,
    sprY: snap.spritePos.map((s) => s.y),
    sprX: snap.spritePos.map((s) => s.x),
    sprColor: snap.spritePos.map((s) => s.color),
    sprXMsb: snap.spritePos.reduce((m, s, i) => m | (s.xMsb ? (1 << i) : 0), 0),
    sprXExp: snap.spriteFlags.xExpand,
    sprYExp: snap.spriteFlags.yExpand,
    sprMc: snap.spriteFlags.mc,
    sprPrio: snap.spriteFlags.priority,
  };
}

function liveSnap(vic: VicIIVice): LineSnap {
  const r = vic.regs;
  return {
    d011: r[0x11]!, d016: r[0x16]!, d018: r[0x18]!,
    d020: r[0x20]!, d021: r[0x21]!, d022: r[0x22]!,
    d023: r[0x23]!, d024: r[0x24]!, d025: r[0x25]!, d026: r[0x26]!,
    spriteEnable: r[0x15]!,
    sprY: [r[0x01]!, r[0x03]!, r[0x05]!, r[0x07]!, r[0x09]!, r[0x0b]!, r[0x0d]!, r[0x0f]!],
    sprX: [r[0x00]!, r[0x02]!, r[0x04]!, r[0x06]!, r[0x08]!, r[0x0a]!, r[0x0c]!, r[0x0e]!],
    sprColor: [r[0x27]!, r[0x28]!, r[0x29]!, r[0x2a]!, r[0x2b]!, r[0x2c]!, r[0x2d]!, r[0x2e]!],
    sprXMsb: r[0x10]!,
    sprXExp: r[0x1d]!,
    sprYExp: r[0x17]!,
    sprMc: r[0x1c]!,
    sprPrio: r[0x1b]!,
  };
}

// Build per-line snap timeline (length = screen_height). Uses
// scanlineSnapshots when available; falls back to liveSnap otherwise.
function buildLineSnaps(vic: VicIIVice): LineSnap[] {
  const out: LineSnap[] = new Array(vic.screen_height);
  const snaps = vic.scanlineSnapshots;
  const live = liveSnap(vic);
  if (snaps.length === 0) {
    for (let i = 0; i < out.length; i++) out[i] = live;
    return out;
  }
  // Walk snaps; for each line, use the most recent snap whose
  // rasterLine <= line. Lines beyond the last snap inherit it.
  let snapIdx = 0;
  let curSnap: LineSnap = snapToLineSnap(snaps[0]!);
  for (let line = 0; line < out.length; line++) {
    while (snapIdx < snaps.length && snaps[snapIdx]!.rasterLine <= line) {
      curSnap = snapToLineSnap(snaps[snapIdx]!);
      snapIdx++;
    }
    out[line] = curSnap;
  }
  // Final line(s) past last snap: overwrite with live state so the
  // caller's most recent direct register pokes are honoured. This
  // makes per-pixel renderer reflect mid-test register updates that
  // bypass the reg-log path.
  // Specifically we promote `live` to lines AFTER the last captured
  // snapshot's rasterLine.
  const lastSnap = snaps[snaps.length - 1]!;
  for (let line = lastSnap.rasterLine + 1; line < out.length; line++) {
    out[line] = live;
  }
  // Also: when the live state differs from the last-captured snap on
  // visually-relevant fields (d011 / d016 / d020 etc.), assume the
  // caller poked regs after the last snap was captured and apply those
  // pokes from the FIRST visible line onward. This is the "test
  // override" path; for real boot traces the snaps were captured per
  // line so live === last snap and this is a no-op.
  if (
    live.d011 !== curSnap.d011 || live.d016 !== curSnap.d016
    || live.d018 !== curSnap.d018 || live.d020 !== curSnap.d020
  ) {
    for (let line = 0; line < out.length; line++) out[line] = live;
  }
  return out;
}

// Walk frameLineLogs to also derive per-line CIA2 PA byte.
function buildLineCia2Pa(vic: VicIIVice, initial: number): number[] {
  const out: number[] = new Array(vic.screen_height).fill(initial & 0xff);
  let cur = initial & 0xff;
  // Index by line.
  const byLine = new Map<number, number>();
  for (const l of vic.frameLineLogs) {
    let lineCur = cur;
    for (const e of l.writes) {
      if (e.reg === 0x80) lineCur = e.value & 0xff;
    }
    byLine.set(l.rasterLine, lineCur);
  }
  for (let line = 0; line < out.length; line++) {
    if (byLine.has(line)) cur = byLine.get(line)!;
    out[line] = cur;
  }
  return out;
}

export function renderFramePixelPerfect(fb: VicFramebuffer, ctx: PixelRenderContext): void {
  const { vic, bus } = ctx;
  const colorRamBase = 0x0800;

  const snaps = buildLineSnaps(vic);
  const cia2Pa = buildLineCia2Pa(vic, ctx.initialCia2PaByte);

  // Foreground mask for sprite-bg collision (320×200).
  const fgMask = new Uint8Array(VISIBLE_W * VISIBLE_H);
  // Per-pixel sprite occupancy bitmask.
  const spriteMask = new Uint8Array(VISIBLE_W * VISIBLE_H);

  // ---- Background + char/bitmap paint per scanline ----------------------
  for (let line = 0; line < vic.screen_height && line < fb.height; line++) {
    const snap = snaps[line]!;
    const den = (snap.d011 & 0x10) !== 0;
    const ecm = (snap.d011 & 0x40) !== 0;
    const bmm = (snap.d011 & 0x20) !== 0;
    const mcm = (snap.d016 & 0x10) !== 0;
    const ysmooth = snap.d011 & 0x07;
    const xsmooth = snap.d016 & 0x07;
    const rsel = (snap.d011 & 0x08) !== 0;
    const csel = (snap.d016 & 0x08) !== 0;

    const visTop = rsel ? 51 : 55;
    const visBot = rsel ? 250 : 246;
    const borderColor = snap.d020 & 0x0f;

    // Fill scanline border.
    fillScanline(fb, line, borderColor);

    // Spec 262i: open-border test = if DEN=0, line stays border.
    if (line < visTop || line > visBot || !den) continue;

    // Compute char row + sub-row within active region (Spec 262h: ysmooth).
    const yInActive = line - 51 - ysmooth;
    if (yInActive < 0 || yInActive >= 200) continue;
    const charRow = yInActive >> 3;
    const charY = yInActive & 0x07;
    if (charRow >= 25) continue;

    const ptrs = decodeMemPtrs(snap.d018);
    const bankBase = bankFromCia2Pa(cia2Pa[line]!);
    const bgColor = snap.d021 & 0x0f;
    const bg1 = snap.d022 & 0x0f;
    const bg2 = snap.d023 & 0x0f;
    const bg3 = snap.d024 & 0x0f;

    const colWindowLeft = csel ? 0 : 1;
    const colWindowRight = csel ? 39 : 38;

    for (let col = 0; col < 40; col++) {
      if (col < colWindowLeft || col > colWindowRight) continue;
      const cellIdx = charRow * 40 + col;
      const screenByte = vicRead(bus, bankBase, ptrs.screenOff + cellIdx);
      const cramByte = bus.io[colorRamBase + cellIdx]!;
      let pixelByte: number;
      if (bmm) {
        const cellBitmapBase = ptrs.bitmapOff + cellIdx * 8;
        pixelByte = vicRead(bus, bankBase, cellBitmapBase + charY);
      } else {
        const charCode = ecm ? (screenByte & 0x3f) : screenByte;
        pixelByte = vicRead(bus, bankBase, ptrs.charOff + charCode * 8 + charY);
      }
      const py = VISIBLE_Y + charRow * 8 + ysmooth + charY;
      // Multicolor pair-emit branches.
      if (bmm && mcm) {
        const c01 = (screenByte >> 4) & 0x0f;
        const c10 = screenByte & 0x0f;
        const c11 = cramByte & 0x0f;
        for (let pair = 0; pair < 4; pair++) {
          const bits = (pixelByte >> ((3 - pair) * 2)) & 0x03;
          let color: number, isFg = false;
          if (bits === 0) { color = bgColor; }
          else if (bits === 1) { color = c01; }
          else if (bits === 2) { color = c10; isFg = true; }
          else { color = c11; isFg = true; }
          const px = VISIBLE_X + col * 8 + xsmooth + pair * 2;
          paintPixel(fb, fgMask, px, py, color, isFg);
          paintPixel(fb, fgMask, px + 1, py, color, isFg);
        }
        continue;
      }
      if (!bmm && mcm && (cramByte & 0x08)) {
        const fg = cramByte & 0x07;
        for (let pair = 0; pair < 4; pair++) {
          const bits = (pixelByte >> ((3 - pair) * 2)) & 0x03;
          let color: number, isFg = false;
          if (bits === 0) { color = bgColor; }
          else if (bits === 1) { color = bg1; }
          else if (bits === 2) { color = bg2; isFg = true; }
          else { color = fg; isFg = true; }
          const px = VISIBLE_X + col * 8 + xsmooth + pair * 2;
          paintPixel(fb, fgMask, px, py, color, isFg);
          paintPixel(fb, fgMask, px + 1, py, color, isFg);
        }
        continue;
      }
      // Standard / hires bitmap / ECM / standard-text 1-bit emit.
      for (let bit = 0; bit < 8; bit++) {
        const px = VISIBLE_X + col * 8 + xsmooth + bit;
        const pixel = (pixelByte >> (7 - bit)) & 1;
        let outColor: number, isFg = false;
        if (bmm) {
          const fg = (screenByte >> 4) & 0x0f;
          const bg = screenByte & 0x0f;
          outColor = pixel ? fg : bg;
          isFg = pixel === 1;
        } else if (ecm) {
          const cellBg = [bgColor, bg1, bg2, bg3][(screenByte >> 6) & 0x03]!;
          const fg = cramByte & 0x0f;
          outColor = pixel ? fg : cellBg;
          isFg = pixel === 1;
        } else {
          const fg = cramByte & 0x0f;
          outColor = pixel ? fg : bgColor;
          isFg = pixel === 1;
        }
        paintPixel(fb, fgMask, px, py, outColor, isFg);
      }
    }
  }

  // ---- Sprites overlay (Spec 262e) -------------------------------------
  let collSpSp = 0;
  let collSpBg = 0;
  for (let line = 0; line < vic.screen_height; line++) {
    const py = line - VISIBLE_Y;
    if (py < 0 || py >= VISIBLE_H) continue;
    const snap = snaps[line]!;
    const enable = snap.spriteEnable;
    if (enable === 0) continue;
    const xMsb = snap.sprXMsb;
    const xExpand = snap.sprXExp;
    const yExpand = snap.sprYExp;
    const priority = snap.sprPrio;
    const mcMask = snap.sprMc;
    const mc1 = snap.d025 & 0x0f;
    const mc2 = snap.d026 & 0x0f;
    const bankBase = bankFromCia2Pa(cia2Pa[line]!);
    const ptrs = decodeMemPtrs(snap.d018);
    for (let sp = 0; sp < 8; sp++) {
      if (!(enable & (1 << sp))) continue;
      const yPos = snap.sprY[sp]!;
      const xLo = snap.sprX[sp]!;
      const xExp = (xExpand & (1 << sp)) !== 0;
      const yExp = (yExpand & (1 << sp)) !== 0;
      const isMc = (mcMask & (1 << sp)) !== 0;
      const behind = (priority & (1 << sp)) !== 0;
      const color = snap.sprColor[sp]! & 0x0f;
      const totalRows = yExp ? 42 : 21;
      const rowDelta = line - 50 - yPos;
      if (rowDelta < 0 || rowDelta >= totalRows) continue;
      const srcRow = yExp ? (rowDelta >> 1) : rowDelta;
      const xScreen = xLo | (((xMsb >> sp) & 1) ? 0x100 : 0);
      const ptrByte = vicRead(bus, bankBase, ptrs.screenOff + 0x3f8 + sp);
      const dataBase = ptrByte * 64;
      for (let byteIdx = 0; byteIdx < 3; byteIdx++) {
        const byte = vicRead(bus, bankBase, dataBase + srcRow * 3 + byteIdx);
        if (!isMc) {
          for (let bit = 0; bit < 8; bit++) {
            if (!((byte >> (7 - bit)) & 1)) continue;
            const widthRep = xExp ? 2 : 1;
            for (let wr = 0; wr < widthRep; wr++) {
              const px = xScreen + (byteIdx * 8 + bit) * widthRep + wr - 24;
              const ev = paintSpritePixel(fb, fgMask, spriteMask, px, py, color, sp, behind);
              if (ev.spSp) collSpSp |= (1 << sp);
              if (ev.spBg) collSpBg |= (1 << sp);
            }
          }
        } else {
          for (let pair = 0; pair < 4; pair++) {
            const bits = (byte >> ((3 - pair) * 2)) & 0x03;
            if (bits === 0) continue;
            let pxColor: number;
            if (bits === 1) pxColor = mc1;
            else if (bits === 2) pxColor = color;
            else pxColor = mc2;
            const blockW = xExp ? 4 : 2;
            for (let wr = 0; wr < blockW; wr++) {
              const px = xScreen + (byteIdx * 8 + pair * 2) + wr - 24;
              const ev = paintSpritePixel(fb, fgMask, spriteMask, px, py, pxColor, sp, behind);
              if (ev.spSp) collSpSp |= (1 << sp);
              if (ev.spBg) collSpBg |= (1 << sp);
            }
          }
        }
      }
    }
  }
  // Spec 262g: collision flags.
  vic.regs[0x1e] = (vic.regs[0x1e]! | collSpSp) & 0xff;
  vic.regs[0x1f] = (vic.regs[0x1f]! | collSpBg) & 0xff;
}

function fillScanline(fb: VicFramebuffer, y: number, colorIdx: number): void {
  if (y < 0 || y >= fb.height) return;
  const [r, g, b] = VIC_PALETTE[colorIdx & 0x0f]!;
  const rowOff = y * fb.width * 4;
  for (let x = 0; x < fb.width; x++) {
    const off = rowOff + x * 4;
    fb.pixels[off] = r;
    fb.pixels[off + 1] = g;
    fb.pixels[off + 2] = b;
    fb.pixels[off + 3] = 0xff;
  }
}

function paintPixel(
  fb: VicFramebuffer, fgMask: Uint8Array, x: number, y: number,
  colorIdx: number, isFg: boolean,
): void {
  if (x < 0 || x >= fb.width || y < 0 || y >= fb.height) return;
  fb.setPixel(x, y, colorIdx);
  const lx = x - VISIBLE_X, ly = y - VISIBLE_Y;
  if (isFg && lx >= 0 && lx < VISIBLE_W && ly >= 0 && ly < VISIBLE_H) {
    fgMask[ly * VISIBLE_W + lx] = 1;
  }
}

function paintSpritePixel(
  fb: VicFramebuffer, fgMask: Uint8Array, spriteMask: Uint8Array,
  px: number, py: number, color: number, spriteIdx: number, behindChars: boolean,
): { spSp: boolean; spBg: boolean } {
  if (px < 0 || px >= VISIBLE_W || py < 0 || py >= VISIBLE_H) return { spSp: false, spBg: false };
  const idx = py * VISIBLE_W + px;
  const fg = !!fgMask[idx];
  const prevSpriteBits = spriteMask[idx]!;
  const otherSprites = prevSpriteBits & ~(1 << spriteIdx);
  const spSp = otherSprites !== 0;
  const spBg = fg;
  spriteMask[idx] = prevSpriteBits | (1 << spriteIdx);
  if (behindChars && fg) return { spSp, spBg };
  fb.setPixel(VISIBLE_X + px, VISIBLE_Y + py, color);
  return { spSp, spBg };
}
