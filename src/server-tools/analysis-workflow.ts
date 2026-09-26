import { basename, dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli } from "../run-cli.js";
import { assembleSource } from "../assemble-source.js";
import { rebuildVerification } from "../lib/rebuild-verify.js";
import { ADDRESS_RULE, parseAddress, parseCount } from "../shared/address-rule.js";
import { suggestDepackers } from "../compression-tools.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { listPayloadEntities } from "../project-knowledge/payload-kinds.js";
import { annotationNames, maxLabelLength, namesTooLong, tooLongMessage } from "../project-knowledge/naming.js";
import { runAndFormatClosedLoopSweep } from "./closed-loop-sweep.js";
import { runPayloadReverseWorkflow, runPrgReverseWorkflow, renderPrgReverseWorkflowResult } from "../lib/prg-workflow.js";
import { safeHandler } from "./safe-handler.js";
import { startAnalysisJob, waitForJob, getAnalysisJob } from "./analysis-jobs.js";
import {
  aliasNotice,
  resolveAnalysis,
  resolveByteReading,
  type ByteReading,
} from "./byte-doors.js";
import type { ServerToolContext } from "./types.js";

/** BUG-039 — grace window before analyze_prg switches to job mode. Small PRGs
 *  finish well inside it (identical UX); large ones return a job_id instead of
 *  tripping the MCP host's ~180s stall limit (which drops the connection).
 *  Env override C64RE_ANALYZE_GRACE_MS for tests / tighter host limits. */
const ANALYZE_JOB_GRACE_MS = Number(process.env["C64RE_ANALYZE_GRACE_MS"]) > 0
  ? Number(process.env["C64RE_ANALYZE_GRACE_MS"])
  : 100_000;

const PACKER_DETECTION_THRESHOLD = 0.7;

interface PackerHintRecord {
  format: string;
  confidence: number;
  offset: number;
  length: number;
  unpackedSize?: number;
  reason: string;
  notes?: string[];
}

async function detectPackerHints(args: { projectDir: string; prgPath: string }): Promise<PackerHintRecord[]> {
  try {
    const suggestions = await suggestDepackers({
      projectDir: args.projectDir,
      inputPath: args.prgPath,
    });
    return suggestions
      .filter((entry) => entry.confidence >= PACKER_DETECTION_THRESHOLD && entry.format !== "unknown")
      .map((entry) => ({
        format: entry.format,
        confidence: entry.confidence,
        offset: entry.offset,
        length: entry.length,
        unpackedSize: entry.unpackedSize,
        reason: entry.reason,
        notes: entry.notes,
      }));
  } catch {
    return [];
  }
}

