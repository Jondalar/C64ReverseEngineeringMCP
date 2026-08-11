import { cartBankUsage, type CartBankUsage, type CartReadSetEntry, type ReadSetEntry } from "../runtime/headless/trace/loader-lens.js";
import type { LoaderManifest } from "./loader-manifest.js";

// Spec 784 B4 + Spec 785 C2/C3 — the validation verdict (meaning → C64RE).
//
// Diff a per-project extractor's manifest against the loader-lens READ-SET (the ground
// truth the REAL loader produced), one branch per medium, both below the same call:
//
//   DISK — BLOCK_READ 0x35: which physical (track, sector) the drive actually latched
//   GCR bytes off, in read order. A manifest span that claims a (track, sector) the
//   loader never actually read → MISMATCH: the extractor's interpretation of the loader
//   code is wrong (the Accolade/Wasteland bug class). A read block the manifest never
//   claims → UNCLAIMED (extractor missed it). Drive-side truth (read_pra/GCR_read), so
//   it is immune to the write-time buffering defect that made the old landing-map source
//   lie (head parked on T35 while the transfer buffered → every span mis-attributed).
//
//   CART — CART_READ 0x36 (Spec 785 C1): which bank served which window, and over which
//   offsets, while the CPU read out of it. Chip-side truth at the read.
//
// **WHAT THE CART BRANCH MAY AND MAY NOT CONCLUDE — Spec 785 §2.1.** The read-set proves
// USED and never UNUSED: a run that did not reach level 90 says nothing about the bank
// level 90 needs. So a slot span the run did not touch is reported "NOT SEEN IN THIS RUN"
// and NEVER fails the verdict — presenting a lower bound as a refutation is the Pawn
// 168/1329 failure in a new costume. What the run CAN contradict is narrower and sound:
//
//   the run demonstrably read payload P, and read PAST the position span S claims,
//   without ever reading S.
//
// A cross-bank stream is consecutive by construction, so a later span of the same
// payload being read while an earlier one was not is a real conflict — the loader walked
// over that position and the bytes it read were not where the manifest says they are.
// That, and only that, fails the cart verdict. A not-seen span AFTER the last read span
// of a payload is left as `truncated`: the capture may simply have ended mid-payload.
//
// Two further producer facts the classification honours (see loader-lens.ts):
//   - `offLo..offHi` BOUNDS the offsets touched; it is not a coverage set. So a span is
//     classified against the OUTER bound (`ranges` — was it read at all) but the
//     "the run walked past here" anchor comes only from the LOWER bound (`solidRanges` —
//     residencies that served at least as many reads as their range spans). Anchoring on
//     the hull produced a false conflict against a byte-verified manifest on real data:
//     four late scattered-read residencies in one bank spanned a hull that happened to
//     overlap an unrelated payload. A span backed only by a hull is reported as the WEAK
//     match it is and never anchors a refutation.
//   - The producer drains periodically, so one walk arrives as several records for the
//     same (bank, slot). `cartBankUsage` merges them before anything is compared.

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

/** A manifest slot span, as claimed. */
export interface SlotSpanClaim {
  payload: string;
  bank: number;
  /** The manifest's slot name (ROML / ROMH / ULTIMAX_ROMH / EEPROM / OTHER). */
  slot: string;
  offsetInBank: number;
  length: number;
}

/** A slot span the run CONTRADICTS — see the header for what that requires. */
export interface SlotSpanConflict extends SlotSpanClaim {
  reason: string;
}

/** A slot span whose payload was read in this run but which was not itself read, with
 *  no later span of the payload confirmed either — the run may have ended mid-payload. */
export interface SlotSpanTruncated extends SlotSpanClaim {
  reason: string;
}

/** Bank/window bytes the run READ that no manifest span claims. Cartridge code executes
 *  in place, so a bank the loader never "loads" still appears here when the CPU ran out
 *  of it — an unclaimed cart read is a lead, not a defect. */
export interface UnclaimedCartRead {
  bank: number;
  slot: number;
  slotName: string;
  offLo: number;
  offHi: number;
  /** Served reads over the whole (bank, slot), repeats and opcode fetches included. */
  bytes: number;
  /** The covering residency was sparse — fewer reads than its bounding range spans, so
   *  this sub-range is bounded-by, not proven-covered-by, the observation. */
  sparse: boolean;
}

