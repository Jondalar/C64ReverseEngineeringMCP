import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSandboxRealCore, type SandboxLoad } from "../sandbox/index.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

function parseHexWord(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
    throw new Error(`Invalid 16-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function parseHexByte(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,2}$/.test(normalized)) {
    throw new Error(`Invalid 8-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function parseHexBytes(value: string): number[] {
  const cleaned = value.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})+$/.test(cleaned)) {
    throw new Error("hex_bytes must be an even-length hex string");
  }
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

function formatHexWord(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

// Issue #17 — a byte this run never wrote is a HOLE, and it renders as one.
// "--" is not hex, so it cannot be read back as a byte by eye or by a parser.
function formatMaybeByte(value: number | null): string {
  return value === null ? "--" : formatHexByte(value);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

// "$4000-$4001 (2 bytes), $4010-$4010 (1 byte)" — capped, because a scattered
// depacker can produce hundreds and the point is the SHAPE, not the whole list.
//
// The cap used to end in ", … +6 more", which reads like a footnote and is not one:
// one of six hidden runs was a 2000-byte write, and the only reason the caller noticed
// was that 11 088 packed bytes cannot expand to the 4825 the visible list added up to.
// So the tail now names the largest hidden run, states the hidden total in BYTES as
// well as in runs, and says which argument shows the rest.
const RUN_LIST_CAP = 12;
// How many PRGs one `output_path` may fan out to. A gapped write set becomes one
// file per run; past this many runs the honest answer is no file at all, not a
// directory full of fragments and not one file with invented bytes in it.
const OUTPUT_FILE_CAP = 64;
function formatRunList(runs: Array<{ lo: number; hi: number }>, from = 0): string {
  const size = (r: { lo: number; hi: number }) => r.hi - r.lo + 1;
  const start = Math.min(Math.max(0, from), Math.max(0, runs.length - 1));
  const window = runs.slice(start, start + RUN_LIST_CAP);
  const shown = window.map((r) => `$${formatHexWord(r.lo)}-$${formatHexWord(r.hi)} (${size(r)} ${plural(size(r), "byte")})`);
  const hidden = [...runs.slice(0, start), ...runs.slice(start + window.length)];
  if (hidden.length === 0) return shown.join(", ");
  const hiddenBytes = hidden.reduce((n, r) => n + size(r), 0);
  const biggest = hidden.reduce((a, b) => (size(b) > size(a) ? b : a));
  const next = start + window.length;
  return `${shown.join(", ")}\n  NOT SHOWN: ${hidden.length} further ${plural(hidden.length, "run")} totalling ${hiddenBytes} ${plural(hiddenBytes, "byte")}`
    + ` — the largest is $${formatHexWord(biggest.lo)}-$${formatHexWord(biggest.hi)} (${size(biggest)} ${plural(size(biggest), "byte")}).`
    + (next < runs.length ? ` Pass write_runs_from=${next} for the next page.` : ` Pass write_runs_from=0 to page from the start.`);
}

const memBlockSchema = z.object({
  // Resolved against project dir if relative.
  prg_path: z.string().optional().describe("Path to a PRG file. First two bytes are load address."),
  raw_path: z.string().optional().describe("Path to a raw blob loaded at `address`."),
  hex_bytes: z.string().optional().describe("Inline hex bytes loaded at `address`."),
  address: z.string().optional().describe("Load address as hex (required for raw_path / hex_bytes)."),
  load_address_override: z.string().optional().describe("Override the PRG load address (rare)."),
  mapping: z.enum(["ram", "rom", "ef_roml", "ef_romh"]).optional().describe("Read/write mapping for this load. \"ram\" (default) is fully writable. \"rom\"/\"ef_roml\"/\"ef_romh\" map the bytes as a READ-ONLY overlay: CPU reads in this range return the load's bytes, writes pass through to a parallel RAM array under the same addresses. Use this for cart depackers where source ($8000+ in ROM) and destination ($8000+ in RAM) collide in a flat sandbox. The CPU port at $01 is NOT emulated — both ef_roml and ef_romh just install the read-only overlay."),
});

export function registerSandboxTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "sandbox_6502_run",
    "Run a 6502 routine in an isolated sandbox: load code/data into a flat 64K RAM, optionally hook PCs to feed bytes from an input stream (e.g. replace a serial-recv subroutine), execute until a stop PC / sentinel RTS / max steps / unimplemented opcode, and return the writes plus final CPU state. Use this for porting depackers, crypto, and custom I/O routines without standing up a full C64 emulator. Sentinel RTS exits when the stack returns to $FFFE (pre-staged at $01FE=$FD, $01FF=$FF). The CPU supports common undocumented opcodes (RLA, SLO, RRA, ISC, LAX, SAX, DCP, ALR, ARR, AXS, ANC, undoc NOPs, JAM). Only the bytes the routine actually STORED are payload: the output names the written runs, and a memory range you ask for prints \"--\" wherever this run never wrote (the machine's own residue and your own loaded bytes both count as never-written). A harvest taken before this rule existed cannot tell the two apart, so re-run anything you kept from one. Zero page and the stack count as output, not as machinery — $0000-$01FF is reported too, judged by change against the run's own pre-run image. Not for depacking specifically (use sandbox_depack) or a full-machine boot (use runtime_session_run).",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from the first path in loads[] to knowledge/phase-plan.json."),
      loads: z.array(memBlockSchema).min(1).describe("Memory loads applied in order. Each entry must specify exactly one of prg_path / raw_path / hex_bytes."),
      initial_pc: z.string().describe("Hex PC where execution starts."),
      initial_zp: z.record(z.string(), z.number().int().min(0).max(255)).optional().describe("Zero-page seed values, keyed by hex zp address (e.g. {\"06\": 0, \"07\": 64})."),
      initial_a: z.number().int().min(0).max(255).optional().describe("Accumulator at entry. Defaults to 0."),
      initial_x: z.number().int().min(0).max(255).optional().describe("X at entry. Defaults to 0."),
      initial_y: z.number().int().min(0).max(255).optional().describe("Y at entry. Defaults to 0."),
      initial_sp: z.number().int().min(0).max(255).optional().describe("Initial SP. Defaults to $FD with sentinel staged."),
      initial_flags: z.number().int().min(0).max(255).optional().describe("Processor status (P) at entry. Defaults to $22."),
      input_stream_path: z.string().optional().describe("Path to a file whose bytes are streamed via the hook PCs."),
      input_stream_hex: z.string().optional().describe("Inline hex stream bytes (alternative to input_stream_path)."),
      stream_hook_pcs: z.array(z.string()).optional().describe("List of hex PCs that should be replaced by 'next stream byte → A; C=0; RTS'."),
      stop_pc: z.string().optional().describe("Optional stop PC in hex."),
      max_steps: z.number().int().positive().optional().describe("Maximum instructions executed (default 10_000_000)."),
      return_writes_start: z.string().optional().describe("Restrict returned writes to start ≤ addr ≤ end (hex)."),
      return_writes_end: z.string().optional().describe("Upper bound (hex, inclusive) of that write filter. Pass it together with return_writes_start; either alone is ignored. It narrows what is REPORTED, never what the run is judged to have written — a memory range still marks a hole wherever the CPU never stored."),
      write_runs_from: z.number().int().nonnegative().optional().describe("Page the \"Written runs\" list: the index of the first run to print (12 per page). The report always states how many runs and how many bytes are NOT shown and names the largest hidden run, so a truncated list can never be read as the whole story."),
      return_memory_ranges: z.array(z.object({ start: z.string(), end: z.string() })).optional().describe("Memory ranges to snapshot at end of run. Bytes this run never wrote print as \"--\", not as data — a range wider than the routine's output is safe to ask for."),
      include_observed: z.boolean().optional().describe("Also print the RAW sandbox RAM behind each return_memory_ranges window, un-holed. Off by default because a byte in it that the run never wrote is machine residue (power-on pattern, KERNAL RAM-test leftovers, screen RAM) or your own loaded input. It is NOT a residue-only view: the run's own stores are in there too. Turn it on to read back what you LOADED, or to see what was sitting in a gap."),
      output_path: z.string().optional().describe("If set, write the written bytes as a PRG (2-byte load header + bytes). One file per contiguous written run: a single run goes to this exact path, and a run set with gaps in it gets one file per run, named <path>-$<lo>.<ext>. A gap is never filled to make one file, because those bytes were never written. Past 64 runs nothing is written at all — narrow with return_writes_start / return_writes_end instead."),
    },
    safeHandler("sandbox_6502_run", async (args) => {
      try {
        // Spec 833 D5 — the project hint. Every other path-taking tool passes one
        // (`project_dir ?? image_path` in disk-g64.ts); this one passed
        // `undefined`, so the resolver had nothing to walk up from and fell back
        // to C64RE_PROJECT_DIR or to the process cwd happening to sit inside a
        // project — the cwd coupling a DEFAULT tool may not have. The hint is an
        // explicit project_dir, else the first loads[] entry that carries a path,
        // which the tool already resolves against the project root.
        const firstLoadPath = args.loads.map((entry) => entry.prg_path ?? entry.raw_path).find((p) => !!p);
        const projectHint = args.project_dir ?? firstLoadPath;
        // A loads[] made only of hex_bytes carries NO path — and such a run needs
        // no project either: every byte is inline, and a project root is only ever
        // used to resolve a RELATIVE path. So the root is resolved on first use
        // instead of up front: a fully inline run never asks for one, and no
        // longer fails outside a project for a filesystem it does not touch. A run
        // that does name a path gets the hint above; only a relative path with no
        // project_dir and no other load path to walk up from still reaches the
        // resolver's env/cwd fallback, and it then fails with the resolver's own
        // message naming what to pass.
        let resolvedProjectRoot: string | undefined;
        const projectRoot = (): string => (resolvedProjectRoot ??= context.projectDir(projectHint, true));
        const loads: SandboxLoad[] = args.loads.map((entry, idx) => {
          const provided = [entry.prg_path, entry.raw_path, entry.hex_bytes].filter(Boolean).length;
          if (provided !== 1) {
            throw new Error(`loads[${idx}]: specify exactly one of prg_path, raw_path, hex_bytes`);
          }
          if (entry.prg_path) {
            return {
              prgPath: resolve(projectRoot(), entry.prg_path),
              loadAddressOverride: entry.load_address_override ? parseHexWord(entry.load_address_override) : undefined,
              mapping: entry.mapping,
            };
          }
          if (entry.raw_path) {
            if (!entry.address) throw new Error(`loads[${idx}]: address is required for raw_path`);
            return { rawPath: resolve(projectRoot(), entry.raw_path), address: parseHexWord(entry.address), mapping: entry.mapping };
          }
          if (!entry.address) throw new Error(`loads[${idx}]: address is required for hex_bytes`);
          return { bytes: parseHexBytes(entry.hex_bytes!), address: parseHexWord(entry.address), mapping: entry.mapping };
        });

        const initialZp: Record<number, number> = {};
        for (const [zpStr, value] of Object.entries(args.initial_zp ?? {})) {
          initialZp[parseHexByte(zpStr)] = value;
        }

        let inputStream: number[] | undefined;
        if (args.input_stream_path) {
          const { readFileSync } = await import("node:fs");
          inputStream = Array.from(readFileSync(resolve(projectRoot(), args.input_stream_path)));
        } else if (args.input_stream_hex) {
          inputStream = parseHexBytes(args.input_stream_hex);
        }

        const writesRange = (args.return_writes_start && args.return_writes_end)
          ? { start: parseHexWord(args.return_writes_start), end: parseHexWord(args.return_writes_end) }
          : undefined;

        const result = runSandboxRealCore({
          loads,
          initialPc: parseHexWord(args.initial_pc),
          initialZp,
          initialA: args.initial_a,
          initialX: args.initial_x,
          initialY: args.initial_y,
          initialSp: args.initial_sp,
          initialFlags: args.initial_flags,
          inputStream,
          streamHookPcs: args.stream_hook_pcs?.map(parseHexWord),
          stopPc: args.stop_pc !== undefined ? parseHexWord(args.stop_pc) : undefined,
          maxSteps: args.max_steps,
          returnWritesRange: writesRange,
          returnMemoryRanges: args.return_memory_ranges?.map((r) => ({ start: parseHexWord(r.start), end: parseHexWord(r.end) })),
        });

        const lines = [
          `sandbox_6502_run finished.`,
          `Stop reason: ${result.stopReason}`,
          `Steps: ${result.steps}`,
          `Final PC: $${formatHexWord(result.finalState.pc)} A=$${formatHexByte(result.finalState.a)} X=$${formatHexByte(result.finalState.x)} Y=$${formatHexByte(result.finalState.y)} SP=$${formatHexByte(result.finalState.sp)} FL=$${formatHexByte(result.finalState.flags)}`,
          `Stream pos: ${result.streamPos}`,
          `Writes returned: ${result.writes.length}`,
        ];
        // (The real core implements the full ISA, so runSandboxRealCore never
        // reports an unimplemented opcode — the old formatting branch that
        // imported opcode-table.ts was dead and was removed with the shadow.)
        // Issue #17 — the runs ARE the answer. They come before the span,
        // because the span is only a bounding box and a bounding box over
        // disjoint runs contains addresses this routine never touched.
        const runs = result.writtenRuns;
        if (runs.length > 0) {
          const runBytes = runs.reduce((n, r) => n + (r.hi - r.lo + 1), 0);
          lines.push(`Written runs: ${runs.length}, ${runBytes} ${plural(runBytes, "byte")} in all — ${formatRunList(runs, args.write_runs_from ?? 0)}`);
        } else {
          lines.push(`Written runs: 0 — this run left no byte of the machine different from how it found it, in main memory or in zero page and the stack.`);
        }
        // Issue: the low pages used to be silently outside the answer, and the
        // description of `include_observed` called what the routine stored there
        // "residue". Zero page IS where 6502 code keeps its state.
        const low = result.lowMemory;
        if (!low.tracked) {
          lines.push(`WARNING: zero page and the stack ($0000-$01FF) are NOT in the numbers above — ${low.note ?? "the runtime did not report them"}.`);
        } else if (low.changed > 0) {
          const where = low.runs.map((r) => (r.lo === r.hi ? `$${formatHexWord(r.lo)}` : `$${formatHexWord(r.lo)}-$${formatHexWord(r.hi)}`)).slice(0, 16).join(", ");
          const more = low.runs.length > 16 ? `, … +${low.runs.length - 16} more` : "";
          lines.push(`Zero page + stack: ${low.changed} ${plural(low.changed, "byte")} written — ${where}${more}. They are counted in the runs above.`);
        }
        if (result.writtenSpan) {
          const holes = result.writtenSpan.bytes.filter((b) => b === null).length;
          const gapNote = holes > 0
            ? `, ${holes} of them NEVER WRITTEN (the span crosses ${runs.length - 1} ${plural(runs.length - 1, "gap")} — use the runs above, not the span)`
            : "";
          lines.push(`Write span: $${formatHexWord(result.writtenSpan.start)}-$${formatHexWord(result.writtenSpan.end)} (${result.writtenSpan.bytes.length} bytes${gapNote})`);
        }
        for (const snap of result.memorySnapshots) {
          const preview = snap.bytes.slice(0, 32).map(formatMaybeByte).join(" ");
          const ell = snap.bytes.length > 32 ? " …" : "";
          const gapNote = snap.unwritten > 0
            ? `, ${snap.unwritten} never written by this run — shown as --`
            : "";
          lines.push(`Memory $${formatHexWord(snap.start)}-$${formatHexWord(snap.end)} (${snap.bytes.length} bytes${gapNote}): ${preview}${ell}`);
          if (args.include_observed) {
            const raw = snap.observed.slice(0, 32).map(formatHexByte).join(" ");
            lines.push(`  observed RAM (the raw window at stop — machine residue, your loaded input AND this run's own stores, together): ${raw}${ell}`);
          }
        }

        if (args.output_path && runs.length > OUTPUT_FILE_CAP) {
          // A routine that scatters single bytes (a screen fill, a table poke)
          // can produce hundreds of runs, and one file each is not an output —
          // it is a mess. Write nothing rather than either a mess or a single
          // gap-filled file, and say how to ask for the part that is wanted.
          lines.push(
            `Wrote NO PRG: this run left ${runs.length} separate written runs, more than the ${OUTPUT_FILE_CAP} files ` +
              `this tool will emit. Nothing was written, because the alternative is one file with ${result.writtenSpan ? result.writtenSpan.bytes.filter((b) => b === null).length : 0} ` +
              `bytes in it that the routine never stored. Narrow with return_writes_start / return_writes_end and call again.`,
          );
        } else if (args.output_path && runs.length > 0) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname, extname } = await import("node:path");
          const outPath = resolve(projectRoot(), args.output_path);
          mkdirSync(dirname(outPath), { recursive: true });
          // One PRG per contiguous run. The old behaviour wrote ONE file over the
          // whole span with the holes zero-filled — those zeroes were bytes the
          // routine never stored, and a PRG has no way to say "hole". So a gap
          // splits the output instead of being invented away.
          const ext = extname(outPath);
          const stem = ext ? outPath.slice(0, -ext.length) : outPath;
          for (const run of runs) {
            const path = runs.length === 1 ? outPath : `${stem}-$${formatHexWord(run.lo)}${ext}`;
            const buf = Buffer.alloc(2 + run.bytes.length);
            buf[0] = run.lo & 0xff;
            buf[1] = (run.lo >> 8) & 0xff;
            for (let i = 0; i < run.bytes.length; i++) buf[2 + i] = run.bytes[i]!;
            writeFileSync(path, buf);
            lines.push(`Wrote PRG: ${path} ($${formatHexWord(run.lo)}-$${formatHexWord(run.hi)}, ${run.bytes.length} written ${plural(run.bytes.length, "byte")})`);
          }
          if (runs.length > 1) {
            lines.push(`  ${runs.length} files, one per written run — the gaps between them were never written, so they are not in any file.`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return context.cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
));
}
