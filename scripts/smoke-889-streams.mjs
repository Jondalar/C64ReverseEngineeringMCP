#!/usr/bin/env node
// Spec 889 §4c smoke — picture and sound from a C64 Ultimate, with no device in sight.
//
// Everything here is synthetic datagrams, fake REST callers, a throwaway HTTP server and UDP
// on 127.0.0.1 with free ports. It never contacts a device, never touches the LAN and never
// binds :4312.
//
//   1  video: complete PAL / 60 Hz frame, nibble order, lost packets (gap-filled), lost last
//      packet, out-of-order, duplicates, height switch, re-anchor (restart, explicit), counter
//      wrap, malformed, "next frame starts" hands out the partial one (never stalls)
//   2  paused: no video packets = paused (signal + last-frame age), keeps the last frame
//   3  audio: in order, duplicate, late, gap concealment, live fill cap, resync, wrap, rate
//   4  relay bytes: decoded back the way ws-client.ts / Live.tsx / audio-player.ts parse them;
//      the palette is the emulator path's; the daemon's streaming.rs agrees when it is on disk
//   5  screenshot answer shape (+ age, paused), frame_indices shape, no-frame error
//   6  control: REST paths, a slow (ARP) start that does not block, timeout / refusal /
//      unreachable reported as such, stop order, stop during start, re-arm after a reset,
//      the plain HTTP caller against a local server
//   7  loopback UDP on 127.0.0.1: datagrams in, relay messages out, source filter
//   8  UI: WebAudioPlayer at the default rate builds exactly what it built at 44.1 kHz; at
//      48,003.07 Hz it resamples from it; the worklet consumes at the ratio
//
//   needs `npm run build:mcp`

import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = await import("../dist/runtime/c64u-streams/index.js");
const { PALETTES } = await import("../dist/graphics-render/c64-decoders.js");