export interface CartValidationResult {
  /** False when no cart read-set was supplied, or the capture carries no CART_READ
   *  records — then slot spans are skipped exactly as before Spec 785 C2. */
  evaluated: boolean;
  /** Why not, when `evaluated` is false. */
  reason?: string;
  /** Names the capture every count below is relative to. Spec 785 C3: these are
   *  "in run <this>" facts, never "used" / "unused" facts. */
  run: string;
  slotSpans: number;
  /** Span range fully inside what the run read for its (bank, slot). */
  confirmedSpans: number;
  /** Of `confirmedSpans`, how many are backed only by a bounding hull rather than by a
   *  full-sweep read — a weak match, never treated as proof. */
  weakConfirmedSpans: number;
  /** Span range overlaps the run's reads but reaches beyond them. */
  partialSpans: number;
  /** Span range not read in this run. NOT a refutation (§2.1). */
  notSeenSpans: number;
  /** Slot kinds the lane has no counterpart for (EEPROM / OTHER). */
  unmappableSpans: number;
  /** Payloads with at least one span inside the run's bounding reads (weak evidence
   *  included). */
  payloadsSeenInRun: number;
  /** Payloads with at least one span backed by a full-sweep read — the ones the run
   *  can actually say something about. */
  payloadsSolidInRun: number;
  payloadsTotal: number;
  /** The only verdict-failing class. */
  conflicts: SlotSpanConflict[];
  truncated: SlotSpanTruncated[];
  unclaimedReads: UnclaimedCartRead[];
  /** (bank, slot) pairs the run read. */
  banksReadInRun: number;
  residencies: number;
  /** Served cart reads over the whole capture. */
  servedReads: number;
}

export interface ValidationResult {
  verdict: "pass" | "fail";
  matchedSpans: number;
  mismatched: SpanMismatch[];
  unclaimed: UnclaimedRead[];
  /** Slot spans NOT validated: no cart read-set supplied / no CART_READ lane in the
   *  capture. 0 once `cart.evaluated` is true. */
  skippedSlotSpans: number;
  /** Spec 785 C2 — the cart branch. */
  cart: CartValidationResult;
}

export interface ValidateExtractionOptions {
  /** The cart read-set from the same capture (`cartReadSetFromCaptureFile`). Omit and
   *  slot spans are skipped, as they were before Spec 785 C2. */
  cartReadSet?: CartReadSetEntry[];
  /** How the run is named in every "in run X" statement. Default "this run". */
  runLabel?: string;
}

/** Manifest slot name → the lane's slot code. ROMH and ULTIMAX_ROMH are one window on
 *  the wire (the producer's `CartSlot::for_address` maps $A000-$BFFF and $E000-$FFFF
 *  both to ROMH). EEPROM / OTHER are not cart-ROM windows and the lane never sees them. */
function laneSlotFor(slot: string): number | null {
  switch (slot) {
    case "ROML": return 0;
    case "ROMH": case "ULTIMAX_ROMH": return 1;
    default: return null;
  }
}

type SpanClass = "confirmed" | "partial" | "notSeen";

/** Bytes of [lo,hi] that fall inside `ranges`. */
function overlap(ranges: ReadonlyArray<{ offLo: number; offHi: number }>, lo: number, hi: number): number {
  let n = 0;
  for (const r of ranges) {
    const a = Math.max(lo, r.offLo);
    const b = Math.min(hi, r.offHi);
    if (b >= a) n += b - a + 1;
  }
  return n;
}

/**
 * Classify one span range against what the run read for its (bank, slot).
 *
 * `cls` comes from the OUTER bound (`ranges`) — outside it, the span was definitely not
 * read. `solid` comes from the LOWER bound (`solidRanges`) and is the only evidence that
 * may anchor a refutation: a hull overlap says the span sits between two scattered reads,
 * which is not the same as the loader having walked through it.
 */
