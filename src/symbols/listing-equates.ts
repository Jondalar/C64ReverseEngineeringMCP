// Spec 877 D5 — the names a listing may equate, decided once, in the layer that owns
// names.
//
// The measured defect: a listing prints `lda $F2A3` while the graph has held
// `game_state` for $F2A3 all along, so a session greps the rendered text for the address
// instead of the name. The fix is an equate at the head of the listing for every name the
// graph holds for an address OUTSIDE the rendered image that the listing references — the
// name then sits where the session is already looking, and the bytes do not move.
//
// The renderer lives in the CommonJS pipeline and this is the ESM half, so the pipeline
// reaches it through one `require()` of the built file (pipeline/src/lib/graph-equates.ts).
// Everything that decides WHICH name — the three layers, the precedence, the ambiguity
// rule, the project's name-length limit — stays here, next to the resolver, because that
// is where it is already written down once.

import { maxLabelLength } from "../project-knowledge/naming.js";
import { SymbolResolver } from "./resolver.js";
import type { NameOrigin, RuntimeSpace } from "./types.js";

/** A name a listing can define without changing a byte. */
export interface ListingEquate {
  address: number;
  name: string;
  origin: NameOrigin;
  kind: string;
  /** the payload the name belongs to, for the reader — `null` for an address name */
  payload: string | null;
}

export interface ListingEquateRequest {
  projectDir: string;
  space: RuntimeSpace;
  /** the addresses this listing references and does not itself define */
  addresses: number[];
  /** the names this listing already defines, and at which address */
  defined: Array<[string, number]>;
  /**
   * Names the rendered text defines at an address this side cannot pin — a label
   * inside a `.pseudopc` block is the case that matters. The name is already in the
   * listing, which is all D5 asks for, so it is skipped without a word: a second
   * definition would be a duplicate symbol and the rebuild would stop.
   */
  definedElsewhere?: string[];
}

export interface ListingEquateResult {
  equates: ListingEquate[];
  /**
   * Why a name the graph holds did NOT become an equate. A name that loses must say so
   * in the listing — silence here is how a session concludes the graph knows nothing.
   */
  notes: string[];
  /** names read out of the graph, whether or not they were emitted */
  considered: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// A name that is a mnemonic or an index register would be read as one by the assembler
// on the very line that uses it. Rejected, not mangled: renaming behind the human's back
// is how a listing comes to disagree with the graph.
const RESERVED = new Set([
  "a", "x", "y",
  "adc", "and", "asl", "bcc", "bcs", "beq", "bit", "bmi", "bne", "bpl", "brk", "bvc", "bvs",
  "clc", "cld", "cli", "clv", "cmp", "cpx", "cpy", "dec", "dex", "dey", "eor", "inc", "inx",
  "iny", "jmp", "jsr", "lda", "ldx", "ldy", "lsr", "nop", "ora", "pha", "php", "pla", "plp",
  "rol", "ror", "rti", "rts", "sbc", "sec", "sed", "sei", "sta", "stx", "sty", "tax", "tay",
  "tsx", "txa", "txs", "tya",
  // the undocumented set the renderer can emit
  "ahx", "alr", "anc", "arr", "axs", "dcp", "isc", "las", "lax", "rla", "rra", "sax", "shx",
  "shy", "slo", "sre", "tas", "xaa",
]);

const hex4 = (n: number): string => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The equates for one listing. Pure over (graph, request): no file is written and nothing
 * is stored — the graph and the symbol files stay the only stores.
 */
export function equatesForListing(req: ListingEquateRequest): ListingEquateResult {
  const resolver = SymbolResolver.forProject(req.projectDir);
  const out: ListingEquateResult = { equates: [], notes: [], considered: 0 };
  if (resolver.size === 0) return out;

  const limit = maxLabelLength(req.projectDir);
  // name → the address the listing already binds it to; an emitted equate joins it, so a
  // second address wanting the same name loses to the first and says so.
  const taken = new Map<string, number>(req.defined);
  const elsewhere = new Set(req.definedElsewhere ?? []);

  for (const address of [...new Set(req.addresses.map((a) => a & 0xffff))].sort((l, r) => l - r)) {
    const resolution = resolver.staticNameAt(req.space, address);
    if (resolution.ambiguous && resolution.ambiguous.length > 0) {
      out.considered += 1;
      out.notes.push(
        `${hex4(address)} has ${resolution.ambiguous.length} names in the graph `
        + `(${resolution.ambiguous.map((a) => a.name).join(", ")}) — no equate, none of them is THE name`,
      );
      continue;
    }
    const name = resolution.name;
    if (!name) continue;
    out.considered += 1;

    if (!IDENTIFIER.test(name.name)) {
      out.notes.push(`${hex4(address)} is "${name.name}" in the graph — not an assembler identifier, no equate`);
      continue;
    }
    if (RESERVED.has(name.name.toLowerCase())) {
      out.notes.push(`${hex4(address)} is "${name.name}" in the graph — a 6502 mnemonic or index register, no equate`);
      continue;
    }
    if (limit !== undefined && name.name.length > limit) {
      out.notes.push(
        `${hex4(address)} is "${name.name}" in the graph — ${name.name.length} characters, `
        + `over this project's limit of ${limit}, no equate`,
      );
      continue;
    }
    const at = taken.get(name.name);
    if (at === address) continue; // the listing already defines it, at the same address
    if (at === undefined && elsewhere.has(name.name)) continue; // already in the text
    if (at !== undefined) {
      out.notes.push(
        `${hex4(address)} is "${name.name}" in the graph, but this listing already uses `
        + `${name.name} for ${hex4(at)} — no equate`,
      );
      continue;
    }

    taken.set(name.name, address);
    out.equates.push({ address, name: name.name, origin: name.origin, kind: name.kind, payload: name.payload });
  }
  return out;
}
