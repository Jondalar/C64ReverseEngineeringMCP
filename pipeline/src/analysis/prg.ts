import { readFileSync } from "node:fs";
import { MemoryMapping, EntryPoint } from "./types";

export interface LoadedPrg {
  buffer: Buffer;
  mapping: MemoryMapping;
}

// Bug 19 (BUGREPORT): analyze_prg used to accept any file and
// reinterpret the first two bytes as a PRG load address, producing
// garbage analysis (and overflow-rejected schemas via Bug 18) for
// JSON / text / oversized blobs that auto-pipelines mistakenly
// fed in. Validate input shape before reading anything.
function validatePrgInput(file: Buffer, prgPath: string): void {
  if (file.length < 3) {
    throw new Error(`PRG too small: ${prgPath} is ${file.length} bytes; need at least 3 (2-byte header + body).`);
  }
  // 2-byte header + max 64 KB body = 65538 bytes total.
  if (file.length > 65538) {
    throw new Error(
      `Not a PRG: ${prgPath} is ${file.length} bytes, exceeds the 65538-byte PRG limit. ` +
      `If this is a raw blob with a known load address, use analyze_raw / --load-address instead.`,
    );
  }
  const load = file[0]! | (file[1]! << 8);
  const end = load + (file.length - 2) - 1;
  if (end > 0xffff) {
    throw new Error(
      `Not a PRG: ${prgPath} load=$${load.toString(16).padStart(4, "0").toUpperCase()} + body=${file.length - 2} bytes overflows the 16-bit address space ` +
      `(end=$${end.toString(16).toUpperCase()}). Use analyze_raw with an explicit load address if this is a cart or other non-CPU-mapped blob.`,
    );
  }
  // Soft warning if the first body byte is printable-ASCII brace /
  // bracket / quote — strong hint the file is actually JSON or text.
  const firstBody = file[2];
  if (firstBody !== undefined && [0x7b, 0x5b, 0x22].includes(firstBody)) {
    process.stderr.write(
      `[c64re analyze_prg] WARNING: ${prgPath} body starts with 0x${firstBody.toString(16)} ('${String.fromCharCode(firstBody)}') — looks like JSON/text. Continuing anyway, but the analysis will likely be garbage.\n`,
    );
  }
}

export function loadPrg(prgPath: string): LoadedPrg {
  const file = readFileSync(prgPath);
  validatePrgInput(file, prgPath);

  const loadAddress = file.readUInt16LE(0);
  const buffer = file.subarray(2);
  const mapping: MemoryMapping = {
    format: "prg",
    loadAddress,
    startAddress: loadAddress,
    endAddress: loadAddress + buffer.length - 1,
    fileOffset: 0,
    fileSize: buffer.length,
  };

  return { buffer, mapping };
}

export function loadRaw(rawPath: string, loadAddress: number): LoadedPrg {
  const file = readFileSync(rawPath);
  if (file.length === 0) {
    throw new Error(`Raw blob empty: ${rawPath}`);
  }
  if (loadAddress < 0 || loadAddress > 0xffff) {
    throw new Error(`Invalid load address $${loadAddress.toString(16)} for raw blob ${rawPath}`);
  }
  const buffer = Buffer.from(file);
  const mapping: MemoryMapping = {
    format: "prg",
    loadAddress,
    startAddress: loadAddress,
    endAddress: Math.min(0xffff, loadAddress + buffer.length - 1),
    fileOffset: 0,
    fileSize: buffer.length,
  };
  return { buffer, mapping };
}

export function detectBasicSysEntry(buffer: Buffer, mapping: MemoryMapping): EntryPoint[] {
  if (mapping.startAddress > 0x0801 || buffer.length < 12) {
    return [];
  }

  const sysToken = 0x9e;
  const tokenIndex = buffer.indexOf(sysToken, 0);
  if (tokenIndex === -1 || tokenIndex > 24) {
    return [];
  }

  let cursor = tokenIndex + 1;
  let digits = "";
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    if (byte >= 0x30 && byte <= 0x39) {
      digits += String.fromCharCode(byte);
      cursor += 1;
      continue;
    }
    if (byte === 0x20) {
      cursor += 1;
      continue;
    }
    break;
  }

  if (digits.length === 0) {
    return [];
  }

  const address = Number.parseInt(digits, 10);
  if (Number.isNaN(address) || address < mapping.startAddress || address > mapping.endAddress) {
    return [];
  }

  return [
    {
      address,
      source: "basic_sys",
      reason: `Detected BASIC SYS stub with target ${digits}.`,
      symbol: "basicSysEntry",
    },
  ];
}

