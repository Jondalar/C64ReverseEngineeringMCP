#!/usr/bin/env node
// scripts/smoke-710-vic-inspect.mjs
//
// Spec 710.2 — checkpoint-bound VIC inspect resolver smoke.
//
// (A) Real boot screen: capture a checkpoint of the BASIC READY screen, build the
//     inspect snapshot, resolve a non-space text cell, assert every MemoryRef is
//     internally consistent with the frozen checkpoint RAM/color RAM — WITHOUT
//     advancing execution.
// (B) Synthetic sprite: a minimal checkpoint with sprite 0 enabled → assert the
//     resolver returns a sprite node with the correct pointer/data refs.
//
// Exit 0 = PASS, 1 = FAIL.

import { resolve as resolvePath } from "node:path";

let startIntegratedSession, stopIntegratedSession, ensureRuntimeController,
    buildVicInspectSnapshot, resolveNodeAt, assembleInspectEvidence,
    resolveVisibleNodeAt, visibleToDisplay, DISPLAY_ORIGIN;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js"));
  ({ buildVicInspectSnapshot, resolveNodeAt, assembleInspectEvidence,
     resolveVisibleNodeAt, visibleToDisplay, DISPLAY_ORIGIN } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
} catch (e) {
  console.error("dist missing / import failed — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let passes = 0;
const failures = [];
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
}

console.log("Spec 710.2 — VIC inspect resolver smoke");

// ---- (A) real boot screen ----
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
  });
  try {
    session.resetCold("pal-default");
    session.runFor(3_000_000, { cycleBudget: 3_000_000 }); // boot to READY

    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    const ref = await ctrl.captureCheckpoint();
    const snap = ctrl.checkpointRing.restoreSnapshot(ref.id);
    const cp = snap?.payload;
    gate("A checkpoint captured + payload readable", !!cp && !!cp.vic && !!cp.ram, `id=${ref.id}`);

    const vsnap = buildVicInspectSnapshot(cp);
    gate("A mode = standard_text at READY", vsnap.mode === "standard_text", `mode=${vsnap.mode}`);
    gate("A screenBase = $0400 (default bank0)", vsnap.screenBase === 0x0400, `screenBase=$${vsnap.screenBase.toString(16)}`);
    gate("A charBase char-ROM shadow ($1000, bank0)", vsnap.charRomShadow === true && vsnap.charBase === 0x1000, `charBase=$${vsnap.charBase.toString(16)} shadow=${vsnap.charRomShadow}`);

    // find a non-space text cell on the banner
    let found = null;
    for (let row = 0; row < 25 && !found; row++) {
      for (let col = 0; col < 40; col++) {
        const code = cp.ram[vsnap.screenBase + row * 40 + col] & 0xff;
        if (code !== 0x20 && code !== 0x00) { found = { row, col, code }; break; }
      }
    }
    gate("A found a non-space text cell on the boot banner", !!found, found ? `code=$${found.code.toString(16)} @cell(${found.col},${found.row})` : "none");

    if (found) {
      const node = resolveNodeAt(cp, found.col * 8 + 1, found.row * 8 + 1);
      const idx = found.row * 40 + found.col;
      gate("A node.type = text_cell", node.type === "text_cell", node.type);
      gate("A node.cell.index matches", node.cell?.index === idx, `idx=${node.cell?.index} expected ${idx}`);
      gate("A node.value == screen RAM byte", node.value === found.code, `value=$${(node.value ?? 0).toString(16)}`);
      const sref = node.refs.find((r) => r.kind === "screen_ram");
      const cref = node.refs.find((r) => r.kind === "color_ram");
      const chref = node.refs.find((r) => r.kind === "charset");
      gate("A screen_ram ref addr = screenBase+index", sref?.addr === vsnap.screenBase + idx, `addr=$${sref?.addr.toString(16)}`);
      gate("A color_ram ref addr = $D800+index", cref?.addr === 0xd800 + idx, `addr=$${cref?.addr.toString(16)}`);
      gate("A charset ref addr = charBase + code*8", chref?.addr === vsnap.charBase + found.code * 8, `addr=$${chref?.addr.toString(16)}`);
      gate("A charset ref notes char ROM shadow", chref?.note === "char ROM shadow", chref?.note);
    }
  } finally {
    try { stopIntegratedSession(sessionId); } catch {}
  }
}

