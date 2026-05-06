#!/usr/bin/env node
// Spec 204 — TrueDrive hook hygiene smoke.
//
// Acceptance:
//   1. Default kernel mode = `debug-lockstep`. All registered legacy
//      hooks present in `kernel.status().hooks` with fireCount 0.
//   2. In `debug-lockstep` mode: synthetic IEC release succeeds,
//      hook fireCount + lastFireClock recorded.
//   3. After `kernel.setMode("true-drive")`: any hook fire throws
//      HookForbiddenError. fireCount stays unchanged.
//   4. Status reports the new mode.

import { existsSync } from "node:fs";

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}

console.log("hook-hygiene smoke — Spec 204 acceptance");

const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});
const kernel = session.kernel;

const expectedHooks = [
  "atn-poke-7c",
  "iec-release-clk",
  "iec-release-data",
  "kernal-serial-trap",
  "kernal-fileio-trap",
  "kernal-io-trap",
  "fake-disk-byte",
  "forced-pc-jump",
];

check("kernel.status().hooks lists every registered hook", () => {
  const s = kernel.status();
  const names = new Set(s.hooks.map((h) => h.name));
  for (const want of expectedHooks) {
    if (!names.has(want)) throw new Error(`missing hook ${want} in status`);
  }
});

check("all hooks start with fireCount 0", () => {
  for (const h of kernel.status().hooks) {
    if (h.fireCount !== 0) throw new Error(`${h.name} fireCount = ${h.fireCount}`);
  }
});

check("default mode is debug-lockstep", () => {
  if (kernel.getMode() !== "debug-lockstep") {
    throw new Error(`mode != debug-lockstep, got ${kernel.getMode()}`);
  }
});

check("releaseDriveClk in debug-lockstep records fire", () => {
  const beforeClock = kernel.c64Clock();
  kernel.iecBus.releaseDriveClk("smoke-test-allowed");
  const h = kernel.status().hooks.find((x) => x.name === "iec-release-clk");
  if (!h) throw new Error("hook record missing");
  if (h.fireCount !== 1) throw new Error(`fireCount != 1, got ${h.fireCount}`);
  if (typeof h.lastFireClock !== "number") throw new Error("lastFireClock not number");
  if (h.lastFireClock < beforeClock) throw new Error("lastFireClock predates fire");
  if (h.lastFireDescription !== "smoke-test-allowed") {
    throw new Error(`lastFireDescription = ${h.lastFireDescription}`);
  }
});

check("releaseDriveData in debug-lockstep records fire", () => {
  kernel.iecBus.releaseDriveData("smoke-test-allowed");
  const h = kernel.status().hooks.find((x) => x.name === "iec-release-data");
  if (!h || h.fireCount !== 1) {
    throw new Error(`fireCount unexpected: ${JSON.stringify(h)}`);
  }
});

check("kernel.setMode('true-drive') updates status.mode", () => {
  kernel.setMode("true-drive");
  if (kernel.getMode() !== "true-drive") throw new Error("mode not switched");
  if (kernel.status().mode !== "true-drive") throw new Error("status mode mismatch");
});

check("releaseDriveClk in true-drive throws HookForbiddenError", () => {
  const before = kernel.status().hooks.find((x) => x.name === "iec-release-clk").fireCount;
  let threw = false;
  try {
    kernel.iecBus.releaseDriveClk("must-fail");
  } catch (e) {
    threw = true;
    const msg = String(e?.message ?? e);
    if (!msg.includes("hook-hygiene")) {
      throw new Error(`unexpected error: ${msg}`);
    }
    if (!msg.includes("iec-release-clk")) {
      throw new Error(`error missing hook name: ${msg}`);
    }
    if (!msg.includes("true-drive")) {
      throw new Error(`error missing mode: ${msg}`);
    }
  }
  if (!threw) throw new Error("expected throw, got nothing");
  const after = kernel.status().hooks.find((x) => x.name === "iec-release-clk").fireCount;
  if (after !== before) {
    throw new Error(`fireCount bumped despite throw: ${before} -> ${after}`);
  }
});

check("recordHookFire(kernal-serial-trap) in true-drive throws", () => {
  let threw = false;
  try {
    kernel.recordHookFire("kernal-serial-trap", "must-fail");
  } catch (e) {
    threw = true;
    if (!String(e?.message ?? e).includes("kernal-serial-trap")) {
      throw new Error("wrong error");
    }
  }
  if (!threw) throw new Error("expected throw");
});

check("setMode back to debug-lockstep restores fire-allow", () => {
  kernel.setMode("debug-lockstep");
  kernel.iecBus.releaseDriveClk("re-enabled");
  const h = kernel.status().hooks.find((x) => x.name === "iec-release-clk");
  if (h.fireCount !== 2) throw new Error(`fireCount = ${h.fireCount}, want 2`);
});

session.shutdown?.();

console.log("---");
console.log(`summary: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(`FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
