import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync as readFileSyncNode } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RawCruncher, ExomizerRawDepacker, ExomizerSfxDepacker } from "./exomizer-ts/index.js";

const execFileAsync = promisify(execFile);

export interface RlePackOptions {
  includeHeader?: boolean;
  writeAddress?: number;
  optimal?: boolean;
}

export interface RlePackResult {
  data: Uint8Array;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  runCount: number;
  copyCount: number;
}

export interface RleDepackResult {
  data: Uint8Array;
  byteCount: number;
  runCount: number;
  copyCount: number;
  headerAddress?: number;
  consumedBytes: number;
  terminated: boolean;
}

export interface ByteBoozerDepackResult {
  data: Uint8Array;
  byteCount: number;
  outputAddress: number;
  inputConsumed: number;
  mode: "raw" | "executable";
  sourceLoadAddress?: number;
}

export interface ExomizerRawPackResult {
  data: Uint8Array;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  encoding: string;
}

export interface ExomizerRawDepackTsResult {
  data: Uint8Array;
  byteCount: number;
}

export interface ExomizerSfxDepackTsResult {
  data: Uint8Array;
  byteCount: number;
  outputStart: number;
  outputEnd: number;
  entryPoint: number;
  cycles: number;
  loadAddress: number;
}

export interface ExomizerSfxPackOptions {
  projectDir: string;
  target: string;
  inputSpecs: string[];
  outputPath: string;
  extraArgs?: string[];
}

export interface ExomizerSharedEncodingOptions {
  projectDir: string;
  inputPaths: string[];
  outputDir: string;
  packedSuffix?: string;
  encodingTextName?: string;
  encodingBinaryName?: string;
  manifestName?: string;
  discoverRuns?: number;
  sampleSize?: number;
  seed?: number;
  importedEncoding?: string;
  maxPasses?: number;
  favorSpeed?: boolean;
  backwards?: boolean;
  reverseOutput?: boolean;
}

export interface ExomizerSharedEncodingCandidateResult {
  runIndex: number;
  source: "all_inputs" | "largest_inputs" | "random_sample" | "provided_encoding";
  sampleCount: number;
  encoding: string;
  encodingBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
}

export interface ExomizerSharedEncodingPackedFile {
  inputPath: string;
  outputPath: string;
  relativeOutputPath: string;
  originalSize: number;
  packedSize: number;
  ratio: number;
}

export interface ExomizerSharedEncodingResult {
  outputDir: string;
  encodingTextPath: string;
  encodingBinaryPath: string;
  manifestPath: string;
  chosenEncoding: string;
  chosenCandidate: ExomizerSharedEncodingCandidateResult;
  candidates: ExomizerSharedEncodingCandidateResult[];
  packedFiles: ExomizerSharedEncodingPackedFile[];
  totalOriginalBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
}

export class RlePacker {
  private readonly includeHeader: boolean;
  private readonly writeAddress: number;
  private readonly optimal: boolean;

  constructor(options: RlePackOptions = {}) {
    this.includeHeader = options.includeHeader ?? false;
    this.writeAddress = options.writeAddress ?? 0x8000;
    this.optimal = options.optimal ?? true;
  }

  pack(data: Uint8Array): RlePackResult {
    return this.optimal ? this.packOptimal(data) : this.packGreedy(data);
  }

  private packOptimal(data: Uint8Array): RlePackResult {
    const n = data.length;
    if (n === 0) {
      return this.createResult([], data.length, 0, 0);
    }

    const runLen = new Array<number>(n).fill(1);
    for (let i = n - 2; i >= 0; i--) {
      if (data[i] === data[i + 1] && runLen[i + 1] < 128) {
        runLen[i] = runLen[i + 1] + 1;
      }
    }

    const cost = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const prev = new Array<{ type: "rle" | "copy"; start: number; len: number }>(n + 1);
    cost[0] = 0;

    for (let i = 1; i <= n; i++) {
      for (let len = 2; len <= Math.min(128, i); len++) {
        const start = i - len;
        if (runLen[start] >= len && cost[start] + 2 < cost[i]) {
          cost[i] = cost[start] + 2;
          prev[i] = { type: "rle", start, len };
        }
      }

      for (let len = 1; len <= Math.min(128, i); len++) {
        const start = i - len;
        const segmentCost = 1 + len;
        if (cost[start] + segmentCost < cost[i]) {
          cost[i] = cost[start] + segmentCost;
          prev[i] = { type: "copy", start, len };
        }
      }
    }

    const segments: Array<{ type: "rle" | "copy"; start: number; len: number }> = [];
    let pos = n;
    while (pos > 0) {
      const segment = prev[pos];
      if (!segment) {
        throw new Error(`RLE optimal parser failed at position ${pos}.`);
      }
      segments.push(segment);
      pos = segment.start;
    }
    segments.reverse();

    const out: number[] = [];
    let runCount = 0;
    let copyCount = 0;
    if (this.includeHeader) {
      out.push(this.writeAddress & 0xff, (this.writeAddress >> 8) & 0xff);
    }
    for (const segment of segments) {
      if (segment.type === "rle") {
        out.push(segment.len - 1);
        out.push(data[segment.start]!);
        runCount++;
      } else {
        out.push(0x80 | (segment.len - 1));
        for (let i = 0; i < segment.len; i++) {
          out.push(data[segment.start + i]!);
        }
        copyCount++;
      }
    }
    out.push(0x00);
    return this.createResult(out, data.length, runCount, copyCount);
  }

