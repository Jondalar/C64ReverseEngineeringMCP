export type XRefType =
  | "read"
  | "write"
  | "call"
  | "jump"
  | "branch"
  | "pointer"
  | "compare"
  | "modify"
  | "bit-test";

export interface Patch {
  address: number;
  value: number;
}

export interface RelocationRange {
  fromStart: number;
  fromEnd: number;
  toStart: number;
  toEnd: number;
}

export interface XRef {
  sourceAddress: number;
  targetAddress: number;
  type: XRefType;
  instruction: string;
  context?: string;
}

export interface LogicalPayloadChunk {
  groupId: number;
  tableIndex: number;
  bank: number;
  destinationStart: number;
  destinationEnd: number;
  size: number;
  chipPath: string;
}

export interface MenuPayloadItem {
  menuIndex: number;
  label: string;
  mode: number;
  payloadGroup: number;
}

export interface ReverseEngineeringProject {
  name: string;
  crtPath: string;
  extractedManifestPath: string;
  payloadMapPath?: string;
  patches: Patch[];
  relocations: RelocationRange[];
  xrefs: XRef[];
}

export function isValidPatch(patch: Patch): boolean {
  return (
    Number.isInteger(patch.address) &&
    Number.isInteger(patch.value) &&
    patch.address >= 0 &&
    patch.address <= 0xffff &&
    patch.value >= 0 &&
    patch.value <= 0xff
  );
}

export function isValidRelocation(range: RelocationRange): boolean {
  if (
    !Number.isInteger(range.fromStart) ||
    !Number.isInteger(range.fromEnd) ||
    !Number.isInteger(range.toStart) ||
    !Number.isInteger(range.toEnd)
  ) {
    return false;
  }

  if (range.fromEnd < range.fromStart || range.toEnd < range.toStart) {
    return false;
  }

  if (range.fromEnd - range.fromStart !== range.toEnd - range.toStart) {
    return false;
  }

  return (
    range.fromStart >= 0 &&
    range.fromEnd <= 0xffff &&
    range.toStart >= 0 &&
    range.toEnd <= 0xffff
  );
}