// ---- (B) synthetic sprite checkpoint ----
{
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14;          // screen $0400, char $1000
  regs[0x15] = 0x01;          // sprite 0 enabled
  regs[0x00] = 24 + 50;       // sprite0 X = 74 → display x 50
  regs[0x01] = 50 + 30;       // sprite0 Y = 80 → display y 30
  regs[0x10] = 0x00;          // no MSB X
  regs[0x27] = 0x07;          // sprite0 color = yellow
  const ram = new Uint8Array(65536);
  ram[0x07f8] = 0x80;         // sprite0 pointer → data @ $80*64 = $2000
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };

  const inside = resolveNodeAt(cp, 52, 32); // inside the 24x21 sprite box at (50,30)
  gate("B sprite hit → node.type = sprite_bounds (honest: box hit, not pixel-exact)", inside.type === "sprite_bounds", inside.type);
  gate("B sprite_data ref notes bounding-box (not pixel-exact)", /bounding-box/.test(inside.refs.find((r) => r.kind === "sprite_data")?.note ?? ""), inside.refs.find((r) => r.kind === "sprite_data")?.note);
  gate("B sprite node.value = sprite index 0", inside.value === 0, `value=${inside.value}`);
  const ptr = inside.refs.find((r) => r.kind === "sprite_ptr");
  const data = inside.refs.find((r) => r.kind === "sprite_data");
  gate("B sprite_ptr ref addr = $07F8", ptr?.addr === 0x07f8, `addr=$${ptr?.addr.toString(16)}`);
  gate("B sprite_ptr value = $80", ptr?.value === 0x80, `value=$${(ptr?.value ?? 0).toString(16)}`);
  gate("B sprite_data ref addr = $2000 (ptr*64)", data?.addr === 0x2000, `addr=$${data?.addr.toString(16)}`);

  const outside = resolveNodeAt(cp, 200, 150); // far from the sprite → text cell
  gate("B pixel outside sprite → text_cell", outside.type === "text_cell", outside.type);
}

// ---- (C) 710.5 evidence assembly (shared 710/711/712 record) ----
{
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
  });
  try {
    session.resetCold("pal-default");
    session.runFor(3_000_000, { cycleBudget: 3_000_000 });
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    const ref = await ctrl.captureCheckpoint();
    const cp = ctrl.checkpointRing.restoreSnapshot(ref.id)?.payload;

    // find a non-space cell again
    const vsnap = buildVicInspectSnapshot(cp);
    let cell = null;
    for (let row = 0; row < 25 && !cell; row++)
      for (let col = 0; col < 40; col++) {
        const code = cp.ram[vsnap.screenBase + row * 40 + col] & 0xff;
        if (code !== 0x20 && code !== 0x00) { cell = { row, col }; break; }
      }
    const ev = assembleInspectEvidence(cp, ref.id, { points: [{ x: cell.col * 8 + 1, y: cell.row * 8 + 1 }] });
    gate("C evidence.checkpointId = captured id", ev.checkpointId === ref.id, ev.checkpointId);
    gate("C evidence carries mediaState (Spec 709 identity in checkpoint)", ev.mediaState !== undefined);
    gate("C evidence.frame.mode = standard_text", ev.frame?.mode === "standard_text", ev.frame?.mode);
    gate("C evidence has exactly one selected node", ev.selectedNodes?.length === 1, `n=${ev.selectedNodes?.length}`);
    gate("C selected node = text_cell with screen_ram ref", ev.selectedNodes?.[0]?.type === "text_cell" && !!ev.selectedNodes[0].refs.find((r) => r.kind === "screen_ram"));
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

// ---- (D) 710.3 option 2 — backend visible-frame → cell conversion ----
{
  // DISPLAY_ORIGIN = {x:32, y:35}. Put 'C' (screen code $03) at cell (9,1).
  const regs = new Array(0x40).fill(0); regs[0x18] = 0x14; // screen $0400, char $1000
  const ram = new Uint8Array(65536); ram[0x400 + 1 * 40 + 9] = 0x03;
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
  // visible-frame px for the centre of cell (9,1):
  const vx = DISPLAY_ORIGIN.x + 9 * 8 + 4, vy = DISPLAY_ORIGIN.y + 1 * 8 + 4;
  const d = visibleToDisplay(vx, vy);
  gate("D DISPLAY_ORIGIN = {32,35}", DISPLAY_ORIGIN.x === 32 && DISPLAY_ORIGIN.y === 35, `(${DISPLAY_ORIGIN.x},${DISPLAY_ORIGIN.y})`);
  gate("D visibleToDisplay → cell (9,1)", (d.x >> 3) === 9 && (d.y >> 3) === 1, `display=(${d.x},${d.y})`);
  const vn = resolveVisibleNodeAt(cp, vx, vy);
  gate("D resolveVisibleNodeAt → cell (9,1)", vn.cell?.col === 9 && vn.cell?.row === 1, `cell=(${vn.cell?.col},${vn.cell?.row})`);
  gate("D resolved screen code $03 ('C') at the visible click", vn.value === 0x03, `code=$${(vn.value || 0).toString(16)}`);
}

// ---- (E) 710.6a — border-aware sprite resolve (open-border logo sprites) ----
{
  // Scramble-like: sprite 0 in the TOP BORDER (X=88, Y=29), multicolor, enabled.
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14;          // screen $0400
  regs[0x15] = 0x01;          // sprite 0 enabled
  regs[0x00] = 88; regs[0x01] = 29; // X=88, Y=29 (raster 29 → open border)
  regs[0x1c] = 0x01;          // sprite 0 multicolor
  regs[0x20] = 14;            // border colour
  regs[0x27] = 0x07;          // sprite 0 colour
  const ram = new Uint8Array(65536); ram[0x07f8] = 0x80; // sprite0 ptr
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram, cia2: { c_cia: [0x03] } };
  // visible box for spr0: x = 88-24+32 = 96..120, y = 29-16 = 13..34 (top border)
  const inSpr = resolveVisibleNodeAt(cp, 100, 17);
  gate("E open-border click → sprite_bounds (sprite 0)", inSpr.type === "sprite_bounds" && inSpr.value === 0, `${inSpr.type} v=${inSpr.value}`);
  gate("E sprite node tags raster line (border, <51)", inSpr.raster?.line === 33, `raster=${inSpr.raster?.line}`);
  gate("E sprite_data ref notes OPEN BORDER", /OPEN BORDER/.test(inSpr.refs.find((r) => r.kind === "sprite_data")?.note ?? ""));
  const inBorderNoSpr = resolveVisibleNodeAt(cp, 10, 5);
  gate("E border click, no sprite → border node", inBorderNoSpr.type === "border" && inBorderNoSpr.colorIndex === 14, `${inBorderNoSpr.type} c=${inBorderNoSpr.colorIndex}`);
  const inDisplay = resolveVisibleNodeAt(cp, 200, 120);
  gate("E display click, no sprite → text/bitmap cell", inDisplay.type === "text_cell" || inDisplay.type === "bitmap_cell", inDisplay.type);
}

