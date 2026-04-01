import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeBinary, writeJson, toPosixRelative, ensureDir } from "./fs-utils";
import { hex16, slugify } from "./format";

export interface PayloadChunk {
  groupId: number;
  tableIndex: number;
  bank: number;
  endOfGroup: boolean;
  destinationStart: number;
  destinationEnd: number;
  size: number;
  chipFile: string;
}

export interface MenuPayloadMap {
  menu_items: Array<{
    menu_index: number;
    label: string;
    mode: number;
    payload_group: number;
  }>;
}

export function readRelocatedLoader(chipsDir: string): Buffer {
  const rom = readFileSync(join(chipsDir, "bank_00_8000.bin"));
  return rom.subarray(0x66, 0x166);
}

export function parseLutGroups(chipsDir: string): PayloadChunk[][] {
  const relocated = readRelocatedLoader(chipsDir);
  const bankTable = relocated.subarray(0xa9, 0xc3);
  const destTable = relocated.subarray(0xc3, 0xdd);

  const groups: PayloadChunk[][] = [];
  let current: PayloadChunk[] = [];
  let groupId = 0;

  for (let index = 0; index < Math.min(bankTable.length, destTable.length); index += 1) {
    const bankByte = bankTable[index];
    const bank = bankByte & 0x7f;
    const endOfGroup = (bankByte & 0x80) !== 0;
    const destinationStart = destTable[index] << 8;
    const size = destTable[index] === 0xe8 ? 0x1800 : 0x2000;
    const destinationEnd = destinationStart + size - 1;

    current.push({
      groupId,
      tableIndex: index,
      bank,
      endOfGroup,
      destinationStart,
      destinationEnd,
      size,
      chipFile: join(chipsDir, `bank_${bank.toString().padStart(2, "0")}_8000.bin`),
    });

    if (endOfGroup) {
      groups.push(current);
      current = [];
      groupId += 1;
    }
  }

  return groups;
}

export function reconstructBootPayloads(analysisDir: string): void {
  const chipsDir = join(analysisDir, "extracted", "chips");
  const groups = parseLutGroups(chipsDir);
  const payloads: Array<Record<string, unknown>> = [];
  const payloadDir = join(analysisDir, "payloads_from_boot");
  const fullDir = join(analysisDir, "full_lut_payloads");
  ensureDir(payloadDir);
  ensureDir(fullDir);

  for (const group of groups) {
    const fullData = Buffer.concat(group.map((chunk) => readFileSync(chunk.chipFile)));
    const fullPath = join(fullDir, `group_${group[0].groupId.toString().padStart(2, "0")}.bin`);
    writeBinary(fullPath, fullData);

    if (group[0].tableIndex < 9) {
      continue;
    }

    const payloadId = payloads.length;
    const outputPath = join(payloadDir, `payload_${payloadId.toString().padStart(2, "0")}.bin`);
    writeBinary(outputPath, fullData);

    payloads.push({
      payload_id: payloadId,
      start_address: group[0].destinationStart,
      total_size: group.reduce((sum, chunk) => sum + chunk.size, 0),
      chunks: group.map((chunk) => ({
        table_index: chunk.tableIndex,
        bank: chunk.bank,
        end_of_payload: chunk.endOfGroup,
        destination: chunk.destinationStart,
        size: chunk.size,
        chip_file: toPosixRelative(analysisDir, chunk.chipFile),
      })),
      output_file: toPosixRelative(analysisDir, outputPath),
    });
  }

  writeJson(join(analysisDir, "boot_payloads.json"), {
    source: "bank_00 startup loader LUT",
    notes: [
      "The startup code relocates a loader stub from ROM $8066-$8165 into RAM $0100-$01FF.",
      "Table $01A9 contains bank numbers; high bit marks the end of a logical payload.",
      "Table $01C3 contains destination high bytes used by the self-modifying copy routine at $016D."
    ],
    payloads,
  });
}

