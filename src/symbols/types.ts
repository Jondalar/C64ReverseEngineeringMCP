// Spec 804 — names are joined in C64RE. The shared vocabulary of the resolver.
//
// TRX64 is a runtime: it delivers bytes and says where it printed an address. C64RE
// owns meaning, so every name a person or an LLM sees next to a runtime address is
// decided here — from the graph, the build's symbol files and the bytes in memory.

/** The CPU an address belongs to, as the runtime names it. */
export type RuntimeSpace = "c64" | "drive8";

/** Where a name came from. The precedence is the order of this list. */
export type NameOrigin = "user" | "build" | "derived";

export const ORIGIN_TAG: Readonly<Record<NameOrigin, string>> = { user: "[u]", build: "[b]", derived: "[?]" };
export const ORIGIN_RANK: Readonly<Record<NameOrigin, number>> = { user: 0, build: 1, derived: 2 };

/**
 * Which bytes decide whether a name's payload is in memory right now.
 *  - `analysis` — a graph owner; its code bytes come from `<owner>_analysis.json`.
 *  - `crt`      — a cartridge bank; the code bytes of every analysis seeded into it.
 *  - `prg`      — a build output nothing has analysed; its own bytes.
 */
export type PayloadRef =
  | { kind: "analysis"; owner: string }
  | { kind: "crt"; bank: number }
  | { kind: "prg"; path: string };

export function payloadKey(ref: PayloadRef): string {
  switch (ref.kind) {
    case "analysis": return `analysis:${ref.owner}`;
    case "crt": return `crt:${ref.bank}`;
    case "prg": return `prg:${ref.path}`;
  }
}

export function payloadLabel(ref: PayloadRef | null): string | null {
  if (!ref) return null;
  switch (ref.kind) {
    case "analysis": return ref.owner;
    case "crt": return `crt bank ${ref.bank}`;
    case "prg": return ref.path;
  }
}

/** One name the resolver knows. `payload: null` names the ADDRESS, whoever is there. */
export interface NameEntry {
  name: string;
  origin: NameOrigin;
  space: RuntimeSpace;
  address: number;
  /** a named range (a routine's extent, a data block, a segment); null = a point */
  endAddress: number | null;
  /** routine | label | segment | data_block | addr | symbol */
  kind: string;
  /** what a named range holds: `code` (a routine's extent, a code segment) or `data` */
  range: "code" | "data" | null;
  payload: PayloadRef | null;
  /** the cartridge bank a `crt` name lives in */
  bank: number | null;
  /** the graph node or the symbol file the name came from */
  source: string;
}

/** The banking state the runtime reports with every monitor reply (Spec 804 §3.2). */
export interface MachineState {
  device: RuntimeSpace;
  cpuPortDirection?: number;
  cpuPortValue?: number;
  exrom?: number;
  game?: number;
  cartBank: number | null;
}

/** Reads bytes for the residency check. A missing key means "not known". */
export interface ByteSource {
  read(space: RuntimeSpace, lens: string | undefined, addrs: number[]): Promise<Map<number, number>>;
}

/** What one address resolved to. */
export interface ResolvedName {
  name: string;
  origin: NameOrigin;
  tag: string;
  kind: string;
  /** where the name itself sits */
  address: number;
  /** the queried address minus `address` — 0 for an exact hit, >0 inside a named range */
  offset: number;
  payload: string | null;
}

export interface ResidencyEvidence {
  payload: string;
  resident: boolean;
  /** code bytes compared, and how many matched */
  compared: number;
  matched: number;
  reason?: string;
}

export interface Resolution {
  space: RuntimeSpace;
  addr: number;
  /** the one name shown, when there is exactly one */
  name?: ResolvedName;
  /** several resident candidates with different names in the winning layer: no name */
  ambiguous?: Array<{ name: string; origin: NameOrigin; payload: string | null }>;
  /** names inside a range request (a dump row) — offset from `addr` */
  inside?: ResolvedName[];
  evidence: ResidencyEvidence[];
}

export interface ResolveRequest {
  space: RuntimeSpace;
  addr: number;
  lens?: string;
  /** a range request (a dump row): names anywhere in [addr, addr+len) */
  len?: number;
  /**
   * Which named RANGES may name an address inside them (`name+$off`). `data` (the
   * default — a listing): tables and data segments only, so a disassembly does not carry
   * its routine's name on every line. `all`: routines and code segments too (a single
   * address asked about on purpose, `runtime_resolve_pc`).
   */
  containment?: "data" | "all";
}

export function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, "0");
}
