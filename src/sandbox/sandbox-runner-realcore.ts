// Real-core engine for `sandbox_6502_run` (Spec 788 tail, piece B).
//
// Drop-in replacement for `runSandbox` (sandbox-runner.ts): SAME
// `SandboxRunOptions` in, SAME `SandboxRunResult` out — so the tool handler
// (server-tools/sandbox.ts) swaps one import and its output-line formatting is
// byte-for-byte unchanged. The difference is the ENGINE: instead of driving the
// flat-64K TS `Cpu6502` shadow, it shells out to the sibling TRX64 real 6502
// core (`trx64cli sandbox --json`), so a routine that touches banking / IO
// executes for real.
//
// Faithfulness to the shadow it replaces (matched for the common `ram` case):
//   * DIRECT-ENTRY — PC=entry + reg-seed + the staged RTS sentinel
//     ($01FE=$FD/$01FF=$FF ⇒ RTS → $FFFE), byte-identical to the TS runner
//     (sandbox-runner.ts:127-130). Never the `jsr entry` stub.
//   * `--io $34` — all-RAM ($A000-$FFFF + $D000-$DFFF = RAM), reproducing the
//     shadow's flat-64K "no ROM / no IO visible" memory model (the tool doc:
//     "load code/data into a flat 64K RAM").
//   * A single full-RAM harvest ($0000:0x10000); memory snapshots and the
//     output PRG span are sliced from it locally (deterministic run).
//
// Issue #17 — the harvest is authoritative about what the run WROTE. The full
// 64K slice above is a snapshot of a whole machine, most of which this routine
// never touched; the write set says which of it is output. `writtenRuns` carries
// the runs and their bytes, `memorySnapshots[].bytes` holes out everything the
// run did not store, and `writtenSpan` no longer gap-fills with zeroes. See
// sandbox-types.ts for the reasoning.
//
// Documented divergences from the shadow (inherent to the real-core write-map):
//   * `writes` is the real core's DISTINCT-address write set (>$01ff), not the
//     shadow's temporal event list — so `Writes returned: N` counts distinct
//     written addresses. Writes to $0000-$01ff (ZP / stack / CPU-port machinery)
//     are excluded from the map.
//   * The unimplemented-opcode line never emits (the real core is a full ISA).
//
// Read-only ROM overlay loads (`mapping: rom | ef_roml | ef_romh`) are NOT
// reproduced here — an arbitrary-address read-only overlay with writes falling
// to RAM-under maps to cart/ultimax geometry that is genuinely ambiguous (e.g.
// ef_romh at $E000 = ultimax, where there is no RAM-under to catch the writes).
// Rather than fake it, such a load is rejected with an actionable error (the
// common, correct case is `ram`).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CpuWrite,
  LoadMapping,
  MemoryWindow,
  SandboxCpuState,
  SandboxLoad,
  SandboxRunOptions,
  SandboxRunResult,
  StopReason,
  WrittenRun,
} from "./sandbox-types.js";
import { hexToBytes, hx2, hx4, resolveTrx64Cli, runTrx64Sandbox } from "./trx64cli.js";

// A single load resolved to raw bytes + address (files read, PRG headers
// stripped) — the uniform shape we materialise every SandboxLoad into.
interface ResolvedLoad {
  address: number;
  bytes: Uint8Array;
}

function toU8(input: number[] | Uint8Array | ArrayLike<number>): Uint8Array {
  return input instanceof Uint8Array ? input : Uint8Array.from(Array.from(input));
}