interface VectorPair {
  low: number;
  high: number;
  label: string;
}

const VECTOR_PAIRS: VectorPair[] = [
  { low: 0x0314, high: 0x0315, label: "irq_vector_ram" },
  { low: 0x0316, high: 0x0317, label: "brk_vector_ram" },
  { low: 0x0318, high: 0x0319, label: "nmi_vector_ram" },
  { low: 0xfffa, high: 0xfffb, label: "nmi_vector_rom" },
  { low: 0xfffc, high: 0xfffd, label: "reset_vector_rom" },
  { low: 0xfffe, high: 0xffff, label: "irq_brk_vector_rom" },
];

function toAddress(offset: number, mapping: MemoryMapping): number {
  return mapping.startAddress + offset;
}

function mappedByte(address: number, buffer: Buffer, mapping: MemoryMapping): number | undefined {
  if (address < mapping.startAddress || address > mapping.endAddress) {
    return undefined;
  }
  return buffer[address - mapping.startAddress];
}

export function detectVectorEntries(buffer: Buffer, mapping: MemoryMapping): EntryPoint[] {
  const entries: EntryPoint[] = [];

  for (let offset = 0; offset <= buffer.length - 10; offset += 1) {
    const opcode = buffer[offset];
    if (opcode !== 0xa9) {
      continue;
    }

    for (const pair of VECTOR_PAIRS) {
      const lowStoreMatches =
        buffer[offset + 2] === 0x8d &&
        buffer[offset + 3] === (pair.low & 0xff) &&
        buffer[offset + 4] === (pair.low >> 8);
      const highStoreMatches =
        buffer[offset + 5] === 0xa9 &&
        buffer[offset + 7] === 0x8d &&
        buffer[offset + 8] === (pair.high & 0xff) &&
        buffer[offset + 9] === (pair.high >> 8);

      if (!lowStoreMatches || !highStoreMatches) {
        continue;
      }

      const target = buffer[offset + 1] | (buffer[offset + 6] << 8);
      if (target < mapping.startAddress || target > mapping.endAddress) {
        continue;
      }

      entries.push({
        address: target,
        source: "vector",
        reason: `Detected ${pair.label} setup to $${target.toString(16).toUpperCase().padStart(4, "0")}.`,
        symbol: pair.label,
      });
    }
  }

  for (const pair of VECTOR_PAIRS) {
    const low = mappedByte(pair.low, buffer, mapping);
    const high = mappedByte(pair.high, buffer, mapping);
    if (low === undefined || high === undefined) {
      continue;
    }

    const target = low | (high << 8);
    if (target < mapping.startAddress || target > mapping.endAddress) {
      continue;
    }

    entries.push({
      address: target,
      source: "vector",
      reason: `Detected inline ${pair.label} value pointing to $${target.toString(16).toUpperCase().padStart(4, "0")}.`,
      symbol: `${pair.label}_target`,
    });
  }

  return entries;
}

export function deriveEntryPoints(mapping: MemoryMapping, buffer: Buffer, userEntryPoints: number[] = []): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];

  for (const address of userEntryPoints) {
    if (address >= mapping.startAddress && address <= mapping.endAddress) {
      entryPoints.push({
        address,
        source: "user",
        reason: "User-specified entry point.",
      });
    }
  }

  entryPoints.push(...detectBasicSysEntry(buffer, mapping));
  entryPoints.push(...detectVectorEntries(buffer, mapping));

  if (entryPoints.length === 0) {
    const firstOpcode = buffer[0];
    if (firstOpcode !== 0x00) {
      entryPoints.push({
        address: mapping.startAddress,
        source: "prg_header",
        reason: "Falling back to PRG load address as probable entry point.",
      });
    }
  }

  return dedupeEntryPoints(entryPoints);
}

function dedupeEntryPoints(entryPoints: EntryPoint[]): EntryPoint[] {
  const seen = new Set<number>();
  const unique: EntryPoint[] = [];

  for (const entryPoint of entryPoints) {
    if (seen.has(entryPoint.address)) {
      continue;
    }
    seen.add(entryPoint.address);
    unique.push(entryPoint);
  }

  return unique.sort((left, right) => left.address - right.address);
}
