// Spec 867 D1 — the window a payload occupies when it is loaded.
//
// It is not new knowledge. A payload record already carries where it lands and how
// many bytes it is; this makes the pair explicit, under one name, so it can be
// asked: which stretch of the machine does this payload own while it is there.
//
// The doors record it at registration. A record written before 867 has no window
// and is not migrated (§5 — nothing is re-keyed, nothing is rewritten); it is
// derived on read from the same two facts, so an untouched project answers the
// same question with the same numbers.

export interface PayloadWindowSpec {
  start: number;
  end: number;
  space?: "ram" | "drv" | "crt";
  bank?: number;
}

export interface PayloadWindowInput {
  payloadWindow?: PayloadWindowSpec;
  payloadLoadAddress?: number;
  payloadFormat?: string;
  addressRange?: { start: number; end: number; bank?: number };
}

/** A `.prg`'s first two bytes are its load address, not bytes of the payload. */
export function runtimeLength(byteLength: number | undefined, format: string | undefined): number | undefined {
  if (byteLength === undefined || byteLength <= 0) return undefined;
  if (format === "prg") return byteLength > 2 ? byteLength - 2 : undefined;
  return byteLength;
}

/**
 * The window, in order of how well the project knows it:
 *   1. what a door recorded,
 *   2. the runtime range the record carries (a range with an extent, not a load
 *      address repeated twice),
 *   3. the load address plus the byte length of the bytes themselves.
 * A load address with nothing to say how far it reaches is not a window, and this
 * returns undefined rather than inventing an extent.
 */
export function derivePayloadWindow(input: PayloadWindowInput, byteLength?: number): PayloadWindowSpec | undefined {
  if (input.payloadWindow) return input.payloadWindow;
  const bank = input.addressRange?.bank;
  const range = input.addressRange;
  if (range && range.end > range.start) {
    return { start: range.start, end: range.end, ...(bank !== undefined ? { bank } : {}) };
  }
  const start = input.payloadLoadAddress ?? range?.start;
  if (start === undefined) return undefined;
  const length = runtimeLength(byteLength, input.payloadFormat);
  if (length === undefined || length < 2) return undefined;
  const end = Math.min(0xffff, start + length - 1);
  if (end <= start) return undefined;
  return { start, end, ...(bank !== undefined ? { bank } : {}) };
}

export const formatWindow = (w: PayloadWindowSpec | undefined): string =>
  w === undefined
    ? "(none — no load address, or nothing says how far it reaches)"
    : `$${w.start.toString(16).toUpperCase().padStart(4, "0")}-$${w.end.toString(16).toUpperCase().padStart(4, "0")}${w.bank !== undefined ? ` bank ${w.bank}` : ""}`;