  private packGreedy(data: Uint8Array): RlePackResult {
    const out: number[] = [];
    let runCount = 0;
    let copyCount = 0;
    if (this.includeHeader) {
      out.push(this.writeAddress & 0xff, (this.writeAddress >> 8) & 0xff);
    }

    let i = 0;
    while (i < data.length) {
      const byte = data[i]!;
      let runLen = 1;
      while (i + runLen < data.length && data[i + runLen] === byte && runLen < 128) {
        runLen++;
      }

      if (runLen >= 3) {
        out.push(runLen - 1, byte);
        runCount++;
        i += runLen;
        continue;
      }

      const copyStart = i;
      let copyLen = 0;
      while (i < data.length && copyLen < 128) {
        const nextByte = data[i]!;
        let nextRunLen = 1;
        while (i + nextRunLen < data.length && data[i + nextRunLen] === nextByte && nextRunLen < 128) {
          nextRunLen++;
        }
        if (nextRunLen >= 3) {
          break;
        }
        const bytesToAdd = Math.min(nextRunLen, 128 - copyLen);
        copyLen += bytesToAdd;
        i += bytesToAdd;
      }

      out.push(0x80 | (copyLen - 1));
      for (let j = 0; j < copyLen; j++) {
        out.push(data[copyStart + j]!);
      }
      copyCount++;
    }

    out.push(0x00);
    return this.createResult(out, data.length, runCount, copyCount);
  }

  private createResult(out: number[], originalSize: number, runCount: number, copyCount: number): RlePackResult {
    return {
      data: Uint8Array.from(out),
      originalSize,
      compressedSize: out.length,
      ratio: originalSize > 0 ? out.length / originalSize : 1,
      runCount,
      copyCount,
    };
  }
}

export class RleDepacker {
  unpack(input: Uint8Array, options: { hasHeader?: boolean; maxSize?: number } = {}): RleDepackResult {
    let src = 0;
    let headerAddress: number | undefined;
    if (options.hasHeader) {
      if (input.length < 2) {
        throw new Error("RLE input is too short to contain a 2-byte load header.");
      }
      headerAddress = input[0]! | (input[1]! << 8);
      src = 2;
    }

    const output: number[] = [];
    let runCount = 0;
    let copyCount = 0;
    const maxSize = options.maxSize ?? Number.POSITIVE_INFINITY;

    while (src < input.length) {
      const header = input[src++]!;
      if (header === 0x00) {
        break;
      }

      if ((header & 0x80) === 0) {
        const len = header + 1;
        if (src >= input.length) {
          throw new Error("RLE input ended inside a run segment.");
        }
        const value = input[src++]!;
        for (let i = 0; i < len; i++) {
          output.push(value);
        }
        runCount++;
      } else {
        const len = (header & 0x7f) + 1;
        if (src + len > input.length + 1) {
          throw new Error("RLE input ended inside a copy segment.");
        }
        for (let i = 0; i < len; i++) {
          const value = input[src++];
          if (value === undefined) {
            throw new Error("RLE input ended inside a copy segment.");
          }
          output.push(value);
        }
        copyCount++;
      }

      if (output.length > maxSize) {
        throw new Error(`RLE unpack overflow: ${output.length} > ${maxSize}`);
      }
    }

    return {
      data: Uint8Array.from(output),
      byteCount: output.length,
      runCount,
      copyCount,
      headerAddress,
      consumedBytes: src,
      terminated: src <= input.length && input[Math.max(0, src - 1)] === 0x00,
    };
  }
}

const BYTEBOOZER_EXECUTABLE_DECRUNCHER_LENGTH = 0xd5;
const BYTEBOOZER_EXECUTABLE_SIGNATURE = Uint8Array.from([
  0x01, 0x08, 0x0b, 0x08, 0x00, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00,
  0x78, 0xa9, 0x34, 0x85, 0x01, 0xa2, 0xb7, 0xbd, 0x1e, 0x08, 0x95, 0x0f, 0xca, 0xd0, 0xf8, 0x4c, 0x10, 0x00,
]);

