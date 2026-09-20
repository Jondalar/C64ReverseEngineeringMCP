// Spec 861 §8 — the three instruments, as tools. API first (doctrine rule 6);
// a view over them is a later step.
//
//   change_impact  what a change can break — a walk over the graph
//   code_cost      what the code costs, and whether the new version is the same
//   trace_cost     what it costs on the machine, from a trace the runtime records
//
// Text only. A tool that also returns `structuredContent` hides its own report
// from the model that called it (`npm run check:text-only-tools`).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";
import type { Loc } from "../knowledge-graph/isa-6502.js";

const PROJECT = z.string().optional().describe("Project root. Defaults to the session's project.");

function text(s: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: s }] };
}

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/** "a9 01 8d 20 d0" · "A901 8D20D0" · "$a9,$01" — bytes, however they were pasted. */
export function parseBytes(input: string): Uint8Array {
  const cleaned = input.replace(/0x/giu, " ").replace(/[$,;\n\r\t]/gu, " ").trim();
  if (!cleaned) throw new Error("no bytes given");
  const parts = cleaned.split(/\s+/u);
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]+$/iu.test(p)) throw new Error(`"${p}" is not hex`);
    if (p.length % 2 !== 0) throw new Error(`"${p}" has an odd number of hex digits — a byte is two`);
    for (let i = 0; i < p.length; i += 2) out.push(parseInt(p.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

/** An address as "$C000", "c000", "0xC000" or a decimal number. */
export function parseAddress(value: string | number): number {
  if (typeof value === "number") return value & 0xffff;
  const t = value.trim().replace(/^\$/u, "").replace(/^0x/iu, "");
  if (!/^[0-9a-f]{1,4}$/iu.test(t)) {
    const dec = Number(value);
    if (Number.isFinite(dec)) return dec & 0xffff;
    throw new Error(`"${value}" is not an address ($C000, c000, 0xC000 or a number)`);
  }
  return parseInt(t, 16) & 0xffff;
}

/** The bytes of a range out of a PRG, which carries its load address in its first two. */
function bytesFromPrg(path: string, start: number, end: number): Uint8Array {
  const raw = readFileSync(path);
  if (raw.length < 3) throw new Error(`${path} is too short to be a PRG`);
  const load = raw[0]! | (raw[1]! << 8);
  const body = raw.subarray(2);
  const from = start - load;
  const to = end - load;
  if (from < 0 || from >= body.length) {
    throw new Error(`${hex4(start)} is outside ${path}, which holds ${hex4(load)}-${hex4(load + body.length - 1)}`);
  }
  return new Uint8Array(body.subarray(from, Math.min(body.length, to + 1)));
}

const LOCS = ["A", "X", "Y", "SP", "C", "Z", "N", "V", "D", "I"] as const;

function parseLiveOut(list: readonly string[] | undefined): Set<Loc> | undefined {
  if (!list) return undefined;
  const out = new Set<Loc>();
  for (const raw of list) {
    const t = raw.trim().toUpperCase();
    if (t === "NOTHING" || t === "NONE" || t === "") continue;
    if (!(LOCS as readonly string[]).includes(t)) throw new Error(`"${raw}" is not one of ${LOCS.join(" ")}`);
    out.add(t as Loc);
  }
  return out;
}

export function registerCostTools(server: McpServer, context: ServerToolContext): void {
  // ------------------------------------------------------------ D1
  server.tool(
    "change_impact",
    "What a change to this code can break, from the knowledge graph: who calls, jumps to or branches into it (by depth), who reads what it writes, which pointer or jump table points INTO it, and which documents and findings claim something about it that may be false afterwards. UNKNOWN is a class of its own and is never folded into \"low\" — an indirect jump, a computed return, a write that lands inside the range (self-modifying code), code on the drive's own CPU and every address the graph could not resolve are listed as what they are. With the PRG the range lives in it also names what the change must PRESERVE (the registers and flags still live after it); with a trace store it names the raster lines the code runs in and what a longer version would cost there. Use it before editing bytes, before accepting a candidate patch, and to find the claims a change makes stale. Not for what the code costs (use code_cost) or what it cost on the machine (use trace_cost). Inputs: ref or address_start/address_end, optional prg_path, trace_path, depth. Returns: the walk, ordered depth 1/2/3, then UNKNOWN, then the claims.",
    {
      project_dir: PROJECT,
      ref: z.string().optional().describe("What is changing: a routine name, a node id any graph tool returned, or an address ($C010). Omit it when you give address_start/address_end."),
      address_start: z.string().optional().describe("Start of the changed range, as $C010 or a number. With address_end this replaces ref."),
      address_end: z.string().optional().describe("End of the changed range, inclusive. Defaults to address_start."),
      prg_path: z.string().optional().describe("The PRG whose bytes back this code. Given, the report also says what the change must preserve, read from the code that follows the range (liveness). Absolute, or relative to the project."),
      trace_path: z.string().optional().describe("A trace store (from trace_cost's capture, or any finalized capture). Given, the report also names the raster lines this code ran in and the cycles it occupies there."),
      candidate_cycles: z.number().optional().describe("How many cycles the replacement adds (code_cost's Δ cycles). With trace_path it turns the timing note into a flag against the margin the busiest line has left."),
      depth: z.number().int().min(1).max(3).optional().describe("How far upstream to walk (default 3)."),
    },
    safeHandler("change_impact", async ({ project_dir, ref, address_start, address_end, prg_path, trace_path, candidate_cycles, depth }) => {
      const projectDir = context.projectDir(project_dir ?? prg_path, false);
      const { Graph } = await import("../knowledge-graph/query.js");
      const { changeImpact, formatImpact } = await import("../cost/impact.js");

      if (!ref && !address_start) {
        return text("change_impact: name what is changing — a routine (ref), or address_start (with address_end for a range).");
      }
      const range = address_start
        ? { start: parseAddress(address_start), end: parseAddress(address_end ?? address_start) }
        : undefined;
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      const graph = Graph.open(projectDir);
      try {
        const timing = trace_path ? await timingFor(abs(trace_path), graph, projectDir, range, ref, candidate_cycles) : undefined;
        const report = changeImpact(graph, projectDir, ref ?? `${hex4(range!.start)}-${hex4(range!.end)}`, {
          ...(range ? { range } : {}),
          ...(prg_path ? { prgPath: abs(prg_path) } : {}),
          ...(timing ? { timing } : {}),
          ...(depth ? { maxDepth: depth as 1 | 2 | 3 } : {}),
        });
        return text(formatImpact(report));
      } finally {
        graph.close();
      }
    }),
  );

  // ------------------------------------------------------------ D2
  server.tool(
    "code_cost",
    "What a piece of 6502 costs, and — given two versions — whether they do the same thing. Per basic block: bytes exact, cycles as a span, where the span is only the page crossings and the branches. A loop whose counter is a constant is resolved to its iteration count and costed exactly; any other loop is reported per iteration with its bound marked unknown. For two straight-line versions it also decides EQUIVALENT / NOT EQUIVALENT (with the differing effect as a counter-example) / UNKNOWN (with the reason) by executing both symbolically and comparing A, X, Y, the stack, every memory write and the flags that are still live — and every access to $D000-$DFFF must be the same access in the same order, because reading $DC0D changes the machine. Use it to price a routine and to check a replacement before it is applied. Not for who a change breaks (use change_impact) or what it cost with the VIC in the way (use trace_cost). Inputs: bytes+address, or prg_path+address_start/address_end; optionally the same again as candidate_*; live_out. Returns: the cost, and for two the Δ and the verdict.",
    {
      project_dir: PROJECT,
      bytes: z.string().optional().describe("The code, as hex: \"a5 10 18 69 01 85 10\". Use this or prg_path."),
      address: z.string().optional().describe("Where those bytes run ($C000). Required with bytes."),
      prg_path: z.string().optional().describe("A PRG to take the bytes from; it carries its own load address. Absolute, or relative to the project."),
      address_start: z.string().optional().describe("With prg_path: the first address of the range."),
      address_end: z.string().optional().describe("With prg_path: the last address of the range, inclusive."),
      candidate_bytes: z.string().optional().describe("The replacement, as hex. Given, the answer is a comparison: Δ bytes, Δ cycles and the equivalence verdict."),
      candidate_address: z.string().optional().describe("Where the replacement runs. Defaults to the original's address."),
      candidate_prg_path: z.string().optional().describe("A PRG to take the replacement from, with candidate_start / candidate_end."),
      candidate_start: z.string().optional().describe("With candidate_prg_path: the first address."),
      candidate_end: z.string().optional().describe("With candidate_prg_path: the last address, inclusive."),
      live_out: z.array(z.string()).optional().describe("What is still live AFTER this code: any of A X Y SP C Z N V D I, or [] for nothing. Omitted, every exit the graph cannot see is assumed to leave everything live — the safe direction, and it will call a replacement NOT EQUIVALENT over a flag nobody reads. change_impact names this set for a range in a project."),
      decimal_at_entry: z.enum(["clear", "unknown"]).optional().describe("Decimal mode on entry. Default clear — the C64 runs with D clear, and a block that sets it is modelled as it is. \"unknown\" keeps every add and subtract opaque, which makes more answers UNKNOWN."),
      listing: z.boolean().optional().describe("Include the per-block, per-instruction listing with each instruction's cycles (default false)."),
    },
    safeHandler("code_cost", async (args) => {
      const {
        project_dir, bytes, address, prg_path, address_start, address_end,
        candidate_bytes, candidate_address, candidate_prg_path, candidate_start, candidate_end,
        live_out, decimal_at_entry, listing,
      } = args;
      const projectDir = (() => { try { return context.projectDir(project_dir ?? prg_path, false); } catch { return process.cwd(); } })();
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));
      const { costOf, compareCost, formatOne, formatComparison } = await import("../cost/code-cost.js");

      const take = (
        hexBytes: string | undefined, at: string | undefined,
        path: string | undefined, from: string | undefined, to: string | undefined,
        label: string,
      ): { address: number; bytes: Uint8Array; label: string } | null => {
        if (hexBytes) {
          if (!at) throw new Error(`${label}: give the address those bytes run at`);
          return { address: parseAddress(at), bytes: parseBytes(hexBytes), label };
        }
        if (path) {
          if (!from) throw new Error(`${label}: give address_start (and address_end) for the range inside ${path}`);
          const start = parseAddress(from);
          const end = parseAddress(to ?? from);
          return { address: start, bytes: bytesFromPrg(abs(path), start, end), label };
        }
        return null;
      };

      const original = take(bytes, address, prg_path, address_start, address_end, "original");
      if (!original) return text("code_cost: give the code — `bytes` + `address`, or `prg_path` + `address_start`/`address_end`.");
      const candidate = take(
        candidate_bytes, candidate_address ?? address ?? address_start,
        candidate_prg_path, candidate_start, candidate_end, "candidate",
      );

      const options = {
        ...(parseLiveOut(live_out) ? { liveOut: parseLiveOut(live_out)! } : {}),
        ...(decimal_at_entry ? { decimalAtEntry: decimal_at_entry } : {}),
        listing: listing === true,
      };
      if (!candidate) return text(formatOne(costOf(original, options), options));
      return text(formatComparison(compareCost(original, candidate, options), options));
    }),
  );

  // ------------------------------------------------------------ D3
  server.tool(
    "trace_cost",
    "What code costs ON THE MACHINE, with the cycles the VIC took and how often it ran. Either evaluates a trace store you already have, or records one itself: a machine of its own boots the medium, advances to a frame boundary, marks it, records the cpu and memory channels for the frames you name and finalizes the capture. Per instruction instance it reports the measured cycles (the difference between two trace rows IS the cycles that instruction took), the cycle table's answer with the page crossing and the branch resolved from the trace itself, the 7 cycles of any interrupt dispatch that ran before it, and the remainder — the cycles the VIC stole — with the raster line they were stolen on. Per routine: cycles per call measured and static, calls per frame, share of the frame, stolen and where. An address no single routine covers is counted as unattributed, never guessed. Use it to find what a frame is actually spent on and to check a static estimate against the machine. Not for a static price (use code_cost). Inputs: trace_path, or prg_path/media_path + frames; cpu, address_start/address_end. Returns: the totals, the per-routine table, the per-line table and every instance whose cost could not be pinned.",
    {
      project_dir: PROJECT,
      trace_path: z.string().optional().describe("A finalized trace store (.duckdb) to evaluate. Absolute, or relative to the project. Give this OR a medium to record."),
      prg_path: z.string().optional().describe("A PRG to record: it is booted on a machine of this call's own, which is then ended. Absolute, or relative to the project."),
      media_path: z.string().optional().describe("Any medium to record instead — .crt / .d64 / .g64 / .d81 / .c64re, identified by content."),
      frames: z.number().int().min(1).max(300).optional().describe("How many frames to record once the machine is warm (default 2). The window is yours; the capture records all of it and the query filters (doctrine rule 4)."),
      record_after_steps: z.number().int().min(0).optional().describe("Start recording only after this many steps — the load is rarely what you are measuring. Default 0 (from the moment the medium is in)."),
      domains: z.array(z.string()).optional().describe("Which channels to record. Default the C64's cpu and memory, which is what the arithmetic reads; add drive8-cpu to evaluate the drive's own 6502."),
      steps: z.array(z.string()).optional().describe("What to do while recording, in the capture-scenario notation — `I wait 50 frames`, `I type \"RUN{RETURN}\"`, `I wait until the CPU reaches $0810 within 4000 frames`. Replaces `frames` when given."),
      model: z.string().optional().describe("Which C64 to record on — c64-pal, c64-ntsc, c64-paln. Omitted: the project's model. The arithmetic is PAL-shaped (§6); another model is recorded and evaluated, with its own line and frame lengths taken from the machine."),
      out: z.string().optional().describe("Where to write the capture. Omitted, it lands in a temporary directory that is named in the report."),
      cpu: z.enum(["c64", "drive8"]).optional().describe("Which CPU's rows to evaluate (default c64). The drive lane is REFUSED and says why: what the runtime records there is a deduplicated sample of the drive's program counter with no opcode, not a stream of retired instructions, so there is nothing to price."),
      address_start: z.string().optional().describe("Evaluate only instructions whose pc is at or after this address."),
      address_end: z.string().optional().describe("Evaluate only instructions whose pc is at or before this address."),
      budget_seconds: z.number().optional().describe("How long the recording machine may live before it ends itself (default 120, max 600)."),
    },
    safeHandler("trace_cost", async (args) => {
      const { project_dir, trace_path, prg_path, media_path, frames, steps, model, out, cpu, address_start, address_end, budget_seconds, record_after_steps, domains } = args;
      const projectDir = context.projectDir(project_dir ?? trace_path ?? prg_path ?? media_path, false);
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      const { evaluateTrace, formatTraceCost } = await import("../cost/trace-cost.js");
      const { readAnchor, readInstructionRows, readMemRows } = await import("../cost/trace-store-read.js");
      const { routineSpans } = await import("../cost/routine-spans.js");

      const header: string[] = [];
      let storePath: string;
      if (trace_path) {
        const { resolveStorePath } = await import("./trace-store.js");
        storePath = resolveStorePath(trace_path, context, project_dir ?? trace_path);
        header.push(`trace_cost: ${storePath}`);
      } else if (prg_path || media_path) {
        const medium = abs((prg_path ?? media_path)!);
        if (!existsSync(medium)) return text(`trace_cost: no such medium: ${medium}`);
        const target = out ? abs(out) : join(tmpdir(), `c64re-861-${Date.now()}.duckdb`);
        mkdirSync(dirname(target), { recursive: true });
        const { captureRun } = await import("../cost/capture.js");
        const run = await captureRun({
          projectDir, mediaPath: medium, output: target,
          ...(steps ? { steps } : {}), ...(frames ? { frames } : {}),
          ...(model ? { model } : {}), ...(budget_seconds ? { budgetSeconds: budget_seconds } : {}),
          ...(record_after_steps ? { afterSteps: record_after_steps } : {}),
          ...(domains ? { domains } : {}),
        });
        storePath = run.storePath;
        header.push(`trace_cost: recorded ${medium}`);
        header.push(...run.log.map((l) => `  ${l}`));
      } else {
        return text("trace_cost: give a trace_path to evaluate, or a prg_path / media_path to record one.");
      }

      const window = { cpu: cpu ?? "c64" };
      const anchor = await readAnchor(storePath);
      const insns = await readInstructionRows(storePath, window);
      const mem = await readMemRows(storePath, window);
      const range = address_start
        ? { start: parseAddress(address_start), end: parseAddress(address_end ?? "ffff") }
        : undefined;

      const report = evaluateTrace(insns.rows, mem.rows, {
        cpu: window.cpu, anchor,
        ...(range ? { range } : {}),
        routines: routineSpans(projectDir),
      });
      if (insns.capped) report.notes.push("the instruction stream hit the row cap — the totals below cover only the part that was read");
      if (mem.capped) report.notes.push("the memory stream hit the row cap, so an interrupt entry or a page crossing near the end may be missing");
      return text([...header, "", formatTraceCost(report, `evaluation (${storePath})`)].join("\n"));
    }),
  );
}