let pass = 0, fail = 0, skipped = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${!c && d !== "" ? `  (${String(d).slice(0, 300)})` : ""}`); };
const skip = (m) => { skipped++; console.log(`  SKIP  ${m}`); };
const eq = (a, b, m) => check(a === b, m, `got ${a}, want ${b}`);
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(10); } return f(); };

// ---------------------------------------------------------------- datagram builders
const col = (frame, y, x) => (y * 7 + x + frame) & 15;
class Gen {
  seq = 0;
  /** One frame's datagrams in line order. `drop` = set of packet start lines to lose (the seq still advances). */
  frame(no, height, drop = new Set()) {
    const out = [];
    for (let line = 0; line < height; line += 4) {
      const b = Buffer.alloc(780);
      b.writeUInt16LE(this.seq++ & 0xffff, 0);
      b.writeUInt16LE(no & 0xffff, 2);
      b.writeUInt16LE(line | (line + 4 >= height ? 0x8000 : 0), 4);
      b.writeUInt16LE(384, 6); b[8] = 4; b[9] = 4; b.writeUInt16LE(0, 10);
      for (let l = 0; l < 4; l++) for (let i = 0; i < 192; i++) {
        b[12 + l * 192 + i] = col(no, line + l, 2 * i) | (col(no, line + l, 2 * i + 1) << 4);
      }
      if (!drop.has(line)) out.push(b);
    }
    return out;
  }
}
const expectIdx = (no, h) => { const o = new Uint8Array(384 * h); for (let y = 0; y < h; y++) for (let x = 0; x < 384; x++) o[y * 384 + x] = col(no, y, x); return o; };
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const feed = (asm, ds) => ds.flatMap((d) => asm.push(d));

// ================================================================ 1 video
section("1  video: datagrams into frames");
{
  eq(S.VIDEO_PACKET_BYTES, 780, "a video datagram is 780 bytes");
  eq(S.VIDEO_HEADER_BYTES, 12, "its header is 12 bytes");
  const g = new Gen();
  const asm = new S.FrameAssembler();
  const f = feed(asm, g.frame(1, 272));
  eq(f.length, 1, "68 packets complete one PAL frame, handed out at its last packet");
  eq(f[0]?.height, 272, "PAL frame is 272 lines");
  eq(f[0]?.width, 384, "384 wide");
  check(f[0]?.complete === true && f[0].missingPackets === 0, "complete, nothing missing");
  check(f[0] && same(f[0].indices, expectIdx(1, 272)), "pixels in place, LEFT pixel in the LOW nibble");
  {
    const d = g.frame(2, 272)[0];
    d[12] = 0x21;
    const a2 = new S.FrameAssembler(); a2.push(d);
    // the builder is private; finish the frame and read pixel 0 / 1 back
    const rest = g.frame(2, 272).slice(1);
    // re-send the first packet patched, rest as is (seq order is irrelevant to the pixel check)
    const out = [...rest].flatMap((p) => a2.push(p));
    check(out.length === 1 && out[0].indices[0] === 1 && out[0].indices[1] === 2, "byte 0x21 = pixel 0 is 1, pixel 1 is 2");
  }

  const a60 = new S.FrameAssembler();
  const f60 = feed(a60, new Gen().frame(7, 240));
  check(f60.length === 1 && f60[0].height === 240 && f60[0].complete, "60 Hz: 60 packets, 240 lines");
  check(same(f60[0].indices, expectIdx(7, 240)), "60 Hz pixels in place");

  // lost packets: frame 11 loses lines 100 and 200; frame 10 was complete, so its lines fill the holes
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    const out = [];
    out.push(...feed(a, g2.frame(10, 272)));
    out.push(...feed(a, g2.frame(11, 272, new Set([100, 200]))));
    eq(out.length, 1, "a frame with lost packets is NOT handed out while its successor has not started");
    out.push(...feed(a, g2.frame(12, 272).slice(0, 1)));
    eq(out.length, 2, "the first packet of the next frame hands it out");
    const p = out[1];
    check(p.complete === false && p.missingPackets === 2, "flagged incomplete, 2 packets missing", `${p.complete}/${p.missingPackets}`);
    const want = expectIdx(11, 272);
    want.set(expectIdx(10, 272).subarray(100 * 384, 104 * 384), 100 * 384);
    want.set(expectIdx(10, 272).subarray(200 * 384, 204 * 384), 200 * 384);
    check(same(p.indices, want), "the gaps show what those lines showed in the previous frame, the rest is this frame");
    const c = a.counts();
    eq(c.packets_dropped, 2, "2 dropped packets counted from the seq gaps");
    eq(c.frames_incomplete, 1, "1 incomplete frame counted");
    eq(c.frames_lost, 0, "an incomplete frame is not a lost frame");
  }

  // no previous frame to fill from: the holes are colour 0, never garbage
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    const out = feed(a, [...g2.frame(1, 272, new Set([8])), ...g2.frame(2, 272).slice(0, 1)]);
    check(out.length === 1 && out[0].indices.subarray(8 * 384, 12 * 384).every((v) => v === 0), "no previous frame: holes are colour 0");
  }

  // the last packet is lost: height is unknown; the previous frame's height is used; never stalls
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    let n = 0;
    n += feed(a, g2.frame(1, 240)).length;
    for (let k = 2; k <= 6; k++) n += feed(a, g2.frame(k, 240, new Set([236]))).length;
    eq(n, 5, "five frames that each lost their LAST packet: each is handed out when the next starts (1 complete + 4)");
    n += feed(a, g2.frame(7, 240)).length;
    eq(n, 7, "and the sixth, handed out by the seventh's first packet, plus the seventh itself");
  }
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    feed(a, g2.frame(1, 240));
    const out = feed(a, [...g2.frame(2, 240, new Set([236])), ...g2.frame(3, 240).slice(0, 1)]);
    check(out.length === 1 && out[0].height === 240 && !out[0].complete, "lost last packet: 240 lines from the previous frame", `${out[0]?.height}`);
  }

  // out of order inside a frame, and duplicates
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    const ds = g2.frame(5, 272);
    const shuffled = [...ds.slice(30), ...ds.slice(0, 30)].reverse();
    const out = feed(a, shuffled);
    check(out.length === 1 && out[0].complete && same(out[0].indices, expectIdx(5, 272)), "out-of-order packets within a frame assemble into the same frame");
    const dup = [...g2.frame(6, 272)]; dup.splice(10, 0, dup[9], dup[9]);
    const out2 = feed(a, dup);
    check(out2.length === 1 && out2[0].complete, "duplicated packets give exactly one frame");
    const late = feed(a, [dup[3]]);
    eq(late.length, 0, "a straggler of a frame already handed out produces nothing");
    check(a.counts().packets_late >= 1, "and is counted late");
  }

  // PAL <-> 60 Hz height switch
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    const hs = [];
    for (const [n, h] of [[1, 272], [2, 272], [3, 240], [4, 240], [5, 272]]) for (const fr of feed(a, g2.frame(n, h))) hs.push(fr.height);
    check(hs.join() === "272,272,240,240,272", "PAL / 60 Hz switch changes the frame height", hs.join());
  }

  // frame / seq counters wrap
  {
    const g2 = new Gen(); g2.seq = 65500; const a = new S.FrameAssembler();
    const nums = [];
    for (let n = 65533; n <= 65535 + 3; n++) for (const fr of feed(a, g2.frame(n, 240))) nums.push(fr.number);
    check(nums.join() === "65533,65534,65535,0,1,2", "frame counter wraps 65535 -> 0 as one step", nums.join());
    const c = a.counts();
    check(c.frames_lost === 0 && c.packets_dropped === 0 && c.stream_discontinuities === 0, "a wrap is no loss and no discontinuity", JSON.stringify(c));
  }

  // re-anchor: device restart (frame jumps far forward, seq jumps), and a counter reset backwards
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    feed(a, g2.frame(10, 272));
    g2.seq += 20000;
    const out = feed(a, g2.frame(10 + 5000, 272));
    check(out.length === 1 && out[0].complete, "after a far-forward jump the next frame still completes");
    const c = a.counts();
    check(c.stream_discontinuities >= 1 && a.discontinuities["device-restart"] >= 1, "far jump is a device-restart discontinuity", JSON.stringify(a.discontinuities));
    eq(c.frames_lost, 0, "a restart is not counted as 5000 lost frames");
    g2.seq = 3;
    const back = feed(a, g2.frame(3, 272));
    check(back.length === 1 && back[0].complete && back[0].number === 3, "a counter that reset backwards is a new baseline, not 'reordering' forever");
    const after = feed(a, g2.frame(4, 272));
    check(after.length === 1, "and frames after it flow");
  }
  {
    const g2 = new Gen(); const a = new S.FrameAssembler();
    feed(a, g2.frame(1, 272));
    feed(a, g2.frame(2, 272).slice(0, 20));
    eq(a.inProgress, 1, "a frame is in progress");
    a.reanchor("re-armed");
    eq(a.inProgress, 0, "an explicit re-anchor drops the partial frame");
    check(a.discontinuities["re-armed"] === 1 && a.counts().frames_incomplete === 1, "with its reason counted");
    const out = feed(a, g2.frame(3, 272));
    check(out.length === 1 && out[0].complete, "and the next frame completes");
  }

  // malformed
  {
    const a = new S.FrameAssembler();
    const ds = new Gen().frame(1, 272);
    eq(a.push(ds[0].subarray(0, 700)).length, 0, "short datagram ignored");
    const bad = Buffer.from(ds[0]); bad.writeUInt16LE(320, 6);
    a.push(bad);
    const bad2 = Buffer.from(ds[0]); bad2.writeUInt16LE(270, 4);
    a.push(bad2);
    eq(a.counts().packets_malformed, 3, "wrong size, wrong width and a line past the largest frame are malformed");
    check(S.parseVideoHeader(ds[67]).last === true && S.parseVideoHeader(ds[0]).last === false, "bit 15 of the line field marks the last packet");
  }
}

// ================================================================ 2 paused
section("2  paused: no video packets means paused");
{
  let t = 1000; const events = [];
  const rx = new S.StreamReceiver({ now: () => t, pausedAfterMs: 250, onPausedChange: (p) => events.push(p) });
  check(rx.isPaused(), "before any packet: paused (and receivedAnyVideo is false)");
  eq(rx.status().receivedAnyVideo, false, "receivedAnyVideo false");
  eq(rx.lastFrame(), null, "no frame yet");
  const g = new Gen();
  for (const d of g.frame(1, 272)) rx.feedVideo(d);
  check(!rx.isPaused() && events.join() === "false", "packets arriving: not paused, one change event");
  t += 100;
  check(!rx.isPaused(), "100 ms of quiet is not a pause");
  const lf = rx.lastFrame();
  check(lf && lf.ageMs === 100 && !lf.paused, "last frame age is 100 ms");
  t += 400; rx.tick();
  check(rx.isPaused() && events.join() === "false,true", "500 ms of quiet: paused, event fired once");
  const lp = rx.lastFrame();
  check(lp && lp.paused && lp.ageMs === 500 && lp.frame.number === 1, "the last frame is kept, marked paused, with its age");
  rx.tick();
  eq(events.length, 2, "no repeated pause events");
  // resumes with an incomplete frame (the machine stopped mid-frame)
  const f2 = g.frame(2, 272);
  for (const d of f2.slice(0, 30)) rx.feedVideo(d);
  check(!rx.isPaused() && events.join() === "false,true,false", "a packet after a pause: not paused again");
  t += 400;
  const f3 = g.frame(3, 272);
  for (const d of f3) rx.feedVideo(d);
  const st = rx.status();
  check(st.video.frames_incomplete === 1 && st.video.frames_completed === 2, "the mid-frame stop became one incomplete frame, then the stream goes on", JSON.stringify(st.video));
}

// ================================================================ 3 audio
section("3  audio: reorder, duplicate, concealment, rate");
{
  const apkt = (seq, v) => { const b = Buffer.alloc(770); b.writeUInt16LE(seq & 0xffff, 0); for (let i = 0; i < 192; i++) { b.writeInt16LE(v, 2 + i * 4); b.writeInt16LE(-v, 4 + i * 4); } return b; };
  eq(S.AUDIO_PACKET_BYTES, 770, "an audio datagram is 770 bytes");
  eq(S.AUDIO_RATE_HZ, 48003.07, "the rate on our core is 48,003.07 Hz");
  const ms = 192 / S.AUDIO_RATE_HZ * 1000;
  check(Math.abs(ms - 4.0) < 0.01, `one packet is ${ms.toFixed(3)} ms`);
  const capMs = S.LIVE_FILL_CAP_PACKETS * ms;
  check(capMs > 40 && capMs < 60, `the live fill cap (${S.LIVE_FILL_CAP_PACKETS} packets) is ${capMs.toFixed(1)} ms, far below the file writer's 2500 packets (~10 s)`);

  const t = new S.AudioTimeline();
  const w1 = t.push(apkt(100, 1000));
  check(w1.pcm.length === 768 && w1.concealedPackets === 0, "first packet anchors the timeline and is written as is");
  const w2 = t.push(apkt(101, 1100));
  eq(w2.pcm.length, 768, "next in order is written");
  eq(t.push(apkt(101, 1100)).pcm.length, 0, "a duplicate is dropped");
  eq(t.push(apkt(99, 900)).pcm.length, 0, "a packet behind the timeline is dropped (its slot was already covered)");
  const c0 = t.counts();
  check(c0.duplicates === 1 && c0.late_dropped === 1, "counted as duplicate and late");
  // gap of 2 packets: 102, 103 lost, 104 arrives
  const w4 = t.push(apkt(104, 3000));
  eq(w4.concealedPackets, 2, "a 2-packet gap is concealed");
  eq(w4.pcm.length, 3 * 768, "fill of 2 packets + the real packet");
  eq(w4.pcm.readInt16LE(0), 1100, "the fill starts exactly at the last real sample (no click)");
  eq(w4.pcm.readInt16LE(2), -1100, "right channel too");
  eq(w4.pcm.readInt16LE(2 * 768 - 4), 3000, "the fill ends exactly at the next real sample");
  eq(w4.pcm.readInt16LE(2 * 768), 3000, "then the real packet");
  const mid = w4.pcm.readInt16LE(192 * 4);
  check(Math.abs(mid) < 1100, "the middle of the fill has faded toward zero", `${mid}`);
  const c1 = t.counts();
  check(c1.packets_lost === 2 && c1.packets_concealed === 2, "loss counted");
  // cap: gap of exactly LIVE_FILL_CAP_PACKETS-1 packets conceals, one more re-anchors
  const cap = S.LIVE_FILL_CAP_PACKETS;
  const wc = t.push(apkt(104 + cap, 500));
  check(wc.concealedPackets === cap - 1 && wc.pcm.length === cap * 768, "a gap at the cap is concealed");
  const wr = t.push(apkt(104 + cap + cap + 1, 500));
  check(wr.concealedPackets === 0 && wr.pcm.length === 768, "a gap beyond the cap re-anchors with NO fill (a long fade live is worse than the jump)");
  eq(t.counts().resyncs, 1, "counted as a resync");
  // far backward = counter reset, not reordering
  const wb = t.push(apkt(10, 700));
  check(wb.pcm.length === 768 && t.counts().resyncs === 2, "a far backward jump is a counter reset: re-anchor");
  // wrap
  const tw = new S.AudioTimeline();
  tw.push(apkt(65534, 1)); const a = tw.push(apkt(65535, 1)); const b = tw.push(apkt(0, 1)); const c = tw.push(apkt(1, 1));
  check([a, b, c].every((w) => w.pcm.length === 768 && w.concealedPackets === 0) && tw.counts().packets_lost === 0, "the 16-bit sequence wraps with no loss");
  eq(tw.push(Buffer.alloc(769)).pcm.length, 0, "wrong size ignored");
  eq(tw.counts().malformed, 1, "counted malformed");
  tw.reanchor("restart");
  const wa = tw.push(apkt(500, 9));
  check(wa.pcm.length === 768 && tw.counts().stream_discontinuities === 1, "an explicit re-anchor starts a new timeline without bridging");
}