class ByteBoozerBitReader {
  private position = 0;
  private bits = 0x80;

  constructor(private readonly input: Uint8Array) {}

  readByte(): number {
    const value = this.input[this.position++];
    if (value === undefined) {
      throw new Error("ByteBoozer input ended unexpectedly.");
    }
    return value;
  }

  nextBit(): number {
    const carry = (this.bits & 0x80) !== 0 ? 1 : 0;
    this.bits = (this.bits << 1) & 0xff;
    if (this.bits !== 0) {
      return carry;
    }
    const value = this.readByte();
    this.bits = ((value << 1) & 0xff) | 0x01;
    return (value >> 7) & 1;
  }

  get consumedBytes(): number {
    return this.position;
  }
}

export class ByteBoozerDepacker {
  unpack(input: Uint8Array): ByteBoozerDepackResult {
    if (looksLikeByteBoozerExecutablePrg(input)) {
      return this.unpackExecutable(input);
    }
    return this.unpackRaw(input);
  }

  unpackRaw(input: Uint8Array): ByteBoozerDepackResult {
    if (input.length < 4) {
      throw new Error("ByteBoozer raw stream is too short.");
    }
    const sourceLoadAddress = input[0]! | (input[1]! << 8);
    const outputAddress = input[2]! | (input[3]! << 8);
    const { data, consumedBytes } = this.decrunch(input.slice(4));
    return {
      data,
      byteCount: data.length,
      outputAddress,
      inputConsumed: consumedBytes + 4,
      mode: "raw",
      sourceLoadAddress,
    };
  }

  unpackExecutable(input: Uint8Array): ByteBoozerDepackResult {
    const minLength = 2 + BYTEBOOZER_EXECUTABLE_DECRUNCHER_LENGTH;
    if (input.length < minLength) {
      throw new Error("ByteBoozer executable PRG is too short.");
    }
    const sourceLoadAddress = input[0]! | (input[1]! << 8);
    const outputAddress = input[2 + 0x85]! | (input[2 + 0x86]! << 8);
    const stream = input.slice(2 + BYTEBOOZER_EXECUTABLE_DECRUNCHER_LENGTH);
    const { data, consumedBytes } = this.decrunch(stream);
    return {
      data,
      byteCount: data.length,
      outputAddress,
      inputConsumed: consumedBytes + 2 + BYTEBOOZER_EXECUTABLE_DECRUNCHER_LENGTH,
      mode: "executable",
      sourceLoadAddress,
    };
  }

  private decrunch(stream: Uint8Array): { data: Uint8Array; consumedBytes: number } {
    const reader = new ByteBoozerBitReader(stream);
    const output: number[] = [];
    // Mirrors the reference Decruncher.inc control flow:
    //   DLoop: next-bit → Match or Literal
    //   Match: read length + offset, copy, `jmp DLoop`
    //   Literal: read length + bytes. If length was 255, `jmp DLoop`;
    //            otherwise fall through to Match (the implicit match)
    //            and then `jmp DLoop`.
    outer: for (;;) {
      if (reader.nextBit() === 0) {
        // Literal run.
        const literalLength = this.readLength(reader);
        for (let i = 0; i < literalLength; i++) {
          output.push(reader.readByte());
        }
        if (literalLength === 0xff) {
          continue;
        }
        // Implicit match after a non-255 literal.
        const storedLength = this.readLength(reader);
        if (storedLength === 0xff) {
          break outer;
        }
        this.copyMatch(reader, output, storedLength);
      } else {
        // Match. No implicit continuation — next iteration reads a new bit.
        const storedLength = this.readLength(reader);
        if (storedLength === 0xff) {
          break outer;
        }
        this.copyMatch(reader, output, storedLength);
      }
    }
    return { data: Uint8Array.from(output), consumedBytes: reader.consumedBytes };
  }

  private copyMatch(reader: ByteBoozerBitReader, output: number[], storedLength: number): void {
    const selector = ((storedLength >= 2 ? 1 : 0) << 2) | (reader.nextBit() << 1) | reader.nextBit();
    const offsetBits = storedLength === 1
      ? [3, 6, 8, 10][selector]
      : [4, 7, 10, 13][selector - 4];
    if (offsetBits === undefined) {
      throw new Error(`Invalid ByteBoozer offset selector ${selector} for stored length ${storedLength}.`);
    }
    const offsetMinusOne = offsetBits < 8
      ? this.readShortOffset(reader, offsetBits)
      : this.readLongOffset(reader, offsetBits);
    const offset = offsetMinusOne + 1;
    const matchLength = storedLength + 1;
    let sourceIndex = output.length - offset;
    if (sourceIndex < 0) {
      throw new Error(`ByteBoozer back-reference underflow: offset=${offset} output=${output.length}`);
    }
    for (let i = 0; i < matchLength; i++) {
      const value = output[sourceIndex++];
      if (value === undefined) {
        throw new Error("ByteBoozer back-reference exceeded current output.");
      }
      output.push(value);
    }
  }

