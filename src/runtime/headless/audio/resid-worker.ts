// Spec 768.2 — reSID render worker.
//
// Owns the reSID engine OFF the emulation thread. Drains the SID write-stream ring
// (sid-write-ring.ts): WRITE records set reSID registers in CPU order; a BOUNDARY
// record triggers resid.emit(dCycles) — exactly today's inline flush() model
// (Spec 703) — and the rendered PCM is written to the PCM ring (sid-pcm-ring.ts)
// the main thread ships over the WS. This is the ~2.1 ms/frame that used to run on
// the emu thread, now on its own core → the emu loop holds 50 fps with audio.
//
// Protocol (main → worker): { type: 'stop' } | { type: 'resync' } (drop pending
// + re-sync after a restore — 768.4 will extend this with reSID state). Worker is
// otherwise autonomous: a tight drain timer, no per-frame main-thread handshake.

import { parentPort, workerData } from "node:worker_threads";
import { createAudioSid, type AudioSidLike } from "../sid/sid-engine.js";
import {
  SidWriteRingConsumer, type SidWriteRingLayout, type SidWriteRecord,
  SID_REC_TYPE_WRITE,
} from "./sid-write-ring.js";
import { SidPcmRingProducer, type SidPcmRingLayout } from "./sid-pcm-ring.js";

if (!parentPort) throw new Error("resid-worker: must run as a worker_thread");
const port = parentPort;

const { writeRingSab, writeLayout, pcmRingSab, pcmLayout, engine, initialRegs } = workerData as {
  writeRingSab: SharedArrayBuffer;
  writeLayout: SidWriteRingLayout;
  pcmRingSab: SharedArrayBuffer;
  pcmLayout: SidPcmRingLayout;
  engine?: string;
  initialRegs?: number[]; // SID register file at attach (sync mid-session)
};

const writeConsumer = new SidWriteRingConsumer(writeRingSab, writeLayout);
const pcm = new SidPcmRingProducer(pcmRingSab, pcmLayout);
const resid: AudioSidLike = createAudioSid({ engine: engine as never });

const batch: SidWriteRecord[] = [];
function drainOnce(): void {
  batch.length = 0;
  writeConsumer.drain(batch);
  for (const r of batch) {
    if (r.type === SID_REC_TYPE_WRITE) {
      resid.write(0xD400 + r.addr, r.value);
    } else {
      // BOUNDARY: render this frame's samples (= inline flush's emit(dCycles)).
      if (r.dCycles > 0) pcm.write(resid.emit(r.dCycles));
    }
  }
}

function start(): void {
  // Sync the register file (mid-session attach), like SidAudioRecorder's ctor.
  if (initialRegs) for (let a = 0; a < initialRegs.length && a < 0x20; a++) resid.write(0xD400 + a, initialRegs[a]! & 0xff);
  const timer = setInterval(drainOnce, 2);
  port.on("message", (m: { type: string }) => {
    if (m.type === "stop") { clearInterval(timer); drainOnce(); port.postMessage({ type: "stopped" }); }
    else if (m.type === "resync") { batch.length = 0; writeConsumer.drain(batch); /* discard pending */ }
  });
  port.postMessage({ type: "ready", sampleRate: resid.sampleRate });
}

// reSID-wasm load is async; wait for it before draining (writes buffer in the ring).
if (resid.ready) resid.ready().then(start).catch((e) => port.postMessage({ type: "error", message: (e as Error).message }));
else start();
