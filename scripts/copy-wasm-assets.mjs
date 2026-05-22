#!/usr/bin/env node
// Spec 703.2 — copy the committed reSID WASM module into dist/ next to the
// compiled engine, so resid-wasm-engine.js can load `./wasm/resid.mjs`.
//
// Runs as part of `build:mcp`. MUST be bulletproof: build:mcp is the root of
// the whole gate chain, so a missing/unbuilt WASM (emscripten not yet run) must
// only warn, never fail. The resid-wasm engine surfaces a clear runtime error
// if actually selected without a built module.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "runtime", "headless", "sid", "wasm");
const DST = join(ROOT, "dist", "runtime", "headless", "sid", "wasm");
const FILES = ["resid.mjs", "resid.wasm"];

try {
  const present = FILES.filter((f) => existsSync(join(SRC, f)));
  if (present.length === 0) {
    console.warn(
      "[copy-wasm-assets] no committed reSID WASM yet — skipping. " +
        "Run `npm run build:resid-wasm` (needs emscripten) to enable resid-wasm audio.",
    );
    process.exit(0);
  }
  mkdirSync(DST, { recursive: true });
  for (const f of present) copyFileSync(join(SRC, f), join(DST, f));
  console.log(`[copy-wasm-assets] copied ${present.join(", ")} → dist/runtime/headless/sid/wasm/`);
} catch (e) {
  // Never break the build over an asset copy.
  console.warn(`[copy-wasm-assets] non-fatal: ${e?.message ?? e}`);
}
process.exit(0);
