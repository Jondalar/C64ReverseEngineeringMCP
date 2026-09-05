// Spec 817 — the platform knowledge base: ONE store, both compilation halves.
//
// "What is at $D018" used to be answered in four hand-typed tables that
// disagreed (817 §1). They existed because the ESM MCP half and the CommonJS
// pipeline half cannot import each other's modules, so the table was copied
// and the copies drifted. A SQLite file is readable from both worlds; a
// TypeScript module is not. This file is the schema, the id grammar and the
// address→kind rule — the three things every reader and the seeder must agree
// on, kept in exactly one place. It has no runtime dependency on node:sqlite so
// it can be imported anywhere.

export const PLATFORM_KB_SCHEMA_VERSION = 1;

export type PlatformTag = "c64" | "c1541";
export type PlatformNodeKind = "zp" | "ram" | "io" | "rom";

export interface PlatformNodeRow {
  id: string;
  platform: PlatformTag;
  kind: PlatformNodeKind;
  address: number;
  symbol: string | null;
  name: string;
  description: string | null;
  source: string;
  layer: "generated";
  origin: "imported";
  confidence: "certain";
}

export interface PlatformRegionRow {
  id: string;
  platform: PlatformTag;
  startAddress: number;
  endAddress: number;
  name: string;
  source: string;
}

export function formatHex4(address: number): string {
  return `$${(address & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The id is DERIVED from what the row is, never assigned (817 D3). Re-seeding
 * therefore lands on the same id, and two rows for one address cannot exist.
 *
 *   c64/io/$D018     c64/rom/$FFD2     c64/zp/$0001     c1541/io/$1800
 */
export function platformNodeId(platform: PlatformTag, kind: PlatformNodeKind, address: number): string {
  return `${platform}/${kind}/${formatHex4(address)}`;
}

/** `c64/region/$D000-$D02E` */
export function platformRegionId(platform: PlatformTag, startAddress: number, endAddress: number): string {
  return `${platform}/region/${formatHex4(startAddress)}-${formatHex4(endAddress)}`;
}

/**
 * Kind is a function of the address on the platform's memory map — it is not
 * stored knowledge and nobody gets to override it, which is what makes the id
 * derivable from the address alone.
 */
export function platformKindForAddress(platform: PlatformTag, address: number): PlatformNodeKind {
  const a = address & 0xffff;
  if (a < 0x0100) return "zp";
  if (platform === "c1541") {
    if (a >= 0x1800 && a <= 0x1c0f) return "io";
    if (a >= 0xc000) return "rom";
    return "ram";
  }
  if (a >= 0xd000 && a <= 0xdfff) return "io";
  if ((a >= 0xa000 && a <= 0xbfff) || a >= 0xe000) return "rom";
  return "ram";
}

export const PLATFORM_KB_DDL = `
CREATE TABLE platform_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE platform_node (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  address     INTEGER NOT NULL,
  symbol      TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  source      TEXT NOT NULL,
  layer       TEXT NOT NULL DEFAULT 'generated',
  origin      TEXT NOT NULL DEFAULT 'imported',
  confidence  TEXT NOT NULL DEFAULT 'certain',
  UNIQUE (platform, kind, address)
);
CREATE INDEX platform_node_addr ON platform_node (platform, address);
CREATE INDEX platform_node_symbol ON platform_node (platform, symbol);
CREATE TABLE platform_region (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  start_address INTEGER NOT NULL,
  end_address   INTEGER NOT NULL,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL
);
CREATE INDEX platform_region_span ON platform_region (platform, start_address, end_address);
`;
