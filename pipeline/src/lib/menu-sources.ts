import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, writeJson } from "./fs-utils";
import { hex16, hex8 } from "./format";
import { decodeInstruction, DecodedInstruction } from "./mos6502";
import { L, type Dialect, type ListingLine, dialectName, emitListing, listingExtension } from "./listing";

interface ChunkInfo {
  menuDir: string;
  fileName: string;
  classification: string;
  startAddress: number;
  endAddress: number;
}

interface SourceManifestItem {
  input_bin: string;
  output_asm: string;
  classification: string;
  start_address: number;
  end_address: number;
}

function collectInternalLabels(instructions: DecodedInstruction[], startAddress: number, endAddress: number): Map<number, string> {
  const labels = new Map<number, string>();
  labels.set(startAddress, `entry_${hex16(startAddress)}`);

  for (const instruction of instructions) {
    if (instruction.targetAddress === undefined) {
      continue;
    }
    if (instruction.targetAddress < startAddress || instruction.targetAddress > endAddress) {
      continue;
    }

    const prefix = instruction.mnemonic === "jsr" ? "sub" : "loc";
    if (!labels.has(instruction.targetAddress)) {
      labels.set(instruction.targetAddress, `${prefix}_${hex16(instruction.targetAddress)}`);
    }
  }

  return labels;
}

function formatOperand(instruction: DecodedInstruction, labels: Map<number, string>): string {
  const operand = instruction.operand;
  const targetLabel = instruction.targetAddress !== undefined ? labels.get(instruction.targetAddress) : undefined;

  switch (instruction.mode) {
    case "impl":
      return "";
    case "acc":
      return "a";
    case "imm":
      return `#$${hex8(operand ?? 0)}`;
    case "zp":
      return `$${hex8(operand ?? 0)}`;
    case "zp,x":
      return `$${hex8(operand ?? 0)},x`;
    case "zp,y":
      return `$${hex8(operand ?? 0)},y`;
    case "abs":
      return targetLabel ?? `$${hex16(operand ?? 0)}`;
    case "abs,x":
      return `${targetLabel ?? `$${hex16(operand ?? 0)}`},x`;
    case "abs,y":
      return `${targetLabel ?? `$${hex16(operand ?? 0)}`},y`;
    case "ind":
      return `(${targetLabel ?? `$${hex16(operand ?? 0)}`})`;
    case "(zp,x)":
      return `($${hex8(operand ?? 0)},x)`;
    case "(zp),y":
      return `($${hex8(operand ?? 0)}),y`;
    case "rel":
      return targetLabel ?? `$${hex16(instruction.targetAddress ?? 0)}`;
  }
}

function bytesComment(bytes: number[]): string {
  return bytes.map((byte) => `$${hex8(byte)}`).join(", ");
}

function emitByteBlock(lines: ListingLine[], startAddress: number, bytes: number[]): void {
  if (bytes.length === 0) {
    return;
  }

  lines.push(L.comment(`undecoded bytes at $${hex16(startAddress)}`, 4));
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    lines.push(L.byte(row.map((byte) => `$${hex8(byte)}`).join(", ")));
  }
}

function sourceHeader(dialect: Dialect, notes: string[], title: string, address: number): ListingLine[] {
  return [
    L.comment(`Auto-generated ${dialectName(dialect)} source`),
    ...notes.map((note) => L.comment(note)),
    L.blank(),
    L.cpu(),
    L.origin(address, title),
    L.blank(),
  ];
}

function disassembleCodeChunk(data: Buffer, startAddress: number, endAddress: number, title: string, dialect: Dialect): string {
  const instructions: DecodedInstruction[] = [];
  let offset = 0;

  while (offset < data.length) {
    const instruction = decodeInstruction(data, offset, startAddress);
    instructions.push(instruction);
    offset += instruction.size;
  }

  const labels = collectInternalLabels(instructions, startAddress, endAddress);
  const lines: ListingLine[] = sourceHeader(
    dialect,
    [title, "Linear 6502 disassembly. Review tables/data manually inside code-classified regions."],
    title,
    startAddress,
  );
  let pendingUnknownStart: number | null = null;
  let pendingUnknownBytes: number[] = [];

  for (const instruction of instructions) {
    if (!instruction.isUnknown && pendingUnknownStart !== null) {
      emitByteBlock(lines, pendingUnknownStart, pendingUnknownBytes);
      pendingUnknownStart = null;
      pendingUnknownBytes = [];
    }

    const label = labels.get(instruction.address);
    if (label) {
      if (pendingUnknownStart !== null) {
        emitByteBlock(lines, pendingUnknownStart, pendingUnknownBytes);
        pendingUnknownStart = null;
        pendingUnknownBytes = [];
      }
      lines.push(L.label(label));
    }

    if (instruction.isUnknown) {
      if (pendingUnknownStart === null) {
        pendingUnknownStart = instruction.address;
      }
      pendingUnknownBytes.push(...instruction.bytes);
      continue;
    }

    lines.push(L.insn(instruction.mnemonic, formatOperand(instruction, labels) || undefined, false, bytesComment(instruction.bytes)));
  }

  if (pendingUnknownStart !== null) {
    emitByteBlock(lines, pendingUnknownStart, pendingUnknownBytes);
  }

  lines.push(L.blank());
  return emitListing(lines, dialect);
}

