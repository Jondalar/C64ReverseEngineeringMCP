// Generic sandbox-driven depacker.
//
// Takes ANY 6502 depacker (the resident routine inside a custom loader)
// + ANY packed byte-blob, runs the depacker, captures destination writes,
// returns the unpacked PRG bytes. New packer formats only need to know
// where the depacker entry lives + which zeropage bytes hold the source
// pointer.
//
// Spec 788 Slice 1 piece B (2026-07-15): the DEFAULT engine now runs the
// depacker on the TRX64 real 6502 core (`trx64cli sandbox`) instead of the
// flat-64K TS `Cpu6502` shadow — so a depacker that touches banking / IO
// executes for real. `genericSandboxDepack` shells out to the sibling
// `trx64cli` (resolved like the runtime daemon; `C64RE_TRX64CLI_BIN`
// overrides). The tool contract (`sandbox_depack` input schema + output
// prose) is unchanged.
//
// The old TS-shadow engine is retained verbatim as `genericSandboxDepackTs`
// for the ONE-TIME migration cross-check (`tests/spec-788/*`). It is NOT a
// runtime fallback — a missing `trx64cli` is an actionable error, not a
// silent drop back onto the shadow (single-path doctrine). `runSandbox` /
// `cpu6502.ts` stay intact; they still back `sandbox_6502_run` + the BWC
// bit-stream depacker (those remain on the shadow, phase 2).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandbox, type SandboxLoad } from "./sandbox-runner.js";
import { hexToBytes, hx2, hx4, repoRoot, resolveTrx64Cli } from "./trx64cli.js";

// Re-export for back-compat: resolveTrx64Cli was originally defined here and is
// imported from this module by the Spec 788 tests. It now lives in ./trx64cli.
export { resolveTrx64Cli };

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

