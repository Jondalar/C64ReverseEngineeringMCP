#!/usr/bin/env node
// BUG-049 ISOLATION TAP — passive consumer of the live runtime A/V WS stream.
//
// Connects to the daemon WS exactly like a 2nd browser tab: READ-ONLY, sends NO
// commands, never drives the machine. Decodes the binary frames and pipes the
// raw audio (BIN 0x02 = s16le stereo 44.1k) to ffplay so you HEAR the daemon's
// stream DIRECTLY — isolating "the daemon stream itself stutters" from "the
// browser worklet playback stutters". Also logs the arrival RATE (a steady ~50
// audio frames/s = daemon emits at realtime; <50 or bursty = daemon-side).
//
// Usage:
//   node scripts/ws-av-tap.mjs                 # tap audio → ffplay (listen)
//   node scripts/ws-av-tap.mjs --video         # also tap video → 2nd ffplay
//   node scripts/ws-av-tap.mjs --wav out.pcm   # record raw PCM instead of play
//   WS=ws://127.0.0.1:4313 node scripts/ws-av-tap.mjs   # alt daemon port
//
// Test configs:
//   A) tap ALONE (close the browser): daemon → only the tap. Clean ffplay =
//      daemon stream is fine; the stutter was browser-side or multi-client load.
//   B) tap + browser both: does adding a client degrade either?
// Stop with Ctrl-C.

import WebSocket from "ws";
import { spawn, execSync } from "node:child_process";
import { createWriteStream } from "node:fs";

const URL = process.env.WS || "ws://127.0.0.1:4312";
const wantVideo = process.argv.includes("--video");
const wavIdx = process.argv.indexOf("--wav");
const wavPath = wavIdx >= 0 ? process.argv[wavIdx + 1] : null;
const recIdx = process.argv.indexOf("--rec");
const recPath = recIdx >= 0 ? process.argv[recIdx + 1] : null;

const BIN_VIC = 0x01, BIN_AUDIO = 0x02;
const SR = 44100;
const VW = 384, VH = 272; // C64 live canvas (fmt 1 = palette-indexed)

let audioWrite = () => {};
let videoWrite = null, vW = 0, vH = 0;

if (recPath) {
  // --- RECORD live A+V into ONE file via ffmpeg + 2 named fifos. Native res
  // (VW×VH, NO upscale). Codecs by extension:
  //   .mp4  → H264 (yuv420p) + AAC  — compact, macOS/QuickTime-friendly (default goal)
  //   else  → rawvideo + pcm_s16le  — uncompressed (.mkv/.mov/.nut/.avi), huge
  // Extra ffmpeg flags pass through via `--ffargs "<flags>"` (inserted before the
  // output), e.g. `--ffargs "-crf 18 -preset slow"` or `--ffargs "-vf scale=768:544"`.
  const isMp4 = /\.mp4$/i.test(recPath);
  const ffaIdx = process.argv.indexOf("--ffargs");
  const extraFf = ffaIdx >= 0 ? (process.argv[ffaIdx + 1] ?? "").split(/\s+/).filter(Boolean) : [];
  const vcodec = isMp4 ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", "-movflags", "+faststart"] : ["-c:v", "rawvideo"];
  const acodec = isMp4 ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "pcm_s16le"];
  const FV = "/tmp/c64tap_v.rgba", FA = "/tmp/c64tap_a.pcm";
  try { execSync(`rm -f '${FV}' '${FA}'; mkfifo '${FV}' '${FA}'`); }
  catch (e) { console.error("[tap] mkfifo failed:", e.message); process.exit(1); }
  const ff = spawn("ffmpeg", [
    "-y",
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${VW}x${VH}`, "-framerate", "50", "-i", FV,
    "-f", "s16le", "-ar", String(SR), "-ac", "2", "-i", FA,
    ...vcodec, ...acodec, ...extraFf,
    recPath,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  ff.on("error", (e) => { console.error("[tap] ffmpeg failed:", e.message); process.exit(1); });
  const vs = createWriteStream(FV), as = createWriteStream(FA);
  vW = VW; vH = VH;
  videoWrite = (_w, _h, rgba) => { try { vs.write(rgba); } catch { /* ffmpeg gone */ } };
  audioWrite = (buf) => { try { as.write(buf); } catch { /* ffmpeg gone */ } };
  console.log(`[tap] RECORDING A+V → ${recPath} (${isMp4 ? "H264+AAC" : "rawvideo+pcm"}, ${VW}x${VH} native${extraFf.length ? `, ffargs: ${extraFf.join(" ")}` : ""}). Ctrl-C to finalize.`);
  // Finalize: close the fifo writers → ffmpeg sees EOF → flushes + writes the mp4
  // moov atom. MUST wait for ffmpeg to EXIT before quitting (a fixed timeout +
  // process.exit truncated the file → unplayable mp4 = no moov). 30s hang-guard.
  let finalizing = false;
  process.on("SIGINT", () => {
    if (finalizing) return; finalizing = true;
    console.log("\n[tap] finalizing — waiting for ffmpeg to write the moov…");
    try { vs.end(); as.end(); } catch { /* ignore */ }
    const done = () => { try { execSync(`rm -f '${FV}' '${FA}'`); } catch { /* ignore */ } process.exit(0); };
    ff.on("close", (code) => { console.log(`[tap] ffmpeg done (exit ${code}) → ${recPath}`); done(); });
    setTimeout(() => { console.error("[tap] ffmpeg didn't exit in 30s — killing (file may be partial)"); try { ff.kill("SIGKILL"); } catch { /* ignore */ } done(); }, 30_000);
  });
} else {
  // --- audio sink: ffplay (live) or a raw .pcm file ------------------------
  if (wavPath) {
    const ws = createWriteStream(wavPath);
    audioWrite = (buf) => ws.write(buf);
    console.log(`[tap] recording raw PCM → ${wavPath}  (play: ffplay -f s16le -ar ${SR} -ac 2 ${wavPath})`);
  } else {
    const ff = spawn("ffplay", ["-f", "s16le", "-ar", String(SR), "-ac", "2", "-nodisp", "-loglevel", "warning", "-i", "-"], { stdio: ["pipe", "inherit", "inherit"] });
    ff.on("error", (e) => { console.error("[tap] ffplay failed:", e.message); process.exit(1); });
    audioWrite = (buf) => { try { ff.stdin.write(buf); } catch { /* ffplay gone */ } };
    console.log("[tap] audio → ffplay (live). Clean here but stutter in browser ⇒ browser-side.");
  }
  // --- optional video sink: 2nd ffplay (rawvideo rgba) ---------------------
  if (wantVideo) {
    let ffv = null;
    videoWrite = (w, h, rgba) => {
      if (!ffv || w !== vW || h !== vH) {
        vW = w; vH = h;
        ffv = spawn("ffplay", ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${w}x${h}`, "-framerate", "50", "-loglevel", "warning", "-i", "-"], { stdio: ["pipe", "inherit", "inherit"] });
        ffv.on("error", (e) => console.error("[tap] ffplay(video) failed:", e.message));
      }
      try { ffv.stdin.write(rgba); } catch { /* gone */ }
    };
    console.log("[tap] video → 2nd ffplay (rawvideo).");
  }
}