// ================================================================ 4 relay bytes
section("4  relay bytes: what the UI parses");
const wsClientSrc = readFileSync(join(ROOT, "ui/src/workbench/ws-client.ts"), "utf8");
const liveSrc = readFileSync(join(ROOT, "ui/src/workbench/tabs/Live.tsx"), "utf8");
const playerSrc = readFileSync(join(ROOT, "ui/src/workbench/audio-player.ts"), "utf8");
{
  // the UI's own parse, as written in ws-client.ts onBinaryMessage and Live.tsx drawFrame
  const uiEnvelope = (buf) => ({ type: buf[0], seq: (buf[1] | (buf[2] << 8) | (buf[3] << 16) | (buf[4] << 24)) >>> 0, payload: buf.slice(5) });
  const uiDrawFrame = (payload) => {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const w = dv.getUint16(0, true), h = dv.getUint16(2, true); const fmt = payload[4];
    if (!w || !h || fmt !== 1) return null;
    const palOff = 10, idxOff = 58, n = w * h;
    if (payload.length < idxOff + n) return null;
    const rgba = new Uint8Array(n * 4);
    for (let p = 0; p < n; p++) { const idx = payload[idxOff + p] & 0x0f; const pe = palOff + idx * 3; const o = p * 4; rgba[o] = payload[pe]; rgba[o + 1] = payload[pe + 1]; rgba[o + 2] = payload[pe + 2]; rgba[o + 3] = 0xff; }
    return { w, h, rgba };
  };
  // the source still says what this decoder says (it would drift silently otherwise)
  check(/BIN_TYPE_VIC_FRAME = 0x01/.test(wsClientSrc) && /BIN_TYPE_AUDIO_BUFFER = 0x02/.test(wsClientSrc), "ws-client.ts types: 0x01 VIC frame, 0x02 audio");
  check(/const palOff = 10, idxOff = 58/.test(liveSrc) && /if \(fmt === 1\)/.test(liveSrc) && /getUint16\(0, true\), h = dv\.getUint16\(2, true\)/.test(liveSrc), "Live.tsx drawFrame: header w,h at 0/2, fmt 1, palette at 10, indices at 58");
  check(/buf\[1\]! \| \(buf\[2\]! << 8\) \| \(buf\[3\]! << 16\) \| \(buf\[4\]! << 24\)/.test(wsClientSrc) && /buf\.slice\(5\)/.test(wsClientSrc), "ws-client.ts envelope: type u8, seq u32 LE, payload from 5");
  eq(S.BIN_TYPE_VIC_FRAME, 0x01, "relay type 0x01"); eq(S.BIN_TYPE_AUDIO_BUFFER, 0x02, "relay type 0x02");

  const idx = expectIdx(3, 272);
  const msg = S.buildVicFrameMessage(0xfeedbeef, 384, 272, idx);
  eq(msg.length, 5 + 58 + 384 * 272, "VIC message length = 5 envelope + 10 header + 48 palette + w*h");
  const env = uiEnvelope(msg);
  check(env.type === 1 && env.seq === 0xfeedbeef, "envelope decodes: type and seq u32");
  const d = uiDrawFrame(env.payload);
  check(d && d.w === 384 && d.h === 272, "UI decode: 384x272");
  let ok = !!d;
  for (let p = 0; ok && p < idx.length; p += 97) {
    const rgb = PALETTES.colodore[idx[p]];
    ok = d.rgba[p * 4] === rgb[0] && d.rgba[p * 4 + 1] === rgb[1] && d.rgba[p * 4 + 2] === rgb[2] && d.rgba[p * 4 + 3] === 255;
  }
  check(ok, "every sampled pixel decodes to the emulator path's palette colour");
  check(Buffer.compare(Buffer.from(S.PALETTE_RGB48), Buffer.from(PALETTES.colodore.flat())) === 0, "palette = colodore, the table the emulator path renders with");
  const m240 = S.buildVicFrameMessage(1, 384, 240, expectIdx(1, 240));
  check(uiDrawFrame(uiEnvelope(m240).payload)?.h === 240, "a 240-line frame carries its own height");
  eq(msg[5 + 4], 1, "fmt byte = 1 (palette-indexed)"); eq(msg[5 + 5], 0, "reserved = 0");
  let threw = false; try { S.buildVicFrameMessage(0, 384, 272, new Uint8Array(10)); } catch { threw = true; }
  check(threw, "indices that do not fill w x h are refused");

  // the daemon's own builder, when its source is on disk
  const trx = "/Users/alex/Development/C64/Tools/TRX64/crates/trx64-daemon/src/streaming.rs";
  if (existsSync(trx)) {
    const rs = readFileSync(trx, "utf8");
    check(/BIN_VIC: u8 = 0x01/.test(rs) && /BIN_AUDIO: u8 = 0x02/.test(rs) && /idxOff|indices at offset 58/.test(rs) && /VIC_FMT_INDEXED: u8 = 1/.test(rs), "streaming.rs (daemon) uses the same types, fmt 1 and offset 58");
    const render = readFileSync("/Users/alex/Development/C64/Tools/TRX64/crates/trx64-core/src/render.rs", "utf8");
    const rsPal = [...render.slice(render.indexOf("pub const COLODORE"), render.indexOf("\n];", render.indexOf("pub const COLODORE"))).matchAll(/0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2})/g)].flatMap((m) => [1, 2, 3].map((i) => parseInt(m[i], 16)));
    check(rsPal.length === 48 && Buffer.compare(Buffer.from(rsPal), Buffer.from(S.PALETTE_RGB48)) === 0, "the daemon's COLODORE equals the relay palette");
  } else skip("TRX64 checkout not on disk: streaming.rs / render.rs not compared");

  const pcm = Buffer.alloc(768); for (let i = 0; i < 192; i++) { pcm.writeInt16LE(i * 10 - 900, i * 4); pcm.writeInt16LE(-i, i * 4 + 2); }
  const am = S.buildAudioMessage(42, pcm);
  const ae = uiEnvelope(am);
  check(ae.type === 2 && ae.seq === 42, "audio envelope: type 2, seq 42");
  // audio-player.push: copies the payload and views it as Int16Array, interleaved L,R
  const copy = ae.payload.slice(0, ae.payload.byteLength & ~1);
  const i16 = new Int16Array(copy.buffer);
  check(i16.length === 384 && i16[0] === -900 && i16[1] === 0 && i16[2] === -890 && i16[3] === -1, "audio-player's Int16Array view reads L,R interleaved s16le");
  check(/new Int16Array\(copy\.buffer\)/.test(playerSrc), "audio-player.ts still reads the payload that way");
}

