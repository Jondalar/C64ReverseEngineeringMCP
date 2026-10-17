// Spec 914 D4 — the rebuild verdict, as the listing and its record keep it.
//
// The record is the truth: `ArtifactRecord.rebuild` is written by the proof that measured it.
// The stamp in the listing's head is information for a person reading the file; it is written in
// the comment syntax of the listing's own dialect and read back — in either syntax — only for a
// listing no proof has recorded on (a project from before the record existed).
//
// A leaf module on purpose: the project store reads verdicts, and the proof (which writes them)
// needs the store, so neither may import the other.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { commentMarker, type Dialect } from "./dialect.js";

/** A stamp line the proof wrote, in either dialect's syntax. */
const STAMP_LINE = /^(?:\/\/|;)\s*(?:rebuild verified byte-identical|WARNING: rebuild )/;

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The listing's current content hash, or undefined when it cannot be read. */
export function listingHash(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

export interface ReadVerdict {
  verified: boolean;
  /** Where the answer came from: the record, the stamp in the file, or nothing at all. */
  source: "record" | "stamp" | "none";
  line?: string;
  /** The record proved a listing that has been changed since. */
  changedSince?: boolean;
}

/** What a listing's record (and, failing that, the stamp in the file) says about its rebuild. */
export function rebuildVerdictOf(listing: { path: string; rebuild?: { verified: boolean; line: string; listingHash?: string } | undefined }): ReadVerdict {
  if (listing.rebuild) {
    const recorded = listing.rebuild;
    if (recorded.listingHash !== undefined) {
      const now = listingHash(listing.path);
      if (now !== undefined && now !== recorded.listingHash) {
        return { verified: false, source: "record", line: recorded.line, changedSince: true };
      }
    }
    return { verified: recorded.verified, source: "record", line: recorded.line };
  }
  try {
    const head = readFileSync(listing.path, "utf8").slice(0, 8192).split(/\r?\n/);
    const stamp = head.find((line) => STAMP_LINE.test(line));
    if (stamp) {
      return { verified: /^(?:\/\/|;)\s*rebuild verified byte-identical/.test(stamp), source: "stamp", line: stamp.replace(/^(?:\/\/|;)\s*/, "") };
    }
  } catch { /* an unreadable listing proves nothing */ }
  return { verified: false, source: "none" };
}

/**
 * Writes the verdict into the head of a listing, in its dialect's comment syntax, before the
 * closing banner of the header. A prior stamp is dropped so re-runs do not accumulate, and the
 * file keeps its own line endings.
 */
export function stampListing(text: string, dialect: Dialect, summary: string): string {
  const marker = commentMarker(dialect);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const banner = `${marker}****************`;
  const stamp = `${marker} ${summary}`;
  const header = lines.findIndex((line) => line.startsWith(banner));
  if (header < 0) return `${stamp}${eol}${text}`;
  const closing = lines.findIndex((line, index) => index > header && line.startsWith(banner));
  const insertAt = closing >= 0 ? closing : Math.min(lines.length, header + 1);
  const filtered = lines.filter((line) => !STAMP_LINE.test(line));
  // filtering can remove lines above the insertion point; recompute it against the filtered list
  const removedBefore = lines.slice(0, insertAt).filter((line) => STAMP_LINE.test(line)).length;
  filtered.splice(insertAt - removedBefore, 0, stamp);
  return filtered.join(eol);
}
