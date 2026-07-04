import type { ReadSetEntry } from "../runtime/headless/trace/loader-lens.js";
import type { LoaderManifest } from "./loader-manifest.js";

// Spec 784 B4 — the validation verdict (meaning → C64RE).
//
// Diff a per-project extractor's manifest against the loader-lens READ-SET (the ground
// truth the REAL loader produced: which physical (track, sector) the drive actually
// latched GCR bytes off, in read order — BLOCK_READ 0x35). A manifest span that claims a
// (track, sector) the loader never actually read → MISMATCH: the extractor's
// interpretation of the loader code is wrong (the Accolade/Wasteland bug class). A read
// block the manifest never claims → UNCLAIMED (extractor missed it). This is what makes a
// bulk-registered manifest trustworthy without a full-emulation bulk run.
//
// Spec 784 Option A: the read-set is DRIVE-SIDE truth (read_pra/GCR_read), so it is
// immune to the write-time buffering defect that made the old landing-map source lie
// (head parked on T35 while the transfer buffered → every span mis-attributed to T35).

export interface SpanMismatch {
  payload: string;
  track: number;
  sector: number;
  reason: string;
}

export interface UnclaimedRead {
  track: number;
  sector: number;
  /** GCR bytes the drive read off this block (read-set evidence). */
  bytes: number;
}

export interface ValidationResult {
  verdict: "pass" | "fail";
  matchedSpans: number;
  mismatched: SpanMismatch[];
  unclaimed: UnclaimedRead[];
  /** Cart (slot) spans are validated by Spec 785 (bank lane), not here. */
  skippedSlotSpans: number;
}

export function validateExtraction(readSet: ReadSetEntry[], manifest: LoaderManifest): ValidationResult {
  const readSources = new Set(readSet.map((e) => `${e.track}/${e.sector}`));
  const claimed = new Set<string>();
  const mismatched: SpanMismatch[] = [];
  let matchedSpans = 0;
  let skippedSlotSpans = 0;

  for (const p of manifest.payloads) {
    for (const span of p.spans) {
      if (span.kind !== "sector") {
        skippedSlotSpans++; // cart slot span → Spec 785
        continue;
      }
      const key = `${span.track}/${span.sector}`;
      claimed.add(key);
      if (readSources.has(key)) {
        matchedSpans++;
      } else {
        mismatched.push({
          payload: p.name,
          track: span.track,
          sector: span.sector,
          reason: "manifest span claims a sector the loader never read (per the read-set)",
        });
      }
    }
  }

  const seenUnclaimed = new Set<string>();
  const unclaimed: UnclaimedRead[] = [];
  for (const e of readSet) {
    const key = `${e.track}/${e.sector}`;
    if (claimed.has(key) || seenUnclaimed.has(key)) continue;
    seenUnclaimed.add(key);
    unclaimed.push({ track: e.track, sector: e.sector, bytes: e.bytes });
  }

  return {
    verdict: mismatched.length === 0 ? "pass" : "fail",
    matchedSpans,
    mismatched,
    unclaimed,
    skippedSlotSpans,
  };
}