function dataRows(data: Buffer): ListingLine[] {
  const lines: ListingLine[] = [];
  for (let offset = 0; offset < data.length; offset += 16) {
    const row = Array.from(data.subarray(offset, Math.min(offset + 16, data.length)));
    lines.push(L.byte(row.map((byte) => `$${hex8(byte)}`).join(", ")));
  }
  return lines;
}

function textRows(data: Buffer): ListingLine[] {
  const rows: ListingLine[] = [];
  let offset = 0;

  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(offset + 32, data.length));
    const printable = Array.from(chunk).every((byte) => byte === 0 || (byte >= 32 && byte < 127));

    if (printable) {
      const text = Array.from(chunk)
        .filter((byte) => byte !== 0)
        .map((byte) => String.fromCharCode(byte))
        .join("")
        .replaceAll("\\", "\\\\")
        .replaceAll("\"", "\\\"");

      if (text.length > 0) {
        rows.push(L.text(text));
      }
    } else {
      rows.push(...dataRows(Buffer.from(chunk)));
    }
    offset += chunk.length;
  }

  return rows;
}

function dumpDataChunk(data: Buffer, startAddress: number, title: string, classification: string, dialect: Dialect): string {
  const body = classification === "text" ? textRows(data) : dataRows(data);
  const lines: ListingLine[] = [
    ...sourceHeader(dialect, [title, `Stored as data because classification is '${classification}'.`], title, startAddress),
    ...(body.some((line) => line.k === "text") ? [L.encoding()] : []),
    ...body,
    L.blank(),
  ];
  return emitListing(lines, dialect);
}

/** Writes one source per menu payload chunk, in one dialect, and an index beside them. */
export function emitMenuSources(analysisDir: string, outputDir: string, dialect: Dialect): void {
  const extension = listingExtension(dialect);
  const menuRoot = join(analysisDir, "menu_payload_exports");
  const workspaceRoot = dirname(analysisDir);
  ensureDir(outputDir);
  const manifest: { dialect: Dialect; files: SourceManifestItem[] } = { dialect, files: [] };
  const includeLines: ListingLine[] = [
    L.comment("Auto-generated include list for Sublime/editor browsing"),
    L.blank(),
  ];
  const menuExportManifest = JSON.parse(readFileSync(join(menuRoot, "manifest.json"), "utf8")) as {
    menu_items: Array<{
      label: string;
      files: Array<{
        type: string;
        file: string;
        classification?: string;
        destination_start?: number;
        destination_end?: number;
      }>;
    }>;
  };

  for (const menuDirName of readdirSync(menuRoot).sort()) {
    if (menuDirName === "manifest.json") continue;
    const menuDir = join(menuRoot, menuDirName);
    const outMenuDir = join(outputDir, menuDirName);
    ensureDir(outMenuDir);

    includeLines.push(L.comment(menuDirName));

    const menuEntry = menuExportManifest.menu_items.find((item) => item.files.some((file) => file.file.includes(`/${menuDirName}/`)));
    const chunkFiles = (menuEntry?.files ?? [])
      .filter((file) => file.type === "chunk" && file.classification && typeof file.destination_start === "number" && typeof file.destination_end === "number")
      .sort((left, right) => (left.destination_start ?? 0) - (right.destination_start ?? 0));

    for (const file of chunkFiles) {
      const fileName = file.file.split("/").pop();
      if (!fileName) continue;

      const classification = file.classification;
      const startAddress = file.destination_start;
      const endAddress = file.destination_end;
      if (!classification || startAddress === undefined || endAddress === undefined) {
        continue;
      }
      const inputPath = join(workspaceRoot, file.file);
      const outputName = fileName.replace(/\.bin$/i, extension);
      const outputPath = join(outMenuDir, outputName);
      const title = `${menuDirName}/${outputName}`;
      const data = readFileSync(inputPath);

      const source =
        classification === "code"
          ? disassembleCodeChunk(data, startAddress, endAddress, title, dialect)
          : dumpDataChunk(data, startAddress, title, classification, dialect);

      writeFileSync(outputPath, source, "utf8");

      manifest.files.push({
        input_bin: inputPath,
        output_asm: outputPath,
        classification,
        start_address: startAddress,
        end_address: endAddress,
      });
      includeLines.push(L.comment(dialect === "64tass" ? `.include "${menuDirName}/${outputName}"` : `.import source "${menuDirName}/${outputName}"`));
    }

    includeLines.push(L.blank());
  }

  writeFileSync(join(outputDir, `menu_payloads_index${extension}`), emitListing(includeLines, dialect), "utf8");
  writeJson(join(outputDir, "manifest.json"), manifest);
}
