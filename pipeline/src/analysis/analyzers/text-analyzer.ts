import { renderTextPreview } from "../render";
import { AnalyzerContext, AnalyzerResult, SegmentCandidate } from "../types";
import { clampConfidence, formatAddress, segmentLength, toOffset } from "../utils";

const PETSCII_PRINTABLE = new Set<number>([
  0x0d,
  0x20,
  0x21,
  0x22,
  0x23,
  0x24,
  0x25,
  0x26,
  0x27,
  0x28,
  0x29,
  0x2a,
  0x2b,
  0x2c,
  0x2d,
  0x2e,
  0x2f,
]);

for (let code = 0x30; code <= 0x39; code += 1) {
  PETSCII_PRINTABLE.add(code);
}
for (let code = 0x41; code <= 0x5a; code += 1) {
  PETSCII_PRINTABLE.add(code);
}
for (let code = 0x61; code <= 0x7a; code += 1) {
  PETSCII_PRINTABLE.add(code);
}

function isPetsciiPrintable(byte: number): boolean {
  return PETSCII_PRINTABLE.has(byte) || (byte >= 0xa0 && byte <= 0xdf);
}

function isScreenCodePrintable(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x01 && byte <= 0x1a) || (byte >= 0x30 && byte <= 0x39);
}

function decodePetscii(bytes: number[]): string {
  return bytes
    .map((byte) => {
      if (byte === 0x0d) {
        return "\\r";
      }
      if (byte >= 0x20 && byte <= 0x7e) {
        return String.fromCharCode(byte);
      }
      if (byte >= 0xa0 && byte <= 0xbf) {
        return String.fromCharCode(byte - 0x80);
      }
      return ".";
    })
    .join("");
}

function alphabeticRatio(text: string): number {
  const relevant = text.replaceAll("\\r", "");
  if (relevant.length === 0) {
    return 0;
  }
  const matches = relevant.match(/[A-Za-z ]/g) ?? [];
  return matches.length / relevant.length;
}

function punctuationRatio(text: string): number {
  const relevant = text.replaceAll("\\r", "");
  if (relevant.length === 0) {
    return 0;
  }
  const matches = relevant.match(/[^A-Za-z0-9 ]/g) ?? [];
  return matches.length / relevant.length;
}

function spacingCount(text: string): number {
  return (text.match(/ /g) ?? []).length;
}

function terminatorCount(bytes: number[]): number {
  return bytes.filter((byte) => byte === 0x00 || byte === 0x0d || byte === 0xff).length;
}

function isPagedPetsciiByte(byte: number): boolean {
  return byte === 0x00 || isPetsciiPrintable(byte);
}

function decodePagedPetscii(bytes: number[]): string {
  return bytes
    .map((byte) => {
      if (byte === 0x00) {
        return "|";
      }
      if (byte === 0x0d) {
        return "\\r";
      }
      if (byte >= 0x20 && byte <= 0x7e) {
        return String.fromCharCode(byte);
      }
      if (byte >= 0xa0 && byte <= 0xbf) {
        return String.fromCharCode(byte - 0x80);
      }
      return ".";
    })
    .join("");
}

function zeroSeparatorCount(bytes: number[]): number {
  return bytes.filter((byte) => byte === 0x00).length;
}

function trimmedPagedRange(bytes: number[], startOffset: number, endOffset: number): [number, number] | undefined {
  let start = startOffset;
  let end = endOffset;

  while (start <= end && bytes[start] === 0x00) {
    start += 1;
  }
  while (end >= start && bytes[end] === 0x00) {
    end -= 1;
  }

  return start <= end ? [start, end] : undefined;
}

export class TextAnalyzer {
  readonly id = "text";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const candidates: SegmentCandidate[] = [];

    for (const region of context.candidateRegions) {
      const startOffset = toOffset(region.start, context.mapping);
      const endOffset = toOffset(region.end, context.mapping);
      if (startOffset === undefined || endOffset === undefined) {
        continue;
      }

      let runStart: number | undefined;
      let mode: "petscii" | "screen" | undefined;

      for (let offset = startOffset; offset <= endOffset + 1; offset += 1) {
        const byte = offset <= endOffset ? context.buffer[offset] : 0xff;
        const petscii = offset <= endOffset && isPetsciiPrintable(byte);
        const screen = offset <= endOffset && isScreenCodePrintable(byte);
        const nextMode = petscii ? "petscii" : screen ? "screen" : undefined;

        if (runStart === undefined && nextMode !== undefined) {
          runStart = offset;
          mode = nextMode;
          continue;
        }

        if (runStart !== undefined && nextMode === mode) {
          continue;
        }

        if (runStart !== undefined && mode !== undefined) {
          const runEnd = offset - 1;
          const length = runEnd - runStart + 1;
          if (length >= 8) {
            const bytes = Array.from(context.buffer.subarray(runStart, runEnd + 1));
            const printableRatio = bytes.filter((candidate) => (mode === "petscii" ? isPetsciiPrintable(candidate) : isScreenCodePrintable(candidate))).length / bytes.length;
            const text = decodePetscii(bytes.slice(0, 48));
            const words = text.match(/[A-Za-z]{3,}/g) ?? [];
            const alphaRatio = alphabeticRatio(text);
            const spaces = spacingCount(text);
            const punctuation = punctuationRatio(text);
            const terminators = terminatorCount(bytes);
            const strongPhrase = words.length >= 2 && spaces >= 1;
            const weakPhrase = words.length >= 1 && spaces >= 2;
            const confidence = clampConfidence(
              0.3 +
                printableRatio * 0.28 +
                (strongPhrase ? 0.24 : weakPhrase ? 0.08 : 0) +
                (terminators >= 1 ? 0.08 : 0) -
                punctuation * 0.18,
            );
            const addressStart = context.mapping.startAddress + runStart;
            const addressEnd = context.mapping.startAddress + runEnd;

            const looksReadable =
              mode === "petscii"
                ? alphaRatio >= 0.72 && punctuation <= 0.18 && (strongPhrase || (weakPhrase && length >= 12) || (words.length >= 3 && terminators >= 1))
                : alphaRatio >= 0.78 && spaces >= 1 && words.length >= 2;

            if (!looksReadable) {
              continue;
            }

            candidates.push({
              analyzerId: this.id,
              kind: mode === "petscii" ? "petscii_text" : "screen_code_text",
              start: addressStart,
              end: addressEnd,
              score: {
                confidence,
                reasons: [
                  `${Math.round(printableRatio * 100)}% of bytes match ${mode === "petscii" ? "PETSCII" : "screen-code"} printable ranges.`,
                  `Detected contiguous text-like run of ${length} bytes at ${formatAddress(addressStart)}-${formatAddress(addressEnd)}.`,
                  strongPhrase
                    ? "Preview contains multiple word-like runs separated by spaces."
                    : "Preview contains limited wording, but still passes the stricter readability gate.",
                  `Alphabetic/space ratio is ${Math.round(alphaRatio * 100)}%, punctuation ratio ${Math.round(punctuation * 100)}%.`,
                ],
                alternatives:
                  mode === "petscii"
                    ? [
                        {
                          kind: "text",
                          confidence: clampConfidence(confidence - 0.08),
                          reasons: ["Text is clearly printable, but PETSCII-specific evidence is moderate."],
                        },
                      ]
                    : undefined,
              },
              preview: [renderTextPreview(text, `${mode} preview`)],
              attributes: {
                length,
                previewText: text,
              },
            });
          }
        }

        runStart = nextMode !== undefined ? offset : undefined;
        mode = nextMode;
      }
    }

