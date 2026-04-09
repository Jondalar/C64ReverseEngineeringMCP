import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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
    for (;;) {
      if (reader.nextBit() === 0) {
        const literalLength = this.readLength(reader);
        for (let i = 0; i < literalLength; i++) {
          output.push(reader.readByte());
        }
        if (literalLength === 0xff) {
          continue;
        }
      } else {
        const storedLength = this.readLength(reader);
        if (storedLength === 0xff) {
          break;
        }
        this.copyMatch(reader, output, storedLength);
      }

      const storedLength = this.readLength(reader);
      if (storedLength === 0xff) {
        break;
      }
      this.copyMatch(reader, output, storedLength);
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

  if (basic?.sysTarget !== undefined) {
    suggestions.push({
      format: "loader_wrapper",
      confidence: 0.6,
      reason: `PRG starts with a BASIC SYS wrapper to ${basic.sysTarget}; the whole file is likely an executable loader wrapper, not a raw compressed stream.`,
      offset,
      length: data.length,
      notes: [
        "Try runtime tracing or breakpoint-driven capture on the loader path.",
        "If payload data is embedded later in the PRG, retry detection on a sliced offset instead of the whole file.",
      ],
    });
  }

  try {
    const exoSfxSuggestion = await withTempSlice(data, async (tempPath, tempDir) => {
      const outputPath = join(tempDir, "slice.desfx.prg");
      const result = await depackExomizerSfx({
        projectDir: tempDir,
        inputPath: tempPath,
        outputPath,
      });
      if (result.exitCode !== 0) {
        return undefined;
      }
      const unpacked = await readBinaryFile(outputPath);
      return {
        format: "exomizer_sfx" as const,
        confidence: basic ? 0.93 : 0.85,
        reason: "Exomizer self-extracting wrapper decrunch succeeded structurally.",
        offset,
        length: data.length,
        unpackedSize: unpacked.length,
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
    const exoSuggestion = await withTempSlice(data, async (tempPath, tempDir) => {
      const outputPath = join(tempDir, "slice.dec");
      const result = await depackExomizerRaw({
        projectDir: tempDir,
        inputPath: tempPath,
        outputPath,
      });
      if (result.exitCode !== 0) {
        return undefined;
      }
      const unpacked = await readBinaryFile(outputPath);
      const ratio = unpacked.length / Math.max(1, data.length);
      let confidence = 0.65;
      if (ratio > 16) confidence = 0.1;
      else if (ratio > 8) confidence = 0.3;
      if (basic) confidence = Math.min(confidence, 0.15);
      return {
        format: "exomizer_raw" as const,
        confidence,
        reason: "Exomizer raw decrunch succeeded structurally.",
        offset,
        length: data.length,
        unpackedSize: unpacked.length,
        notes: [`Expansion ratio: ${ratio.toFixed(2)}x`],
      };
    });
    if (exoSuggestion) {
      suggestions.push(exoSuggestion);
    }
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
  format: "loader_wrapper" | "rle" | "exomizer_raw" | "exomizer_sfx" | "byteboozer2_executable" | "byteboozer2_raw" | "byteboozer2_maybe" | "unknown";
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

async function resolveExomizerBinary(): Promise<string> {
  return await resolveExecutable([
    process.env.C64RE_EXOMIZER_BIN ?? "",
    "exomizer",
    resolve(repoRoot(), "..", "exomizer", "src", "exomizer"),
  ].filter(Boolean));
}

async function resolveByteBoozerBinary(): Promise<string> {
  return await resolveExecutable([
    process.env.C64RE_BYTEBOOZER_BIN ?? "",
    "b2",
    resolve(repoRoot(), "..", "ByteBoozer2", "b2", "b2"),
  ].filter(Boolean));
}

export async function packExomizerRaw(options: {
  projectDir: string;
  inputPath: string;
  outputPath: string;
  backwards?: boolean;
  reverseOutput?: boolean;
  noEncodingHeader?: boolean;
}): Promise<ExternalToolResult> {
  const binary = await resolveExomizerBinary();
  const args = ["raw"];
  if (options.backwards) args.push("-b");
  if (options.reverseOutput) args.push("-r");
  if (options.noEncodingHeader) args.push("-E");
  args.push("-o", options.outputPath, options.inputPath);
  const result = await runExternalTool(binary, args, options.projectDir);
  return { tool: "exomizer", command: binary, args, outputPath: options.outputPath, ...result };
}

export async function depackExomizerRaw(options: {
  projectDir: string;
  inputPath: string;
  outputPath: string;
  backwards?: boolean;
  reverseOutput?: boolean;
}): Promise<ExternalToolResult> {
  const binary = await resolveExomizerBinary();
  const args = ["raw", "-d"];
  if (options.backwards) args.push("-b");
  if (options.reverseOutput) args.push("-r");
  args.push("-o", options.outputPath, options.inputPath);
  const result = await runExternalTool(binary, args, options.projectDir);
  return { tool: "exomizer", command: binary, args, outputPath: options.outputPath, ...result };
}

export async function depackExomizerSfx(options: {
  projectDir: string;
  inputPath: string;
  outputPath: string;
  entryAddress?: number | "load";
}): Promise<ExternalToolResult> {
  const binary = await resolveExomizerBinary();
  const args = ["desfx"];
  if (options.entryAddress !== undefined) {
    args.push("-e", options.entryAddress === "load" ? "load" : options.entryAddress.toString(16));
  }
  args.push("-o", options.outputPath, options.inputPath);
  const result = await runExternalTool(binary, args, options.projectDir);
  return { tool: "exomizer", command: binary, args, outputPath: options.outputPath, ...result };
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