  private readLength(reader: ByteBoozerBitReader): number {
    let value = 1;
    for (;;) {
      if (reader.nextBit() === 0) {
        return value;
      }
      value = ((value << 1) | reader.nextBit()) & 0xff;
      if ((value & 0x80) !== 0) {
        return value;
      }
    }
  }

  private readShortOffset(reader: ByteBoozerBitReader, bitCount: number): number {
    let encoded = 0;
    for (let i = 0; i < bitCount; i++) {
      encoded = (encoded << 1) | reader.nextBit();
    }
    return (~encoded) & ((1 << bitCount) - 1);
  }

  private readLongOffset(reader: ByteBoozerBitReader, bitCount: number): number {
    let high = 0;
    for (let i = 0; i < bitCount - 8; i++) {
      high = (high << 1) | reader.nextBit();
    }
    const low = reader.readByte() ^ 0xff;
    return (high << 8) | low;
  }
}

function detectBasicSysStub(data: Uint8Array): { loadAddress: number; sysTarget?: number } | undefined {
  if (data.length < 16) {
    return undefined;
  }
  const loadAddress = data[0]! | (data[1]! << 8);
  if (loadAddress !== 0x0801) {
    return undefined;
  }
  const sysIndex = data.indexOf(0x9e, 2);
  if (sysIndex === -1) {
    return { loadAddress };
  }
  let cursor = sysIndex + 1;
  let ascii = "";
  while (cursor < data.length && data[cursor] >= 0x30 && data[cursor] <= 0x39) {
    ascii += String.fromCharCode(data[cursor]!);
    cursor++;
  }
  return {
    loadAddress,
    sysTarget: ascii ? Number.parseInt(ascii, 10) : undefined,
  };
}