// Resolve a SandboxLoad to (address, bytes), rejecting the read-only overlay
// mappings the real-core engine does not reproduce. Mirrors sandbox-runner.ts
// applyLoad's address/bytes derivation.
function resolveLoad(load: SandboxLoad, idx: number): ResolvedLoad {
  const mapping: LoadMapping = (load as { mapping?: LoadMapping }).mapping ?? "ram";
  if (mapping !== "ram") {
    throw new Error(
      `loads[${idx}]: mapping "${mapping}" (read-only ROM overlay) is not supported by the ` +
        `real-core sandbox engine. Only "ram" is reproduced. A read-only overlay whose writes ` +
        `fall to RAM-under maps to cart/ultimax geometry that is ambiguous on the real core ` +
        `(e.g. ef_romh at $E000 = ultimax, no RAM-under). Use "ram", or handle the overlay ` +
        `as a real cart via a full runtime session.`,
    );
  }
  if ("bytes" in load) {
    return { address: load.address & 0xffff, bytes: toU8(load.bytes) };
  }
  if ("prgPath" in load) {
    const buf = readFileSync(load.prgPath);
    const address = load.loadAddressOverride ?? (buf[0]! | (buf[1]! << 8));
    return { address: address & 0xffff, bytes: Uint8Array.from(buf.subarray(2)) };
  }
  const buf = readFileSync(load.rawPath);
  return { address: load.address & 0xffff, bytes: Uint8Array.from(buf) };
}

/**
 * Run a 6502 routine on the TRX64 real core. Drop-in for `runSandbox` —
 * identical `SandboxRunOptions` in, identical `SandboxRunResult` out.
 */
