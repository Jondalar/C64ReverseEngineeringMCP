// Generic sandbox-driven depacker.
//
// Takes ANY 6502 depacker (the resident routine inside a custom loader)
// + ANY packed byte-blob, runs the depacker in the sandbox CPU, captures
// destination writes, returns the unpacked PRG bytes. The BWC bit-stream
// sandbox-depack helper is a thin domain-specific wrapper over this
// engine; new packer formats only need to know where the depacker
// entry lives + which zeropage bytes hold the source pointer.

import { runSandbox, type SandboxLoad } from "./sandbox-runner.js";

export interface SandboxDepackOptions {
  // Packed bytes to depack. Routed into the sandbox at sourceLoadAddress
  // (default: just after the resident loader window).
  packed: Uint8Array;
  // The resident loader binary (the routine that contains the depacker).
  // Loaded at residentLoadAddress.
  residentLoader: Uint8Array;
  residentLoadAddress: number;
  // Optional override of where the packed bytes land in the sandbox.
  // Default = residentLoadAddress + residentLoader.length.
  sourceLoadAddress?: number;
  // PC the depacker starts at. Required.
  entryPc: number;
  // Zero-page byte where the depacker reads the source pointer's low
  // byte. BWC convention is $52/$53; pucrunch and exomizer use the
  // same; some custom loaders use $FA/$FB or $52/$53 still. Default
  // $52.
  sourceZpLow?: number;
  // High byte of the source pointer in zero-page. Default $53.
  sourceZpHigh?: number;
  // Optional zero-page seed values for any other ZP bytes the depacker
  // expects pre-loaded.
  initialZp?: Record<number, number>;
  // Initial CPU register state. SP defaults to $FD with sentinel staged.
  initialA?: number;
  initialX?: number;
  initialY?: number;
  initialSp?: number;
  initialFlags?: number;
  // Cap on instruction count. Default 5_000_000.
  maxSteps?: number;
  // Optional "where the depacker writes" hint. When set, the contiguous
  // run of writes starting here is returned as `unpacked`. When unset,
  // the largest contiguous run anywhere in the captured writes is used.
  destAddress?: number;
  // Optional explicit capture window — mostly when destAddress is unset
  // and the caller knows the depacker writes into a specific range.
  captureRange?: { start: number; end: number };
  // Stop the sandbox at this PC if reached. Default: sentinel RTS exit.
  stopPc?: number;
}

export interface SandboxDepackResult {
  unpacked: Uint8Array;
  destAddress: number;
  steps: number;
  stopReason: string;
  entryPc: number;
  // Diagnostic: every write into the dest range, in temporal order.
  writes: Array<{ address: number; value: number }>;
}

export class GenericSandboxDepackError extends Error {}

export function genericSandboxDepack(opts: SandboxDepackOptions): SandboxDepackResult {
  const residentEnd = opts.residentLoadAddress + opts.residentLoader.length;
  const sourceLoad = opts.sourceLoadAddress ?? residentEnd;

  if (sourceLoad + opts.packed.length > 0x10000) {
    throw new GenericSandboxDepackError(
      `packed payload (${opts.packed.length} bytes) at $${sourceLoad.toString(16)} overflows 64K`,
    );
  }
  if (sourceLoad < residentEnd && sourceLoad + opts.packed.length > opts.residentLoadAddress) {
    throw new GenericSandboxDepackError(
      `packed payload $${sourceLoad.toString(16)}-$${(sourceLoad + opts.packed.length - 1).toString(16)} overlaps the resident loader window`,
    );
  }

  const zpLow = opts.sourceZpLow ?? 0x52;
  const zpHigh = opts.sourceZpHigh ?? 0x53;
  const initialZp = {
    ...(opts.initialZp ?? {}),
    [zpLow]: sourceLoad & 0xff,
    [zpHigh]: (sourceLoad >> 8) & 0xff,
  };

  const loads: SandboxLoad[] = [
    { bytes: opts.residentLoader, address: opts.residentLoadAddress },
    // Plain RAM so LZ self-references reach freshly-written bytes.
    { bytes: opts.packed, address: sourceLoad, mapping: "ram" },
  ];

  const result = runSandbox({
    loads,
    initialPc: opts.entryPc & 0xffff,
    initialZp,
    initialA: opts.initialA,
    initialX: opts.initialX,
    initialY: opts.initialY,
    initialSp: opts.initialSp,
    initialFlags: opts.initialFlags,
    stopPc: opts.stopPc,
    maxSteps: opts.maxSteps ?? 5_000_000,
    returnWritesRange: opts.captureRange,
  });

  if (result.stopReason !== "sentinel_rts" && result.stopReason !== "stop_pc") {
    throw new GenericSandboxDepackError(
      `depacker stopped with ${result.stopReason} after ${result.steps} steps (final PC $${result.finalState.pc.toString(16)})`,
    );
  }

  // Find the contiguous write run starting at destAddress, or the
  // largest contiguous run in the writes if destAddress is undefined.
  const writeMap = new Map<number, number>();
  for (const w of result.writes) writeMap.set(w.address, w.value);

  let dest = opts.destAddress;
  if (dest === undefined) {
    // Largest contiguous run.
    const sorted = [...writeMap.keys()].sort((a, b) => a - b);
    let bestStart = 0;
    let bestLen = 0;
    let runStart = sorted[0] ?? 0;
    let runLen = 0;
    let prev = -2;
    for (const a of sorted) {
      if (a === prev + 1) {
        runLen += 1;
      } else {
        if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
        runStart = a;
        runLen = 1;
      }
      prev = a;
    }
    if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
    dest = bestStart;
  }
  const bytes: number[] = [];
  let addr = dest;
  while (writeMap.has(addr)) {
    bytes.push(writeMap.get(addr)!);
    addr += 1;
    if (addr > 0xffff) break;
  }
  if (bytes.length === 0) {
    throw new GenericSandboxDepackError(`no contiguous write run found at dest $${dest.toString(16)}`);
  }

  return {
    unpacked: Uint8Array.from(bytes),
    destAddress: dest,
    steps: result.steps,
    stopReason: result.stopReason,
    entryPc: opts.entryPc,
    writes: result.writes,
  };
}
