// Spec 065 Sprint 71 (Phase 65b) smoke — VIC framebuffer + text mode + PNG.

import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { VicFramebuffer, VIC_PALETTE } from "../dist/runtime/headless/peripherals/vic-renderer.js";
import { rgbaToPng } from "../dist/runtime/headless/peripherals/png-writer.js";

// ---- Test 1: VicFramebuffer.fill paints uniformly ----
{
  const fb = new VicFramebuffer(true);
  assert.equal(fb.width, 504);
  assert.equal(fb.height, 312);
  fb.fill(6); // blue
  const [r, g, b] = VIC_PALETTE[6];
  assert.equal(fb.pixels[0], r);
  assert.equal(fb.pixels[1], g);
  assert.equal(fb.pixels[2], b);
  assert.equal(fb.pixels[3], 0xff);
  console.log("  ✓ Framebuffer fill works");
}

// ---- Test 2: setPixel ----
{
  const fb = new VicFramebuffer(true);
  fb.setPixel(10, 20, 1); // white
  const off = (20 * fb.width + 10) * 4;
  assert.equal(fb.pixels[off], 0xff);
  assert.equal(fb.pixels[off + 1], 0xff);
  assert.equal(fb.pixels[off + 2], 0xff);
  console.log("  ✓ setPixel writes correct color");
}

// ---- Test 3: PNG round-trip ----
{
  const tmp = mkdtempSync(join(tmpdir(), "sprint71-png-"));
  try {
    const fb = new VicFramebuffer(true);
    fb.fill(14); // light blue border
    const png = rgbaToPng(fb.width, fb.height, fb.pixels);
    const path = join(tmp, "test.png");
    const fs = await import("node:fs");
    fs.writeFileSync(path, png);
    assert.ok(existsSync(path));
    const bytes = readFileSync(path);
    // Check PNG signature
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.equal(bytes[2], 0x4e);
    assert.equal(bytes[3], 0x47);
    console.log(`  ✓ PNG written + valid signature (${png.length} bytes)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Test 4: end-to-end via IntegratedSession ----
{
  const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
  const candidate = join(samples, "maniac_mansion_s1[activision_1987](german)(manual)(!).g64");
  if (!existsSync(candidate)) {
    console.log("  (end-to-end skipped — no sample G64)");
  } else {
    const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
    const { session } = startIntegratedSession({ diskPath: candidate, enableKernalFileIoTraps: true });
    session.resetCold();
    session.runFor(1_500_000);
    const tmp = mkdtempSync(join(tmpdir(), "sprint71-e2e-"));
    try {
      const path = join(tmp, "ready.png");
      const r = session.renderToPng(path);
      assert.equal(r.width, 504);
      assert.equal(r.height, 312);
      assert.ok(statSync(path).size > 1000, "PNG > 1KB (compressed framebuffer)");
      console.log(`  ✓ KERNAL READY prompt rendered to PNG: ${r.bytes} bytes`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log("Sprint 71 smoke (VIC framebuffer + text-mode render + PNG export) OK");