    candidates.push(...this.findPagedPetsciiCandidates(context));

    return {
      analyzerId: this.id,
      candidates,
    };
  }

  private findPagedPetsciiCandidates(context: AnalyzerContext): SegmentCandidate[] {
    const candidates: SegmentCandidate[] = [];

    for (const region of context.candidateRegions) {
      const startOffset = toOffset(region.start, context.mapping);
      const endOffset = toOffset(region.end, context.mapping);
      if (startOffset === undefined || endOffset === undefined) {
        continue;
      }

      let runStart: number | undefined;

      for (let offset = startOffset; offset <= endOffset + 1; offset += 1) {
        const byte = offset <= endOffset ? context.buffer[offset] : 0xff;
        const isTextual = offset <= endOffset && isPagedPetsciiByte(byte);

        if (runStart === undefined && isTextual) {
          runStart = offset;
          continue;
        }

        if (runStart !== undefined && isTextual) {
          continue;
        }

        if (runStart !== undefined) {
          const runEnd = offset - 1;
          const rawBytes = Array.from(context.buffer.subarray(runStart, runEnd + 1));
          const trimmed = trimmedPagedRange(rawBytes, 0, rawBytes.length - 1);
          if (!trimmed) {
            runStart = undefined;
            continue;
          }

          const [trimmedStart, trimmedEnd] = trimmed;
          const bytes = rawBytes.slice(trimmedStart, trimmedEnd + 1);
          const length = bytes.length;
          const printableRatio = bytes.filter((candidate) => isPagedPetsciiByte(candidate)).length / Math.max(1, bytes.length);
          const zeroCount = zeroSeparatorCount(bytes);
          const text = decodePagedPetscii(bytes.slice(0, 240));
          const alphaRatio = alphabeticRatio(text.replaceAll("|", ""));
          const spaces = spacingCount(text);
          const punctuation = punctuationRatio(text.replaceAll("|", ""));
          const words = text.match(/[A-Za-z]{3,}/g) ?? [];
          const hasMultiPageShape = zeroCount >= 2;
          const hasStoryWords = words.length >= 8;
          const longEnough = length >= 160;
          const looksReadable = printableRatio >= 0.96 && alphaRatio >= 0.55 && punctuation <= 0.12 && spaces >= 12;

          if (longEnough && hasMultiPageShape && hasStoryWords && looksReadable) {
            const addressStart = context.mapping.startAddress + runStart + trimmedStart;
            const addressEnd = context.mapping.startAddress + runStart + trimmedEnd;
            const confidence = clampConfidence(0.72 + Math.min(0.18, zeroCount * 0.01) + Math.min(0.08, words.length * 0.004));

            candidates.push({
              analyzerId: this.id,
              kind: "petscii_text",
              start: addressStart,
              end: addressEnd,
              score: {
                confidence,
                reasons: [
                  `${Math.round(printableRatio * 100)}% of bytes match PETSCII or zero page separators.`,
                  `Detected long paged text block of ${length} bytes at ${formatAddress(addressStart)}-${formatAddress(addressEnd)}.`,
                  `Contains ${zeroCount} $00 separators, which fits multi-page story/script text.`,
                  `Preview contains ${words.length} word-like runs and ${spaces} spaces, suggesting formatted narrative text rather than screen/code data.`,
                ],
                alternatives: [
                  {
                    kind: "screen_code_text",
                    confidence: clampConfidence(confidence - 0.22),
                    reasons: ["The block is text-like, but the ASCII/PETSCII letter range is stronger than screen-code evidence."],
                  },
                ],
              },
              preview: [renderTextPreview(text.slice(0, 120), "paged petscii preview")],
              attributes: {
                length: segmentLength(addressStart, addressEnd),
                previewText: text.slice(0, 240),
                pagedText: true,
                zeroSeparators: zeroCount,
              },
            });
          }
        }

        runStart = undefined;
      }
    }

    return candidates;
  }
}