function looksLikeByteBoozerExecutablePrg(data: Uint8Array): boolean {
  if (data.length < BYTEBOOZER_EXECUTABLE_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < BYTEBOOZER_EXECUTABLE_SIGNATURE.length; i++) {
    if (data[i] !== BYTEBOOZER_EXECUTABLE_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

function looksMaybeLikeByteBoozerStream(data: Uint8Array): boolean {
  if (data.length < 24) {
    return false;
  }
  return data[2] === 0x00
    && data[3] === 0x10
    && data[4] === 0x54
    && data[5] === 0x4c
    && data[12] === 0x4c;
}

async function withTempSlice<T>(data: Uint8Array, fn: (tempPath: string, dir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "c64re-packed-"));
  try {
    const tempPath = join(tempDir, "slice.bin");
    await writeFile(tempPath, data);
    return await fn(tempPath, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function suggestDepackers(options: {
  projectDir: string;
  inputPath: string;
  offset?: number;
  length?: number;
}): Promise<DepackerSuggestion[]> {
  const raw = await readBinaryFile(options.inputPath);
  const offset = options.offset ?? 0;
  const end = options.length === undefined ? raw.length : Math.min(raw.length, offset + options.length);
  const data = raw.slice(offset, end);
  const suggestions: DepackerSuggestion[] = [];
  const basic = offset === 0 ? detectBasicSysStub(data) : undefined;
  const diskLoader = detectKernalLoadWrapper(data);

  if (basic?.sysTarget !== undefined) {
    suggestions.push({
      format: diskLoader ? "disk_loader_wrapper" : "loader_wrapper",
      confidence: diskLoader ? 0.82 : 0.6,
      reason: diskLoader
        ? `PRG starts with a BASIC SYS wrapper to ${basic.sysTarget} and contains a KERNAL SETNAM/SETLFS/LOAD sequence. This stage is a disk loader wrapper, not a raw compressed stream.`
        : `PRG starts with a BASIC SYS wrapper to ${basic.sysTarget}; the whole file is likely an executable loader wrapper, not a raw compressed stream.`,
      offset,
      length: data.length,
      notes: [
        diskLoader
          ? `KERNAL loader sequence at offsets ${diskLoader.setnamOffset.toString(16)}, ${diskLoader.setlfsOffset.toString(16)}, ${diskLoader.loadOffset.toString(16)}.`
          : "Try runtime tracing or breakpoint-driven capture on the loader path.",
        diskLoader
          ? "The next stage likely comes from disk and should be identified from the image directory or captured at LOAD/after-return."
          : "If payload data is embedded later in the PRG, retry detection on a sliced offset instead of the whole file.",
      ],
    });
  }

  try {
    const exoSfxSuggestion = await withTempSlice(data, async (tempPath, tempDir) => {
      const result = await depackExomizerSfx({
        inputPath: tempPath,
      });
      return {
        format: "exomizer_sfx" as const,
        confidence: basic ? 0.93 : 0.85,
        reason: "Exomizer self-extracting wrapper decrunch succeeded structurally.",
        offset,
        length: data.length,
        unpackedSize: result.data.length,
        notes: [
          "This is an executable self-decrunching wrapper, not a raw Exomizer stream.",
          basic?.sysTarget !== undefined ? `BASIC SYS target: ${basic.sysTarget}` : "No BASIC SYS wrapper was required for detection.",
        ],
      };
    });
    if (exoSfxSuggestion) {
      suggestions.push(exoSfxSuggestion);
    }
  } catch {
    // Ignore failed Exomizer SFX probes.
  }

  try {
    const rle = new RleDepacker().unpack(data, { hasHeader: false, maxSize: Math.max(data.length * 16, 65536) });
    if (rle.terminated && rle.consumedBytes === data.length) {
      const ratio = rle.byteCount / Math.max(1, data.length);
      suggestions.push({
        format: "rle",
        confidence: ratio <= 8 ? 0.85 : 0.55,
        reason: `Data is structurally valid Mike-RLE and terminates cleanly after ${rle.consumedBytes} input bytes.`,
        offset,
        length: data.length,
        unpackedSize: rle.byteCount,
        notes: [`Expansion ratio: ${ratio.toFixed(2)}x`, `Runs=${rle.runCount}, copies=${rle.copyCount}`],
      });
    }
  } catch {
    // Not RLE.
  }

  try {
    const byteboozer = new ByteBoozerDepacker().unpack(data);
    suggestions.push({
      format: byteboozer.mode === "executable" ? "byteboozer2_executable" : "byteboozer2_raw",
      confidence: byteboozer.mode === "executable" ? 0.9 : 0.8,
      reason: byteboozer.mode === "executable"
        ? "PRG matches the ByteBoozer2 executable wrapper and decrunches successfully."
        : "ByteBoozer2 host-side depack completed successfully for this data window.",
      offset,
      length: data.length,
      unpackedSize: byteboozer.byteCount,
      notes: [
        `Mode: ${byteboozer.mode}`,
        `Output address: $${byteboozer.outputAddress.toString(16).toUpperCase()}`,
        "If this is only an outer loader, runtime tracing can still help locate an inner packed payload.",
      ],
    });
  } catch {
    if (looksLikeByteBoozerExecutablePrg(data)) {
      suggestions.push({
        format: "byteboozer2_executable",
        confidence: 0.6,
        reason: "PRG matches the stable ByteBoozer2 executable stub signature, but host-side depack did not complete cleanly.",
        offset,
        length: data.length,
      });
    } else if (looksMaybeLikeByteBoozerStream(data)) {
      suggestions.push({
        format: "byteboozer2_maybe",
        confidence: 0.45,
        reason: "Data starts with a ByteBoozer-like low-memory decrunch stub pattern, but the signature is not strong enough to be certain.",
        offset,
        length: data.length,
      });
    }
  }

  try {
    const unpacked = new ExomizerRawDepacker().unpack(data);
    const ratio = unpacked.byteCount / Math.max(1, data.length);
    let confidence = 0.65;
    if (ratio > 16) confidence = 0.1;
    else if (ratio > 8) confidence = 0.3;
    if (basic) confidence = Math.min(confidence, 0.15);
    suggestions.push({
      format: "exomizer_raw",
      confidence,
      reason: "Exomizer raw decrunch succeeded structurally.",
      offset,
      length: data.length,
      unpackedSize: unpacked.byteCount,
      notes: [`Expansion ratio: ${ratio.toFixed(2)}x`],
    });
  } catch {
    // Ignore failed Exomizer probes.
  }

  if (suggestions.length === 0) {
    suggestions.push({
      format: "unknown",
      confidence: 0.1,
      reason: "No built-in depacker probe recognized this input confidently.",
      offset,
      length: data.length,
      notes: ["This may be a custom loader stub, embedded packed payload, or an unsupported crunch format."],
    });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

export interface ExternalToolResult {
  tool: "exomizer" | "byteboozer2";
  command: string;
  args: string[];
  outputPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DepackerSuggestion {
  format: "loader_wrapper" | "disk_loader_wrapper" | "rle" | "exomizer_raw" | "exomizer_sfx" | "byteboozer2_executable" | "byteboozer2_raw" | "byteboozer2_maybe" | "unknown";
  confidence: number;
  reason: string;
  offset: number;
  length: number;
  unpackedSize?: number;
  notes?: string[];
}

async function runExternalTool(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolvePromise) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: error ? ((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0,
      });
    });
  });
}

async function resolveExecutable(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.startsWith(".")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    try {
      await execFileAsync("which", [candidate]);
      return candidate;
    } catch {
      // Keep searching the remaining candidates.
    }
  }
  throw new Error(`Unable to locate executable. Tried: ${candidates.join(", ")}`);
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function detectKernalLoadWrapper(data: Uint8Array): { setnamOffset: number; setlfsOffset: number; loadOffset: number } | undefined {
  for (let i = 0; i <= data.length - 9; i++) {
    if (data[i] !== 0x20 || data[i + 1] !== 0xbd || data[i + 2] !== 0xff) {
      continue;
    }
    let setlfsOffset = -1;
    let loadOffset = -1;
    for (let j = i + 3; j < Math.min(data.length - 2, i + 24); j++) {
      if (setlfsOffset < 0 && data[j] === 0x20 && data[j + 1] === 0xba && data[j + 2] === 0xff) {
        setlfsOffset = j;
        continue;
      }
      if (setlfsOffset >= 0 && data[j] === 0x20 && data[j + 1] === 0xd5 && data[j + 2] === 0xff) {
        loadOffset = j;
        return { setnamOffset: i, setlfsOffset, loadOffset };
      }
    }
  }
  return undefined;
}

async function resolveByteBoozerBinary(): Promise<string> {
  return await resolveExecutable([
    process.env.C64RE_BYTEBOOZER_BIN ?? "",
    "b2",
    resolve(repoRoot(), "..", "ByteBoozer2", "b2", "b2"),
  ].filter(Boolean));
}

async function resolveExomizerBinary(): Promise<string> {
  return await resolveExecutable([
    process.env.C64RE_EXOMIZER_BIN ?? "",
    "exomizer",
    resolve(repoRoot(), "..", "easyflash_image_builder", "src", "compression", "exomizer-c-port", "exomizer_src_c", "src", "exomizer"),
  ].filter(Boolean));
}

function resolveExomizerInputSpec(spec: string, cwd: string): string {
  const commaIndex = spec.indexOf(",");
  if (commaIndex < 0) {
    return resolve(cwd, spec);
  }
  const inputPath = spec.slice(0, commaIndex);
  const suffix = spec.slice(commaIndex);
  return `${resolve(cwd, inputPath)}${suffix}`;
}

function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleIndices(count: number, sampleSize: number, random: () => number): number[] {
  const indices = Array.from({ length: count }, (_, index) => index);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }
  indices.length = Math.min(sampleSize, indices.length);
  return indices.sort((left, right) => left - right);
}

function sanitizeRelativeOutputPath(projectDir: string, inputAbs: string, packedSuffix: string): string {
  const rel = relative(projectDir, inputAbs);
  const base = rel.startsWith("..") || rel === "" ? basename(inputAbs) : rel;
  return `${base}${packedSuffix}`;
}

function resolveImportedEncodingReference(importedEncoding: string | undefined, projectDir: string): string | null {
  if (!importedEncoding) {
    return null;
  }
  if (!importedEncoding.startsWith("@")) {
    return importedEncoding.trim().toUpperCase();
  }
  const path = resolve(projectDir, importedEncoding.slice(1));
  const raw = readFileSyncNode(path);
  const asText = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F,]+$/.test(asText)) {
    return asText.toUpperCase();
  }
  throw new Error(`Imported encoding file must contain a textual Exomizer encoding string: ${path}`);
}

