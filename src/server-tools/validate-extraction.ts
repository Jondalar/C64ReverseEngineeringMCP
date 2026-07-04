import type { LandingMapEntry } from "../runtime/headless/trace/loader-lens.js";
import type { LoaderManifest } from "./loader-manifest.js";

// Spec 784 B4 — the validation verdict (meaning → C64RE).
//
// Diff a per-project extractor's manifest against the loader-lens landing map (the
// ground truth the REAL loader produced). A manifest span that claims a (track,
// sector) the loader never actually read → MISMATCH: the extractor's interpretation
// of the loader code is wrong (the Accolade/Wasteland bug class). A landing the
// manifest never claims → UNCLAIMED (extractor missed it). This is what makes a
// bulk-registered manifest trustworthy without a full-emulation bulk run.

export interface SpanMismatch {
  payload: string;
  track: number;
  sector: number;
  reason: string;
}

export interface UnclaimedLanding {
  track: number;
  sector: number;
  c64Dest: number;
}

export interface ValidationResult {
  verdict: "pass" | "fail";
  matchedSpans: number;
  mismatched: SpanMismatch[];
  unclaimed: UnclaimedLanding[];
  /** Cart (slot) spans are validated by Spec 785 (bank lane), not here. */
  skippedSlotSpans: number;
}

export function validateExtraction(landingMap: LandingMapEntry[], manifest: LoaderManifest): ValidationResult {
  const landedSources = new Set(landingMap.map((e) => `${e.source.track}/${e.source.sector}`));
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
      if (landedSources.has(key)) {
        matchedSpans++;
      } else {
        mismatched.push({
          payload: p.name,
          track: span.track,
          sector: span.sector,
          reason: "manifest span claims a sector the loader never read (per the landing map)",
        });
      }
    }
  }

  const seenUnclaimed = new Set<string>();
  const unclaimed: UnclaimedLanding[] = [];
  for (const e of landingMap) {
    const key = `${e.source.track}/${e.source.sector}`;
    if (claimed.has(key) || seenUnclaimed.has(key)) continue;
    seenUnclaimed.add(key);
    unclaimed.push({ track: e.source.track, sector: e.source.sector, c64Dest: e.c64Dest });
  }

  return {
    verdict: mismatched.length === 0 ? "pass" : "fail",
    matchedSpans,
    mismatched,
    unclaimed,
    skippedSlotSpans,
  };
}
