#!/usr/bin/env node
// Spec 263 — CLI shim for `runtime_audio_export`. Boots a session from a
// disk image, runs for N seconds, writes a stereo WAV.
//
// Usage:
//   node scripts/cli-audio-export.mjs --disk path.g64 --out out.wav --sec 10
//   [--mode true-drive] [--rate 44100]

import { resolve as resolvePath } from "node:path";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

const disk = flag("disk");
const out = flag("out");
const sec = parseFloat(flag("sec", "10"));
const mode = flag("mode", "true-drive");
const rate = parseInt(flag("rate", "44100"), 10);

if (!disk || !out) {
  console.error("usage: cli-audio-export.mjs --disk <path> --out <path.wav> [--sec N] [--mode true-drive] [--rate 44100]");
  process.exit(2);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);
const { AudioExportSession } = await import(`${repoRoot}/dist/runtime/headless/audio/sid-audio-recorder.js`);
const { exportSessionAudio } = await import(`${repoRoot}/dist/runtime/headless/audio/export.js`);

const { sessionId, session } = startIntegratedSession({
  diskPath: resolvePath(disk),
  mode,
  useMicrocodedCpu: true,
});

console.log(`session: ${sessionId} disk=${disk} mode=${mode}`);
const exp = new AudioExportSession(session, { sampleRate: rate });
const r = exportSessionAudio(session, exp, resolvePath(out), sec);
console.log(JSON.stringify(r, null, 2));
