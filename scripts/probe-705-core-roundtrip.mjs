#!/usr/bin/env node
// Spec 705.A step 3 — native RuntimeCheckpoint core+VIC+drive roundtrip.
//
// Proves the spike-gate identities for the FULL active machine path (C64 core
// + active literal VIC + active VICE1541 drive), WITHOUT audio (reSID PCM is
// the explicit step-4 follow-on):
//
//   checkpoint -> disturb/run -> restore == original          (immediate identity)
//   checkpoint -> run N == restore(checkpoint) -> run N        (continuation)
//   mid-frame checkpoint -> restore -> first completed frame identical
//
// STRICTLY SEQUENTIAL from one checkpoint in ONE session: the literal VIC
// (LIT_TYPES.vicii) is a global singleton, so two parallel sessions cannot be
// used as a comparison oracle. Control runs first, then restore + replay.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";

const diskPath = resolvePath("samples/POLARBEAR.d64");

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

function fnv1a(bytes) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// Full comparable machine signature: CPU regs+cycles, VIC raster position, RAM
// hash, completed-frame hash, drive state, IEC line intent.
function machineSig(session) {
  const cpu = session.c64Cpu;
  const r = session.vicRaster();
  const d = session.kernel.drive1541?.debugProbe?.() ?? null;
  const iec = session.iecBus.snapshot();
  return {
    pc: cpu.pc & 0xffff, a: cpu.a & 0xff, x: cpu.x & 0xff, y: cpu.y & 0xff,
    sp: cpu.sp & 0xff, cycles: cpu.cycles >>> 0,
    rasterLine: r.line, rasterCycle: r.cycle,
    ramHash: fnv1a(session.c64Bus.ram),
    frameHash: session.literalPortFbStable ? fnv1a(session.literalPortFbStable) : -1,
    drive: d ? `${(d.drive_pc ?? 0).toString(16)}/${d.drive_clk ?? 0}/${d.head_halftrack ?? 0}` : "n/a",
    iec: `${iec.line.atn ? 1 : 0}${iec.line.clk ? 1 : 0}${iec.line.data ? 1 : 0}`,
  };
}
function sigEqual(a, b) {
  for (const k of Object.keys(a)) if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] };
  return { ok: true };
}
function sigStr(s) { return `pc=${s.pc.toString(16)} cyc=${s.cycles} ry=${s.rasterLine} ram=${s.ramHash.toString(16)} fr=${s.frameHash.toString(16)} drv=${s.drive}`; }

function startSession(withDisk) {
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
  });
  return { session, sessionId, withDisk };
}

// One self-contained sequential scenario in its OWN session.
async function scenario(label, { withDisk, warmup, runN, midFrame }) {
  console.log(`\n[${label}]`);
  const { session, sessionId } = startSession(withDisk);
  try {
    if (withDisk) {
      const mount = await mountMedia(session, 8, diskPath);
      gate(`${label}: disk mounts`, !mount.errors?.length, mount.errors?.join("; "));
    }
    session.resetCold("pal-default");
    session.runFor(warmup, { cycleBudget: warmup });

    if (midFrame) {
      // advance to a non-frame-edge raster line so the checkpoint lands mid-frame
      let guard = 0;
      while ((session.vicRaster().line === 0 || session.vicRaster().line > 250) && guard++ < 200) {
        session.runFor(2000, { cycleBudget: 2000 });
      }
    }

    // checkpoint at the current (instruction-boundary) state
    const cp = session.kernel.snapshot();
    gate(`${label}: kernel checkpoint payload is non-null`, cp.payload != null,
      `schema=${cp.schemaVersion}`);
    const sigAtCp = machineSig(session);

    // CONTROL: run N forward
    session.runFor(runN, { cycleBudget: runN });
    const sigControl = machineSig(session);
    gate(`${label}: run N actually advanced state`, sigControl.cycles !== sigAtCp.cycles,
      `${sigAtCp.cycles} -> ${sigControl.cycles}`);

    // RESTORE the checkpoint
    session.kernel.restore(cp);
    const sigAfterRestore = machineSig(session);

    // immediate identity: restored == checkpoint moment
    const im = sigEqual(sigAtCp, sigAfterRestore);
    gate(`${label}: restore == checkpoint (immediate identity)`, im.ok,
      im.ok ? sigStr(sigAtCp) : `mismatch ${im.k}: ${im.a} != ${im.b}`);

    // REPLAY: run N again from restore
    session.runFor(runN, { cycleBudget: runN });
    const sigReplay = machineSig(session);

    // continuation determinism: replay == control
    const co = sigEqual(sigControl, sigReplay);
    gate(`${label}: run N == restore -> run N (continuation determinism)`, co.ok,
      co.ok ? sigStr(sigControl) : `mismatch ${co.k}: ${co.a} != ${co.b}`);
  } finally {
    stopIntegratedSession(sessionId);
  }
}

console.log("Spec 705.A step 3 — native RuntimeCheckpoint core+VIC+drive roundtrip");
if (!existsSync(diskPath)) console.log(`  (note: ${diskPath} missing — real-media scenario will report mount RED)`);

await scenario("BASIC/READY (no disk)", { withDisk: false, warmup: 2_500_000, runN: 200_000, midFrame: false });
await scenario("real-media + VICE1541", { withDisk: true, warmup: 2_500_000, runN: 200_000, midFrame: false });
await scenario("mid-frame VIC restore", { withDisk: false, warmup: 2_500_000, runN: 60_000, midFrame: true });

console.log("\n---");
console.log("reSID PCM continuation: PENDING (Spec 705.A step 4) — not covered here.");
if (failures.length === 0) {
  console.log(`GREEN 705.A core roundtrip: ${passes} checks pass.`);
  process.exit(0);
}
console.log(`RED 705.A core roundtrip: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