// ================================================================ 5 screenshot
section("5  screenshot: the daemon's answer shape, plus age and paused");
{
  let t = 5000;
  const rx = new S.StreamReceiver({ now: () => t, pausedAfterMs: 250 });
  let threw = null; try { S.streamScreenshot(rx); } catch (e) { threw = e; }
  check(threw && /no video frame received/.test(threw.message), "no frame yet: an error that says why, never a black picture");
  const g = new Gen();
  for (const d of g.frame(9, 272)) rx.feedVideo(d);
  t += 700;
  const shot = S.streamScreenshot(rx);
  check(shot.dataUrl.startsWith("data:image/png;base64,") && shot.width === 384 && shot.height === 272, "{ dataUrl (PNG), width, height } as session/screenshot answers");
  check(shot.paused === true && shot.ageMs === 700 && shot.complete === true && shot.frame === 9 && shot.source === "c64u-video-stream", "plus ageMs, paused, complete, frame, source", JSON.stringify({ ...shot, dataUrl: "…" }));
  const png = Buffer.from(shot.dataUrl.split(",")[1], "base64");
  check(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "a PNG");
  // decode it: IHDR, IDAT (stored deflate, filter 0), compare colours
  let off = 8, ihdr = null; const idat = [];
  while (off < png.length) { const len = png.readUInt32BE(off); const type = png.toString("latin1", off + 4, off + 8); const body = png.subarray(off + 8, off + 8 + len); if (type === "IHDR") ihdr = body; if (type === "IDAT") idat.push(body); off += 12 + len; }
  check(ihdr.readUInt32BE(0) === 384 && ihdr.readUInt32BE(4) === 272 && ihdr[8] === 8 && ihdr[9] === 6, "IHDR: 384x272, 8-bit RGBA");
  const raw = inflateSync(Buffer.concat(idat));
  const row = (y) => raw.subarray(y * (1 + 384 * 4), (y + 1) * (1 + 384 * 4));
  let pngOk = raw.length === 272 * (1 + 384 * 4);
  for (const [x, y] of [[0, 0], [1, 0], [200, 100], [383, 271]]) {
    if (!pngOk) break;
    const r = row(y); const rgb = PALETTES.colodore[col(9, y, x)];
    pngOk = r[0] === 0 && r[1 + x * 4] === rgb[0] && r[2 + x * 4] === rgb[1] && r[3 + x * 4] === rgb[2] && r[4 + x * 4] === 255;
  }
  check(pngOk, "the PNG's pixels are the frame in the emulator path's palette");
  const fi = S.streamFrameIndices(rx);
  check(fi.width === 384 && fi.height === 272 && Buffer.from(fi.palette, "base64").length === 48 && Buffer.from(fi.indices, "base64").length === 384 * 272, "session/frame_indices shape: width, height, palette b64(48), indices b64(w*h)");
  check(same(Buffer.from(fi.indices, "base64"), expectIdx(9, 272)), "indices are the frame's");
  // an incomplete last frame says so
  for (const d of g.frame(10, 272, new Set([40]))) rx.feedVideo(d);
  rx.feedVideo(g.frame(11, 272)[0]);
  const s2 = S.streamScreenshot(rx);
  check(s2.complete === false && s2.missingPackets === 1 && s2.frame === 10, "an incomplete last frame is reported as such");
}

