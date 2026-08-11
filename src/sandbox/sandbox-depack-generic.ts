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
// A missing `trx64cli` is an actionable error, not a silent drop back onto a
// TS shadow (single-path doctrine). Spec 788 tail piece C (2026-07-15) deleted
// the flat-64K TS `Cpu6502` shadow and the `genericSandboxDepackTs` migration
// cross-check that used it; the real core is now the only engine.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
//
// Spec 805 — ONE code path, batched. `trx64cli` costs ~740 ms to start (~650 ms of
// it eager machine init, before argument parsing), so a campaign that depacked N
// payloads one call at a time paid that N times: 101 chunks in one proof project
// meant ~75 seconds of pure process startup for milliseconds of work. Everything
// below therefore builds a batch SPEC rather than an argv, and the single-payload
// entry point is a batch of one — so the two can never drift apart.

/** The `trx64cli sandbox --batch` item for one depack, plus the temp files it needs. */
function buildDepackItem(opts: SandboxDepackOptions, tmp: string, index: number): Record<string, unknown> {
  const residentEnd = opts.residentLoadAddress + opts.residentLoader.length;
  const sourceLoad = opts.sourceLoadAddress ?? residentEnd;
  checkLayout(opts, sourceLoad, residentEnd);

  const zpLow = opts.sourceZpLow ?? 0x52;
  const zpHigh = opts.sourceZpHigh ?? 0x53;

  const residentFile = join(tmp, `resident-${index}.bin`);
  const packedFile = join(tmp, `packed-${index}.bin`);
  writeFileSync(residentFile, opts.residentLoader);
  writeFileSync(packedFile, opts.packed);

  // Zero-page seeds. Order matches the TS spread: any caller-supplied initialZp
  // first, then the src-pointer low/high bytes (which win) — trx64 applies --zp
  // in order, last write wins.
  const zp: string[] = [];
  for (const [k, v] of Object.entries(opts.initialZp ?? {})) zp.push(`${hx2(Number(k))}=${hx2(v)}`);
  zp.push(`${hx2(zpLow)}=${hx2(sourceLoad & 0xff)}`);
  zp.push(`${hx2(zpHigh)}=${hx2((sourceLoad >> 8) & 0xff)}`);

  const item: Record<string, unknown> = {
    load: [`${residentFile}@${hx4(opts.residentLoadAddress)}`, `${packedFile}@${hx4(sourceLoad)}`],
    entry: hx4(opts.entryPc),
    directEntry: true,
    // All-RAM: model the flat-64K TS shadow ($A000-$FFFF + $D000-$DFFF = RAM) so a
    // faithful cross-check holds and $E000-dest writes are harvestable.
    io: "$34",
    instrCap: opts.maxSteps ?? 5_000_000,
    // Harvest all of RAM once (the run is deterministic) and slice the dest window
    // locally — final RAM == last write under all-RAM, so this is byte-identical to
    // a targeted second-pass `--harvest $dest:len`.
    harvest: ["$0000:0x10000"],
    zp,
  };
  // Registers observed at ENTRY (only when the caller set them; trx64 direct-entry
  // defaults A/X/Y=0, SP=$FD, P=$22 = the TS Cpu6502 defaults).
  if (opts.initialA !== undefined) item.regA = hx2(opts.initialA);
  if (opts.initialX !== undefined) item.regX = hx2(opts.initialX);
  if (opts.initialY !== undefined) item.regY = hx2(opts.initialY);
  if (opts.initialSp !== undefined) item.regSp = hx2(opts.initialSp);
  if (opts.initialFlags !== undefined) item.regP = hx2(opts.initialFlags);
  // stopPc → an extra sentinel breakpoint (trx64 maps a non-RTS-landing breakpoint
  // to the "stop_pc" vocab).
  if (opts.stopPc !== undefined) item.sentinel = hx4(opts.stopPc);
  return item;
}

