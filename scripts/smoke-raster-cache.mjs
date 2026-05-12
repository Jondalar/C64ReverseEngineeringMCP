#!/usr/bin/env node
// Spec 290 — VIC-II raster cache smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const { RasterCache, computeLineKey } = await import(
  `${REPO}/dist/runtime/headless/vic/raster-cache.js`
);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 290 raster cache smoke ===\n");

const c = new RasterCache(312, 504);

// 1. Disabled by default.
check("cache disabled by default", !c.isEnabled());
check("lookup with disabled returns null",
  c.lookup(50, 0xdeadbeef) === null);

// 2. Enable + miss-then-store flow.
c.enable(true);
check("enabled after enable(true)", c.isEnabled());

const k = 0x12345678;
check("first lookup = miss", c.lookup(50, k) === null);

const px = new Uint8Array(504);
px[10] = 0xae;
c.store(50, k, px);
check("store writes entry", c.lookup(50, k) !== null);

const e = c.lookup(50, k);
check("cache returned same key", e?.key === k);
check("cache pixels preserved", e?.pixels[10] === 0xae);

// 3. Different key on same line = miss.
check("different key = miss",
  c.lookup(50, k + 1) === null);

// 4. Invalidation drops entry.
c.invalidate(50);
check("invalidated entry not returned",
  c.lookup(50, k) === null);

// 5. invalidateAll affects all lines.
c.store(100, k, px);
c.store(200, k, px);
c.invalidateAll();
check("after invalidateAll: line 100 miss",
  c.lookup(100, k) === null);
check("after invalidateAll: line 200 miss",
  c.lookup(200, k) === null);

// 6. Stats counters.
const stats = c.stats();
check("stats.hits > 0", stats.hits > 0, `hits=${stats.hits}`);
check("stats.misses > 0", stats.misses > 0, `misses=${stats.misses}`);
check("stats.invalidations > 0",
  stats.invalidations > 0, `inv=${stats.invalidations}`);

// 7. computeLineKey uniqueness.
const baseState = {
  video_mode: 0, xsmooth: 0, ysmooth: 0,
  screen_base_ptr: 0x0400, chargen_base_ptr: 0x1000,
  bitmap_base_ptr: 0,
  background_color: 6, border_color: 14,
  sprite_enable: 0, raster_mode: "display",
};
const k1 = computeLineKey(baseState);
const k2 = computeLineKey({ ...baseState, video_mode: 1 });
check("computeLineKey: video_mode change → different key", k1 !== k2);

const k3 = computeLineKey({ ...baseState, background_color: 7 });
check("computeLineKey: bg color change → different key", k1 !== k3);

const k4 = computeLineKey({ ...baseState, raster_mode: "border" });
check("computeLineKey: raster_mode change → different key", k1 !== k4);

const k5 = computeLineKey(baseState);
check("computeLineKey: same state → same key (deterministic)", k1 === k5);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