// --- decode a palette-indexed VIC frame (fmt 1) to RGBA -------------------
function decodeVic(payload) {
  // [w:u16][h:u16][fmt:u8][rsvd:u8][cycle:u32][48B palette][w*h indices]
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const w = dv.getUint16(0, true), h = dv.getUint16(2, true), fmt = payload[4];
  if (fmt !== 1 || !w || !h) return null;
  const palOff = 10, idxOff = 58, n = w * h;
  if (payload.length < idxOff + n) return null;
  const rgba = Buffer.allocUnsafe(n * 4);
  for (let p = 0; p < n; p++) {
    const idx = payload[idxOff + p] & 0x0f;
    const pe = palOff + idx * 3, o = p * 4;
    rgba[o] = payload[pe]; rgba[o + 1] = payload[pe + 1]; rgba[o + 2] = payload[pe + 2]; rgba[o + 3] = 0xff;
  }
  return { w, h, rgba };
}

// --- stats window ---------------------------------------------------------
let aFrames = 0, aBytes = 0, vFrames = 0;
setInterval(() => {
  console.log(`[tap] 2s: audio=${aFrames} frames (${(aBytes / 1024).toFixed(0)} KiB, ~${(aFrames / 2).toFixed(0)}/s — realtime≈50/s)  video=${vFrames} (~${(vFrames / 2).toFixed(0)}/s)`);
  aFrames = 0; aBytes = 0; vFrames = 0;
}, 2000).unref();

// --- connect (passive) ----------------------------------------------------
console.log(`[tap] connecting ${URL} …`);
const ws = new WebSocket(URL);
ws.binaryType = "nodebuffer";
ws.on("open", () => console.log("[tap] connected (passive — no commands sent). If silent: make sure audio is ON in the browser."));
ws.on("error", (e) => { console.error("[tap] ws error:", e.message); process.exit(1); });
ws.on("close", () => { console.log("[tap] ws closed."); process.exit(0); });
ws.on("message", (data, isBinary) => {
  if (!isBinary || data.length < 5) return;
  const type = data[0];
  const payload = data.subarray(5); // skip [type:u8][seq:u32]
  if (type === BIN_AUDIO) { aFrames++; aBytes += payload.length; audioWrite(payload); }
  else if (type === BIN_VIC && videoWrite) { const f = decodeVic(payload); if (f) { vFrames++; videoWrite(f.w, f.h, f.rgba); } }
  else if (type === BIN_VIC) { vFrames++; }
});

process.on("SIGINT", () => { try { ws.close(); } catch {} process.exit(0); });