export function runSandboxRealCore(options: SandboxRunOptions): SandboxRunResult {
  // Materialise loads up front so a bad mapping / missing file fails before we
  // spawn anything.
  const resolved = options.loads.map((l, i) => resolveLoad(l, i));

  const cli = resolveTrx64Cli();
  const maxSteps = options.maxSteps ?? 10_000_000;

  const tmp = mkdtempSync(join(tmpdir(), "c64re-sandbox-"));
  try {
    const args: string[] = [
      "sandbox",
      "--entry", hx4(options.initialPc),
      // TS-faithful entry: PC=entry, reg-seed, staged RTS sentinel — not the
      // `jsr entry` stub (sandbox-runner.ts sets PC directly + stages $01FE/$01FF).
      "--direct-entry",
      // All-RAM: reproduce the flat-64K TS shadow ($A000-$FFFF + $D000-$DFFF = RAM,
      // no ROM / no IO). The tool doc: "load code/data into a flat 64K RAM".
      "--io", "$34",
      // The shadow caps on instruction count only; make the cycle cap non-binding
      // (generous multiple, bounded) so the instruction cap is what stops a runaway.
      "--instr-cap", String(maxSteps),
      "--cyc-cap", String(Math.min(maxSteps * 16, 8_000_000_000)),
      // One deterministic full-RAM harvest; snapshots + the PRG span are sliced
      // from it locally (final RAM == last write under all-RAM).
      "--harvest", "$0000:0x10000",
      "--json",
    ];

    // Loads → temp files (`--load FILE@ADDR`; avoids arg-length limits).
    resolved.forEach((r, i) => {
      const file = join(tmp, `load${i}.bin`);
      writeFileSync(file, r.bytes);
      args.push("--load", `${file}@${hx4(r.address)}`);
    });

    // Zero-page seeds (src/dst pointers etc.).
    for (const [k, v] of Object.entries(options.initialZp ?? {})) {
      args.push("--zp", `${hx2(Number(k))}=${hx2(v)}`);
    }

    // Entry registers — only when the caller set them (else the real core's
    // direct-entry defaults A/X/Y=0, SP=$FD, P=$22 match the TS Cpu6502 defaults).
    if (options.initialA !== undefined) args.push("--reg-a", hx2(options.initialA));
    if (options.initialX !== undefined) args.push("--reg-x", hx2(options.initialX));
    if (options.initialY !== undefined) args.push("--reg-y", hx2(options.initialY));
    if (options.initialSp !== undefined) args.push("--reg-sp", hx2(options.initialSp));
    if (options.initialFlags !== undefined) args.push("--reg-p", hx2(options.initialFlags));

    // stop_pc → an extra sentinel breakpoint (maps to the "stop_pc" vocab).
    if (options.stopPc !== undefined) args.push("--sentinel", hx4(options.stopPc));

    // Stream hooks + fed bytes (get_byte replacement).
    for (const pc of options.streamHookPcs ?? []) args.push("--stream-hook", hx4(pc));
    if (options.inputStream && options.inputStream.length > 0) {
      const streamFile = join(tmp, "stream.bin");
      writeFileSync(streamFile, toU8(options.inputStream));
      args.push("--stream", streamFile);
    }

    const j = runTrx64Sandbox(cli, args);

    // Full 64K RAM as written (raw slice, banking ignored).
    const ram = hexToBytes(j.harvest.hex);

    // The run's FULL write set as a per-address mask — one byte per address is
    // cheap (64 KiB) and it is what makes a gap answerable for any window the
    // caller asks about. Deliberately NOT narrowed by returnWritesRange:
    // "did the CPU store here" is a fact about the run, not about the filter.
    const wrote = new Uint8Array(0x10000);
    for (const { lo, hi } of j.writtenRuns) {
      for (let a = lo; a <= hi; a++) wrote[a] = 1;
    }

    // Reconstruct the shadow's write-derived fields from the real core's
    // write-map (contiguous runs of distinct written addresses >$01ff), clipped
    // to returnWritesRange when the caller set one.
    const range = options.returnWritesRange;
    const writes: CpuWrite[] = [];
    const writtenMap: Record<number, number> = {};
    const writtenRuns: WrittenRun[] = [];
    for (const { lo, hi } of j.writtenRuns) {
      const a0 = range ? Math.max(lo, range.start) : lo;
      const a1 = range ? Math.min(hi, range.end) : hi;
      if (a1 < a0) continue; // the clip removed this run entirely
      const runBytes: number[] = [];
      for (let a = a0; a <= a1; a++) {
        const value = ram[a] ?? 0;
        writes.push({ address: a, value });
        writtenMap[a] = value;
        runBytes.push(value);
      }
      writtenRuns.push({ lo: a0, hi: a1, bytes: runBytes });
    }

    // writtenSpan: min..max of the written addresses. The shadow gap-filled the
    // holes with 0 (sandbox-runner.ts:166-176) — 0 is a plausible byte and the
    // caller could not tell it from a stored zero, so the holes are now `null`.
    // The span is a convenience; `writtenRuns` is the answer.
    let writtenSpan: SandboxRunResult["writtenSpan"] = null;
    const addrs = Object.keys(writtenMap).map(Number).sort((a, b) => a - b);
    if (addrs.length > 0) {
      const start = addrs[0]!;
      const end = addrs[addrs.length - 1]!;
      const bytes: (number | null)[] = new Array(end - start + 1).fill(null);
      for (const [addrStr, value] of Object.entries(writtenMap)) {
        bytes[Number(addrStr) - start] = value;
      }
      writtenSpan = { start, end, bytes };
    }

    // Memory snapshots. The raw RAM slice survives as `observed` — a caller who
    // wants the machine's window (e.g. to read back bytes it LOADED) still has
    // it, by name. `bytes` is the written-only view: a hole where this run never
    // stored, so residue can never arrive as payload through the default field.
    const memorySnapshots: MemoryWindow[] = (options.returnMemoryRanges ?? []).map((r) => {
      const observed = Array.from(ram.subarray(r.start, r.end + 1));
      let unwritten = 0;
      const bytes = observed.map((value, i) => {
        if (wrote[r.start + i]) return value;
        unwritten += 1;
        return null;
      });
      return { start: r.start, end: r.end, bytes, observed, unwritten };
    });

    const finalState: SandboxCpuState = {
      pc: j.pc & 0xffff,
      a: j.finalRegs.a & 0xff,
      x: j.finalRegs.x & 0xff,
      y: j.finalRegs.y & 0xff,
      sp: j.finalRegs.sp & 0xff,
      flags: j.finalRegs.p & 0xff,
      cycles: j.cycles,
    };

    return {
      stopReason: j.stopReason as StopReason | "stop_pc",
      steps: j.steps,
      finalState,
      writes,
      writtenMap,
      writtenRuns,
      writtenSpan,
      memorySnapshots,
      streamPos: j.streamPos,
      // Never set: the real core implements the full ISA (no unimplemented op).
      unimplementedOpcode: undefined,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
