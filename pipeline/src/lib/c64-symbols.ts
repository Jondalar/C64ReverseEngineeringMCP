// Spec 817. This file used to hold EXACT_COMMENTS — 68 hand-typed I/O register
// names that disagreed with three other tables in the repo ($D011 and $D016
// even shared one string). The names now come from resources/platform-kb.sqlite
// through ./platform-kb; what stays here is address arithmetic, not knowledge.

import { hex16 } from "./format";
import { isIoAddress, platformNode, platformRegionName, type PlatformTag } from "./platform-kb";

export interface C64IoMetadata {
  comment: string;
}

/** A register-level comment for an I/O address, or undefined. Only `io` kind
 * nodes answer here — ROM and zero page have their own comment shapes in the
 * renderer and must not be pre-empted by the generic operand comment. */
export function findC64IoMetadata(address: number, platform: PlatformTag = "c64"): C64IoMetadata | undefined {
  const hit = platformNode(platform, address);
  if (!hit && (platform === "vic20" || platform === "plus4") && isIoAddress(platform, address)) {
    // an I/O address with no row of its own but inside a named range (colour RAM): the range names it
    const region = platformRegionName(platform, address);
    return region ? { comment: region } : undefined;
  }
  if (!hit || hit.kind !== "io") {
    return undefined;
  }
  return { comment: hit.label };
}

/** True inside the platform's I/O window (the c64 default: $D000-$DFFF). */
export function isC64IoAddress(address: number, platform: PlatformTag = "c64"): boolean {
  return isIoAddress(platform, address);
}

export function formatC64IoAddress(address: number): string {
  return `$${hex16(address).toUpperCase()}`;
}