export function classifyChunk(data: Buffer): string {
  let asciiCount = 0;
  let zeroCount = 0;
  let ffCount = 0;
  let jsrCount = 0;
  let branchCount = 0;
  let d418Hits = 0;
  let d4xxHits = 0;
  const unique = new Set<number>();

  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    unique.add(byte);

    if (byte >= 32 && byte < 127) {
      asciiCount += 1;
    }
    if (byte === 0x00) {
      zeroCount += 1;
    }
    if (byte === 0xff) {
      ffCount += 1;
    }
    if (byte === 0x20) {
      jsrCount += 1;
    }
    if ([0x4c, 0x60, 0xd0, 0xf0, 0x10, 0x30, 0x90, 0xb0].includes(byte)) {
      branchCount += 1;
    }

    if (index + 2 < data.length && byte === 0x8d && data[index + 1] === 0x18 && data[index + 2] === 0xd4) {
      d418Hits += 1;
    }
    if (index + 2 < data.length && byte === 0x8d && data[index + 2] === 0xd4) {
      d4xxHits += 1;
    }
  }

  const asciiRatio = asciiCount / data.length;
  const zeroRatio = zeroCount / data.length;
  const ffRatio = ffCount / data.length;
  const uniqueRatio = unique.size / 256;
  const jsrRatio = jsrCount / data.length;
  const opcodeRatio = branchCount / data.length;

  if (asciiRatio > 0.45) {
    return "text";
  }
  if (d418Hits >= 2 || (d4xxHits >= 6 && asciiRatio < 0.15)) {
    return "music-or-sfx";
  }
  if (jsrRatio > 0.01 || opcodeRatio > 0.025) {
    return "code";
  }
  if (uniqueRatio < 0.25 || zeroRatio > 0.2 || ffRatio > 0.2) {
    return "gfx-or-leveldata";
  }
  return "unknown";
}

export function exportMenuPayloads(analysisDirInput: string): void {
  const analysisDir = resolve(analysisDirInput);
  const rootDir = dirname(analysisDir);
  const chipsDir = join(analysisDir, "extracted", "chips");
  const menuMap = JSON.parse(readFileSync(join(analysisDir, "menu_payload_map.json"), "utf8")) as MenuPayloadMap;
  const groups = parseLutGroups(chipsDir);
  const groupMap = new Map(groups.map((group) => [group[0].groupId, group]));
  const outDir = join(analysisDir, "menu_payload_exports");
  ensureDir(outDir);

  const manifest: { menu_items: Array<Record<string, unknown>> } = { menu_items: [] };

  for (const item of menuMap.menu_items) {
    const group = groupMap.get(item.payload_group);
    if (!group) {
      throw new Error(`Missing payload group ${item.payload_group} for menu item ${item.label}`);
    }

    const labelSlug = slugify(item.label);
    const menuDir = join(outDir, `${item.menu_index}-${labelSlug}`);
    ensureDir(menuDir);

    const fullData = Buffer.concat(group.map((chunk) => readFileSync(chunk.chipFile)));
    const fullPath = join(
      menuDir,
      `${item.menu_index}-0-${labelSlug}-full-group_${item.payload_group.toString().padStart(2, "0")}.bin`,
    );
    writeBinary(fullPath, fullData);

    const files: Array<Record<string, unknown>> = [
      {
        type: "full",
        file: toPosixRelative(rootDir, fullPath),
        group_id: item.payload_group,
        mode: item.mode,
      },
    ];

    group.forEach((chunk, chunkIndex) => {
      const data = readFileSync(chunk.chipFile);
      const classification = classifyChunk(data);
      const filename = `${item.menu_index}-${chunkIndex + 1}-${labelSlug}-${classification}_$${hex16(
        chunk.destinationStart,
      )}-$${hex16(chunk.destinationEnd)}.bin`;
      const outPath = join(menuDir, filename);
      writeBinary(outPath, data);

      files.push({
        type: "chunk",
        file: toPosixRelative(rootDir, outPath),
        classification,
        table_index: chunk.tableIndex,
        bank: chunk.bank,
        destination_start: chunk.destinationStart,
        destination_end: chunk.destinationEnd,
        mode: item.mode,
      });
    });

    manifest.menu_items.push({
      menu_index: item.menu_index,
      label: item.label,
      mode: item.mode,
      payload_group: item.payload_group,
      files,
    });
  }

  writeJson(join(outDir, "manifest.json"), manifest);
}