function classifySpan(
  usage: CartBankUsage | undefined, lo: number, hi: number,
): { cls: SpanClass; solid: boolean; fullySolid: boolean } {
  if (!usage) return { cls: "notSeen", solid: false, fullySolid: false };
  const covered = overlap(usage.ranges, lo, hi);
  const solidCovered = overlap(usage.solidRanges, lo, hi);
  const span = hi - lo + 1;
  const cls: SpanClass = covered === 0 ? "notSeen" : covered >= span ? "confirmed" : "partial";
  return { cls, solid: solidCovered > 0, fullySolid: solidCovered >= span };
}

/** Subtract the claimed sub-ranges from a merged read range, leaving what the run read
 *  and no span claims. */
function subtractClaims(
  range: { offLo: number; offHi: number }, claims: Array<{ lo: number; hi: number }>,
): Array<{ offLo: number; offHi: number }> {
  let open: Array<{ offLo: number; offHi: number }> = [{ ...range }];
  for (const c of claims) {
    const next: Array<{ offLo: number; offHi: number }> = [];
    for (const r of open) {
      if (c.hi < r.offLo || c.lo > r.offHi) { next.push(r); continue; }
      if (c.lo > r.offLo) next.push({ offLo: r.offLo, offHi: c.lo - 1 });
      if (c.hi < r.offHi) next.push({ offLo: c.hi + 1, offHi: r.offHi });
    }
    open = next;
    if (!open.length) break;
  }
  return open;
}

const NO_CART: CartValidationResult = {
  evaluated: false, run: "this run", slotSpans: 0, confirmedSpans: 0, weakConfirmedSpans: 0,
  partialSpans: 0, notSeenSpans: 0, unmappableSpans: 0, payloadsSeenInRun: 0, payloadsSolidInRun: 0,
  payloadsTotal: 0, conflicts: [], truncated: [], unclaimedReads: [], banksReadInRun: 0,
  residencies: 0, servedReads: 0,
};

