import { useEffect, useRef, useState } from "react";
import {
  C64_PALETTE,
  decodeCharset,
  decodeHiresBitmap,
  decodeMulticolorBitmap,
  decodeSprites,
  type DecodedImage,
} from "../lib/c64-graphics";

export type GraphicsRenderKind =
  | "sprite"
  | "charset"
  | "charset_source"
  | "bitmap"
  | "hires_bitmap"
  | "multicolor_bitmap"
  | "bitmap_source"
  | "screen_ram"
  | "screen_source"
  | "color_source";

interface Props {
  bytes: Uint8Array | null;
  loading?: boolean;
  error?: string | null;
  kind: GraphicsRenderKind;
  zoom?: number;          // pixel scale (default per-kind sensible)
  fg?: number;            // palette index
  bg?: number;            // palette index
  c1?: number;
  c2?: number;
  screen?: Uint8Array;    // optional bitmap-companion data
  colorRam?: Uint8Array;
  showColourPicker?: boolean;
  onColourChange?: (next: { fg: number; bg: number; c1: number; c2: number }) => void;
}

function defaultZoom(kind: GraphicsRenderKind): number {
  switch (kind) {
    case "sprite": return 3;
    case "charset":
    case "charset_source": return 3;
    case "bitmap":
    case "hires_bitmap":
    case "multicolor_bitmap":
    case "bitmap_source":
      return 1;
    case "screen_ram":
    case "screen_source":
    case "color_source":
      return 6;
    default:
      return 2;
  }
}

function decodeFor(kind: GraphicsRenderKind, bytes: Uint8Array, props: Props): DecodedImage | null {
  const palette = { fg: props.fg, bg: props.bg, c1: props.c1, c2: props.c2 };
  switch (kind) {
    case "sprite":
      return decodeSprites(bytes, palette);
    case "charset":
    case "charset_source":
      return decodeCharset(bytes, palette);
    case "bitmap":
    case "hires_bitmap":
    case "bitmap_source":
      return decodeHiresBitmap(bytes, { ...palette, screen: props.screen });
    case "multicolor_bitmap":
      return decodeMulticolorBitmap(bytes, { ...palette, screen: props.screen, colorRam: props.colorRam });
    case "screen_ram":
    case "screen_source":
    case "color_source":
      // Treat as charset preview using the bytes themselves; useful as a
      // sanity-check of contiguous data but not strictly meaningful for
      // screen-RAM. For the spike we just hexdump-render via charset path.
      return decodeCharset(bytes, palette);
    default:
      return null;
  }
}

export function C64GraphicsView(props: Props) {
  const { bytes, loading, error, kind, showColourPicker, onColourChange } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [internalFg, setFg] = useState<number>(props.fg ?? 1);
  const [internalBg, setBg] = useState<number>(props.bg ?? 0);
  const [internalC1, setC1] = useState<number>(props.c1 ?? 11);
  const [internalC2, setC2] = useState<number>(props.c2 ?? 12);

  useEffect(() => { if (props.fg !== undefined) setFg(props.fg); }, [props.fg]);
  useEffect(() => { if (props.bg !== undefined) setBg(props.bg); }, [props.bg]);

  const fg = props.fg ?? internalFg;
  const bg = props.bg ?? internalBg;
  const c1 = props.c1 ?? internalC1;
  const c2 = props.c2 ?? internalC2;
  const zoom = props.zoom ?? defaultZoom(kind);

  useEffect(() => {
    if (!bytes || bytes.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const decoded = decodeFor(kind, bytes, { ...props, fg, bg, c1, c2 });
    if (!decoded) return;
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.createImageData(decoded.width, decoded.height);
    imageData.data.set(decoded.pixels);
    ctx.putImageData(imageData, 0, 0);
  }, [bytes, kind, fg, bg, c1, c2, props.screen, props.colorRam]);

  function emitColourChange(next: { fg?: number; bg?: number; c1?: number; c2?: number }) {
    const merged = {
      fg: next.fg ?? fg,
      bg: next.bg ?? bg,
      c1: next.c1 ?? c1,
      c2: next.c2 ?? c2,
    };
    if (next.fg !== undefined) setFg(next.fg);
    if (next.bg !== undefined) setBg(next.bg);
    if (next.c1 !== undefined) setC1(next.c1);
    if (next.c2 !== undefined) setC2(next.c2);
    onColourChange?.(merged);
  }

  return (
    <div className="c64-graphics-view">
      {loading ? <div className="empty-state">Decoding bytes...</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}
      {!loading && !error && bytes ? (
        <div className="c64-graphics-canvas-wrap">
          <canvas
            ref={canvasRef}
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              imageRendering: "pixelated",
              backgroundColor: "#000",
            }}
          />
        </div>
      ) : null}
      {showColourPicker ? (
        <div className="c64-palette-pickers">
          <PalettePicker label="Foreground" value={fg} onChange={(v) => emitColourChange({ fg: v })} />
          <PalettePicker label="Background" value={bg} onChange={(v) => emitColourChange({ bg: v })} />
          {(kind === "multicolor_bitmap") ? (
            <>
              <PalettePicker label="Multi 1" value={c1} onChange={(v) => emitColourChange({ c1: v })} />
              <PalettePicker label="Multi 2" value={c2} onChange={(v) => emitColourChange({ c2: v })} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PalettePicker({ label, value, onChange }: { label: string; value: number; onChange: (next: number) => void }) {
  return (
    <label className="c64-palette-picker">
      <span>{label}</span>
      <div className="c64-palette-row">
        {C64_PALETTE.map((rgb, index) => (
          <button
            key={index}
            type="button"
            className={value === index ? "c64-palette-swatch active" : "c64-palette-swatch"}
            style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
            title={`Index ${index}`}
            onClick={() => onChange(index)}
          />
        ))}
      </div>
    </label>
  );
}