/**
 * §2's last paragraph — timing is a direction of impact too. When a measurement
 * exists, the impact names the lines the code runs in and what is left of them.
 */
async function timingFor(
  storePath: string,
  graph: import("../knowledge-graph/query.js").Graph,
  projectDir: string,
  range: { start: number; end: number } | undefined,
  ref: string | undefined,
  candidateCycles: number | undefined,
): Promise<import("../cost/impact.js").TimingImpact | undefined> {
  const { evaluateTrace } = await import("../cost/trace-cost.js");
  const { readAnchor, readInstructionRows, readMemRows } = await import("../cost/trace-store-read.js");
  const { resolveRef } = await import("../knowledge-graph/cards.js");

  let where = range;
  if (!where && ref) {
    const node = resolveRef(graph, ref).find((n) => !n.dangling && !n.platform);
    if (node) where = { start: node.address, end: node.endAddress ?? node.address };
  }
  if (!where) return undefined;

  const anchor = await readAnchor(storePath);
  const insns = await readInstructionRows(storePath, { cpu: "c64" });
  const mem = await readMemRows(storePath, { cpu: "c64" });
  const report = evaluateTrace(insns.rows, mem.rows, { cpu: "c64", anchor, range: where });
  if (report.evaluated === 0) {
    return { lines: `nothing in this capture ran inside ${hex4(where.start)}-${hex4(where.end)}`, worstLine: "so there is no line budget to report", warning: null };
  }
  if (!anchor) {
    return {
      lines: `${report.evaluated} instance(s), ${report.measured} cycles measured`,
      worstLine: "the store has no frame anchor, so the raster lines cannot be named — record with trace_cost and the anchor is written for you",
      warning: null,
    };
  }
  const busiest = [...report.perLine].sort((a, b) => b.cycles - a.cycles)[0]!;
  const lineList = report.perLine.map((l) => l.line);
  const free = Math.max(0, anchor.cyclesPerLine - busiest.cycles);
  const lines = `it runs in raster line${lineList.length === 1 ? "" : "s"} ${summariseLines(lineList)} — ${report.measured} cycles measured over ${report.evaluated} instance(s)`;
  const worstLine = `line ${busiest.line} is its busiest: ${busiest.cycles} of the ${anchor.cyclesPerLine} cycles that line has, ${free} left`;
  const warning =
    candidateCycles !== undefined && candidateCycles > 0
      ? candidateCycles > free
        ? `the replacement adds ${candidateCycles} cycles and line ${busiest.line} has ${free} — it will not fit where this code runs`
        : `the replacement adds ${candidateCycles} cycles into raster-timed code; line ${busiest.line} has ${free} left`
      : null;
  return { lines, worstLine, warning };
}

function summariseLines(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const runs: string[] = [];
  let from = sorted[0], prev = sorted[0];
  for (const l of sorted.slice(1)) {
    if (l === prev! + 1) { prev = l; continue; }
    runs.push(from === prev ? String(from) : `${from}-${prev}`);
    from = l; prev = l;
  }
  if (from !== undefined) runs.push(from === prev ? String(from) : `${from}-${prev}`);
  return runs.join(", ");
}