export async function packExomizerRaw(options: {
  inputPath: string;
  backwards?: boolean;
  reverseOutput?: boolean;
  noEncodingHeader?: boolean;
}): Promise<ExomizerRawPackResult> {
  const input = await readBinaryFile(options.inputPath);
  const cruncher = new RawCruncher();
  const result = cruncher.crunchMulti([input], {
    outputHeader: !(options.noEncodingHeader ?? false),
    directionForward: !(options.backwards ?? false),
    writeReverse: options.reverseOutput ?? false,
  });
  return {
    data: result.data[0]!,
    originalSize: input.length,
    compressedSize: result.data[0]!.length,
    ratio: input.length > 0 ? result.data[0]!.length / input.length : 1,
    encoding: result.encoding,
  };
}

export async function depackExomizerRaw(options: {
  inputPath: string;
  backwards?: boolean;
  reverseOutput?: boolean;
}): Promise<ExomizerRawDepackTsResult> {
  const input = await readBinaryFile(options.inputPath);
  const result = new ExomizerRawDepacker().unpack(input, {
    backwards: options.backwards,
    reverseOutput: options.reverseOutput,
  });
  return { data: result.data, byteCount: result.byteCount };
}

export async function depackExomizerSfx(options: {
  inputPath: string;
  entryAddress?: number | "load";
  maxInstructions?: number;
}): Promise<ExomizerSfxDepackTsResult> {
  const input = await readBinaryFile(options.inputPath);
  const result = new ExomizerSfxDepacker().unpack(input, {
    entryAddress: options.entryAddress,
    maxInstructions: options.maxInstructions,
  });
  return result;
}

