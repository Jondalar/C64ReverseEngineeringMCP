import { PreviewFrame } from "./types";

function byteToBits(byte: number, width: number): string {
  let result = "";
  for (let bit = 7; bit >= 8 - width; bit -= 1) {
    result += (byte & (1 << bit)) !== 0 ? "#" : ".";
  }
  return result;
}

export function renderSpriteAscii(block: Uint8Array, title: string): PreviewFrame {
  const lines: string[] = [];
  for (let row = 0; row < 21; row += 1) {
    const base = row * 3;
    lines.push(
      `${byteToBits(block[base] ?? 0, 8)}${byteToBits(block[base + 1] ?? 0, 8)}${byteToBits(block[base + 2] ?? 0, 8)}`,
    );
  }
  return {
    kind: "sprite",
    title,
    width: 24,
    height: 21,
    encoding: "ascii",
    lines,
  };
}

export function renderCharsetAscii(glyphs: Uint8Array, glyphCount: number, title: string): PreviewFrame {
  const previewGlyphs = Math.min(glyphCount, 8);
  const lines: string[] = [];

  for (let row = 0; row < 8; row += 1) {
    const parts: string[] = [];
    for (let glyph = 0; glyph < previewGlyphs; glyph += 1) {
      parts.push(byteToBits(glyphs[glyph * 8 + row] ?? 0, 8));
    }
    lines.push(parts.join(" "));
  }

  return {
    kind: "charset",
    title,
    width: previewGlyphs * 8,
    height: 8,
    encoding: "ascii",
    lines,
  };
}

export function renderTextPreview(text: string, title: string): PreviewFrame {
  return {
    kind: "text",
    title,
    width: Math.max(1, text.length),
    height: 1,
    encoding: "ascii",
    lines: [text],
  };
}

export function renderBitmapSampleAscii(bytes: Uint8Array, title: string, rows = 8): PreviewFrame {
  const lines: string[] = [];
  const lineCount = Math.min(rows, Math.floor(bytes.length / 3));
  for (let row = 0; row < lineCount; row += 1) {
    const base = row * 3;
    lines.push(
      `${byteToBits(bytes[base] ?? 0, 8)}${byteToBits(bytes[base + 1] ?? 0, 8)}${byteToBits(bytes[base + 2] ?? 0, 8)}`,
    );
  }
  return {
    kind: "bitmap",
    title,
    width: 24,
    height: lineCount,
    encoding: "ascii",
    lines,
  };
}
