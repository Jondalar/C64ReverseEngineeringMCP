// Spec 817 — ESM reader for resources/platform-kb.sqlite (the MCP half).
//
// The pipeline half has its own 60-line reader (pipeline/src/lib/platform-kb.ts)
// because the two compilation worlds cannot share a module. Two readers of ONE
// store is the intended shape: drift lives in data, and the data has one copy.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAddr4, formatHex4, platformNodeId, type PlatformNodeKind, type PlatformTag } from "./schema.js";
import { DatabaseSync } from "./sqlite-quiet.js";

export interface PlatformNode {
  id: string;
  platform: PlatformTag;
  kind: PlatformNodeKind;
  address: number;
  symbol: string | null;
  name: string;
  description: string | null;
  source: string;
}

export interface PlatformRegion {
  id: string;
  platform: PlatformTag;
  startAddress: number;
  endAddress: number;
  name: string;
  source: string;
}

export function defaultPlatformKbPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.C64RE_PLATFORM_KB,
    join(here, "..", "..", "resources", "platform-kb.sqlite"), // dist/platform-kb → repo root
    join(here, "..", "..", "..", "resources", "platform-kb.sqlite"),
    join(process.cwd(), "resources", "platform-kb.sqlite"),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  throw new Error(
    `platform-kb.sqlite not found (looked in ${candidates.join(", ")}). Run \`npm run build:platform-kb\` — the store is generated from resources/c64ref-rom-knowledge.json and needs no network.`,
  );
}

type NodeRecord = { id: string; platform: string; kind: string; address: number; symbol: string | null; name: string; description: string | null; source: string };
type RegionRecord = { id: string; platform: string; start_address: number; end_address: number; name: string; source: string };

export class PlatformKb {
  private readonly db: DatabaseSync;
  private readonly nodeByAddress;
  private readonly nodeById;
  private readonly regionAt;
  private readonly searchStmt;

  constructor(path = defaultPlatformKbPath()) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.nodeByAddress = this.db.prepare("SELECT * FROM platform_node WHERE platform = ? AND address = ?");
    this.nodeById = this.db.prepare("SELECT * FROM platform_node WHERE id = ?");
    this.regionAt = this.db.prepare(
      "SELECT * FROM platform_region WHERE platform = ? AND start_address <= ? AND end_address >= ? ORDER BY (end_address - start_address) ASC LIMIT 1",
    );
    this.searchStmt = this.db.prepare(
      "SELECT * FROM platform_node WHERE platform = ? AND (symbol LIKE ? OR name LIKE ?) ORDER BY (symbol = ?) DESC, address ASC LIMIT ?",
    );
  }

  node(platform: PlatformTag, address: number): PlatformNode | undefined {
    const row = this.nodeByAddress.get(platform, address & 0xffff) as NodeRecord | undefined;
    return row ? toNode(row) : undefined;
  }

  byId(id: string): PlatformNode | undefined {
    const row = this.nodeById.get(id) as NodeRecord | undefined;
    return row ? toNode(row) : undefined;
  }

  region(platform: PlatformTag, address: number): PlatformRegion | undefined {
    const a = address & 0xffff;
    const row = this.regionAt.get(platform, a, a) as RegionRecord | undefined;
    return row ? { id: row.id, platform: row.platform as PlatformTag, startAddress: row.start_address, endAddress: row.end_address, name: row.name, source: row.source } : undefined;
  }

  /** Symbol or name substring match; an exact symbol hit sorts first. */
  search(platform: PlatformTag, query: string, limit = 10): PlatformNode[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q}%`;
    return (this.searchStmt.all(platform, like, like, q.toUpperCase(), limit) as NodeRecord[]).map(toNode);
  }

  /** The derived id for an address on a platform, whether or not a row exists. */
  idFor(platform: PlatformTag, address: number): string {
    const n = this.node(platform, address);
    return n ? n.id : platformNodeId(platform, "ram", address);
  }

  /** `$D018` → "VMCSB VIC-II Chip Memory Control Register", or undefined. */
  label(platform: PlatformTag, address: number): string | undefined {
    const n = this.node(platform, address);
    if (!n) return undefined;
    return n.symbol ? `${n.symbol} ${n.name}` : n.name;
  }

  meta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.db.prepare("SELECT key, value FROM platform_meta").all() as Array<{ key: string; value: string }>) out[row.key] = row.value;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function toNode(row: NodeRecord): PlatformNode {
  return {
    id: row.id, platform: row.platform as PlatformTag, kind: row.kind as PlatformNodeKind,
    address: row.address, symbol: row.symbol, name: row.name, description: row.description, source: row.source,
  };
}

let shared: PlatformKb | undefined;

/** Process-wide read-only handle; opening is ~100 µs, so this is convenience, not a cache. */
export function platformKb(): PlatformKb {
  if (!shared) shared = new PlatformKb();
  return shared;
}

export { formatAddr4, formatHex4 };