export async function packExomizerSfx(options: ExomizerSfxPackOptions): Promise<ExternalToolResult> {
  if (options.inputSpecs.length === 0) {
    throw new Error("At least one Exomizer input spec is required.");
  }
  const command = await resolveExomizerBinary();
  const args = [
    "sfx",
    options.target,
    ...(options.extraArgs ?? []),
    ...options.inputSpecs.map((spec) => resolveExomizerInputSpec(spec, options.projectDir)),
    "-o",
    options.outputPath,
  ];
  const result = await runExternalTool(command, args, options.projectDir);
  return {
    tool: "exomizer",
    command,
    args,
    outputPath: options.outputPath,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export async function packExomizerSharedEncoding(options: ExomizerSharedEncodingOptions): Promise<ExomizerSharedEncodingResult> {
  if (options.inputPaths.length === 0) {
    throw new Error("At least one input file is required.");
  }

  const packedSuffix = options.packedSuffix ?? ".exo";
  const encodingTextName = options.encodingTextName ?? "shared-encoding.txt";
  const encodingBinaryName = options.encodingBinaryName ?? "shared-encoding.bin";
  const manifestName = options.manifestName ?? "manifest.json";
  const discoverRuns = Math.max(1, options.discoverRuns ?? 1);
  const resolvedInputs = options.inputPaths.map((inputPath) => resolve(options.projectDir, inputPath));
  const inputBuffers = await Promise.all(resolvedInputs.map((inputPath) => readBinaryFile(inputPath)));
  const totalOriginalBytes = inputBuffers.reduce((sum, data) => sum + data.length, 0);
  const sampleSize = Math.max(1, Math.min(options.sampleSize ?? Math.min(inputBuffers.length, 32), inputBuffers.length));
  const random = makeSeededRandom(options.seed ?? 0xc64e0001);
  const directionForward = !(options.backwards ?? false);
  const readEncodingSync = (path: string): Uint8Array => new Uint8Array(readFileSyncNode(resolve(options.projectDir, path)));
  const cruncher = new RawCruncher(readEncodingSync);

  const evaluateEncoding = (runIndex: number, source: ExomizerSharedEncodingCandidateResult["source"], sampleCount: number, encoding: string) => {
    const encodingBinary = cruncher.exportEncodingBinary(encoding);
    const packedOutputs = inputBuffers.map((input) =>
      cruncher.crunch(input, {
        outputHeader: false,
        importedEncoding: encoding,
        maxPasses: 1,
        favorSpeed: options.favorSpeed ?? false,
        directionForward,
        writeReverse: options.reverseOutput ?? false,
      }).data
    );
    const totalPayloadBytes = packedOutputs.reduce((sum, data) => sum + data.length, 0);
    return {
      candidate: {
        runIndex,
        source,
        sampleCount,
        encoding,
        encodingBytes: encodingBinary.length,
        totalPayloadBytes,
        totalBytes: totalPayloadBytes + encodingBinary.length,
      } satisfies ExomizerSharedEncodingCandidateResult,
      packedOutputs,
      encodingBinary,
    };
  };

  const candidateSpecs: Array<{ runIndex: number; source: ExomizerSharedEncodingCandidateResult["source"]; indices: number[]; importedEncoding?: string }> = [];
  if (options.importedEncoding) {
    candidateSpecs.push({ runIndex: 0, source: "provided_encoding", indices: [], importedEncoding: options.importedEncoding });
  } else {
    candidateSpecs.push({ runIndex: 0, source: "all_inputs", indices: Array.from({ length: inputBuffers.length }, (_, index) => index) });
    if (discoverRuns > 1 && sampleSize < inputBuffers.length) {
      const largest = Array.from({ length: inputBuffers.length }, (_, index) => index)
        .sort((left, right) => inputBuffers[right]!.length - inputBuffers[left]!.length)
        .slice(0, sampleSize)
        .sort((left, right) => left - right);
      candidateSpecs.push({ runIndex: 1, source: "largest_inputs", indices: largest });
    }
    while (candidateSpecs.length < discoverRuns) {
      candidateSpecs.push({
        runIndex: candidateSpecs.length,
        source: "random_sample",
        indices: sampleIndices(inputBuffers.length, sampleSize, random),
      });
    }
  }

  const candidateEvaluations = candidateSpecs.map((spec) => {
    const candidateEncoding = spec.importedEncoding
      ? resolveImportedEncodingReference(spec.importedEncoding, options.projectDir) ?? ""
      : cruncher.crunchMulti(spec.indices.map((index) => inputBuffers[index]!), {
          outputHeader: false,
          maxPasses: options.maxPasses ?? 100,
          favorSpeed: options.favorSpeed ?? false,
          directionForward,
          writeReverse: options.reverseOutput ?? false,
        }).encoding;
    return evaluateEncoding(spec.runIndex, spec.source, spec.importedEncoding ? inputBuffers.length : spec.indices.length, candidateEncoding);
  });

  candidateEvaluations.sort((left, right) => {
    if (left.candidate.totalBytes !== right.candidate.totalBytes) {
      return left.candidate.totalBytes - right.candidate.totalBytes;
    }
    return left.candidate.runIndex - right.candidate.runIndex;
  });
  const best = candidateEvaluations[0];
  if (!best) {
    throw new Error("No shared-encoding candidate could be evaluated.");
  }

  await mkdir(options.outputDir, { recursive: true });
  const encodingTextPath = resolve(options.outputDir, encodingTextName);
  const encodingBinaryPath = resolve(options.outputDir, encodingBinaryName);
  const manifestPath = resolve(options.outputDir, manifestName);
  await writeFile(encodingTextPath, `${best.candidate.encoding}\n`, "utf8");
  await writeBinaryFile(encodingBinaryPath, best.encodingBinary);

  const packedFiles: ExomizerSharedEncodingPackedFile[] = [];
  for (let i = 0; i < resolvedInputs.length; i++) {
    const relativeOutputPath = sanitizeRelativeOutputPath(options.projectDir, resolvedInputs[i]!, packedSuffix);
    const outputPath = resolve(options.outputDir, relativeOutputPath);
    const packed = best.packedOutputs[i]!;
    await writeBinaryFile(outputPath, packed);
    packedFiles.push({
      inputPath: resolvedInputs[i]!,
      outputPath,
      relativeOutputPath,
      originalSize: inputBuffers[i]!.length,
      packedSize: packed.length,
      ratio: inputBuffers[i]!.length > 0 ? packed.length / inputBuffers[i]!.length : 1,
    });
  }

  const manifest = {
    outputDir: options.outputDir,
    encodingTextPath,
    encodingBinaryPath,
    chosenEncoding: best.candidate.encoding,
    chosenCandidate: best.candidate,
    candidates: candidateEvaluations.map((entry) => entry.candidate),
    packedFiles,
    totalOriginalBytes,
    totalPayloadBytes: best.candidate.totalPayloadBytes,
    totalBytes: best.candidate.totalBytes,
    options: {
      discoverRuns,
      sampleSize,
      maxPasses: options.maxPasses ?? 100,
      favorSpeed: options.favorSpeed ?? false,
      backwards: options.backwards ?? false,
      reverseOutput: options.reverseOutput ?? false,
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    outputDir: options.outputDir,
    encodingTextPath,
    encodingBinaryPath,
    manifestPath,
    chosenEncoding: best.candidate.encoding,
    chosenCandidate: best.candidate,
    candidates: candidateEvaluations.map((entry) => entry.candidate),
    packedFiles,
    totalOriginalBytes,
    totalPayloadBytes: best.candidate.totalPayloadBytes,
    totalBytes: best.candidate.totalBytes,
  };
}

export async function packByteBoozer(options: {
  projectDir: string;
  inputPath: string;
  outputPath: string;
  executableStart?: number;
  relocateTo?: number;
  clipStartAddress?: boolean;
}): Promise<ExternalToolResult> {
  const binary = await resolveByteBoozerBinary();
  const tmpDir = await mkdtemp(join(tmpdir(), "c64re-b2-"));
  try {
    const stagedInput = join(tmpDir, basename(options.inputPath));
    await copyFile(options.inputPath, stagedInput);

    const args: string[] = [];
    if (options.clipStartAddress) {
      args.push("-b");
    } else if (options.executableStart !== undefined) {
      args.push("-c", options.executableStart.toString(16).padStart(4, "0"));
    } else if (options.relocateTo !== undefined) {
      args.push("-r", options.relocateTo.toString(16).padStart(4, "0"));
    }
    args.push(stagedInput);

    const result = await runExternalTool(binary, args, tmpDir);
    const defaultOutput = `${stagedInput}.b2`;
    if (result.exitCode === 0) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await rename(defaultOutput, options.outputPath);
    }
    return { tool: "byteboozer2", command: binary, args, outputPath: options.outputPath, ...result };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}
