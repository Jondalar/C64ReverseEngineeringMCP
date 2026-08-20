// Spec 812 — the shutter, for a reel you drive by hand.
// Spec 814 §7 — and it lives at the TOP now, in an overlay.
//
// The written scenario (`runtime_scene_reel`) is for a reel that has to be
// rebuildable: it boots a private machine, walks a schedule, and produces the same
// bytes every time. This is the other half of the same need — you are already
// playing the game, you reach a screen worth keeping, and you press a button.
//
// Capturing is READ-ONLY. It asks the machine for the frame it is already
// displaying and never advances it: this is the ONE session a human co-drives,
// and a screenshot must not move it. (`displayed` is the frozen previous frame,
// so it is always a whole picture.)
//
// WHY IT MOVED. The shutter and the recorder are the same gesture from opposite
// ends — one takes pictures out of a run, the other takes the run — so they belong
// in the same place. And the bottom of the Live tab was stacking a filmstrip and a
// reel strip and could not keep growing. Button up top, pictures in an overlay:
// that REMOVES a strip instead of adding one.
//
// The reel is assembled in the browser by the same encoder the tool uses, so a
// hand-shot reel and a scenario-shot reel are byte-for-byte the same kind of file:
// GIF89a, 384x272 including border, hard cuts, one delay, 16 colours straight from
// the video chip with nothing re-quantized.

import React, { useEffect, useRef, useState } from "react";
import { encodeWithin, parseStructure } from "../../../../src/reel/gif89a.js";

/** The byte ceiling a release reel is expected to stay under. */
const MAX_BYTES = 512_000;

export interface Shot {
  readonly id: number;
  label: string;
  /** The machine cycle this picture was taken at — the daemon's number, not a clock. */
  readonly cycle: number;
  readonly width: number;
  readonly height: number;
  readonly indices: Uint8Array;
  readonly palette: Uint8Array;
}

/** Paint one shot's colour indices onto a canvas through its own palette. */
function paint(cv: HTMLCanvasElement | null, shot: Shot): void {
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  if (cv.width !== shot.width) cv.width = shot.width;
  if (cv.height !== shot.height) cv.height = shot.height;
  const img = ctx.createImageData(shot.width, shot.height);
  for (let i = 0; i < shot.indices.length; i++) {
    const c = shot.indices[i] * 3;
    const o = i * 4;
    img.data[o] = shot.palette[c];
    img.data[o + 1] = shot.palette[c + 1];
    img.data[o + 2] = shot.palette[c + 2];
    img.data[o + 3] = 0xff;
  }
  ctx.putImageData(img, 0, 0);
}

function Thumb({ shot }: { shot: Shot }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { paint(ref.current, shot); }, [shot]);
  return <canvas ref={ref} className="wb-reel-thumb" style={{ imageRendering: "pixelated" }} />;
}

interface Props {
  shots: Shot[];
  setShots: React.Dispatch<React.SetStateAction<Shot[]>>;
  onClose: () => void;
}

export function CaptureOverlay({ shots, setShots, onClose }: Props): React.ReactElement {
  const [delayMs, setDelayMs] = useState(700);
  const [note, setNote] = useState("");

  const move = (i: number, by: number): void =>
    setShots((s) => {
      const j = i + by;
      if (j < 0 || j >= s.length) return s;
      const out = s.slice();
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const remove = (id: number): void => setShots((s) => s.filter((x) => x.id !== id));

  const download = (): void => {
    if (shots.length === 0) return;
    // A reel of one canvas: a shot taken after a mode change would otherwise be a
    // different size and the file would be silently wrong.
    const odd = shots.find((s) => s.width !== shots[0].width || s.height !== shots[0].height);
    if (odd) {
      setNote(`"${odd.label}" is ${odd.width}x${odd.height} but the reel is ${shots[0].width}x${shots[0].height} — remove it`);
      return;
    }
    try {
      const encoded = encodeWithin(
        shots[0].width,
        shots[0].height,
        shots[0].palette,
        shots.map((s) => ({ indices: s.indices })),
        Math.max(1, Math.floor(delayMs / 10)),
        MAX_BYTES,
      );
      const s = parseStructure(encoded.bytes);
      const blob = new Blob([encoded.bytes as BlobPart], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "release-reel.gif";
      a.click();
      URL.revokeObjectURL(url);
      // Say what went, if anything did. A reel that quietly lost the middle of
      // the story would look finished and be wrong.
      const dropped = encoded.dropped.map((i) => shots[i].label);
      setNote(
        `${s.frames} frames · ${encoded.bytes.length} of ${MAX_BYTES} bytes` +
          (dropped.length ? ` · DROPPED to fit: ${dropped.join(", ")}` : "") +
          (s.frames < 5 ? " · a scene release is expected to show at least 5 different screens" : ""),
      );
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="wb-overlay" role="dialog" aria-label="Captures">
      <div className="wb-overlay-panel">
        <div className="wb-overlay-bar">
          <strong>📷 Captures</strong>
          <span className="wb-reel-count">
            {shots.length === 0 ? "no shots yet" : `${shots.length} shot${shots.length === 1 ? "" : "s"}`}
          </span>
          <label className="wb-reel-delay">
            delay
            <input
              type="number"
              min={10}
              step={50}
              value={delayMs}
              onChange={(e) => setDelayMs(Math.max(10, Number(e.target.value) || 10))}
            />
            ms
          </label>
          <button className="wb-btn" onClick={download} disabled={shots.length === 0}>⬇ Download animated GIF</button>
          <button className="wb-btn" onClick={() => { setShots([]); setNote(""); }} disabled={shots.length === 0}>Clear</button>
          <span className="wb-controls-spacer" />
          <button className="wb-btn" onClick={onClose}>✕ Close</button>
        </div>

        {note && <p className="wb-reel-note">{note}</p>}

        {shots.length === 0 ? (
          <p className="wb-overlay-empty">
            Press 📷 in the top bar while the machine runs. Capturing never moves the machine.
          </p>
        ) : (
          <div className="wb-reel-strip">
            {shots.map((s, i) => (
              <div key={s.id} className="wb-reel-item">
                <Thumb shot={s} />
                <input
                  className="wb-reel-label"
                  value={s.label}
                  onChange={(e) =>
                    setShots((all) => all.map((x) => (x.id === s.id ? { ...x, label: e.target.value } : x)))
                  }
                />
                <div className="wb-reel-item-bar">
                  <button className="wb-btn wb-btn-tiny" onClick={() => move(i, -1)} disabled={i === 0} title="earlier">←</button>
                  <span className="wb-reel-cycle" title="the machine cycle this picture was taken at">{s.cycle}</span>
                  <button className="wb-btn wb-btn-tiny" onClick={() => move(i, 1)} disabled={i === shots.length - 1} title="later">→</button>
                  <button className="wb-btn wb-btn-tiny" onClick={() => remove(s.id)} title="remove">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