// ── Shared dest-run selection (byte-identical between the real-core + shadow
// paths). Given the set of written addresses, pick `dest` — the caller hint,
// else the start of the LARGEST contiguous run — and walk the contiguous run
// from `dest` to get its length. This is the exact algorithm the original TS
// engine ran inline (sandbox-depack-generic.ts:116-148 pre-788). ───────────
function pickDestRun(
  writtenAddrs: Iterable<number>,
  destAddress: number | undefined,
): { dest: number; len: number } {
  const keySet = new Set<number>();
  for (const a of writtenAddrs) keySet.add(a);

  let dest = destAddress;
  if (dest === undefined) {
    const sorted = [...keySet].sort((a, b) => a - b);
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

  let len = 0;
  let addr = dest;
  while (keySet.has(addr)) {
    len += 1;
    addr += 1;
    if (addr > 0xffff) break;
  }
  return { dest, len };
}

// Validate the 64K layout (engine-independent input checks — the packed blob
// must fit and must not overlap the resident loader window).
function checkLayout(opts: SandboxDepackOptions, sourceLoad: number, residentEnd: number): void {
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
}

// ── DEFAULT engine: run the depacker on the TRX64 real 6502 core. ──────────
export function genericSandboxDepack(opts: SandboxDepackOptions): SandboxDepackResult {
  const residentEnd = opts.residentLoadAddress + opts.residentLoader.length;
  const sourceLoad = opts.sourceLoadAddress ?? residentEnd;
  checkLayout(opts, sourceLoad, residentEnd);

  const zpLow = opts.sourceZpLow ?? 0x52;
  const zpHigh = opts.sourceZpHigh ?? 0x53;

  const cli = resolveTrx64Cli();
  if (!existsSync(cli)) {
    throw new GenericSandboxDepackError(
      `trx64cli not found at ${cli}. Build it with ` +
        `\`cargo build --release --bin trx64cli\` in the sibling TRX64 repo, ` +
        `or point C64RE_TRX64CLI_BIN at the binary.`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "c64re-depack-"));
  try {
    const residentFile = join(tmp, "resident.bin");
    const packedFile = join(tmp, "packed.bin");
    writeFileSync(residentFile, opts.residentLoader);
    writeFileSync(packedFile, opts.packed);

    const args: string[] = [
      "sandbox",
      "--load", `${residentFile}@${hx4(opts.residentLoadAddress)}`,
      "--load", `${packedFile}@${hx4(sourceLoad)}`,
      "--entry", hx4(opts.entryPc),
      "--direct-entry",
      // All-RAM: model the flat-64K TS shadow ($A000-$FFFF + $D000-$DFFF = RAM)
      // so a faithful cross-check holds and $E000-dest writes are harvestable.
      "--io", "$34",
      "--instr-cap", String(opts.maxSteps ?? 5_000_000),
      // Harvest all of RAM once (the run is deterministic) and slice the dest
      // window locally — final RAM == last write under all-RAM, so this is
      // byte-identical to a targeted second-pass `--harvest $dest:len`.
      "--harvest", "$0000:0x10000",
      "--json",
    ];

    // Zero-page seeds. Order matches the TS spread: any caller-supplied
    // initialZp first, then the src-pointer low/high bytes (which win) —
    // trx64 applies --zp in argv order, last write wins.
    for (const [k, v] of Object.entries(opts.initialZp ?? {})) {
      args.push("--zp", `${hx2(Number(k))}=${hx2(v)}`);
    }
    args.push("--zp", `${hx2(zpLow)}=${hx2(sourceLoad & 0xff)}`);
    args.push("--zp", `${hx2(zpHigh)}=${hx2((sourceLoad >> 8) & 0xff)}`);

    // Registers observed at ENTRY (only when the caller set them; trx64
    // direct-entry defaults A/X/Y=0, SP=$FD, P=$22 = the TS Cpu6502 defaults).
    if (opts.initialA !== undefined) args.push("--reg-a", hx2(opts.initialA));
    if (opts.initialX !== undefined) args.push("--reg-x", hx2(opts.initialX));
    if (opts.initialY !== undefined) args.push("--reg-y", hx2(opts.initialY));
    if (opts.initialSp !== undefined) args.push("--reg-sp", hx2(opts.initialSp));
    if (opts.initialFlags !== undefined) args.push("--reg-p", hx2(opts.initialFlags));

    // stopPc → an extra sentinel breakpoint (trx64 maps a non-RTS-landing
    // breakpoint to the "stop_pc" vocab).
    if (opts.stopPc !== undefined) args.push("--sentinel", hx4(opts.stopPc));

    let stdout: string;
    try {
      stdout = execFileSync(cli, args, {
        env: { ...process.env, C64RE_ROOT: process.env.C64RE_ROOT ?? repoRoot() },
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      const stderr = err.stderr ? String(err.stderr).trim() : "";
      throw new GenericSandboxDepackError(
        `trx64cli sandbox failed: ${stderr || err.message || "unknown error"}`,
      );
    }

    const j = JSON.parse(stdout) as {
      ok: boolean;
      stopReason: string;
      steps: number;
      writtenRuns: Array<{ lo: number; hi: number }>;
      harvest: { addr: number; len: number; hex: string };
    };

    if (j.stopReason !== "sentinel_rts" && j.stopReason !== "stop_pc") {
      throw new GenericSandboxDepackError(
        `depacker stopped with ${j.stopReason} after ${j.steps} steps`,
      );
    }

    // Reproduce the TS dest selection from the real core's write-map. The
    // runs already exclude $0000-$01ff (stack + CPU port machinery — never
    // depack output); clip to captureRange when the caller set one.
    const range = opts.captureRange;
    const writtenAddrs: number[] = [];
    for (const { lo, hi } of j.writtenRuns) {
      const a0 = range ? Math.max(lo, range.start) : lo;
      const a1 = range ? Math.min(hi, range.end) : hi;
      for (let a = a0; a <= a1; a++) writtenAddrs.push(a);
    }
    const { dest, len } = pickDestRun(writtenAddrs, opts.destAddress);
    if (len === 0) {
      throw new GenericSandboxDepackError(
        `no contiguous write run found at dest $${dest.toString(16)}`,
      );
    }

    // Slice the unpacked bytes out of the full-RAM harvest.
    const ram = hexToBytes(j.harvest.hex);
    const unpacked = Uint8Array.from(ram.subarray(dest, dest + len));

    // `writes` (diagnostic) reconstructed as the dest run: the real core
    // reports the write-map, not the temporal event list, so `total writes`
    // now counts the unpacked dest bytes rather than raw store events.
    const writes = Array.from(unpacked, (value, i) => ({ address: (dest + i) & 0xffff, value }));

    return {
      unpacked,
      destAddress: dest,
      steps: j.steps,
      stopReason: j.stopReason,
      entryPc: opts.entryPc,
      writes,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Retained TS-shadow engine (migration cross-check ONLY; NOT a runtime
// fallback). Same behaviour as the pre-788 `genericSandboxDepack`. ─────────
export function genericSandboxDepackTs(opts: SandboxDepackOptions): SandboxDepackResult {
  const residentEnd = opts.residentLoadAddress + opts.residentLoader.length;
  const sourceLoad = opts.sourceLoadAddress ?? residentEnd;
  checkLayout(opts, sourceLoad, residentEnd);

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

  const writeMap = new Map<number, number>();
  for (const w of result.writes) writeMap.set(w.address, w.value);

  const { dest, len } = pickDestRun(writeMap.keys(), opts.destAddress);
  if (len === 0) {
    throw new GenericSandboxDepackError(`no contiguous write run found at dest $${dest.toString(16)}`);
  }

  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(writeMap.get((dest + i) & 0xffff)!);

  return {
    unpacked: Uint8Array.from(bytes),
    destAddress: dest,
    steps: result.steps,
    stopReason: result.stopReason,
    entryPc: opts.entryPc,
    writes: result.writes,
  };
}
