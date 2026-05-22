#!/usr/bin/env node
// Spec 703.2 — build the reSID audio engine to WASM.
//
// Compiles the vendored GPL reSID C++ (third_party/resid/) plus our flat-C
// shim (src/runtime/headless/sid/wasm/resid_shim.cc) into a committed,
// portable WASM module. Maintainer-only: the OUTPUT is committed to git so a
// plain checkout / npm install needs no emscripten. See
// src/runtime/headless/sid/wasm/README.md.
//
// Usage:
//   npm run build:resid-wasm
//
// Requires emscripten (em++ on PATH, e.g. `brew install emscripten` or emsdk).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESID_SRC = join(ROOT, "third_party", "resid");
const WASM_DIR = join(ROOT, "src", "runtime", "headless", "sid", "wasm");
const SHIM = join(WASM_DIR, "resid_shim.cc");
const OUT = join(WASM_DIR, "resid.mjs"); // emscripten emits resid.mjs + resid.wasm

// reSID compile units. NOTE: with NEW_8580_FILTER=1 (siddefs.h) the active
// Filter class comes from filter8580new.{h,cc}; compiling filter.cc too would
// duplicate the `reSID::Filter` symbols. So filter.cc is intentionally omitted.
const RESID_UNITS = [
  "sid.cc",
  "voice.cc",
  "wave.cc",
  "envelope.cc",
  "filter8580new.cc",
  "extfilt.cc",
  "pot.cc",
  "dac.cc",
  "version.cc",
];

// Flat-C entry points the shim exports (leading underscore = emscripten C ABI),
// plus malloc/free so the TS engine can own a sample buffer in the WASM heap.
const EXPORTED_FUNCTIONS = [
  "_resid_set_chip_model",
  "_resid_set_voice_mask",
  "_resid_enable_filter",
  "_resid_adjust_filter_bias",
  "_resid_enable_external_filter",
  "_resid_set_sampling",
  "_resid_reset",
  "_resid_write",
  "_resid_read",
  "_resid_clock",
  "_resid_clock_remaining",
  "_resid_clock_silent",
  "_resid_output",
  "_malloc",
  "_free",
];

const EXPORTED_RUNTIME_METHODS = ["cwrap", "getValue", "setValue", "HEAP16", "HEAPU8"];

function findEmcc() {
  for (const exe of ["em++", "emcc"]) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return exe;
  }
  return null;
}

function fail(msg) {
  console.error(`\n[build-resid-wasm] ${msg}\n`);
  process.exit(1);
}

const emcc = findEmcc();
if (!emcc) {
  fail(
    "emscripten not found (em++/emcc not on PATH).\n" +
      "  Install it, then re-run `npm run build:resid-wasm`:\n" +
      "    brew install emscripten          # macOS\n" +
      "    # or: https://emscripten.org/docs/getting_started/downloads.html\n" +
      "  The compiled WASM is committed to git, so this is only needed when the\n" +
      "  reSID source (third_party/resid/) or the shim changes.",
  );
}

for (const u of RESID_UNITS) {
  if (!existsSync(join(RESID_SRC, u))) {
    fail(`missing reSID source ${u} in ${RESID_SRC} — re-vendor from VICE (see third_party/resid/PROVENANCE.md).`);
  }
}
if (!existsSync(SHIM)) fail(`missing shim ${SHIM}`);

mkdirSync(WASM_DIR, { recursive: true });

// reSID version string — normally injected by VICE configure. version.cc does
// `resid_version_string = VERSION;` so it must be a C string literal. No shell
// here (execFileSync), so the quotes survive into the macro value.
const RESID_VERSION = "1.0-pre2";

const args = [
  "-O3",
  "-std=c++11",
  `-DVERSION="${RESID_VERSION}"`,
  `-I${RESID_SRC}`,
  ...RESID_UNITS.map((u) => join(RESID_SRC, u)),
  SHIM,
  "-o",
  OUT,
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createResidModule",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sENVIRONMENT=node,web,worker",
  "-sFILESYSTEM=0",
  `-sEXPORTED_FUNCTIONS=${EXPORTED_FUNCTIONS.join(",")}`,
  `-sEXPORTED_RUNTIME_METHODS=${EXPORTED_RUNTIME_METHODS.join(",")}`,
];

console.log(`[build-resid-wasm] ${emcc} ${RESID_UNITS.length} reSID units + shim → ${OUT}`);
try {
  execFileSync(emcc, args, { stdio: "inherit", cwd: ROOT });
} catch (e) {
  fail(`emscripten build failed (exit ${e.status ?? "?"}).`);
}

const wasm = join(WASM_DIR, "resid.wasm");
for (const f of [OUT, wasm]) {
  if (!existsSync(f)) fail(`expected output missing: ${f}`);
  console.log(`[build-resid-wasm]   ${f}  (${(statSync(f).size / 1024).toFixed(1)} KiB)`);
}
console.log(
  "[build-resid-wasm] done. Commit the two artifacts:\n" +
    "  git add src/runtime/headless/sid/wasm/resid.mjs src/runtime/headless/sid/wasm/resid.wasm",
);
