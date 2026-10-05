// Where a depack result is written, and whether it carries a load address.
//
// A file named `.prg` is read by every later tool as address-then-body, so a headerless
// body under that name makes its first two data bytes an address (a ByteBoozer2 result
// once came back as `$F4 $F4`). The rule, per depacker:
//
//   the depacker knows the destination address  -> a PRG: 2-byte load address + body
//   it does not                                 -> the body alone, named `.bin`
//
// Naming: with no output_path the name follows the result (`.prg` / `.bin`). A caller's
// own name is kept, with ONE exception — a header-less body the caller named `.prg` is
// written as `.bin` beside it, because writing it under `.prg` is the defect. The answer
// says so. A PRG written to a caller's `.bin` stays where the caller put it.

import { extname } from "node:path";

export interface DepackOutputChoice {
  /** Absolute path the bytes go to. */
  path: string;
  /** One line for the answer when the name was changed; undefined when it was not. */
  renamedNote?: string;
}

export function chooseDepackOutput(args: {
  /** The caller's output_path, already resolved; undefined when none was given. */
  requestedAbs: string | undefined;
  /** Used to build the default name. */
  inputAbs: string;
  format: string;
  /** True when the result is written with a 2-byte load address in front. */
  hasLoadAddress: boolean;
}): DepackOutputChoice {
  const { requestedAbs, inputAbs, format, hasLoadAddress } = args;
  if (requestedAbs === undefined) {
    return { path: `${inputAbs}.${format}.unpacked.${hasLoadAddress ? "prg" : "bin"}` };
  }
  if (!hasLoadAddress && extname(requestedAbs).toLowerCase() === ".prg") {
    const path = `${requestedAbs.slice(0, -4)}.bin`;
    return {
      path,
      renamedNote: `Named ${requestedAbs} but written as ${path}: this result carries no load address, and a .prg would be read as address-then-body.`,
    };
  }
  return { path: requestedAbs };
}

/** A PRG: the 2-byte little-endian load address, then the body. */
export function withLoadAddress(address: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 2);
  out[0] = address & 0xff;
  out[1] = (address >> 8) & 0xff;
  out.set(body, 2);
  return out;
}
