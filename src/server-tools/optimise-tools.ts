// Spec 862 §6 — one tool over the rule table.
//
// `optimisation_candidates` — a scope, optionally a capture to rank by, and
// the rule classes to use. It answers with where it looked, what it refused to
// touch and why, the candidates in gain order with a verdict on each, and a
// counter per rule.
//
// Text only. A tool that also returns `structuredContent` hides its own report
// from the model that called it (`npm run check:text-only-tools`).
//
// NOTHING IS APPLIED. This tool reads bytes and writes none — not the PRG, not
// the graph, not a record. Turning a candidate into a patch is a deliberate,
// separate act with its own door.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";
import { parseAddress } from "./cost-tools.js";
import { DEFAULT_CLASSES, type RuleClass } from "../optimise/rules.js";

const PROJECT = z.string().optional().describe("Project root. Defaults to the session's project.");

function text(s: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: s }] };
}

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

export function registerOptimiseTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "optimisation_candidates",
    "Where this code could be faster, with a deterministic verdict on every suggestion. Each rule — a `jsr`+`rts` that could be a `jmp`, a load nothing needs, a `clc` where the carry is already what it would set, a `jmp` to a `jmp`, a table read that pays for crossing a page, a variable that belongs in zero page, a loop that could count down — is a heuristic that may be wrong about whether it applies, so nothing is shown without the answer beside it: both versions executed symbolically and compared over the registers, the flags that are still live there, every memory cell either writes and every access to $D000-$DFFF in order. A suggestion that comes back NOT EQUIVALENT has proposed nothing and is dropped and counted, so a rule that is often wrong is visible as such. Code whose purpose IS its timing is refused outright and listed with the reason — delay loops, raster waits, drive and fastloader handshakes, self-modified bytes, an indirect jump. With a trace the list is ranked by cycles saved per frame; without one by what each change saves once, and the report says which. Undocumented opcodes are a class of their own and are off until you ask for them. Nothing is applied: turning a candidate into a patch is runtime_candidate_patch, on purpose. Use it to find what is worth speeding up in a routine, a payload or a whole program. Not for pricing code you have already chosen (use code_cost) and not for what a change would break (use change_impact). Inputs: prg_path or payload, optional ref / address_start / address_end, trace_path, classes. Returns: where it looked, what it left alone, the ranked candidates with their verdicts and assumptions, and a counter per rule.",
    {
      project_dir: PROJECT,
      prg_path: z.string().optional().describe("The PRG whose bytes are scanned; it carries its own load address. Absolute, or relative to the project. Give this or payload."),
      payload: z.string().optional().describe("A payload or artifact to scan instead — its id, its title, or its path in the project. Its file is the byte source."),
      ref: z.string().optional().describe("One routine to scan: a name, or a node id any graph tool returned. Omitted, every routine the graph knows inside the image is scanned."),
      address_start: z.string().optional().describe("Scan this range instead ($C000 or a number). With address_end."),
      address_end: z.string().optional().describe("The last address of the range, inclusive. Defaults to the end of the image."),
      trace_path: z.string().optional().describe("A finalized capture (.duckdb) to rank by — from trace_cost, or any capture of this code running. With it the list is ordered by cycles saved per frame and a page crossing becomes an exact count instead of a possibility."),
      classes: z.array(z.enum(["local", "dataflow", "structural", "undocumented"])).optional()
        .describe("Which rule classes to use. Default local, dataflow and structural. \"undocumented\" adds the rules that rewrite into LAX, DCP and the other stable illegal opcodes — off unless you ask, because using them is a decision about which machines the result must run on."),
      limit: z.number().int().min(1).max(200).optional().describe("How many candidates to list (default 40). The counters always cover all of them."),
      show_rules: z.boolean().optional().describe("Print the rule table — what each rule looks for, what it requires, what it becomes and what it saves — instead of scanning."),
    },
    safeHandler("optimisation_candidates", async (args) => {
      const { project_dir, prg_path, payload, ref, address_start, address_end, trace_path, classes, limit, show_rules } = args;

      if (show_rules === true) {
        const { formatRuleTable } = await import("../optimise/format.js");
        return text(formatRuleTable());
      }

      const projectDir = context.projectDir(project_dir ?? prg_path, false);
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      // ---- the byte source -------------------------------------------------
      let source: string | null = prg_path ? abs(prg_path) : null;
      if (!source && payload) {
        source = await resolvePayload(projectDir, payload);
        if (!source) {
          return text(
            `optimisation_candidates: nothing in this project is called "${payload}". list_artifacts and list_payloads say what there is; ` +
            "or give prg_path directly.",
          );
        }
      }
      if (!source) {
        return text(
          "optimisation_candidates: give the bytes to scan — `prg_path` (a PRG, which carries its own load address) or `payload` " +
          "(an artifact in this project). A routine name alone is not enough: the graph holds where the code is, not what is in it.",
        );
      }
      if (!existsSync(source)) return text(`optimisation_candidates: no such file: ${source}`);

      const raw = readFileSync(source);
      if (raw.length < 3) return text(`optimisation_candidates: ${source} is too short to be a PRG`);
      const load = raw[0]! | (raw[1]! << 8);
      const image = { load, bytes: new Uint8Array(raw.subarray(2)) };
      const imageEnd = load + image.bytes.length - 1;

      // ---- the scope -------------------------------------------------------
      const { routineSpans } = await import("../cost/routine-spans.js");
      const { unitsFromSpans, scanForCandidates } = await import("../optimise/candidates.js");
      const { formatScan } = await import("../optimise/format.js");
      const { freeZeroPage } = await import("../optimise/free-zp.js");
      const { Graph } = await import("../knowledge-graph/query.js");
      const { changeImpact } = await import("../cost/impact.js");

      const spans = routineSpans(projectDir);
      let units = unitsFromSpans(spans, load, imageEnd);
      const header: string[] = [];

      if (address_start) {
        const start = parseAddress(address_start);
        const end = address_end ? parseAddress(address_end) : imageEnd;
        units = [{ label: `${hex4(start)}-${hex4(end)}`, start, end }];
      } else if (ref) {
        const match = spans.filter((s) => s.id === ref || s.label === ref || s.label.toLowerCase() === ref.toLowerCase());
        if (match.length === 0) {
          return text(
            `optimisation_candidates: "${ref}" is not a routine in this project's graph. graph_find says what it does have; ` +
            "or scan a plain range with address_start / address_end.",
          );
        }
        units = unitsFromSpans(match, load, imageEnd);
      } else if (units.length === 0) {
        // No graph routines inside this image: scan the whole thing and say so,
        // rather than answering "nothing to look at" when there plainly is.
        units = [{ label: "the whole image", start: load, end: imageEnd }];
        header.push(
          "  no routine in the graph falls inside this image, so the whole of it was decoded as one run of instructions — " +
          "run analyze_prg and disasm_prg and the scan gets routine boundaries, and with them the data segments it must not decode",
        );
      }

      // ---- the measurement -------------------------------------------------
      let trace = null;
      if (trace_path) {
        const { resolveStorePath } = await import("./trace-store.js");
        const storePath = resolveStorePath(trace_path, context, project_dir ?? trace_path);
        const { evaluateTrace } = await import("../cost/trace-cost.js");
        const { readAnchor, readInstructionRows, readMemRows } = await import("../cost/trace-store-read.js");
        const anchor = await readAnchor(storePath);
        const insns = await readInstructionRows(storePath, { cpu: "c64" });
        const mem = await readMemRows(storePath, { cpu: "c64" });
        trace = evaluateTrace(insns.rows, mem.rows, { cpu: "c64", anchor, routines: spans });
        header.push(`  ranked against ${storePath}: ${trace.evaluated} instance(s), ${trace.frames} frame(s)`);
        if (insns.capped) header.push("  the capture hit the row cap, so the counts below cover only the part that was read");
      }

      // ---- the graph's own verdicts ---------------------------------------
      const graph = Graph.open(projectDir);
      try {
        const report = scanForCandidates({
          image, units,
          classes: (classes as RuleClass[] | undefined) ?? DEFAULT_CLASSES,
          trace,
          freeZp: freeZeroPage(projectDir),
          onDriveCpu: (routineId) => {
            if (!routineId) return false;
            if (routineId.startsWith("c1541:")) return true;
            try { return graph.resolve(routineId).space === "drv"; } catch { return false; }
          },
          writtenInto: (start, end) => {
            const out: string[] = [];
            for (let addr = start; addr <= end && out.length < 3; addr += 1) {
              for (const n of graph.nodesAt(addr)) {
                if (n.platform) continue;
                for (const e of graph.edgesInto(n.id, ["WRITES"])) {
                  if (e.from === n.id) continue;
                  out.push(`${e.fromNode.name ?? e.from} writes ${hex4(addr)}`);
                  break;
                }
              }
            }
            return out;
          },
          impactFor: (range) => {
            try {
              const r = changeImpact(graph, projectDir, `${hex4(range.start)}-${hex4(range.end)}`, { range, maxDepth: 2 });
              const d1 = r.items.filter((i) => i.depth === 1).length;
              const d2 = r.items.filter((i) => i.depth === 2).length;
              return `${d1} reach it directly, ${d2} depend on it, ${r.unknown.length} UNKNOWN, ${r.claims.length} claim(s) would need re-reading` +
                (r.unknown.length ? ` — change_impact ${hex4(range.start)} says which` : "");
            } catch {
              return null;
            }
          },
          ...(limit ? { limit } : {}),
        });
        const title = [
          `optimisation_candidates: ${source}${ref ? ` → ${ref}` : ""}`,
          ...header,
        ].join("\n");
        return text(formatScan(report, title));
      } finally {
        graph.close();
      }
    }),
  );
}

/** A payload or artifact by id, title or path. */
async function resolvePayload(projectDir: string, ref: string): Promise<string | null> {
  const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
  let artifacts;
  try {
    artifacts = new KnowledgeRecords(projectDir).listArtifacts();
  } catch {
    return null;
  }
  const needle = ref.toLowerCase();
  const hit =
    artifacts.find((a) => a.id === ref) ??
    artifacts.find((a) => (a.relativePath ?? "").toLowerCase() === needle) ??
    artifacts.find((a) => (a.title ?? "").toLowerCase() === needle) ??
    artifacts.find((a) => (a.relativePath ?? "").toLowerCase().endsWith(needle));
  if (!hit?.relativePath) return null;
  const path = isAbsolute(hit.relativePath) ? hit.relativePath : join(projectDir, hit.relativePath);
  return existsSync(path) ? path : null;
}