function attachPackerHintsToAnalysis(analysisPath: string, hints: PackerHintRecord[]): void {
  try {
    const raw = readFileSync(analysisPath, "utf8");
    const report = JSON.parse(raw) as Record<string, unknown>;
    report.packerHints = hints;
    writeFileSync(analysisPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // best-effort; the analysis JSON is still valid without hints
  }
}

function summarizePackerHints(hints: PackerHintRecord[]): string[] {
  if (hints.length === 0) return [];
  const lines = ["", "Packer detection:"];
  for (const hint of hints) {
    lines.push(`- ${hint.format} (conf=${hint.confidence.toFixed(2)}) at $${hint.offset.toString(16).toUpperCase()}+$${hint.length.toString(16).toUpperCase()}${hint.unpackedSize !== undefined ? `, unpacked ≈ ${hint.unpackedSize} bytes` : ""}`);
    if (hint.reason) lines.push(`    ${hint.reason}`);
  }
  const top = hints[0]!;
  // A hint under 0.6 is a candidate, not a verdict. The SFX probe only proves that the
  // file's own code decompresses SOMETHING; naming a packer on the strength of that is
  // how a $B3-escape RLE got reported as Exomizer at 0.93.
  if (top.confidence < 0.6) {
    lines.push(`NEXT: no packer is established — the strongest hint is ${top.format} at ${top.confidence.toFixed(2)}, and its reason above says what was and was not shown. Read the depacker stub in the disassembly and identify the codec there before depacking.`);
  } else if (top.format.startsWith("exomizer")) {
    lines.push(`NEXT: this PRG is likely Exomizer-packed. Run depack_exomizer_${top.format === "exomizer_sfx" ? "sfx" : "raw"} on it before treating the analysis output as semantic ground truth.`);
  } else if (top.format === "rle") {
    lines.push("NEXT: this PRG looks RLE-encoded. Run try_depack with format=rle, then re-analyze the unpacked output.");
  } else if (top.format === "byteboozer2") {
    lines.push("NEXT: this PRG looks ByteBoozer2-packed. Run try_depack with format=byteboozer2, then re-analyze the unpacked output.");
  } else {
    lines.push("NEXT: try the matching depacker tool, then re-analyze the unpacked output.");
  }
  return lines;
}

/**
 * Spec 833 D3 — the listing's own verdict on the annotations, read back from
 * the listing.
 *
 * The renderer writes exactly one header line saying what happened to them:
 * applied and how many, found-and-not-applied with the reason, or none found.
 * This wrapper does not render, so it does not get to say — it quotes. That is
 * the whole fix: a caller now reads a rendering result from the renderer and a
 * graph result from the graph, instead of taking one line for both.
 */
function listingAnnotationStatus(asmPath: string): string {
  try {
    // the header is the first ~10 lines; a listing can be megabytes
    const line = readFileSync(asmPath, "utf8")
      .slice(0, 4096)
      .split(/\r?\n/)
      .find((l) => /^\/\/\s+(?:No s|S)emantic annotations/.test(l));
    if (line) return line.replace(/^\/\/\s+/, "");
  } catch {
    // fall through — an unreadable listing is reported as unknown, never as applied
  }
  return "annotation status unknown — the listing header could not be read";
}

/**
 * Spec 838 D3 — say at the tool surface what the analysis did about seeds. The
 * reported bug (issue #16) is half a silent tool: `entry_points` addresses that
 * did nothing, and a graph full of cross-overlay call sites that nobody fed to
 * the disassembler. Both are now in the JSON; this puts them in the answer.
 * Soft: a summary line never breaks the analysis.
 */
function describeCodeSeeds(analysisPath: string): string {
  try {
    if (!existsSync(analysisPath)) return "";
    const report = JSON.parse(readFileSync(analysisPath, "utf8")) as {
      codeSeedReport?: {
        status: string; owner: string; reason?: string; seeds?: Array<{ origin: string }>;
        window?: { start: number; end: number; space: string; bank: number | null; source: string; name: string };
        outOfScope?: Array<{ address: number; detail: string }>;
      };
      rejectedEntryPoints?: Array<{ address: number; reason: string }>;
      strandedByDecodeConflict?: unknown[];
    };
    const lines: string[] = [];
    const seeds = report.codeSeedReport;
    // Spec 867 D1 — the window the seeds were scoped to, said before the seeds.
    const hx = (a: number) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;
    if (seeds?.window) {
      const w = seeds.window;
      lines.push(`Payload window: ${hx(w.start)}-${hx(w.end)} in ${w.space}${w.bank !== null && w.bank !== undefined ? ` bank ${w.bank}` : ""} — ${w.source === "payload" ? "recorded on the payload record" : "the extent this image was analysed at"}. Graph seeds are scoped to it; a window that loads inside it is that payload's business, not this one's.`);
    }
    if (seeds?.status === "ok" && (seeds.seeds?.length ?? 0) > 0) {
      const byOrigin = new Map<string, number>();
      for (const seed of seeds.seeds ?? []) byOrigin.set(seed.origin, (byOrigin.get(seed.origin) ?? 0) + 1);
      lines.push(`Graph code seeds: ${seeds.seeds!.length} for owner "${seeds.owner}" — ${[...byOrigin].sort().map(([o, n]) => `${o}=${n}`).join(", ")}. Addresses only another overlay reaches are disassembled instead of rendered as .byte; the listing names which seed reached each region.`);
    } else if (seeds && seeds.status !== "ok") {
      // The reason can carry the project's entire owner list. Summarised — an old
      // analysis JSON on disk still holds the long form, so it is cut here too, not
      // only where it is written.
      lines.push(`Graph code seeds: none — ${shortenSeedOwners(seeds.reason ?? seeds.status)}`);
    }
    const outOfScope = seeds?.outOfScope ?? [];
    if (outOfScope.length > 0) {
      lines.push(`Out of scope for this window: ${outOfScope.length} cross-owner address${outOfScope.length === 1 ? "" : "es"} — outside the window, or inside a window that loads inside it. Not refusals: they were never this payload's (codeSeedReport.outOfScope).`);
    }
    const rejected = report.rejectedEntryPoints ?? [];
    const refused = rejected.filter((r) => r.reason !== "already_code");
    if (refused.length > 0) {
      const byReason = new Map<string, number>();
      for (const r of refused) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
      lines.push(`Entry points NOT seeded: ${refused.length} (${[...byReason].sort().map(([r, n]) => `${r}=${n}`).join(", ")}) — see rejectedEntryPoints in the JSON. An entry_points list CONSTRAINS this scan; it does not simply add to it.`);
    }
    const stranded = report.strandedByDecodeConflict ?? [];
    if (stranded.length > 0) {
      lines.push(`Bytes stranded by a decode conflict: ${stranded.length} — two seeds decoded the same range at different alignments (strandedByDecodeConflict).`);
    }
    return lines.length > 0 ? `\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

/**
 * ONE address rule, for every address and every byte count these tools accept — and it
 * is not written here. It lives in `src/shared/address-rule.ts`, the only body of code
 * that states it, and the pipeline half compiles the same body as
 * `pipeline/src/lib/address-rule.ts` because ESM and CommonJS cannot import each other.
 * `npm run check:address-rule` proves the two agree and refuses a third copy.
 *
 * It is there rather than here because it has drifted twice. First inside one call:
 * `entry_points` read `"E800"` as hex while the relocation loader ran `parseInt(s, 10)`
 * on it, so `"E800"` became NaN and printed as `null` and `"2000"` became $07D0. That
 * was fixed by writing the rule down — in two files. Then `disasm_raw` was written
 * against the written rule instead of the function, and the pipeline kept four inline
 * `parseInt(x, 16)` sites of its own. A rule stated twice disagrees with itself.
 *
 * The names below are the ones this module has always exported; they now forward.
 */
export { ADDRESS_RULE } from "../shared/address-rule.js";
export const parseAddressStrict = parseAddress;
export const parseCountStrict = parseCount;

/**
 * Does this analysis JSON describe the window it is about to be rendered over?
 *
 * The body lives in `byte-doors.ts`, beside the rule that decided the window in the
 * first place; this name is kept because it is what the gates and the other doors
 * import.
 */
export { analysisWindowMismatch } from "./byte-doors.js";

/**
 * What to do when the rebuild did not come back byte-identical.
 *
 * The verdict names the assembler's own complaint, which for a packed stream is
 * `relative address is illegal (jump distance is too far: 65471)` — a branch whose
 * target wrapped the address space, which is what a LINEAR decode of compressed bytes
 * produces and nothing else does. The message used to stop there. The remedy is not
 * guessable from it: declare the range as data, or depack first.
 */
export function rebuildRemedy(verdictLine: string, kind: "prg" | "raw"): string {
  if (!/WARNING: rebuild/i.test(verdictLine)) return "";
  const door = kind === "raw" ? "annotations_path" : "a <stem>_annotations.json beside the PRG";
  if (/jump distance is too far|relative address is illegal|branch out of range/i.test(verdictLine)) {
    return "\nWhat this is: a branch whose target wrapped the address space. A linear decode emits one only when the "
      + "bytes are not code — a compressed stream, a depacker's payload, a table. These bytes are probably packed.\n"
      + `Two ways on: declare the range as data — an annotations file with `
      + `segments: [{"start":"$XXXX","end":"$YYYY","kind":"unknown"}] passed as ${door}, after which the bytes render `
      + `as .byte and the rebuild is byte-identical — or depack first (suggest_depacker, then try_depack / `
      + `sandbox_depack) and disassemble the result.`;
  }
  if (/assembler exited/i.test(verdictLine)) {
    return "\nWhat this is: the listing did not reassemble. When the bytes are data read as code, declare the range "
      + `as data — an annotations file with segments: [{"start":"$XXXX","end":"$YYYY","kind":"unknown"}] passed as `
      + `${door} — and the rebuild comes back byte-identical.`;
  }
  return "";
}

/**
 * The seed report's reason, cut down to what a caller can act on.
 *
 * A project with 500 seeded owners printed all 500 names into every analyze_prg
 * answer, every disasm_prg answer and every listing header — by a wide margin the
 * largest single context cost of an autonomous run, and not one of the names was
 * actionable. The count is, and so are the few whose names are near the one asked for.
 * Set `C64RE_GRAPH_SEED_OWNERS=full` to get the whole list back.
 */
export function shortenSeedOwners(reason: string): string {
  const match = /\(seeded owners: ([^)]*)\)/.exec(reason);
  if (!match || process.env.C64RE_GRAPH_SEED_OWNERS === "full") return reason;
  const owners = match[1].split(", ").map((o) => o.trim()).filter(Boolean);
  if (owners.length <= 6 || match[1] === "none") return reason;
  return reason.replace(match[0], `(${owners.length} owners are seeded, e.g. ${owners.slice(0, 3).join(", ")}; C64RE_GRAPH_SEED_OWNERS=full lists them all)`);
}

interface NormalizedRelocation {
  fileStart: number;
  fileEnd: number;
  runtimeAddr: number;
  label?: string;
  subSegments?: Array<{ start: number; end: number; kind: string; label?: string; comment?: string }>;
}

/**
 * Read the relocation list with the one rule, then hold it against the PRG.
 *
 * A relocation outside the file used to throw out of `prg-disasm` and arrive as a node
 * stack trace in the tool result — four times in one run, once for a zero-page entry
 * ($0002-$0024) that was simply a typo for a region inside the file. An entry that
 * cannot be rendered is a validation case, not a crash.
 */
export function normalizeRelocationInput(
  relocations: ReadonlyArray<Record<string, unknown>>,
  prg: { loadAddress: number; lastAddress: number; name: string },
): NormalizedRelocation[] {
  const out: NormalizedRelocation[] = relocations.map((r, i) => ({
    fileStart: parseAddress(r.fileStart, `relocations[${i}].fileStart`),
    fileEnd: parseAddress(r.fileEnd, `relocations[${i}].fileEnd`),
    runtimeAddr: parseAddress(r.runtimeAddr, `relocations[${i}].runtimeAddr`),
    ...(typeof r.label === "string" ? { label: r.label } : {}),
    ...(Array.isArray(r.subSegments)
      ? {
        subSegments: (r.subSegments as Array<Record<string, unknown>>).map((sub, j) => ({
          start: parseAddress(sub.start, `relocations[${i}].subSegments[${j}].start`),
          end: parseAddress(sub.end, `relocations[${i}].subSegments[${j}].end`),
          kind: String(sub.kind ?? "code"),
          ...(typeof sub.label === "string" ? { label: sub.label } : {}),
          ...(typeof sub.comment === "string" ? { comment: sub.comment } : {}),
        })),
      }
      : {}),
  }));

  const hex = (n: number) => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
  const span = `${hex(prg.loadAddress)}-${hex(prg.lastAddress)}`;
  const sorted = [...out].sort((a, b) => a.fileStart - b.fileStart);
  let cursor = -1;
  for (const r of sorted) {
    const i = out.indexOf(r);
    if (r.fileEnd < r.fileStart) {
      throw new Error(`relocations[${i}]: fileEnd ${hex(r.fileEnd)} is before fileStart ${hex(r.fileStart)}.`);
    }
    if (r.fileStart < prg.loadAddress || r.fileEnd > prg.lastAddress) {
      throw new Error(
        `relocations[${i}]: ${hex(r.fileStart)}-${hex(r.fileEnd)} is outside ${prg.name}, which holds ${span}. `
        + `fileStart/fileEnd are STORED addresses inside this PRG; runtimeAddr is where those bytes execute. `
        + `(${ADDRESS_RULE}.)`,
      );
    }
    if (r.fileStart <= cursor) {
      throw new Error(`relocations[${i}]: ${hex(r.fileStart)} overlaps the region ending ${hex(cursor)}. Relocated regions may not overlap.`);
    }
    cursor = r.fileEnd;
  }
  return sorted;
}

// ── D3 — the bulk door ──────────────────────────────────────────────────────
//
// A run over one game extracted 217 payloads and then had to put each one through
// `analyze` and `disasm` on its own: 400+ round trips through two doors that each
// take exactly ONE path. `disasm_menu` is not the missing door — it wants an
// extract_disk manifest, not a list of payloads. The run worked around the
// arithmetic by spawning eight subagents, which is a scheduling answer to a door
// problem.
//
// `paths` is the door. One call, the SAME body per path (no second code path to
// drift), a named result per path, and an answer that stays one line per path
// however many there are — 217 full listings is not a readable answer, it is a
// different way of losing the report.

/** What one path's trip through a door did — filled by the door, read by the batch. */
interface DoorOutcome {
  ok?: boolean;
  outputPath?: string;
  /** The rebuild verdict / analysis headline, for the one line this path gets. */
  verdict?: string;
  /** Why it did not work, in the door's own words. */
  reason?: string;
}

/** The first thing a failed child process actually complained about, on one line. */
function firstComplaint(result: { stdout?: string; stderr?: string }): string {
  for (const line of `${result.stderr ?? ""}\n${result.stdout ?? ""}`.split(/\r?\n/)) {
    const text = line.trim();
    if (text && !/^\s*at\s/.test(text)) return text.slice(0, 160);
  }
  return "";
}

/** One line's worth of a long refusal: the first sentence that carries the cause. */
function reasonHeadline(reason: string | undefined, max = 150): string {
  const flat = (reason ?? "it failed, and said nothing about why").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The stored span a PRG covers, read from its 2-byte load address and its size. */
export function prgSpan(prgAbs: string): { loadAddress: number; lastAddress: number; name: string } {
  const head = readFileSync(prgAbs);
  if (head.length < 3) throw new Error(`${basename(prgAbs)} is too short to be a PRG (${head.length} bytes).`);
  const loadAddress = head[0]! | (head[1]! << 8);
  return { loadAddress, lastAddress: loadAddress + (head.length - 2) - 1, name: basename(prgAbs) };
}

export function registerAnalysisWorkflowTools(server: McpServer, context: ServerToolContext): void {
  // ──────────────────────────────────────────────────────────────────────────
  // TWO DOORS. Everything below this line is ONE `disasm` body and ONE
  // `analyze` body; the five registrations at the end differ only in the name
  // they were invoked under and the one line an old name adds to its answer.
  //
  // Four doors used to answer two questions. `disasm_prg` and `disasm_raw` ran
  // the same decoder, the same renderer, the same annotation handling and the
  // same rebuild proof, and differed only in whether two bytes at the front are
  // a load address — while `analyze_prg` took a PRG and nothing else, so
  // headerless bytes could not be classified at all. A run over four G64 sides
  // needed segment annotations on 1541 drive code, so it built FAKE 2-byte load
  // headers, wrote `.prg` copies and routed them through the PRG door: the exact
  // workaround the raw door exists to end, reappearing one door over.
  // ──────────────────────────────────────────────────────────────────────────

  /** The bytes a call is about: a path, or an artifact already registered. */
  function locateBytes(
    pd: string,
    service: ProjectKnowledgeService,
    a: { path?: string; prg_path?: string; artifact_id?: string },
  ): { ok: true; sourceAbs: string; artifactId?: string; registeredKind?: string } | { ok: false; refusal: string } {
    const named = a.path ?? a.prg_path;
    if (named && a.artifact_id) {
      return { ok: false, refusal: "path and artifact_id both given. Name the bytes once: a file path, or the id of an artifact already registered (list_artifacts / project_inventory_sync)." };
    }
    if (a.artifact_id) {
      const artifact = service.getArtifactById(a.artifact_id);
      if (!artifact) return { ok: false, refusal: `No artifact with id ${a.artifact_id}. List the project's artifacts with list_artifacts, or pass the file with path instead.` };
      return { ok: true, sourceAbs: resolve(pd, artifact.path), artifactId: artifact.id, ...(artifact.kind ? { registeredKind: artifact.kind } : {}) };
    }
    if (named) {
      const sourceAbs = resolve(pd, named);
      const row = (() => { try { return service.listArtifacts().find((x) => x.path === sourceAbs); } catch { return undefined; } })();
      return { ok: true, sourceAbs, ...(row ? { artifactId: row.id, registeredKind: row.kind } : {}) };
    }
    return { ok: false, refusal: "Neither path nor artifact_id was given. Name the bytes: a file path (absolute or project-relative), or the id of a registered artifact." };
  }

  /** The annotations files a render may pick up, in the order the renderer searches. */
  function annotationCandidatesFor(sourceAbs: string, outAbs: string, analysisAbs?: string): string[] {
    return [
      outAbs.replace(/\.asm$/i, "_annotations.json"),
      sourceAbs.replace(/\.[^./]+$/, "_annotations.json"),
      join(dirname(outAbs), basename(sourceAbs).replace(/\.[^./]+$/, "") + "_annotations.json"),
      ...(analysisAbs ? [analysisAbs.replace(/\.[^./]+$/, "_annotations.json")] : []),
      join(dirname(outAbs), "annotations.json"),
      join(dirname(sourceAbs), "annotations.json"),
    ];
  }

  /** Where a listing goes when the caller names no output. */
  function defaultListingPath(pd: string, sourceAbs: string, reading: ByteReading): string {
    if (reading.kind === "headed") {
      const out = /\.prg$/i.test(sourceAbs)
        ? sourceAbs.replace(/\.prg$/i, "_disasm.asm")
        : `${sourceAbs.replace(/\.[^./]+$/, "")}_disasm.asm`;
      return out === sourceAbs ? `${sourceAbs}_disasm.asm` : out;
    }
    const stem = basename(sourceAbs).replace(/\.[^./]+$/, "");
    const size = statSync(sourceAbs).size;
    const window = reading.byteOffset === 0 && reading.byteLength === size
      ? ""
      : `_${reading.byteOffset.toString(16).toUpperCase().padStart(4, "0")}-${(reading.byteOffset + reading.byteLength - 1).toString(16).toUpperCase().padStart(4, "0")}`;
    const addr = reading.loadAddress.toString(16).toUpperCase().padStart(4, "0");
    return join(pd, "analysis", "raw-disasm", `${stem}${window}_${addr}_disasm.asm`);
  }

  // ── D1 — `disasm` ─────────────────────────────────────────────────────────
  async function runDisasm(invokedAs: string, a: {
    project_dir?: string; path?: string; prg_path?: string; artifact_id?: string;
    load_address?: string | number; headed?: boolean;
    offset?: string | number; length?: string | number;
    entry_points?: Array<string | number>;
    analysis_json?: string; no_analysis?: boolean; annotations_path?: string;
    output_asm?: string; platform?: "c64" | "c1541"; cpu?: "c64" | "drive";
    bank?: number; space?: string;
    relocations?: Array<Record<string, unknown>>;
    paths?: string[];
  }, outcome?: DoorOutcome): Promise<{ content: { type: "text"; text: string }[] }> {
    const pd = context.projectDir(a.project_dir ?? a.path ?? a.prg_path, true);
    const refuse = (text: string) => {
      if (outcome) { outcome.ok = false; outcome.reason = text; }
      return { content: [{ type: "text" as const, text: `# ${invokedAs} refused\n\n${text}` }] };
    };
    const service = new ProjectKnowledgeService(pd);

    const located = locateBytes(pd, service, a);
    if (!located.ok) return refuse(located.refusal);
    const { sourceAbs } = located;
    let sourceArtifactId = located.artifactId;

    // ── §1 the load address decides ─────────────────────────────────────────
    const read = resolveByteReading({
      sourceAbs,
      ...(a.load_address !== undefined ? { loadAddress: a.load_address } : {}),
      ...(a.headed !== undefined ? { headed: a.headed } : {}),
      ...(a.offset !== undefined ? { offset: a.offset } : {}),
      ...(a.length !== undefined ? { length: a.length } : {}),
      ...(located.registeredKind ? { registeredKind: located.registeredKind } : {}),
    });
    if (!read.ok) return refuse(read.refusal);
    const reading = read.reading;
    const hex = (value: number) => `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
    const both = (value: number) => `${value} ($${value.toString(16).toUpperCase()})`;

    // ── the seeds ───────────────────────────────────────────────────────────
    let seeds: number[];
    try {
      seeds = (a.entry_points ?? []).map((value, index) => {
        const text = String(value).trim();
        if (text === "") throw new Error(`entry_points[${index}] is empty.`);
        try {
          return parseAddress(value, `entry_points[${index}]`);
        } catch {
          const isJson = /\.json$/i.test(text);
          throw new Error(
            `entry_points[${index}] = ${JSON.stringify(text)} is not an address — ${ADDRESS_RULE}.`
            + (isJson
              ? `\n\nThat is an analysis JSON. It belongs in analysis_json, which is the parameter that renders a listing segment-aware; entry_points only ever holds addresses.`
              : ``),
          );
        }
      });
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
    if (reading.kind === "raw") {
      const outside = seeds.filter((seed) => seed < reading.loadAddress || seed > reading.lastAddress);
      if (outside.length > 0) {
        return refuse(`entry_points ${outside.map(hex).join(", ")} lie outside ${hex(reading.loadAddress)}-${hex(reading.lastAddress)}, the span these bytes run at. An entry point is a RUNTIME address inside the window, not a file offset. ${ADDRESS_RULE}.`);
      }
    }

    // ── which machine ───────────────────────────────────────────────────────
    const namedPlatform: "c64" | "c1541" | undefined = a.platform ?? (a.cpu === "drive" ? "c1541" : a.cpu === "c64" ? "c64" : undefined);
    let resolvedPlatform: "c64" | "c1541" = namedPlatform ?? "c64";
    if (!namedPlatform) {
      try {
        const row = service.listArtifacts().find((art) => art.path === sourceAbs);
        if (row?.platform === "c1541") resolvedPlatform = "c1541";
      } catch { /* best effort */ }
    }
    // An explicitly named platform is RECORDED, not merely used for this render: the
    // three readers that decide a node's space look at the artifact record and at the
    // declared machine, and a render that knew the answer used to tell neither.
    if (namedPlatform) {
      try {
        const { declareMachine } = await import("../knowledge-graph/producers/machine.js");
        const { normStem } = await import("../knowledge-graph/migrate/classify.js");
        declareMachine(pd, normStem(basename(sourceAbs)), resolvedPlatform);
      } catch { /* the render stands without the declaration */ }
    }

    // ── where the listing goes ──────────────────────────────────────────────
    const outAbs = a.output_asm ? resolve(pd, a.output_asm) : defaultListingPath(pd, sourceAbs, reading);
    mkdirSync(dirname(outAbs), { recursive: true });
    const tassPath = outAbs.replace(/\.asm$/i, ".tas");

    // ── §2 which analysis ───────────────────────────────────────────────────
    const choice = resolveAnalysis({
      service,
      sourceAbs,
      ...(a.analysis_json ? { namedAbs: resolve(pd, a.analysis_json) } : {}),
      ...(a.no_analysis !== undefined ? { noAnalysis: a.no_analysis } : {}),
      reading,
    });
    if (choice.refusal) return refuse(choice.refusal);

    // ── the annotations, checked for name length before anything is written ──
    let annotationsAbs: string | undefined;
    if (a.annotations_path) {
      annotationsAbs = resolve(pd, a.annotations_path);
      if (!existsSync(annotationsAbs)) {
        return refuse(`annotations_path ${annotationsAbs} does not exist. A named annotations file is never swapped for one found beside the bytes — write it, fix the path, or leave annotations_path out.`);
      }
    }
    {
      const limit = maxLabelLength(pd);
      const file = annotationsAbs
        ?? (limit === undefined ? undefined : annotationCandidatesFor(sourceAbs, outAbs, choice.path).find((c) => existsSync(c)));
      if (limit !== undefined && file && existsSync(file)) {
        let names: string[] = [];
        try { names = annotationNames(JSON.parse(readFileSync(file, "utf8"))); } catch { /* the renderer reports a broken file */ }
        const long = namesTooLong(names, limit);
        if (long.length > 0) return refuse(`${file}\n${tooLongMessage(long, limit)}`);
      }
    }

    // ── relocations, held against the span these bytes actually cover ───────
    let relocationsFile: string | undefined;
    let normalizedRelocations: ReturnType<typeof normalizeRelocationInput> = [];
    if (a.relocations && a.relocations.length > 0) {
      try {
        normalizedRelocations = normalizeRelocationInput(a.relocations, {
          loadAddress: reading.loadAddress,
          lastAddress: reading.lastAddress,
          name: basename(sourceAbs),
        });
      } catch (e) {
        return refuse(e instanceof Error ? e.message : String(e));
      }
      relocationsFile = join(tmpdir(), `c64re-reloc-${randomUUID()}.json`);
      writeFileSync(relocationsFile, `${JSON.stringify(normalizedRelocations, null, 2)}\n`, "utf8");
    }

    // ── render, through the one renderer, by whichever reading was taken ────
    const asHex = (value: number) => `$${value.toString(16).toUpperCase()}`;
    const cliArgs: string[] = [];
    if (reading.kind === "raw") {
      cliArgs.push("--load-address", asHex(reading.loadAddress));
      if (reading.byteOffset !== 0) cliArgs.push("--offset", asHex(reading.byteOffset));
      cliArgs.push("--length", asHex(reading.byteLength));
    }
    if (resolvedPlatform !== "c64") cliArgs.push("--platform", resolvedPlatform);
    if (relocationsFile) cliArgs.push("--relocations", relocationsFile);
    if (annotationsAbs) cliArgs.push("--annotations", annotationsAbs);
    if (choice.path) cliArgs.push("--analysis", choice.path);
    else cliArgs.push("--no-analysis");
    cliArgs.push(sourceAbs, outAbs);
    const entries = seeds.map((seed) => hex(seed).slice(1)).join(",");
    if (reading.kind === "raw" || entries) cliArgs.push(entries);

    try {
      const { loadAddressIndex, loadAbiIndex } = await import("../project-knowledge/address-index.js");
      loadAddressIndex(pd);
      loadAbiIndex(pd);
    } catch { /* the index is an enhancement; the render proceeds without it */ }

    const result = await runCli(reading.kind === "raw" ? "disasm-raw" : "disasm-prg", cliArgs, { projectDir: pd });
    if (result.exitCode !== 0) {
      const failed = context.cliResultToContent(result) as { content: { type: "text"; text: string }[] };
      failed.content[0]!.text = `${reading.line}\n\n${failed.content[0]!.text}`;
      if (outcome) {
        outcome.ok = false;
        outcome.reason = `the renderer exited ${result.exitCode}${firstComplaint(result) ? ` — ${firstComplaint(result)}` : ""}`;
      }
      return failed;
    }

    // ── what the project keeps ──────────────────────────────────────────────
    const provenance = reading.kind === "raw"
      ? `Bytes ${reading.byteOffset}..${reading.byteOffset + reading.byteLength - 1} of ${basename(sourceAbs)} `
        + `(offset ${both(reading.byteOffset)}, length ${both(reading.byteLength)}), running at ${hex(reading.loadAddress)}-${hex(reading.lastAddress)}`
        + `${resolvedPlatform === "c1541" ? ", on the 1541's 6502" : ""}`
        + `${a.bank !== undefined ? `, bank ${a.bank}` : ""}${a.space ? `, space ${a.space}` : ""}`
        + `. Seeded: ${seeds.length > 0 ? seeds.map(hex).join(", ") : `${hex(reading.loadAddress)} (first byte)`}.`
      : `${basename(sourceAbs)} read as headed: its first two bytes are ${hex(reading.loadAddress)}, so the `
        + `${reading.byteLength}-byte body runs at ${hex(reading.loadAddress)}-${hex(reading.lastAddress)}`
        + `${resolvedPlatform === "c1541" ? ", on the 1541's 6502" : ""}`
        + `${a.bank !== undefined ? `, bank ${a.bank}` : ""}${a.space ? `, space ${a.space}` : ""}.`;

    const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
      toolName: invokedAs,
      title: reading.kind === "raw"
        ? `Disassemble bytes: ${basename(sourceAbs)} @ ${hex(reading.loadAddress)}`
        : `Disassemble PRG: ${basename(sourceAbs)}`,
      parameters: {
        source: sourceAbs,
        artifact_id: sourceArtifactId ?? null,
        reading: reading.kind,
        load_address: reading.loadAddress,
        offset: reading.byteOffset,
        length: reading.byteLength,
        entry_points: seeds.map(hex),
        platform: resolvedPlatform,
        bank: a.bank ?? null,
        space: a.space ?? null,
        analysis_json: choice.path ?? null,
        annotations_path: annotationsAbs ?? null,
        output_asm: outAbs,
      },
      notes: [provenance],
      inputs: [
        {
          path: sourceAbs,
          kind: reading.kind === "headed" ? "prg" : "raw",
          scope: "input",
          role: "disasm-target",
          producedByTool: invokedAs,
        },
        ...(choice.path ? [{
          path: choice.path,
          kind: "other" as const,
          scope: "analysis" as const,
          role: "analysis-json",
          format: "json",
          producedByTool: invokedAs,
        }] : []),
      ],
      outputs: reading.kind === "headed"
        ? [
          { path: outAbs, kind: "generated-source" as const, scope: "generated" as const, role: "kickassembler-source", format: "asm", producedByTool: invokedAs },
          { path: tassPath, kind: "generated-source" as const, scope: "generated" as const, role: "64tass-source", format: "tass", producedByTool: invokedAs },
        ]
        : [
          { path: outAbs, kind: "listing" as const, scope: "analysis" as const, role: "disasm", format: "asm", producedByTool: invokedAs },
          { path: tassPath, kind: "generated-source" as const, scope: "generated" as const, role: "disasm-tass", format: "tass", producedByTool: invokedAs },
        ],
    });
    if (!sourceArtifactId) {
      try { sourceArtifactId = service.listArtifacts().find((x) => x.path === sourceAbs)?.id; } catch { /* best effort */ }
    }

    // The provenance belongs ON the listing's own row, not only in the run log: a
    // caller who finds the .asm months later must be able to ask what bytes it is.
    const listingArtifactId = (() => {
      try {
        const listing = service.listArtifacts().find((x) => x.path === outAbs);
        if (!listing) return undefined;
        service.saveArtifact({
          id: listing.id,
          kind: listing.kind,
          scope: listing.scope,
          title: listing.title,
          path: outAbs,
          description: provenance,
          format: "asm",
          role: listing.role ?? "disasm",
          producedByTool: invokedAs,
          platform: resolvedPlatform,
          sourceArtifactIds: listing.sourceArtifactIds,
          tags: [...new Set([...(listing.tags ?? []), invokedAs, ...(reading.kind === "raw" ? ["raw-block"] : [])])],
        });
        return listing.id;
      } catch {
        return undefined;
      }
    })();
    // The PRG's own row carries the machine too — the other half of the loop this
    // door resolves the platform from when the caller names none.
    if (namedPlatform) {
      try {
        const row = service.listArtifacts().find((x) => x.path === sourceAbs);
        if (row && row.platform !== resolvedPlatform) {
          service.saveArtifact({ ...row, path: sourceAbs, platform: resolvedPlatform });
        }
      } catch { /* the listing stands without the stamp */ }
    }

    // ── prove it, against the bytes it was rendered from ────────────────────
    const verdict = await rebuildVerification({
      projectDir: pd,
      asmPath: outAbs,
      prgPath: sourceAbs,
      ...(sourceArtifactId ? { sourceArtifactId } : {}),
      ...(reading.kind === "raw"
        ? {
          compareRange: { offset: reading.byteOffset, length: reading.byteLength },
          compareLabel: `${basename(sourceAbs)} bytes ${reading.byteOffset}..${reading.byteOffset + reading.byteLength - 1}`,
          discardCheckOnSuccess: true,
        }
        : {}),
      toolName: invokedAs,
    });

    // ── and tell the payload, when these bytes are one ──────────────────────
    let payloadLine = "";
    if (listingArtifactId) {
      try {
        const payload = listPayloadEntities(service).find((entity) =>
          entity.payloadSourceArtifactId === sourceArtifactId
          || (entity.payloadSourceArtifactId !== undefined && entity.payloadSourceArtifactId === listingArtifactId));
        if (payload && !(payload.payloadAsmArtifactIds ?? []).includes(listingArtifactId)) {
          service.saveEntity({
            id: payload.id,
            kind: payload.kind,
            name: payload.name,
            payloadAsmArtifactIds: [...new Set([...(payload.payloadAsmArtifactIds ?? []), listingArtifactId])],
          });
          payloadLine = `\nPayload: linked to ${payload.name} (${payload.id}) — whichever door created it.`;
        } else if (payload) {
          payloadLine = `\nPayload: already linked to ${payload.name} (${payload.id}).`;
        }
      } catch { /* the link is an enhancement; the listing stands without it */ }
    }

    // ── the names go into the graph ─────────────────────────────────────────
    //
    // The path is the one the RENDERER printed, never a candidate list re-derived
    // here: two halves guessing the same order is how a listing full of names came
    // to sit beside an import that was handed a path that does not exist.
    const usedAnnotations = /^Annotations used: (.+)$/m.exec(result.stdout)?.[1];
    const annotationsApplied = usedAnnotations !== undefined && usedAnnotations !== "none";
    let graphLine = "";
    if (annotationsApplied) {
      try {
        const graphRelocations = normalizedRelocations.map((r) => ({
          fileStart: r.fileStart, fileEnd: r.fileEnd, runtimeAddr: r.runtimeAddr,
        }));
        const owner = sourceArtifactId ?? listingArtifactId;
        const imported = service.importAnnotations({
          ...(owner ? { sourcePrgArtifactId: owner } : {}),
          // The path the RENDERER printed, never a candidate list re-derived here.
          annotationsPath: usedAnnotations!,
          // …and the SAME relocations the listing was rendered with, so a relocated
          // annotation lands in the graph at the address it RUNS at. Parsed once, by
          // the one rule, above.
          ...(graphRelocations.length > 0 ? { relocations: graphRelocations } : {}),
        });
        graphLine = imported.changed
          ? `\nGraph: imported ${imported.routines} routines, ${imported.labels} labels, ${imported.segments} segments into the knowledge graph (owner ${imported.owner}) — graph contents, not the listing.`
          : `\nGraph: unchanged since the last import; the graph holds ${imported.routines} routines, ${imported.labels} labels, ${imported.segments} segments — graph contents, not the listing.`;
        if (sourceArtifactId ?? listingArtifactId) {
          graphLine += `\n${runAndFormatClosedLoopSweep(service, { artifactId: (sourceArtifactId ?? listingArtifactId)! })}`;
        }
      } catch (importError) {
        graphLine = `\nAnnotations import: FAILED — ${importError instanceof Error ? importError.message : String(importError)}`;
      }
    }

    // ── the answer ──────────────────────────────────────────────────────────
    const seededText = seeds.length > 0
      ? seeds.map(hex).join(", ")
      : `${hex(reading.loadAddress)} (the first byte — no entry point was given)`;
    const verdictLine = verdict.line.replace(/^\/\/\s*/, "");
    const annotationsPath = outAbs.replace(/\.asm$/i, "_annotations.json");
    const nextStep = annotationsApplied
      ? `Annotations file: ${usedAnnotations}`
      : `\nNEXT STEP: Read the full ASM with read_artifact, then create ${annotationsPath} with segment reclassifications, semantic labels, and routine documentation. Then run ${invokedAs} again to produce the final annotated version.`;
    if (!annotationsApplied) {
      try {
        const subjectId = knowledgeRegistration.runPath ? `analysis-run:${basename(sourceAbs)}` : basename(sourceAbs);
        service.emitNextStepTask({
          producedByTool: invokedAs,
          artifactIds: [subjectId],
          title: `Write ${basename(annotationsPath)}`,
          description: `Write semantic annotations file then re-run ${invokedAs} with annotations.`,
          autoCloseHint: { kind: "file-exists", path: annotationsPath },
          priority: "medium",
        });
      } catch { /* best effort */ }
    }

    result.stdout = [
      reading.line,
      "",
      result.stdout.trimEnd() || "Disassembly complete.",
      `Output: ${outAbs}`,
      `Knowledge written to: ${resolve(pd, "knowledge")}`,
      `Analysis: ${choice.why}`,
      `Provenance: ${provenance}`,
      `Seeded: ${seededText}`,
      `${verdictLine}${rebuildRemedy(verdictLine, reading.kind === "raw" ? "raw" : "prg")}`,
      `Listing: ${listingAnnotationStatus(outAbs)}`,
      nextStep,
      graphLine.trim(),
      payloadLine.trim(),
      listingArtifactId ? `Artifact: ${listingArtifactId} (re-running with the same arguments updates this row; it does not make a second one).` : "",
      knowledgeRegistration.runPath ? `Knowledge run: ${knowledgeRegistration.runPath}` : (knowledgeRegistration.message ?? ""),
      aliasNotice(invokedAs, pd),
    ].filter((line) => line !== "" && line !== undefined).join("\n");
    if (outcome) { outcome.ok = true; outcome.outputPath = outAbs; outcome.verdict = verdictLine; }
    return context.cliResultToContent(result) as { content: { type: "text"; text: string }[] };
  }

  // ── D2 — `analyze` ────────────────────────────────────────────────────────
  async function runAnalyze(invokedAs: string, a: {
    project_dir?: string; path?: string; prg_path?: string; artifact_id?: string;
    load_address?: string | number; headed?: boolean;
    offset?: string | number; length?: string | number;
    entry_points?: Array<string | number>; output_json?: string;
    paths?: string[];
  }, outcome?: DoorOutcome): Promise<{ content: { type: "text"; text: string }[] }> {
    const pd = context.projectDir(a.project_dir ?? a.path ?? a.prg_path, true);
    const refuse = (text: string) => {
      if (outcome) { outcome.ok = false; outcome.reason = text; }
      return { content: [{ type: "text" as const, text: `# ${invokedAs} refused\n\n${text}` }] };
    };
    const service = new ProjectKnowledgeService(pd);

    const located = locateBytes(pd, service, a);
    if (!located.ok) return refuse(located.refusal);
    const { sourceAbs } = located;

    const read = resolveByteReading({
      sourceAbs,
      ...(a.load_address !== undefined ? { loadAddress: a.load_address } : {}),
      ...(a.headed !== undefined ? { headed: a.headed } : {}),
      ...(a.offset !== undefined ? { offset: a.offset } : {}),
      ...(a.length !== undefined ? { length: a.length } : {}),
      ...(located.registeredKind ? { registeredKind: located.registeredKind } : {}),
    });
    if (!read.ok) return refuse(read.refusal);
    const reading = read.reading;

    let entries: string;
    try {
      entries = (a.entry_points ?? [])
        .map((e, i) => parseAddress(e, `entry_points[${i}]`).toString(16).toUpperCase().padStart(4, "0"))
        .join(",");
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }

    const outAbs = a.output_json
      ? resolve(pd, a.output_json)
      : defaultAnalysisPath(pd, sourceAbs, reading);
    mkdirSync(dirname(outAbs), { recursive: true });

    // Inside a batch the whole batch is ALREADY one job (see runBatch): a second
    // layer of job mode would hand back a job_id per path and turn one call back
    // into N polls, which is the round-trip arithmetic this door exists to end.
    if (outcome) {
      return runAnalyzeBody({ invokedAs, pd, sourceAbs, outAbs, reading, entries, entryPoints: a.entry_points ?? [] }, outcome);
    }

    const job = startAnalysisJob(invokedAs, outAbs, () =>
      runAnalyzeBody({ invokedAs, pd, sourceAbs, outAbs, reading, entries, entryPoints: a.entry_points ?? [] }));
    const settled = await waitForJob(job, ANALYZE_JOB_GRACE_MS);
    if (!settled) {
      return { content: [{ type: "text" as const, text: [
        reading.line,
        "",
        `${invokedAs} is still running (large image) — switched to background job mode.`,
        `job_id: ${job.id}`,
        `output (when done): ${outAbs}`,
        `Poll with analysis_job_status { job_id } every ~30s. Do NOT re-run ${invokedAs} for these bytes.`,
      ].join("\n") }] };
    }
    if (job.state === "failed") throw new Error(job.error ?? `${invokedAs} failed`);
    return job.result as { content: { type: "text"; text: string }[] };
  }

  /** Where an analysis goes when the caller names no output. */
  function defaultAnalysisPath(pd: string, sourceAbs: string, reading: ByteReading): string {
    if (reading.kind === "headed") {
      const out = /\.prg$/i.test(sourceAbs)
        ? sourceAbs.replace(/\.prg$/i, "_analysis.json")
        : `${sourceAbs.replace(/\.[^./]+$/, "")}_analysis.json`;
      return out === sourceAbs ? `${sourceAbs}_analysis.json` : out;
    }
    const stem = basename(sourceAbs).replace(/\.[^./]+$/, "");
    const size = statSync(sourceAbs).size;
    const window = reading.byteOffset === 0 && reading.byteLength === size
      ? ""
      : `_${reading.byteOffset.toString(16).toUpperCase().padStart(4, "0")}-${(reading.byteOffset + reading.byteLength - 1).toString(16).toUpperCase().padStart(4, "0")}`;
    const addr = reading.loadAddress.toString(16).toUpperCase().padStart(4, "0");
    return join(pd, "analysis", "raw-analysis", `${stem}${window}_${addr}_analysis.json`);
  }

  /** The analysis body — the pipeline run plus the registration, for either reading. */
  async function runAnalyzeBody(a: {
    invokedAs: string; pd: string; sourceAbs: string; outAbs: string;
    reading: ByteReading; entries: string; entryPoints: Array<string | number>;
  }, outcome?: DoorOutcome): Promise<{ content: { type: "text"; text: string }[] }> {
    const { invokedAs, pd, sourceAbs, outAbs, reading, entries } = a;
    const asHex = (value: number) => `$${value.toString(16).toUpperCase()}`;
    const args: string[] = [sourceAbs, outAbs];
    if (entries) args.push(entries);
    if (reading.kind === "raw") {
      args.push("--load-address", asHex(reading.loadAddress));
      if (reading.byteOffset !== 0) args.push("--offset", asHex(reading.byteOffset));
      args.push("--length", asHex(reading.byteLength));
    }
    const result = await runCli("analyze-prg", args, { projectDir: pd });
    if (result.exitCode !== 0) {
      const failed = context.cliResultToContent(result) as { content: { type: "text"; text: string }[] };
      failed.content[0]!.text = `${reading.line}\n\n${failed.content[0]!.text}`;
      if (outcome) {
        outcome.ok = false;
        outcome.reason = `the analyser exited ${result.exitCode}${firstComplaint(result) ? ` — ${firstComplaint(result)}` : ""}`;
      }
      return failed;
    }
    const packerHints = await detectPackerHints({ projectDir: pd, prgPath: sourceAbs });
    if (packerHints.length > 0) attachPackerHintsToAnalysis(outAbs, packerHints);
    const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
      toolName: invokedAs,
      title: `Analyze: ${basename(sourceAbs)}`,
      parameters: {
        source: sourceAbs,
        reading: reading.kind,
        load_address: reading.loadAddress,
        offset: reading.byteOffset,
        length: reading.byteLength,
        output_json: outAbs,
        entry_points: a.entryPoints.map(String),
      },
      inputs: [{
        path: sourceAbs,
        kind: reading.kind === "headed" ? "prg" : "raw",
        scope: "input",
        role: "analysis-target",
        producedByTool: invokedAs,
      }],
      outputs: [{
        path: outAbs,
        kind: "other",
        scope: "analysis",
        role: "analysis-json",
        format: "json",
        producedByTool: invokedAs,
      }],
    });
    result.stdout = `${reading.line}\n\n` + (result.stdout || "Analysis complete.")
      + `\nOutput: ${outAbs}\nKnowledge written to: ${resolve(pd, "knowledge")}`;
    result.stdout += describeCodeSeeds(outAbs);
    if (knowledgeRegistration.outputArtifacts?.[0]) {
      try {
        const knowledgeService = new ProjectKnowledgeService(pd);
        const imported = knowledgeService.importAnalysisArtifact(knowledgeRegistration.outputArtifacts[0]);
        result.stdout += `\nImported analysis knowledge: ${imported.importedEntityCount} entities, ${imported.importedFindingCount} findings, ${imported.importedRelationCount} relations, ${imported.importedFlowCount} flows, ${imported.importedOpenQuestionCount} open questions`;
      } catch (error) {
        result.stdout += `\nAnalysis import skipped: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (knowledgeRegistration.runPath) {
      result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
    } else if (knowledgeRegistration.message) {
      result.stdout += `\n${knowledgeRegistration.message}`;
    }
    // The analysis is registered FOR these bytes, which is what a later render asks
    // the store about instead of guessing a path beside them.
    result.stdout += `\nRegistered for: ${basename(sourceAbs)} — a later disasm of these bytes finds this analysis by asking the project store, whatever directory it sits in.`;
    try {
      const knowledgeService = new ProjectKnowledgeService(pd);
      knowledgeService.emitNextStepTask({
        producedByTool: invokedAs,
        artifactIds: [knowledgeRegistration.outputArtifacts?.[0] ?? basename(sourceAbs)],
        title: `Run disasm on ${basename(sourceAbs)}`,
        description: `Disassemble using ${basename(outAbs)} and verify rebuild.`,
        autoCloseHint: { kind: "file-exists", path: outAbs.replace(/_analysis\.json$/i, "_disasm.asm") },
        priority: "medium",
      });
    } catch { /* best effort */ }
    const packerSummary = summarizePackerHints(packerHints);
    if (packerSummary.length > 0) result.stdout += `\n${packerSummary.join("\n")}`;
    const notice = aliasNotice(invokedAs, pd);
    if (notice) result.stdout += `\n${notice}`;
    if (outcome) {
      outcome.ok = true;
      outcome.outputPath = outAbs;
      outcome.verdict = `${reading.kind === "raw" ? "raw" : "headed"} · ${describeCodeSeeds(outAbs).replace(/\s+/g, " ").trim().slice(0, 90) || "analysed"}`;
    }
    return context.cliResultToContent(result) as { content: { type: "text"; text: string }[] };
  }

  // ── D3 — the bulk door ────────────────────────────────────────────────────

  /** How many paths one call may carry. Past this the answer stops being a report. */
  const BATCH_LIMIT = 512;

  /**
   * Run one door over many paths, in order, and answer with ONE report.
   *
   * Three rules, and they are the whole point:
   *   • the same body — each path goes through exactly the call a single-path
   *     caller would make, so nothing can be true in a batch and false alone;
   *   • per-path failure — a bad path is named with its reason and the rest keep
   *     going; one unreadable file may not sink 216 good ones;
   *   • one line per path — the per-path answers are NOT concatenated. At 217
   *     payloads that is megabytes of listing, and a report nobody can read is
   *     the same defect as no report.
   */
  async function runBatch(opts: {
    invokedAs: string;
    verb: string;
    paths: string[];
    projectDir: string;
    outputParam: "output_asm" | "output_json";
    outputValue: string | undefined;
    single: string | undefined;
    artifactId: string | undefined;
    each: (path: string, outcome: DoorOutcome) => Promise<unknown>;
  }): Promise<{ content: { type: "text"; text: string }[] }> {
    const { invokedAs, verb } = opts;
    const refuse = (text: string) => ({ content: [{ type: "text" as const, text: `# ${invokedAs} refused\n\n${text}` }] });

    if (opts.single !== undefined) {
      return refuse(
        `paths and path were both given. Name the bytes once: \`path\` for a single file, or \`paths\` for a batch — `
        + `not both, because a batch that silently ignored one of them would be wrong in a way nothing prints.`,
      );
    }
    if (opts.artifactId !== undefined) {
      return refuse(
        `paths and artifact_id were both given. \`paths\` is a list of FILE paths; an artifact id names exactly one `
        + `registered artifact. Use one or the other.`,
      );
    }
    if (opts.paths.length === 0) {
      return refuse(`paths is empty. Pass at least one path, or use \`path\` for a single file. Nothing was ${verb}.`);
    }
    if (opts.outputValue !== undefined) {
      return refuse(
        `paths and ${opts.outputParam} were both given. One output name cannot hold ${opts.paths.length} results — `
        + `they would overwrite each other and only the last would survive. Leave ${opts.outputParam} out: in a batch `
        + `every path gets its own default output, which is the same place a single-path call would put it.`,
      );
    }
    if (opts.paths.length > BATCH_LIMIT) {
      return refuse(
        `${opts.paths.length} paths is past the ${BATCH_LIMIT}-path limit for one call. Split the list; the door is `
        + `sequential either way, so two calls of ${BATCH_LIMIT} cost what one call of ${opts.paths.length} would.`,
      );
    }

    const seen = new Set<string>();
    const unique = opts.paths.filter((p) => {
      const key = resolve(opts.projectDir, p);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const collapsed = opts.paths.length - unique.length;

    const rel = (abs: string | undefined) => {
      if (!abs) return "";
      const root = `${opts.projectDir}/`;
      return abs.startsWith(root) ? abs.slice(root.length) : abs;
    };

    const ok: string[] = [];
    const bad: Array<{ path: string; reason: string }> = [];
    for (const p of unique) {
      const outcome: DoorOutcome = {};
      try {
        await opts.each(p, outcome);
      } catch (e) {
        outcome.ok = false;
        outcome.reason = e instanceof Error ? e.message : String(e);
      }
      if (outcome.ok) {
        const verdict = (outcome.verdict ?? "").replace(/\s+/g, " ").trim();
        ok.push(`  OK      ${p} → ${rel(outcome.outputPath)}${verdict ? `  ${verdict.slice(0, 110)}` : ""}`);
      } else {
        bad.push({ path: p, reason: outcome.reason ?? "" });
      }
    }

    const SHOWN_IN_FULL = 10;
    const lines: string[] = [
      `# ${invokedAs} — ${unique.length} paths: ${ok.length} ${verb}, ${bad.length} failed`,
      ...(collapsed > 0 ? ["", `(${collapsed} duplicate path(s) collapsed — each file is done once.)`] : []),
      "",
      ...ok,
      ...bad.map((b) => `  FAILED  ${b.path} — ${reasonHeadline(b.reason)}`),
    ];
    if (bad.length > 0) {
      lines.push("", `FAILED in full — ${Math.min(bad.length, SHOWN_IN_FULL)} of ${bad.length}:`);
      for (const b of bad.slice(0, SHOWN_IN_FULL)) {
        lines.push("", `  ${b.path}`);
        for (const l of (b.reason || "(no reason given)").split("\n").slice(0, 6)) lines.push(`    ${l}`);
      }
      if (bad.length > SHOWN_IN_FULL) {
        lines.push("", `  …and ${bad.length - SHOWN_IN_FULL} more, each named on its own FAILED line above.`);
      }
    }
    lines.push(
      "",
      `${ok.length} ${verb}, ${bad.length} failed, of ${unique.length} paths. Every path went through the same door a `
      + `single-path call goes through — written, registered and checked the same way. Only the per-path headline is `
      + `printed here, because ${unique.length} full answers is not a report: re-run one path on its own (\`path\`) for its full answer.`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }

  // ── the shared input shapes ───────────────────────────────────────────────
  const BYTES_INPUT = {
    project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json."),
    path: z.string().optional().describe("Path to the file holding the bytes (absolute or project-relative). Use this OR artifact_id OR paths. The extension is never consulted: a .bin may be a PRG and a .prg may be a raw block."),
    paths: z.array(z.string()).optional().describe("MANY files in ONE call, instead of one round trip each — an extract that produced 217 payloads is one call, not 217. Each path goes through exactly the body a single-path call goes through and gets its own default output; the other arguments here apply to all of them, so a batch is for files that are read the same way. A path that fails is NAMED with its reason and the rest keep going — one bad file never sinks the batch. The answer is one line per path, not the full per-path listing; re-run a single path with `path` when you want its whole answer. Use this OR path OR artifact_id, and leave the output-name argument out — one name cannot hold N results."),
    artifact_id: z.string().optional().describe("Id of an already-registered artifact holding the bytes. Use this OR path OR paths."),
    load_address: z.union([z.string(), z.number()]).optional().describe("Where the FIRST byte runs. GIVEN: the bytes are raw and start there, and nothing at the front is treated as a header. OMITTED: the file must carry a 2-byte load header and its first two bytes are read as this address. An address is HEX: \"C000\", \"$C000\" and \"0xC000\" are the same; a JSON number is taken as-is."),
    headed: z.boolean().optional().describe("Say outright whether these bytes carry a 2-byte load header. Normally unnecessary — load_address decides. Pass true with a load_address to have a disagreeing header refused by name; pass false to read a file the project store recorded as a PRG from offset 0 as raw."),
    offset: z.union([z.string(), z.number()]).optional().describe("Byte offset into the file where the block starts. Requires load_address: a window's first byte is not a load header. Default 0. Same rule as an address: a string is hex, a JSON number is taken as given."),
    length: z.union([z.string(), z.number()]).optional().describe("How many bytes. Default: to the end of the file. Same rule as offset."),
    entry_points: z.array(z.union([z.string(), z.number()])).optional().describe("Runtime addresses where code is known to start. A seed that falls inside a decoded instruction breaks it: the bytes up to the seed render as data and the decode resumes at the seed — byte-exact either way. An entry_points list CONSTRAINS an analysis scan; it does not simply add to it, and the refused ones are named."),
  } as const;

  server.tool(
    "disasm",
    "Disassemble bytes to KickAssembler .asm + 64tass .tas, segment-aware when an analysis describes them, with a rebuild proof. Use for any listing of any bytes: a PRG, a payload carved off a disk, a depacked chunk, a relocated overlay, a block lifted out of a raw track, 1541 drive code. THE LOAD ADDRESS DECIDES HOW THE BYTES ARE READ, NEVER THE FILE NAME — pass load_address and the bytes are raw and start there with nothing at the front treated as a header; leave it out and the file must carry a 2-byte load header, whose first two bytes are read as the address. A header and a load_address that disagree are refused, naming both. Every answer opens with the reading it took and where the address came from, so a wrong reading is caught before the listing is believed. Not for the structural scan (use analyze), for menus / multi-file containers (use disasm_menu) or for the running machine's memory (use runtime_monitor_disasm). The analysis it renders with: analysis_json names one and a named analysis that exists is used unchanged and never swapped; if it does not exist, or none is named, the project store is asked which analysis is registered for THESE bytes, and the answer names what it used and why — only with nothing in the store does it fall back to the file beside the bytes, and no_analysis refuses one outright. Pass offset/length to narrow a window (they require load_address, because a window's first byte is not a header); a whole-file analysis over a window is refused rather than rendered. A `<stem>_annotations.json` beside the bytes, the output or the analysis is auto-applied, or name one with annotations_path: names (labels, routines, a segment's `label`) apply with or without an analysis, while segment kinds and pointer/jump/immediate tables need one — the listing's header line says which happened and the answer quotes it back as `Listing:`. Exact shape: labels[{address,label,comment?}], routines[{address,name,comment?}], segments[{start,end,kind,label?,comment?}], optional pointerTables/jumpTables/immediates. Hex with or without `$`. Loading is tolerant: a mistyped entry (e.g. `addr` for `address`) is skipped and reported as `[annotations] applied N, skipped M`; it never crashes the rebuild. In a project created since 2026-09-19 no label, routine or segment name may be longer than 20 characters: such a file is REFUSED before anything is rendered and the refusal names every offender. Whatever is applied is imported into the knowledge graph. For relocated code (stored at one address, executed at another) pass `relocations`: each region renders as KickAssembler .pseudopc / 64tass .logical at its runtime PC while the stored bytes stay byte-exact — accept the proposals from analyze / propose_annotations (draft.relocations[]) and copy them straight in. Addresses are HEX with $ or 0x optional; a JSON number is taken as given, and offset/length follow the same rule (\"100\" = 256 bytes, 100 = 100 bytes). Full annotation reference: docs/annotations-reference.md. MANY FILES AT ONCE: pass `paths` instead of `path` and one call renders every one of them, each through the same body a single-path call goes through — an extract that produced 217 payloads is one call, not 217. A path that fails is named with its reason and the rest still render; the answer is one line per path, not 217 listings, and you leave output_asm out because one name cannot hold N listings. Inputs: path or paths or artifact_id, optional load_address/offset/length/entry_points/analysis_json/no_analysis/annotations_path/platform/bank/space/relocations/output_asm. Returns: the reading it took, the .asm/.tas paths, the analysis it used and why, the provenance, what was seeded, and the rebuild verdict — or, for `paths`, one line per path and the failures named.",
    {
      ...BYTES_INPUT,
      analysis_json: z.string().optional().describe("Path to an analysis JSON for segment-aware rendering. Named and present, it is the analysis rendered and is never swapped. Named and absent, or omitted, the project store is asked which analysis is registered for these bytes; only then the file beside them."),
      no_analysis: z.boolean().optional().describe("Refuse an analysis outright for this render. Nothing is read, nothing is inherited, and the answer says the listing is linear. Use when an analysis exists for these bytes and you know it does not apply."),
      annotations_path: z.string().optional().describe("Path to an annotations file (labels/routines/segments). Without it a <stem>_annotations.json beside the bytes, the output or the analysis is picked up. Whatever is applied is imported into the knowledge graph."),
      output_asm: z.string().optional().describe("Output path for the .asm, with the .tas beside it. Default for a headed file: <stem>_disasm.asm next to it; for raw bytes: analysis/raw-disasm/<stem>[_<window>]_<address>_disasm.asm."),
      platform: z.enum(["c64", "c1541"]).optional().describe("Target machine for ZP / IO / ROM symbol tables. Default c64. Use c1541 for drive-side code. Naming it RECORDS the machine for this file: its graph nodes are then indexed in the drive's address space, so a boundary asserted with space=\"drv\" over a range the C64 and the 1541 share (e.g. $0300-$07FF) actually contains them."),
      bank: z.number().int().nonnegative().optional().describe("Cartridge bank these bytes belong to, recorded with the listing's provenance."),
      space: z.string().optional().describe("Which memory space these bytes belong to (e.g. \"ram\", \"cart\", \"drive\"), recorded with the listing's provenance."),
      relocations: z.array(z.object({
        fileStart: z.union([z.string(), z.number()]).describe("Stored address of the region's first byte (inclusive). HEX: \"FC00\", \"$FC00\" and \"0xFC00\" are the same; a JSON number is taken as-is. Must lie inside the span these bytes cover."),
        fileEnd: z.union([z.string(), z.number()]).describe("Stored address of the region's last byte (inclusive). Same rule."),
        runtimeAddr: z.union([z.string(), z.number()]).describe("Logical execution PC that fileStart runs at. Same rule; unlike fileStart/fileEnd it may be anywhere in the 64K space."),
        label: z.string().optional().describe("Optional label/comment for the relocated region."),
        subSegments: z.array(z.object({
          start: z.union([z.string(), z.number()]),
          end: z.union([z.string(), z.number()]),
          kind: z.string(),
          label: z.string().optional(),
          comment: z.string().optional(),
        })).optional().describe("Runtime-addressed code/data kind hints inside the region."),
      })).optional().describe("Relocated regions, rendered as .pseudopc / .logical blocks at their runtime PC while the stored bytes stay byte-exact. A region outside the span, a reversed range or two overlapping regions are refused by name before anything is rendered."),
    },
    safeHandler("disasm", async (args) => {
      const a = args as Parameters<typeof runDisasm>[1] & { paths?: string[] };
      if (a.paths === undefined) return runDisasm("disasm", a);
      const pd = context.projectDir(a.project_dir ?? a.paths[0], true);
      const batch = () => runBatch({
        invokedAs: "disasm", verb: "rendered", paths: a.paths!, projectDir: pd,
        outputParam: "output_asm", outputValue: a.output_asm,
        single: a.path ?? a.prg_path, artifactId: a.artifact_id,
        each: (path, outcome) => runDisasm("disasm", { ...a, paths: undefined, path, project_dir: pd }, outcome),
      });
      // A 217-path batch takes as long as 217 calls; the MCP host drops the
      // connection at its stall limit. One job for the WHOLE batch (not one per
      // path — that would be N polls again) keeps the connection and hands back
      // a job_id the way a single large analyse already does.
      const job = startAnalysisJob("disasm", pd, batch);
      if (await waitForJob(job, ANALYZE_JOB_GRACE_MS)) {
        if (job.state === "failed") throw new Error(job.error ?? "disasm batch failed");
        return job.result as { content: { type: "text"; text: string }[] };
      }
      return { content: [{ type: "text" as const, text: [
        `disasm is still working through ${a.paths.length} paths — switched to background job mode.`,
        `job_id: ${job.id}`,
        `Poll with analysis_job_status { job_id } every ~30s. Do NOT re-run disasm for these paths.`,
      ].join("\n") }] };
    }),
  );

  server.tool(
    "analyze",
    "Run the heuristic analysis pipeline over bytes and produce structured JSON — segments, cross-references, RAM facts, pointer tables, relocation proposals. Use first on anything you are about to disassemble, headed or not: a PRG, a depacked chunk, a relocated overlay, a block of 1541 drive code. THE LOAD ADDRESS DECIDES HOW THE BYTES ARE READ, NEVER THE FILE NAME — pass load_address and the bytes are raw and start there; leave it out and the file must carry a 2-byte load header, whose first two bytes are read as the address. A header and a load_address that disagree are refused, naming both, and every answer opens with the reading it took. Not for producing assembly (use disasm next; it finds this analysis by asking the project store, whatever directory it sits in) and not for disk / cart images (extract first). Pass offset/length to analyse a window, so the analysis and the listing that consumes it describe one span instead of two; they require load_address, because a window's first byte is not a header. Addresses are HEX with $ or 0x optional; a JSON number is taken as given, and offset/length follow the same rule (\"100\" = 256 bytes, 100 = 100 bytes). MANY FILES AT ONCE: pass `paths` instead of `path` and one call analyses every one of them, each through the same body a single-path call goes through — an extract that produced 217 payloads is one call, not 217. A path that fails is named with its reason and the rest are still analysed; the answer is one line per path, and you leave output_json out because one name cannot hold N analyses. Inputs: path or paths or artifact_id, optional load_address/headed/offset/length/entry_points/output_json. Returns: the reading it took, the analysis JSON path and a summary of what was seeded and what was refused — or, for `paths`, one line per path and the failures named.",
    {
      ...BYTES_INPUT,
      output_json: z.string().optional().describe("Output path for the analysis JSON. Default for a headed file: <stem>_analysis.json next to it; for raw bytes: analysis/raw-analysis/<stem>[_<window>]_<address>_analysis.json."),
    },
    safeHandler("analyze", async (args) => {
      const a = args as Parameters<typeof runAnalyze>[1] & { paths?: string[] };
      if (a.paths === undefined) return runAnalyze("analyze", a);
      const pd = context.projectDir(a.project_dir ?? a.paths[0], true);
      const batch = () => runBatch({
        invokedAs: "analyze", verb: "analysed", paths: a.paths!, projectDir: pd,
        outputParam: "output_json", outputValue: a.output_json,
        single: a.path ?? a.prg_path, artifactId: a.artifact_id,
        each: (path, outcome) => runAnalyze("analyze", { ...a, paths: undefined, path, project_dir: pd }, outcome),
      });
      const job = startAnalysisJob("analyze", pd, batch);
      if (await waitForJob(job, ANALYZE_JOB_GRACE_MS)) {
        if (job.state === "failed") throw new Error(job.error ?? "analyze batch failed");
        return job.result as { content: { type: "text"; text: string }[] };
      }
      return { content: [{ type: "text" as const, text: [
        `analyze is still working through ${a.paths.length} paths — switched to background job mode.`,
        `job_id: ${job.id}`,
        `Poll with analysis_job_status { job_id } every ~30s. Do NOT re-run analyze for these paths.`,
      ].join("\n") }] };
    }),
  );

  // ── the old names ─────────────────────────────────────────────────────────
  //
  // They are named in playbooks, in the doctrine, in gates and in project notes
  // written months ago. Each keeps working for ONE release and renders identically
  // because it IS the same body.
  //
  // Each also names its successor ONCE PER SESSION, in the first answer that name
  // produces — `aliasNotice` in byte-doors.ts keeps that ledger in the project and
  // `agent_onboard` re-arms it, and the answer says it is the last one that will say
  // so. Not once per answer: repeated on every listing the sentence becomes furniture.
  // Not once per PROCESS either, which is what it was until the ledger became a file:
  // this server outlives a session, so the second session on a globally configured one
  // was told nothing. And not nowhere, which is what it was worth before the note
  // carried a reason — a run four days after 866 shipped reached for these names,
  // found they want a PRG header, and wrote `struct.pack('<H', addr) + data` in front
  // of every block it extracted. e2e:866 §8.6 asserts all three halves: the first
  // answer says it, the second does not, and the next session is told again.

  server.tool(
    // retired-name-ok: the alias registration itself — 866 keeps the name alive for one release
    "analyze_prg",
    "Run the heuristic analysis pipeline on a PRG and produce structured JSON — segments, cross-references, RAM facts, pointer tables. Use first on any new PRG to map its structure. Now the same door as `analyze`, which takes headerless bytes too: this name keeps working for one release and says so in its answer. Not for producing assembly (run disasm next, passing this JSON) or for disk/cart images (extract first). Inputs: prg_path, optional project_dir. Returns: analysis JSON path + summary.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project dir)"),
      output_json: z.string().optional().describe("Output path for the analysis JSON (default: next to PRG)"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses, e.g. [\"0827\", \"3E07\"]. Usually unnecessary: when the project graph knows an address another overlay calls into, the scan seeds it by itself and reports what it used. A list does NOT simply add seeds — an address inside an instruction another seed already decoded cannot be honoured, and the analysis names the ones it refused (`rejectedEntryPoints`, also printed in the listing header)."),
    },
    // retired-name-ok: the alias registration itself — 866 keeps the name alive for one release
    safeHandler("analyze_prg", async (args) => runAnalyze("analyze_prg", { ...args, headed: true } as Parameters<typeof runAnalyze>[1])),
  );

  server.tool(
    "analysis_job_status",
    "Use to poll a background job started by analyze or disasm (an image too large, or a `paths` batch too long, to finish synchronously) or by runtime_loader_lens (capture too large to fold synchronously) — each hands back a job_id instead of stalling the call. Not for launching the work itself (use analyze / disasm / runtime_loader_lens). Returns the full original tool result once done — for a batch, the whole per-path report. Inputs: job_id. Returns: running (elapsed) | done (result) | failed (error).",
    {
      job_id: z.string().describe("Job id returned by analyze, by a disasm/analyze `paths` batch, or by runtime_loader_lens."),
    },
    safeHandler("analysis_job_status", async ({ job_id }) => {
      const job = getAnalysisJob(job_id);
      if (!job) {
        return { content: [{ type: "text" as const, text:
          `analysis job ${job_id} unknown — the MCP server likely restarted since it was started. ` +
          `The pipeline writes its output to disk regardless: check for the expected _analysis.json next to the bytes.` }] };
      }
      if (job.state === "running") {
        const elapsed = Math.round((Date.now() - job.startedAtMs) / 1000);
        return { content: [{ type: "text" as const, text:
          `${job.tool} job ${job.id}: still running (${elapsed}s elapsed).\noutput (when done): ${job.outputPath}\nPoll again in ~30s.` }] };
      }
      if (job.state === "failed") throw new Error(`${job.tool} job ${job.id} failed: ${job.error}`);
      return job.result as { content: { type: "text"; text: string }[] };
    }),
  );

  server.tool(
    // retired-name-ok: the alias registration itself — 866 keeps the name alive for one release
    "disasm_prg",
    "Disassemble a PRG to KickAssembler .asm + 64tass .tas, segment-aware when given an analysis JSON. Use after analyze to get readable assembly, and again to render the final annotated version once you have an annotations file. Now the same door as `disasm`, which reads headerless bytes too: this name keeps working for one release and says so in its answer. For relocated/self-relocating loaders (code stored at one address but executed at another), pass `relocations`: each region is rendered as KickAssembler .pseudopc / 64tass .logical at its runtime PC while the stored bytes stay byte-exact — accept the relocation proposals from analyze / propose_annotations (draft.relocations[]) and copy them straight in. Not for the structural scan (use analyze), for menus/multi-file containers (use disasm_menu) or for bytes with no load header (use disasm, passing load_address). An analysis_json named here that EXISTS is the analysis rendered and is never swapped; when it does not exist the project store is asked which analysis is registered for these bytes, and the answer names what it used and why. A `<stem>_annotations.json` next to the PRG/ASM is auto-applied: names (labels, routines, a segment's `label`) apply with or without `analysis_json`, while segment kinds and pointer/jump/immediate tables need `analysis_json` — the listing's header line says which happened, and the tool output quotes it back as `Listing:`. Exact shape: labels[{address,label,comment?}], routines[{address,name,comment?}], segments[{start,end,kind,label?,comment?}], optional pointerTables/jumpTables/immediates. Hex with or without `$`. Loading is tolerant: a bad/mistyped entry (e.g. `addr` for `address`, `name` for a label's `label`) is skipped and reported as `[annotations] applied N, skipped M` in the output — it never crashes the rebuild. In a project created since 2026-09-19 (project_init stamps it) no label, routine or segment name may be longer than 20 characters: such a file is REFUSED before anything is rendered, and the refusal names every offender. Full reference: docs/annotations-reference.md. Inputs: prg_path, optional analysis_json, entry_points, platform, relocations. Returns: .asm/.tas artifact paths.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
      prg_path: z.string().describe("Path to the .prg file"),
      output_asm: z.string().optional().describe("Output path for the .asm file"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses"),
      analysis_json: z.string().optional().describe("Path to a prior analysis JSON for segment-aware disassembly"),
      annotations_path: z.string().optional().describe("Path to an annotations file, instead of the <stem>_annotations.json found beside the PRG, the output or the analysis."),
      platform: z.enum(["c64", "c1541"]).optional().describe("target platform for ZP / IO / ROM symbol tables. Default c64. Use c1541 for drive-side disassembly. Naming it RECORDS the machine for this file: its graph nodes are then indexed in the drive's address space, so a boundary asserted with space=\"drv\" over a range the C64 and the 1541 share (e.g. $0300-$07FF) actually contains them."),
      relocations: z.array(z.object({
        fileStart: z.union([z.string(), z.number()]).describe("Stored/file address of the region's first byte (inclusive). An address is HEX: \"FC00\", \"$FC00\" and \"0xFC00\" are the same; a JSON number is taken as-is. Must lie inside the PRG."),
        fileEnd: z.union([z.string(), z.number()]).describe("Stored/file address of the region's last byte (inclusive). Same hex rule as fileStart. Must lie inside the PRG."),
        runtimeAddr: z.union([z.string(), z.number()]).describe("Logical execution PC that fileStart runs at. Same hex rule; unlike fileStart/fileEnd it may be anywhere in the 64K space."),
        label: z.string().optional().describe("Optional label/comment for the relocated region."),
        subSegments: z.array(z.object({
          start: z.union([z.string(), z.number()]),
          end: z.union([z.string(), z.number()]),
          kind: z.string(),
          label: z.string().optional(),
          comment: z.string().optional(),
        })).optional().describe("Runtime-addressed code/data kind hints inside the region (applied in a later slice; carried through for now)."),
      })).optional().describe("relocated regions, rendered as KickAssembler .pseudopc / 64tass .logical blocks at their runtime PC while the stored bytes stay byte-exact. Every address here obeys the same rule as entry_points: hex, with $ or 0x optional. A region outside the PRG, a reversed range or two overlapping regions are refused by name before anything is rendered. Omit for normal disassembly."),
    },
    // retired-name-ok: the alias registration itself — 866 keeps the name alive for one release
    safeHandler("disasm_prg", async (args) => runDisasm("disasm_prg", { ...args, headed: true } as Parameters<typeof runDisasm>[1])),
  );

  server.tool(
    // retired-name-ok: the alias registration itself — 866 keeps the name alive for one release
    "disasm_raw",
    "Disassemble raw bytes at an address you already know — a depacked chunk, a relocated overlay, a block lifted out of a track, drive code — with no PRG header and none invented. Use when you hold bytes and their runtime address: give a file path (or an artifact id), optionally a byte window, and load_address. Now the same door as `disasm`, which also reads a file that carries a header: this name keeps working for one release and says so in its answer. Not for a file that already carries a 2-byte load address (use disasm without load_address) and not for the running machine's memory (use runtime_monitor_disasm). Same decoder, renderer, annotations and rebuild proof as the PRG reading: it writes .asm + .tas, reassembles them and reports byte-identical or the first divergence, and registers the listing with its provenance — which file, which byte range, which address. Addresses are HEX with $ or 0x optional; a JSON number is taken as given, and offset/length follow the same rule (\"100\" = 256 bytes, 100 = 100 bytes) — every answer prints the window both ways. Pass entry_points when the block does not start with code: a seed resyncs the linear decode there and the bytes before it render as data. Pass analysis_json for segment-aware rendering; it must describe THIS window and is refused when it describes a different span, and no_analysis refuses one outright. When none is named, the project store is asked which analysis is registered for these bytes and the answer names what it found. Annotations it applies are imported into the knowledge graph, so a block with no PRG header gets human names in the graph too. Inputs: path or artifact_id, load_address, optional offset/length/entry_points/analysis_json/no_analysis/annotations_path/cpu/bank. Returns: the .asm/.tas paths, the address span, the instruction count, what was seeded, and the rebuild verdict.",
    {
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json."),
      path: z.string().describe("Path to the file holding the bytes (absolute or project-relative). Use this OR artifact_id.").optional(),
      artifact_id: z.string().optional().describe("Id of an already-registered artifact holding the bytes. Use this OR path."),
      load_address: z.union([z.string(), z.number()]).describe("Where the FIRST byte of the window runs. An address is HEX: \"C000\", \"$C000\" and \"0xC000\" are the same; a JSON number is taken as-is."),
      offset: z.union([z.string(), z.number()]).optional().describe("Byte offset into the file where the block starts. Default 0. Same rule as an address: a string is hex, a JSON number is taken as given."),
      length: z.union([z.string(), z.number()]).optional().describe("How many bytes. Default: to the end of the file. Same rule as offset."),
      entry_points: z.array(z.union([z.string(), z.number()])).optional().describe("Runtime addresses inside the window where code is known to start. Without one the first byte is the only seed. A seed that falls inside a decoded instruction breaks it: the bytes up to the seed render as data and the decode resumes at the seed — byte-exact either way."),
      analysis_json: z.string().optional().describe("Path to an analysis JSON for segment-aware rendering, produced by analyze over THIS window. Named and present it is used unchanged; named and absent, or omitted, the project store is asked which analysis is registered for these bytes."),
      no_analysis: z.boolean().optional().describe("Refuse an analysis outright for this render. Nothing is read, nothing is inherited, and the answer says the listing is linear."),
      annotations_path: z.string().optional().describe("Path to an annotations file (labels/routines/segments). Without it, a <stem>_annotations.json beside the bytes or beside the output is picked up as usual. Whatever is applied is imported into the knowledge graph."),
      output_asm: z.string().optional().describe("Output path for the .asm. Default: analysis/raw-disasm/<stem>[_<window>]_<address>_disasm.asm, and the .tas beside it."),
      cpu: z.enum(["c64", "drive"]).optional().describe("Which 6502 these bytes run on. Default c64. `drive` renders 1541 zero page, VIA registers and drive ROM entry points instead of the C64's."),
      bank: z.number().int().nonnegative().optional().describe("Cartridge bank these bytes belong to, recorded with the listing's provenance."),
      space: z.string().optional().describe("Which memory space these bytes belong to (e.g. \"ram\", \"cart\", \"drive\"), recorded with the listing's provenance."),
    },
    // retired-name-ok: the alias registration itself — 866 keeps the name alive for one release
    safeHandler("disasm_raw", async (args) => runDisasm("disasm_raw", { ...args, headed: false } as Parameters<typeof runDisasm>[1])),
  );

  server.tool(
    "ram_report",
    "Generate a markdown RAM-state facts report from an analysis JSON (zero-page + RAM usage). Use after analyze to summarise how the program uses memory. Not for pointer tables (use pointer_report) or raw bytes (use read_artifact). Inputs: analysis JSON path. Returns: markdown report path.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    safeHandler("ram_report", async ({ analysis_json, output_md }) => {
      const pd = context.projectDir(analysis_json, true);
      const jsonAbs = resolve(pd, analysis_json);
      const outAbs = output_md
        ? resolve(pd, output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_RAM_STATE_FACTS.md");
      const result = await runCli("ram-report", [jsonAbs, outAbs], { projectDir: pd });
      if (result.exitCode === 0) {
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "ram_report",
          title: `RAM report: ${basename(jsonAbs)}`,
          parameters: {
            analysis_json,
            output_md: outAbs,
          },
          inputs: [{
            path: jsonAbs,
            kind: "other",
            scope: "analysis",
            role: "analysis-json",
            format: "json",
            producedByTool: "ram_report",
          }],
          outputs: [{
            path: outAbs,
            kind: "report",
            scope: "generated",
            role: "ram-report",
            format: "markdown",
            producedByTool: "ram_report",
          }],
        });
        result.stdout = (result.stdout || "RAM report complete.") + `\nOutput: ${outAbs}`;
        if (knowledgeRegistration.runPath) {
          result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout += `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    }),
  );

  server.tool(
    "pointer_report",
    "Generate a pointer table facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    safeHandler("pointer_report", async ({ analysis_json, output_md }) => {
      const pd = context.projectDir(analysis_json, true);
      const jsonAbs = resolve(pd, analysis_json);
      const outAbs = output_md
        ? resolve(pd, output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_POINTER_TABLE_FACTS.md");
      const result = await runCli("pointer-report", [jsonAbs, outAbs], { projectDir: pd });
      if (result.exitCode === 0) {
        const knowledgeRegistration = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "pointer_report",
          title: `Pointer report: ${basename(jsonAbs)}`,
          parameters: {
            analysis_json,
            output_md: outAbs,
          },
          inputs: [{
            path: jsonAbs,
            kind: "other",
            scope: "analysis",
            role: "analysis-json",
            format: "json",
            producedByTool: "pointer_report",
          }],
          outputs: [{
            path: outAbs,
            kind: "report",
            scope: "generated",
            role: "pointer-report",
            format: "markdown",
            producedByTool: "pointer_report",
          }],
        });
        result.stdout = (result.stdout || "Pointer report complete.") + `\nOutput: ${outAbs}`;
        if (knowledgeRegistration.runPath) {
          result.stdout += `\nKnowledge run: ${knowledgeRegistration.runPath}`;
        } else if (knowledgeRegistration.message) {
          result.stdout += `\n${knowledgeRegistration.message}`;
        }
      }
      return context.cliResultToContent(result);
    }),
  );

  registerPrgReverseWorkflow(server, context);
}

function registerPrgReverseWorkflow(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "propose_annotations",
    "Generate a DRAFT annotations file (labels, segment reclassifications, routine names, and relocations) from an analysis JSON + optional disasm. Use to bootstrap semantic annotation before hand-editing. The draft's relocations[] entries are in disasm.relocations shape ({fileStart,fileEnd,runtimeAddr} hex) — copy accepted ones straight into disasm(relocations=[...]) to render relocated loader code as .pseudopc/.logical. When hand-editing the draft, the field shape is: labels[{address,label,comment?}], routines[{address,name,comment?}], segments[{start,end,kind,label?,comment?}] (hex with or without `$`) — a mistyped key (`addr`/`name`) is tolerantly skipped, not applied; disasm reports the skip count. Full reference: docs/annotations-reference.md. This door writes a DRAFT to review; it is not how a finished reading is written. Once you know what the ranges and routines ARE, call write_annotations with them — it produces the real `<stem>_annotations.json` that disasm applies and the graph imports, so the draft never has to be hand-edited into shape. What several sessions, subagents or passes produced goes through merge_annotations, which names every contradiction and records who won. Not for saving confirmed knowledge (use save_finding / save_entity); it never overwrites a manual annotations file. Inputs: analysis JSON, optional disasm, persist_questions. Returns: draft annotations path.",
    {
      project_dir: z.string().optional(),
      analysis_json: z.string().describe("Path to the *_analysis.json file (relative to project_dir)."),
      output_path: z.string().optional().describe("Optional draft output path; defaults to <stem>_annotations.draft.json next to the analysis."),
      listing_path: z.string().optional().describe("Optional *_disasm.asm path for label naming heuristics."),
      persist_questions: z.boolean().optional().describe("If true, also save openQuestions[] entries via save_open_question with source=static-analysis."),
    },
    safeHandler("propose_annotations", async ({ project_dir, analysis_json, output_path, listing_path, persist_questions }) => {
      const pd = context.projectDir(project_dir, true);
      const analysisAbs = resolve(pd, analysis_json);
      const draftAbs = output_path ? resolve(pd, output_path) : analysisAbs.replace(/_analysis\.json$/i, "_annotations.draft.json");
      const listingAbs = listing_path ? resolve(pd, listing_path) : undefined;
      // Pipeline runs in CommonJS; spawn the child to keep the ESM/CommonJS
      // boundary clean. The child no longer registers the draft — this door does,
      // below, like every other door that produces a file.
      const args = [analysisAbs, draftAbs];
      if (listingAbs) args.push(listingAbs);
      const result = await runCli("propose-annotations", args, { projectDir: pd });
      // The draft was the last output on the MCP path that only the pipeline child
      // named. `disasm_prg` consumes the file this writes, so an unregistered draft
      // is an annotation nobody can trace back to the run that proposed it.
      if (result.exitCode === 0 && existsSync(draftAbs)) {
        const reg = context.tryRegisterKnowledgeArtifacts(pd, {
          toolName: "propose_annotations",
          title: `Annotation draft: ${basename(analysisAbs)}`,
          parameters: {
            analysis_json: analysisAbs,
            output_path: draftAbs,
            listing_path: listingAbs ?? null,
          },
          inputs: [
            { path: analysisAbs, kind: "other", scope: "analysis", role: "analysis-json", format: "json", producedByTool: "propose_annotations" },
            ...(listingAbs && existsSync(listingAbs)
              ? [{ path: listingAbs, kind: "generated-source" as const, scope: "analysis" as const, role: "disasm", format: "asm", producedByTool: "propose_annotations" }]
              : []),
          ],
          outputs: [{
            path: draftAbs,
            kind: "report",
            scope: "analysis",
            role: "annotation-draft",
            format: "json",
            producedByTool: "propose_annotations",
          }],
        });
        if (reg.runPath) result.stdout = `${result.stdout ?? ""}\nKnowledge run: ${reg.runPath}`;
        // A registration that failed leads the answer; it never trails a success.
        else if (reg.failed && reg.message) result.stdout = `${reg.message}\n\n${result.stdout ?? ""}`;
      }
      // Optional: walk the draft and persist openQuestions.
      if (persist_questions && result.exitCode === 0 && existsSync(draftAbs)) {
        try {
          const draft = JSON.parse(readFileSync(draftAbs, "utf8")) as { openQuestions?: Array<{ title: string; description: string; confidence: number }> };
          const service = new ProjectKnowledgeService(pd);
          let saved = 0;
          for (const q of draft.openQuestions ?? []) {
            service.saveOpenQuestion({
              kind: "static-analysis",
              title: q.title,
              description: q.description,
              confidence: q.confidence,
              source: "static-analysis",
              autoResolvable: true,
            });
            saved += 1;
          }
          result.stdout = (result.stdout ?? "") + `\nPersisted ${saved} open question(s) (source=static-analysis).`;
        } catch (error) {
          result.stdout = (result.stdout ?? "") + `\nPersist questions skipped: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return context.cliResultToContent(result);
    }),
  );

  server.tool(
    "run_prg_reverse_workflow",
    "Run the full first-pass PRG reverse-engineering chain end-to-end: register, analyze, disassemble, RAM + pointer reports, import knowledge, rebuild views. Use to bootstrap a fresh PRG in one call. Not for a single step (call analyze / disasm directly). Inputs: prg_path. Returns: done/incomplete/blocked + the next required semantic action.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project_dir)."),
      mode: z.enum(["quick", "full"]).optional().describe("quick = analyze + disasm only. full = also ram_report + pointer_report. Default full."),
      output_dir: z.string().optional().describe("Override output directory. Default places outputs next to the PRG."),
      rebuild_views: z.boolean().optional().describe("Run build_all_views after the workflow. Default true."),
      entry_points: z.array(z.string()).optional().describe("Optional hex entry-point overrides (e.g. [\"0827\"])."),
    },
    safeHandler("run_prg_reverse_workflow", async ({ project_dir, prg_path, mode, output_dir, rebuild_views, entry_points }) => {
      const pd = context.projectDir(project_dir ?? prg_path, true);
      const result = await runPrgReverseWorkflow({
        projectRoot: pd,
        prgPath: prg_path,
        mode,
        outputDir: output_dir,
        rebuildViews: rebuild_views,
        entryPoints: entry_points,
      });
      return context.cliResultToContent({
        stdout: renderPrgReverseWorkflowResult(result),
        stderr: "",
        exitCode: result.status === "blocked" ? 1 : 0,
      });
    }),
  );

  server.tool(
    "run_payload_reverse_workflow",
    "Run the reverse-engineering workflow on a payload entity. Resolves the payload's source artifact and load address, supports both PRG-header and raw blobs, stamps produced asm artifact ids back onto the payload.",
    {
      project_dir: z.string().optional().describe("Project root directory. Defaults to C64RE_PROJECT_DIR or process.cwd()."),
      payload_id: z.string().describe("Payload entity id (kind=payload)."),
      mode: z.enum(["quick", "full"]).optional().describe("quick = analyze + disasm only. full = also ram_report + pointer_report. Default full."),
      output_dir: z.string().optional().describe("Override output directory. Default artifacts/generated/payloads/<payload_id>."),
      rebuild_views: z.boolean().optional().describe("Run build_all_views after the workflow. Default true."),
      entry_points: z.array(z.string()).optional().describe("Optional hex entry-point overrides."),
    },
    safeHandler("run_payload_reverse_workflow", async ({ project_dir, payload_id, mode, output_dir, rebuild_views, entry_points }) => {
      const pd = context.projectDir(project_dir, false);
      const result = await runPayloadReverseWorkflow({
        projectRoot: pd,
        payloadId: payload_id,
        mode,
        outputDir: output_dir,
        rebuildViews: rebuild_views,
        entryPoints: entry_points,
      });
      return context.cliResultToContent({
        stdout: renderPrgReverseWorkflowResult(result),
        stderr: "",
        exitCode: result.status === "blocked" ? 1 : 0,
      });
    }),
  );

  // Spec 822.2: `import_annotations_as_findings` (Spec 055 R25) is retired — the
  // annotations file is a door into the graph's human layer (D6), imported by
  // disasm_prg when it changed and by `c64re graph annotations-import <file>`;
  // no finding is minted from it any more.
}
