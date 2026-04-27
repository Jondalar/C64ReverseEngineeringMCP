import { runSandbox } from "../sandbox/sandbox-runner.js";
import { parseHeader, type BwcHeader } from "./header.js";

export interface SandboxDepackOptions {
  // Packed payload bytes (header + bit-stream body).
  packed: Uint8Array;
  // BWC resident loader binary (the 1 KB block that contains $C992).
  // Should already be in the form bytes_starting_at(residentLoadAddress);
  // do NOT include the 2-byte PRG header here — strip it before calling.
  residentLoader: Uint8Array;
  // Load address for the resident loader. BWC uses $C800.
  residentLoadAddress?: number;
  // Source-load address inside the sandbox where the packed payload is
  // placed. The payload is mapped read-only ("ef_roml"), so writes to
  // overlapping addresses pass through to RAM and don't clobber it.
  // Default $1000 — gives 28 KB of source room before the resident loader
  // window at $C800 and avoids the page-zero / stack / screen areas.
  sourceLoadAddress?: number;
  // Cap on instruction count. Default 5_000_000 (a single 16 KB chunk
  // typically depacks in <1M steps).
  maxSteps?: number;
}

export interface SandboxDepackResult {
  header: BwcHeader;
  // Unpacked bytes, length determined from the contiguous run of writes
  // starting at the destination address.
  unpacked: Uint8Array;
  destAddress: number;
  steps: number;
  stopReason: string;
}

export class SandboxDepackError extends Error {}

export function sandboxDepack(opts: SandboxDepackOptions): SandboxDepackResult {
  const chunk = parseHeader(opts.packed);
  const dest = chunk.header.dest;
  const residentAddress = opts.residentLoadAddress ?? 0xc800;
  const residentEnd = residentAddress + opts.residentLoader.length;
  // Default source load address: place packed bytes in plain RAM, AFTER
  // the resident loader, where they cannot overlap any plausible
  // depack destination. ef_roml mapping is NOT used: with ef_roml the
  // packed bytes would mask reads even when dest writes have already
  // happened in the same range, breaking LZ self-references whose
  // source overlaps the dest output. Plain RAM avoids that.
  const sourceLoad = opts.sourceLoadAddress ?? residentEnd;

  if (sourceLoad + opts.packed.length > 0x10000) {
    throw new SandboxDepackError(
      `packed payload (${opts.packed.length} bytes) at $${sourceLoad.toString(16)} overflows 64K — pick a lower sourceLoadAddress`,
    );
  }
  if (sourceLoad < residentEnd && sourceLoad + opts.packed.length > residentAddress) {
    throw new SandboxDepackError(
      `packed payload $${sourceLoad.toString(16)}-$${(sourceLoad + opts.packed.length - 1).toString(16)} overlaps the resident loader window`,
    );
  }
  // Hard collision check: source range must not intersect dest range,
  // since the depacker's LZ refs read from mem and would pick up
  // packed-source bytes instead of the running output.
  // We can't know dest_end exactly without running the depacker, but
  // refuse if the dest address falls inside the source range.
  if (dest >= sourceLoad && dest < sourceLoad + opts.packed.length) {
    throw new SandboxDepackError(
      `dest $${dest.toString(16)} falls inside source range $${sourceLoad.toString(16)}-$${(sourceLoad + opts.packed.length - 1).toString(16)} — pick a different sourceLoadAddress`,
    );
  }

  // Capture writes across the entire 64K. The depacker also writes the
  // small literal table to $0101..$0100+y but we filter by [dest,
  // dest+max_window] when extracting the unpacked block.
  const result = runSandbox({
    loads: [
      { bytes: opts.residentLoader, address: residentAddress },
      // Plain RAM mapping: the depacker only reads source via $52/$53
      // pointer (the cart-source window). LZ self-refs read via
      // ($58),Y from RAM, which is also where dest writes land. A
      // ROM overlay would mask LZ reads when source range and dest
      // range coincide — see sandbox-depack history.
      { bytes: opts.packed, address: sourceLoad, mapping: "ram" },
    ],
    initialPc: 0xc992,
    initialZp: { 0x52: sourceLoad & 0xff, 0x53: (sourceLoad >> 8) & 0xff },
    maxSteps: opts.maxSteps ?? 5_000_000,
  });

  if (result.stopReason !== "sentinel_rts" && result.stopReason !== "stop_pc") {
    throw new SandboxDepackError(
      `depacker stopped with ${result.stopReason} after ${result.steps} steps (final PC $${result.finalState.pc.toString(16)})`,
    );
  }

  // Slice the contiguous run of writes starting at dest. The depacker
  // writes destination bytes via WCAB0 which auto-increments the dest
  // pointer, so the unpacked block is a single contiguous span.
  const writeMap = new Map<number, number>();
  for (const w of result.writes) writeMap.set(w.address, w.value);
  const bytes: number[] = [];
  let addr = dest;
  while (writeMap.has(addr)) {
    bytes.push(writeMap.get(addr)!);
    addr += 1;
    if (addr > 0xffff) break;
  }

  if (bytes.length === 0) {
    throw new SandboxDepackError(`depacker produced no writes at destination $${dest.toString(16)}`);
  }

  return {
    header: chunk.header,
    unpacked: Uint8Array.from(bytes),
    destAddress: dest,
    steps: result.steps,
    stopReason: result.stopReason,
  };
}