/** The real core's JSON for one run → the depack result the callers expect. */
function interpretDepackRun(
  j: {
    stopReason: string;
    steps: number;
    writtenRuns: Array<{ lo: number; hi: number }>;
    harvest: { addr: number; len: number; hex: string };
  },
  opts: SandboxDepackOptions,
): SandboxDepackResult {
  if (j.stopReason !== "sentinel_rts" && j.stopReason !== "stop_pc") {
    throw new GenericSandboxDepackError(
      `depacker stopped with ${j.stopReason} after ${j.steps} steps`,
    );
  }

  // Reproduce the TS dest selection from the real core's write-map. The runs
  // already exclude $0000-$01ff (stack + CPU port machinery — never depack
  // output); clip to captureRange when the caller set one.
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

  const ram = hexToBytes(j.harvest.hex);
  const unpacked = Uint8Array.from(ram.subarray(dest, dest + len));

  // `writes` (diagnostic) reconstructed as the dest run: the real core reports the
  // write-map, not the temporal event list, so `total writes` now counts the
  // unpacked dest bytes rather than raw store events.
  const writes = Array.from(unpacked, (value, i) => ({ address: (dest + i) & 0xffff, value }));

  return { unpacked, destAddress: dest, steps: j.steps, stopReason: j.stopReason, entryPc: opts.entryPc, writes };
}

/**
 * Depack N payloads in ONE `trx64cli` process (Spec 805). Each still gets its own
 * fresh machine on its own thread inside that process — this batches the process
 * start, nothing else.
 *
 * A payload that fails does NOT sink the batch: its slot carries the error and the
 * caller decides. A campaign wants the 100 that worked plus the name of the one
 * that did not.
 */
export function genericSandboxDepackMany(
  optsList: SandboxDepackOptions[],
): Array<{ ok: true; result: SandboxDepackResult } | { ok: false; error: string }> {
  if (optsList.length === 0) return [];

  const cli = resolveTrx64Cli();
  if (!existsSync(cli)) {
    throw new GenericSandboxDepackError(
      `trx64cli not found at ${cli}. Build it with ` +
        `\`cargo build --release --bin trx64cli\`` +
        ` in the sibling TRX64 repo, or point C64RE_TRX64CLI_BIN at the binary.`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "c64re-depack-"));
  try {
    // A layout error is the caller's mistake about THIS payload, not a batch
    // failure — hold it and report it in that payload's slot.
    type BuiltItem = { __error: string } | Record<string, unknown>;
    const items: BuiltItem[] = optsList.map((opts, i): BuiltItem => {
      try {
        return buildDepackItem(opts, tmp, i);
      } catch (e) {
        return { __error: e instanceof Error ? e.message : String(e) };
      }
    });
    const runnable = items
      .map((it, i) => ({ it, i }))
      .filter((x): x is { it: Record<string, unknown>; i: number } => !("__error" in x.it));

    const out: Array<{ ok: true; result: SandboxDepackResult } | { ok: false; error: string }> =
      items.map((it) =>
        "__error" in it
          ? { ok: false as const, error: String(it.__error) }
          : { ok: false as const, error: "not run" },
      );

    if (runnable.length > 0) {
      const specFile = join(tmp, "batch.json");
      writeFileSync(specFile, JSON.stringify({ runs: runnable.map((x) => x.it) }));

      let stdout: string;
      try {
        stdout = execFileSync(cli, ["sandbox", "--batch", specFile], {
          env: { ...process.env, C64RE_ROOT: process.env.C64RE_ROOT ?? repoRoot() },
          maxBuffer: 256 * 1024 * 1024,
          encoding: "utf8",
        });
      } catch (e) {
        const err = e as { stderr?: Buffer | string; message?: string };
        const stderr = err.stderr ? String(err.stderr).trim() : "";
        throw new GenericSandboxDepackError(
          `trx64cli sandbox failed: ${stderr || err.message || "unknown error"}`,
        );
      }

      const batch = JSON.parse(stdout) as {
        runs: Array<{ index: number; ok: boolean; error?: string; result?: unknown }>;
      };
      for (const run of batch.runs) {
        const slot = runnable[run.index];
        if (!slot) continue;
        if (!run.ok || !run.result) {
          out[slot.i] = { ok: false, error: run.error ?? "run failed" };
          continue;
        }
        try {
          out[slot.i] = { ok: true, result: interpretDepackRun(run.result as never, optsList[slot.i]) };
        } catch (e) {
          out[slot.i] = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** One payload — a batch of one, so single and batch semantics cannot diverge. */
export function genericSandboxDepack(opts: SandboxDepackOptions): SandboxDepackResult {
  const [only] = genericSandboxDepackMany([opts]);
  if (!only || !only.ok) {
    throw new GenericSandboxDepackError(only && !only.ok ? only.error : "no result");
  }
  return only.result;
}