export function validateExtraction(
  readSet: ReadSetEntry[],
  manifest: LoaderManifest,
  opts: ValidateExtractionOptions = {},
): ValidationResult {
  const readSources = new Set(readSet.map((e) => `${e.track}/${e.sector}`));
  const claimed = new Set<string>();
  const mismatched: SpanMismatch[] = [];
  let matchedSpans = 0;
  let skippedSlotSpans = 0;

  const runLabel = opts.runLabel ?? "this run";
  const cartEntries = opts.cartReadSet;
  const cartArmed = cartEntries !== undefined && cartEntries.length > 0;
  const usage = cartArmed ? cartBankUsage(cartEntries) : [];
  const usageByKey = new Map(usage.map((u) => [`${u.bank}/${u.slot}`, u]));

  const cart: CartValidationResult = cartArmed
    ? { ...NO_CART, evaluated: true, run: runLabel, conflicts: [], truncated: [], unclaimedReads: [] }
    : {
        ...NO_CART, run: runLabel, conflicts: [], truncated: [], unclaimedReads: [],
        reason: cartEntries === undefined
          ? "no cart read-set supplied — pass one from a capture armed with the cart-read domain"
          : "the capture carries no CART_READ records (the cart-read domain was not armed, or no cartridge was mounted)",
      };
  if (cartArmed) {
    cart.banksReadInRun = usage.length;
    cart.residencies = cartEntries!.length;
    cart.servedReads = usage.reduce((n, u) => n + u.bytes, 0);
  }

  // Claimed cart sub-ranges per (bank, slot), for the unclaimed-read diff.
  const cartClaims = new Map<string, Array<{ lo: number; hi: number }>>();

  for (const p of manifest.payloads) {
    for (const span of p.spans) {
      if (span.kind !== "sector") continue;
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

    // ---- Spec 785 C2 — the cart branch, symmetric to the disk one above. ----
    const slotSpans = p.spans.filter((s) => s.kind === "slot");
    if (!slotSpans.length) continue;
    if (!cartArmed) { skippedSlotSpans += slotSpans.length; continue; }
    cart.slotSpans += slotSpans.length;
    cart.payloadsTotal++;

    // Pass 1 — classify every span of this payload in span order (the manifest emits
    // a cross-bank payload's spans ordered and consecutive, 784 B1).
    const classed = slotSpans.map((span) => {
      const laneSlot = laneSlotFor(span.slot);
      const claim: SlotSpanClaim = {
        payload: p.name, bank: span.bank, slot: span.slot,
        offsetInBank: span.offsetInBank, length: span.length,
      };
      if (laneSlot === null) return { claim, cls: "unmappable" as const, solid: false, fullySolid: false };
      if (span.length <= 0) return { claim, cls: "notSeen" as const, solid: false, fullySolid: false };
      const lo = span.offsetInBank;
      const hi = span.offsetInBank + span.length - 1;
      const u = usageByKey.get(`${span.bank}/${laneSlot}`);
      const cls = classifySpan(u, lo, hi);
      const list = cartClaims.get(`${span.bank}/${laneSlot}`) ?? [];
      list.push({ lo, hi });
      cartClaims.set(`${span.bank}/${laneSlot}`, list);
      return { claim, ...cls };
    });

    for (const c of classed) {
      if (c.cls === "unmappable") cart.unmappableSpans++;
      else if (c.cls === "confirmed") { cart.confirmedSpans++; if (!c.fullySolid) cart.weakConfirmedSpans++; }
      else if (c.cls === "partial") cart.partialSpans++;
      else cart.notSeenSpans++;
    }

    // Pass 2 — the only sound refutation: the run read this payload, and read PAST a
    // span it never read. The anchor is the last span backed by a FULL-SWEEP read; a
    // bounding-hull overlap is not evidence that the loader walked through anything.
    const seenAtAll = classed.some((c) => c.cls === "confirmed" || c.cls === "partial");
    if (seenAtAll) cart.payloadsSeenInRun++;
    let lastSeen = -1;
    for (let i = 0; i < classed.length; i++) if (classed[i].solid) lastSeen = i;
    if (lastSeen < 0) continue; // no solid evidence this run reached the payload — say nothing (§2.1)
    cart.payloadsSolidInRun++;

    for (let i = 0; i < classed.length; i++) {
      const c = classed[i];
      if (c.cls === "confirmed" || c.cls === "unmappable") continue;
      if (i < lastSeen) {
        cart.conflicts.push({
          ...c.claim,
          reason: c.cls === "notSeen"
            ? `${runLabel} swept span ${lastSeen + 1}/${classed.length} of this payload, so it read PAST this one — yet bank ${c.claim.bank} ${c.claim.slot} $${hex(c.claim.offsetInBank)}-$${hex(c.claim.offsetInBank + c.claim.length - 1)} was never read in ${runLabel}. The span does not describe the bytes the loader took.`
            : `${runLabel} swept span ${lastSeen + 1}/${classed.length} of this payload, so it read PAST this one — yet only part of bank ${c.claim.bank} ${c.claim.slot} $${hex(c.claim.offsetInBank)}-$${hex(c.claim.offsetInBank + c.claim.length - 1)} was read in ${runLabel}. The span reaches beyond what the loader took.`,
        });
      } else {
        cart.truncated.push({
          ...c.claim,
          reason: `${runLabel} read this payload but this TRAILING span was ${c.cls === "notSeen" ? "not read" : "only partly read"} — ${runLabel} may have ended mid-payload, so this is not a refutation`,
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

  // Cart: what the run read that no slot span claims (the mirror of `unclaimed`).
  if (cartArmed) {
    for (const u of usage) {
      const claims = (cartClaims.get(`${u.bank}/${u.slot}`) ?? []).sort((a, b) => a.lo - b.lo);
      for (const r of u.ranges) {
        for (const left of subtractClaims(r, claims)) {
          cart.unclaimedReads.push({
            bank: u.bank, slot: u.slot, slotName: u.slotName,
            offLo: left.offLo, offHi: left.offHi, bytes: u.bytes, sparse: u.sparse,
          });
        }
      }
    }
  }

  return {
    verdict: mismatched.length === 0 && cart.conflicts.length === 0 ? "pass" : "fail",
    matchedSpans,
    mismatched,
    unclaimed,
    skippedSlotSpans,
    cart,
  };
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}
