// Spec 877 D5 — the pipeline's one door to the name layers.
//
// The renderer must print the name the project holds for an address it references, and
// the three layers, their precedence and the ambiguity rule are already written once, in
// `src/symbols/` (Spec 804). The pipeline is CommonJS and that half is ESM, so instead of
// a second reader over graph.sqlite — which is exactly how two halves come to disagree
// about who is called what — this loads the BUILT ESM module. Node has resolved
// `require()` of an ESM module without a top-level await since 22.12; when it cannot, the
// listing loses its equates and says so, it never guesses a name.
//
// Absent = a named reason, never a silent fall-back: `reason` is what the renderer prints.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ListingEquate {
  address: number;
  name: string;
  origin: "user" | "build" | "derived";
  kind: string;
  payload: string | null;
}

export interface ListingEquateResult {
  equates: ListingEquate[];
  notes: string[];
}

export interface ListingEquateRequest {
  projectDir: string;
  space: "c64" | "drive8";
  addresses: number[];
  defined: Array<[string, number]>;
  definedElsewhere?: string[];
}

interface Bridge {
  equatesForListing(req: ListingEquateRequest): ListingEquateResult;
}

let loaded: { bridge: Bridge } | { reason: string } | undefined;

function bridge(): { bridge: Bridge } | { reason: string } {
  if (loaded !== undefined) return loaded;
  // dist/pipeline/lib/graph-equates.cjs → dist/symbols/listing-equates.js
  const modulePath = join(__dirname, "..", "..", "symbols", "listing-equates.js");
  if (!existsSync(modulePath)) {
    loaded = { reason: `the name layers are not built beside this pipeline (${modulePath})` };
    return loaded;
  }
  try {
    const mod = require(modulePath) as Bridge;
    if (typeof mod.equatesForListing !== "function") {
      loaded = { reason: `${modulePath} has no equatesForListing` };
      return loaded;
    }
    loaded = { bridge: mod };
  } catch (error) {
    loaded = { reason: `the name layers could not be loaded: ${(error as Error).message}` };
  }
  return loaded;
}

/**
 * The names the project holds for `addresses`, minus everything that cannot become an
 * equate. `defined` is what this listing already binds, so a graph name never quietly
 * takes a name the listing is using for something else.
 */
export function listingEquates(req: ListingEquateRequest): ListingEquateResult & { reason?: string } {
  const b = bridge();
  if ("reason" in b) return { equates: [], notes: [], reason: b.reason };
  try {
    return b.bridge.equatesForListing(req);
  } catch (error) {
    return { equates: [], notes: [], reason: `reading the name layers failed: ${(error as Error).message}` };
  }
}