// ================================================================ 6 control
section("6  control: REST start/stop, never blocking");
{
  const calls = [];
  const mkRest = (impl) => async (req) => { calls.push(req.path); return impl ? impl(req) : { status: 200, body: '{"errors":[]}' }; };
  const ports = () => ({ video: 40001, audio: 40002 });
  {
    calls.length = 0;
    const ctl = new S.StreamController({ rest: mkRest(), receiverHost: "10.0.0.5", ports });
    const tk = ctl.start();
    const r = await tk.settled;
    check(calls.join() === "/v1/streams/video:start?ip=10.0.0.5%3A40001,/v1/streams/audio:start?ip=10.0.0.5%3A40002", "PUT video:start then audio:start with ip=<host:port>", calls.join());
    check(decodeURIComponent(calls[0]).endsWith("ip=10.0.0.5:40001"), "the ip parameter is host:port");
    check(r.video.phase === "running" && r.audio.phase === "running" && r.video.target === "10.0.0.5:40001", "both running");
    const st = await ctl.stop();
    check(calls.slice(2).join() === "/v1/streams/audio:stop,/v1/streams/video:stop", "stop: audio first, then video");
    check(st.video.phase === "idle" && st.audio.phase === "idle", "both idle after stop");
  }
  // slow (ARP) start does not block the caller
  {
    calls.length = 0;
    const ctl = new S.StreamController({ rest: mkRest(async (req) => { if (req.path.startsWith("/v1/streams/video:start")) await sleep(600); return { status: 200, body: "" }; }), receiverHost: "10.0.0.5", ports });
    const t0 = Date.now();
    const tk = ctl.start();
    const dt = Date.now() - t0;
    check(dt < 50, `start() returned in ${dt} ms while the device was still ARPing`);
    eq(ctl.status().video.phase, "starting", "video is 'starting' meanwhile");
    eq(ctl.status().audio.phase, "idle", "audio waits behind it");
    const again = ctl.start();
    check(again === tk, "a second start while one is in flight is the same ticket");
    const r = await tk.settled;
    check(r.video.phase === "running" && r.audio.phase === "running", "settles to running");
    eq(calls.filter((c) => c.includes("start")).length, 2, "and the in-flight start did not issue duplicates");
  }
  // timeout reported as such
  {
    const ctl = new S.StreamController({ rest: () => new Promise(() => { /* never answers */ }), receiverHost: "10.0.0.5", ports, startTimeoutMs: 80 });
    const r = await ctl.start().settled;
    check(r.video.phase === "failed" && r.video.failure.kind === "timeout" && /did not answer within 0\.1 s/.test(r.video.failure.message) && /ARPs/.test(r.video.failure.message), "a caller that never answers is a timeout, said so", r.video.failure?.message);
  }
  {
    const ctl = new S.StreamController({ rest: async () => { const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; }, receiverHost: "10.0.0.5", ports });
    const r = await ctl.start().settled;
    eq(r.video.failure.kind, "timeout", "a TimeoutError from the transport is a timeout");
  }
  {
    const ctl = new S.StreamController({ rest: async () => ({ status: 500, body: '{"errors":["Cannot find MAC"]}' }), receiverHost: "10.0.0.5", ports });
    const r = await ctl.start().settled;
    check(r.video.failure.kind === "refused" && /HTTP 500/.test(r.video.failure.message) && /Cannot find MAC/.test(r.video.failure.message), "the device's refusal is passed through verbatim", r.video.failure?.message);
  }
  {
    const ctl = new S.StreamController({ rest: async () => { throw new Error("connect ECONNREFUSED"); }, receiverHost: "10.0.0.5", ports });
    const r = await ctl.start().settled;
    check(r.video.failure.kind === "unreachable" && /ECONNREFUSED/.test(r.video.failure.message), "an unreachable device is reported as unreachable");
  }
  // stop during a start: the start must not mark the streams running afterwards
  {
    calls.length = 0;
    const ctl = new S.StreamController({ rest: mkRest(async (req) => { if (req.path.includes("video:start")) await sleep(200); return { status: 200, body: "" }; }), receiverHost: "10.0.0.5", ports });
    const tk = ctl.start();
    await sleep(20);
    await ctl.stop();
    await tk.settled;
    check(ctl.status().video.phase === "idle" && ctl.status().audio.phase === "idle", "stop during a slow start leaves them idle");
    check(!calls.includes("/v1/streams/audio:start?ip=10.0.0.5%3A40002"), "and the audio start behind it was never issued", calls.join());
  }
  // re-arm after a system reset
  {
    calls.length = 0; const restarts = [];
    const ctl = new S.StreamController({ rest: mkRest(), receiverHost: "10.0.0.5", ports, onRestart: (n) => restarts.push(n) });
    await ctl.rearm().settled;
    eq(calls.length, 0, "re-arm without a prior start does nothing");
    await ctl.start().settled;
    const before = calls.length;
    const r = await ctl.rearm().settled;
    eq(calls.length - before, 2, "re-arm after a start issues both starts again");
    check(r.video.starts === 2 && r.audio.starts === 2 && restarts.join() === "video,audio,video,audio", "start counted, onRestart fired per stream each time", restarts.join());
    await ctl.stop();
    await ctl.rearm().settled;
    eq(ctl.status().video.phase, "idle", "after a stop, re-arm does not resurrect the streams");
  }
  // the plain HTTP caller against a local server
  {
    const seen = [];
    let hang = false;
    const srv = createServer((req, res) => { seen.push({ m: req.method, u: req.url, pw: req.headers["x-password"] }); if (hang) return; res.writeHead(req.url.includes("bad") ? 404 : 200, { "content-type": "application/json" }); res.end('{"errors":[]}'); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const rest = S.httpRestCaller(base, { password: "sesame" });
    const ok = await rest({ method: "PUT", path: "/v1/streams/video:start?ip=127.0.0.1%3A11000", timeoutMs: 2000 });
    check(ok.status === 200 && seen[0].m === "PUT" && seen[0].u === "/v1/streams/video:start?ip=127.0.0.1%3A11000" && seen[0].pw === "sesame", "PUT with the path, the query and X-Password");
    const nf = await rest({ method: "PUT", path: "/v1/streams/bad:start", timeoutMs: 2000 });
    eq(nf.status, 404, "an HTTP error status is returned, not thrown");
    hang = true;
    const ctl = new S.StreamController({ rest, receiverHost: "127.0.0.1", ports, startTimeoutMs: 150 });
    const t0 = Date.now();
    const r = await ctl.start().settled;
    check(r.video.failure?.kind === "timeout" && Date.now() - t0 < 1500, "a server that never answers: timeout, bounded", r.video.failure?.message);
    srv.closeAllConnections?.(); await new Promise((r2) => srv.close(r2));
    eq(await S.localAddressTowards("127.0.0.1"), "127.0.0.1", "localAddressTowards(loopback) is loopback (UDP connect sends nothing)");
  }
}

// ================================================================ 7 loopback UDP
section("7  loopback UDP on 127.0.0.1");
{
  const client = createSocket("udp4");
  await new Promise((r) => client.bind(0, "127.0.0.1", r));
  const send = (port, buf) => new Promise((res, rej) => client.send(buf, port, "127.0.0.1", (e) => (e ? rej(e) : res())));
  const vid = [], aud = [], pausedEv = []; const calls = [];
  const streams = new S.C64UStreams({
    rest: async (req) => { calls.push(req.path); return { status: 200, body: "" }; },
    receiverHost: "127.0.0.1", deviceHost: "127.0.0.1", bindAddress: "127.0.0.1",
    relay: { video: (m) => vid.push(m), audio: (m) => aud.push(m), paused: (p) => pausedEv.push(p) },
    pausedAfterMs: 120,
  });
  const tk = streams.startStreams();
  const r = await tk.settled;
  const ports = streams.receiver.ports;
  check(ports.video > 0 && ports.audio > 0 && ports.video !== 4312 && ports.audio !== 4312, "free ports bound, never 4312", JSON.stringify(ports));
  check(r.video.phase === "running" && calls[0] === `/v1/streams/video:start?ip=127.0.0.1%3A${ports.video}` && calls[1] === `/v1/streams/audio:start?ip=127.0.0.1%3A${ports.audio}`, "the device was told the ports the sockets are on", calls.join());

  const g = new Gen();
  for (const d of g.frame(1, 272)) await send(ports.video, d);
  for (const d of g.frame(2, 240)) await send(ports.video, d);
  check(await until(() => vid.length === 2), "two frames arrive over UDP and are relayed", `${vid.length}`);
  check(vid[0][0] === 1 && vid[1][0] === 1 && new DataView(vid[0].buffer, vid[0].byteOffset).getUint32(1, true) === 0 && new DataView(vid[1].buffer, vid[1].byteOffset).getUint32(1, true) === 1, "relay seq counts 0, 1");
  check(new DataView(vid[0].buffer, vid[0].byteOffset).getUint16(7, true) === 272 && new DataView(vid[1].buffer, vid[1].byteOffset).getUint16(7, true) === 240, "heights 272 then 240 follow the stream");
  const ap = (seq, v) => { const b = Buffer.alloc(770); b.writeUInt16LE(seq, 0); for (let i = 0; i < 192; i++) b.writeInt16LE(v, 2 + i * 4); return b; };
  await send(ports.audio, ap(0, 100)); await send(ports.audio, ap(1, 200)); await send(ports.audio, ap(3, 300));
  check(await until(() => aud.length === 3), "three audio datagrams arrive", `${aud.length}`);
  check(aud[0].length === 5 + 768 && aud[0][0] === 2 && aud[2].length === 5 + 2 * 768, "audio relayed; the 1-packet gap is concealed (fill + packet)", aud.map((a) => a.length).join());
  check(streams.audioFormat().sampleRate === 48003.07 && streams.audioFormat().channels === 2, "audioFormat() = 48,003.07 Hz stereo for the audio/start reply");
  const shot = streams.screenshot();
  check(shot.width === 384 && shot.height === 240 && shot.dataUrl.startsWith("data:image/png"), "screenshot is the last frame (240 lines)");
  check(await until(() => pausedEv.includes(true), 1500), "silence from the device raises the paused signal");
  check(streams.screenshot().paused === true, "and the screenshot says paused");
  await send(ports.video, g.frame(3, 240)[0]);
  check(await until(() => pausedEv.at(-1) === false), "a packet clears it", pausedEv.join());
  const st = streams.status();
  check(st.framesRelayed === 2 && st.audioBuffersRelayed === 3 && st.audioRateHz === 48003.07 && st.streams.video.phase === "running", "status() reports relayed counts, rate and stream phases");
  const stopped = await streams.stopStreams();
  check(calls.slice(-2).join() === "/v1/streams/audio:stop,/v1/streams/video:stop" && stopped.video.phase === "idle" && streams.receiver.ports.video === null, "stopStreams: device told to stop, sockets closed");

  // source filter: a datagram from anyone else is dropped and counted
  const vid2 = [];
  const filtered = new S.C64UStreams({ rest: async () => ({ status: 200, body: "" }), receiverHost: "127.0.0.1", deviceHost: "127.0.0.9", bindAddress: "127.0.0.1", relay: { video: (m) => vid2.push(m), audio() {} } });
  await filtered.startStreams().settled;
  for (const d of new Gen().frame(1, 272)) await send(filtered.receiver.ports.video, d);
  check(await until(() => filtered.status().foreignDatagrams === 68), "datagrams from another sender are counted foreign", `${filtered.status().foreignDatagrams}`);
  eq(vid2.length, 0, "and relay nothing (a second Ultimate on the segment is not interleaved)");
  await filtered.stopStreams();

  // a taken port is an error that names it
  const blocker = createSocket("udp4"); await new Promise((r2) => blocker.bind(0, "127.0.0.1", r2));
  const taken = blocker.address().port;
  const clash = new S.C64UStreams({ rest: async () => ({ status: 200, body: "" }), receiverHost: "127.0.0.1", bindAddress: "127.0.0.1", videoPort: taken, relay: { video() {}, audio() {} } });
  let err = null; try { await clash.startStreams().settled; } catch (e) { err = e; }
  check(err && new RegExp(`video stream: cannot bind 127.0.0.1:${taken}`).test(err.message), "a taken port rejects, naming it", err?.message);
  blocker.close(); client.close();
}

// ================================================================ 8 UI player
section("8  UI: the player's stream rate");
{
  const { build } = await import("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "smoke-889-"));
  try {
    const out = await build({
      entryPoints: [join(ROOT, "ui/src/workbench/audio-player.ts")], bundle: true, format: "esm", platform: "node", write: false,
      plugins: [{ name: "stub-url", setup(b) { b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "stub" })); b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export default "worklet://resid";', loader: "js" })); } }],
    });
    const file = join(dir, "audio-player.mjs");
    (await import("node:fs")).writeFileSync(file, out.outputFiles[0].text);

    const made = [];
    class FakeCtx {
      constructor(o) { this.sampleRate = o.sampleRate; this.state = "suspended"; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; this.closed = false; made.push({ ctx: this, nodes: [] }); }
      async resume() { this.state = "running"; } async close() { this.closed = true; this.state = "closed"; }
    }
    class FakeNode {
      constructor(ctx, name, o) { this.opts = o.processorOptions; this.port = { postMessage: () => {} }; made.find((m) => m.ctx === ctx).nodes.push(this); }
      connect() {} disconnect() {}
    }
    globalThis.window = { AudioContext: FakeCtx, addEventListener() {}, removeEventListener() {} };
    globalThis.AudioWorkletNode = FakeNode;
    const { WebAudioPlayer, DEFAULT_STREAM_RATE } = await import(file);

    eq(DEFAULT_STREAM_RATE, 44100, "the default stream rate is 44100");
    const p0 = new WebAudioPlayer();
    await p0.resume();
    const o0 = made[0].nodes[0].opts;
    check(made[0].ctx.sampleRate === 44100 && o0.ringFrames === 44100 && o0.resampleRatio === 1 && o0.startFrames === 8820 && o0.governorTarget === 7938 && o0.governorMargin === 2205,
      "default player: context 44100, ring 44100, ratio 1, start 8820, target 7938, margin 2205 (the values it had before the rate was a parameter)", JSON.stringify(o0));
    check(p0.rate === 44100, "rate getter");

    const p1 = new WebAudioPlayer(48003.07);
    await p1.resume();
    const o1 = made[1].nodes[0].opts;
    check(made[1].ctx.sampleRate === 48003 && o1.ringFrames === 48003 && Math.abs(o1.resampleRatio - 48003.07 / 48003) < 1e-12 && o1.startFrames === Math.round(48003.07 * 0.2),
      "a 48,003.07 Hz player: context 48003, resample ratio 48003.07/48003, ring and prebuffer from the stream rate", JSON.stringify(o1));

    // a context at another rate (the browser ignored the request): the ratio follows the context
    class Ctx48 extends FakeCtx { constructor(o) { super({ sampleRate: 48000 }); } }
    globalThis.window.AudioContext = Ctx48;
    const p2 = new WebAudioPlayer(44100);
    await p2.resume();
    check(Math.abs(made[2].nodes[0].opts.resampleRatio - 44100 / 48000) < 1e-12, "if the context runs at 48000 the 44.1 kHz stream resamples at 44100/48000 (as before)");
    globalThis.window.AudioContext = FakeCtx;

    // setStreamRate: same rate = no-op; new rate = rebuilt at the new rate
    const n = made.length;
    await p0.setStreamRate(44100);
    eq(made.length, n, "setStreamRate with the same rate changes nothing");
    p0.arm();
    await p0.setStreamRate(48003.07);
    await p0.resume();
    check(made[0].ctx.closed && made.length === n + 1 && p0.rate === 48003.07 && made[n].ctx.sampleRate === 48003, "setStreamRate(48003.07) closes the old context and rebuilds at the new rate");
    await p0.close(); await p1.close(); await p2.close();

    // the worklet, run as the browser would
    const wsrc = readFileSync(join(ROOT, "ui/src/workbench/resid-worklet.js"), "utf8");
    let Cls = null;
    const sandbox = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } }, registerProcessor: (_n, c) => { Cls = c; } };
    vm.runInNewContext(wsrc, sandbox);
    const consume = (rate, ctxRate, outFrames) => {
      const w = new Cls({ processorOptions: { ringFrames: 100000, resampleRatio: rate / ctxRate, startFrames: 100, governorTarget: 0 } });
      const pcm = new Int16Array(2 * 60000); for (let i = 0; i < 60000; i++) { pcm[2 * i] = i % 30000; pcm[2 * i + 1] = 0; }
      w.enqueue(pcm);
      const before = w.avail;
      const blk = new Float32Array(128);
      for (let i = 0; i < outFrames / 128; i++) w.process([], [[blk, new Float32Array(128)]]);
      return before - w.avail;
    };
    eq(consume(44100, 44100, 44160), 44160, "worklet at ratio 1 consumes one input frame per output frame");
    const c48 = consume(48003.07, 48000, 48000);
    check(Math.abs(c48 - 48003.07) <= 2, `worklet at 48003.07 -> 48000 consumes ${c48} input frames per 48000 out (want 48003.07)`);
    const cc = consume(48003.07, 48003, 48128);
    const want = 48128 * 48003.07 / 48003;
    check(Math.abs(cc - want) <= 2, `at 48003.07 -> 48003 it consumes ${cc} per 48128 out (want ${want.toFixed(1)})`);
  } finally { rmSync(dir, { recursive: true, force: true }); delete globalThis.window; delete globalThis.AudioWorkletNode; }

  const mc = readFileSync(join(ROOT, "ui/src/workbench/components/MachineControls.tsx"), "utf8");
  check(/call<\{ sampleRate\?: number \} \| undefined>\("audio\/start"/.test(mc) && /player\.setStreamRate\(rate\)/.test(mc), "MachineControls takes the rate from the audio/start reply (absent = unchanged)");
  check(/new WebAudioPlayer\(\)/.test(mc), "and still builds the default player first, so the emulator path is unchanged");
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail ? 1 : 0);