// ---- (F) 710.6b — multiplexer: per-raster sprite provenance ----
{
  const regs = new Array(0x40).fill(0); regs[0x18] = 0x14; regs[0x15] = 0x00; // no FROZEN sprites
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram: new Uint8Array(65536), cia2: { c_cia: [0x03] } };
  // sprite 0 multiplexed: at raster 60 → X=88; at raster 140 → X=200 (re-used).
  const provenance = { lines: [
    { line: 60, d011: 0, d016: 0, d018: 0x14, bank: 0, sprites: [{ i: 0, x: 88, y: 60, w: 24, h: 21, ptr: 0x80, color: 1 }] },
    { line: 140, d011: 0, d016: 0, d018: 0x14, bank: 0, sprites: [{ i: 0, x: 200, y: 140, w: 24, h: 21, ptr: 0x81, color: 2 }] },
  ] };
  const spriteX = (n) => n.refs.find((r) => r.kind === "vic_reg" && r.note === "sprite X")?.value;
  const a = resolveVisibleNodeAt(cp, 100, 60 - 16, provenance); // raster 60, over X=88
  gate("F multiplexer raster 60 → sprite0 @ X=88", a.type === "sprite_bounds" && a.value === 0 && spriteX(a) === 88, `${a.type} X=${spriteX(a)}`);
  const b = resolveVisibleNodeAt(cp, 215, 140 - 16, provenance); // raster 140, over X=200
  gate("F multiplexer raster 140 → SAME sprite0 @ X=200 (moved)", b.type === "sprite_bounds" && b.value === 0 && spriteX(b) === 200, `${b.type} X=${spriteX(b)}`);
  gate("F sprite_data ref notes MULTIPLEXED", /MULTIPLEXED/.test(b.refs.find((r) => r.kind === "sprite_data")?.note ?? ""));
  const c = resolveVisibleNodeAt(cp, 215, 60 - 16, provenance); // raster 60, off the sprite
  gate("F raster 60 off-sprite → NOT sprite (per-raster state authoritative)", c.type !== "sprite_bounds", c.type);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 710.2/710.5 VIC inspect: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 710.2 VIC inspect: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
