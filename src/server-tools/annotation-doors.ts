// The two doors that put MEANING into a file.
//
// `write_annotations` takes segments / labels / routines and produces the file the
// importer accepts. Nothing did, so five subagents on one run wrote five generators
// (`genA.py`, `B_gen.py`, `C_gen.py`, `D_gen.py`, `E_gen.py`) and agreed on neither a
// file name nor the spelling of an address.
//
// The rules the file must satisfy, and why each one is a refusal and not a warning,
// are in `annotation-file.ts` next door.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";
import {
  buildAnnotationsDocument, documentSummary, nameLengthRefusal, overwriteRefusal,
  renderProblems, resolveAnnotationsPath, serialiseDocument,
} from "./annotation-file.js";
import { planMerge, resolutionFinding, type FragmentInput, type ResolutionInput } from "./annotation-merge.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

// The section schemas DOCUMENT the fields and enforce none of them.
//
// That is deliberate and was measured here: with `name` declared required, a routine
// entry that forgot it came back as `MCP error -32602: Input validation error … {"code":
// "invalid_type","expected":"string"}` — the caller learns a type is wrong somewhere and
// nothing about WHICH routine or that the field it typed (`label`, `title`, `addr`) is
// the one the loader calls something else. The whole point of this door is that the
// answer names the entry and the key that was probably meant, in the loader's own
// wording, so every field is optional and `.passthrough()` keeps the mistyped key
// visible for the "did you mean" to find. The checking is in `annotation-file.ts`.
const hexAddress = z.string().optional().describe("Hex address — `43A8`, `$43a8` or `0x43A8`; it is written back as bare uppercase hex");

const segmentSchema = z.object({
  start: hexAddress,
  end: hexAddress.describe("Hex end address, inclusive"),
  kind: z.string().optional().describe("A segment kind: code, text, sprite, charset, bitmap, pointer_table, lookup_table, state_variable, music_data, unknown, …"),
  label: z.string().optional().describe("A name for the segment start"),
  comment: z.string().optional().describe("What this range is, rendered as the block comment above it"),
  space: z.string().optional().describe("Under a relocation: `runtime` (the .pseudopc address, the default) or `file` (the stored position)"),
}).passthrough();
const labelSchema = z.object({
  address: hexAddress,
  label: z.string().optional().describe("The name — one address carries one name, and one name belongs to one address"),
  comment: z.string().optional(),
}).passthrough();
const routineSchema = z.object({
  address: hexAddress,
  name: z.string().optional().describe("What the routine is called — REQUIRED; it prints as the header and renames the label"),
  comment: z.string().optional().describe("What it does, rendered as the block comment above it. Optional: a name alone is a legitimate annotation."),
}).passthrough();
const pointerTableSchema = z.object({
  start: hexAddress, end: hexAddress,
  stride: z.number().int().optional().describe("1 or 2 (default 2, a .word table)"),
  endian: z.string().optional().describe("`little` (default) or `big`"),
  comment: z.string().optional(),
}).passthrough();
const jumpTableSchema = z.object({
  start: hexAddress, end: hexAddress,
  kind: z.string().optional().describe("`jmp`/`jsr` = 3-byte rows, `word` = 2-byte rows"),
  comment: z.string().optional(),
}).passthrough();
const immediateSchema = z.object({
  address: hexAddress.describe("The lda/ldx/ldy #imm instruction to rewrite"),
  kind: z.string().optional().describe("`lo-of` or `hi-of`"),
  label: z.string().optional().describe("The target label the immediate is rewritten to"),
  comment: z.string().optional(),
}).passthrough();

export const ANNOTATION_SECTION_SCHEMAS = {
  segments: segmentSchema,
  labels: labelSchema,
  routines: routineSchema,
  pointerTables: pointerTableSchema,
  jumpTables: jumpTableSchema,
  immediates: immediateSchema,
};

export function registerAnnotationDoors(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "write_annotations",
    "Write the semantic annotation file for a payload from structured input: segments, labels, routines, and the optional pointer/jump/immediate tables. "
    + "Use whenever you have read a listing and know what its ranges and routines ARE — this is the door that turns that into the `<stem>_annotations.json` "
    + "that `disasm` applies and the knowledge graph imports, so you never write the JSON by hand or with a script of your own. "
    + "Every address may be written `43A8`, `$43a8` or `0x43A8` and comes back as bare uppercase hex, so nothing downstream has to normalise. "
    + "It refuses BEFORE the file exists, naming every offending entry by its own index: two segments on one start (the id the listing and the graph "
    + "are both keyed on), a routine with no `name`, one address carrying two names, one name at two addresses, a name past the project's length limit, "
    + "or an output path the importer could not read a stem off. A single offender means nothing is written at all. "
    + "Not for combining what several sessions or subagents wrote (use merge_annotations, which names every contradiction and records who won), "
    + "not for a first guess to review by hand (use propose_annotations, which writes a draft), and not for rendering the listing afterwards (use disasm). "
    + "It will not replace an existing file unless you pass overwrite. "
    + "Inputs: prg_path or output_path, segments/labels/routines, optional pointerTables/jumpTables/immediates, binary, overwrite. "
    + "Returns: the path written, what went into it, and the next call that applies it.",
    {
      project_dir: z.string().optional(),
      prg_path: z.string().optional().describe("The bytes this annotates; the file lands beside them as <stem>_annotations.json"),
      output_path: z.string().optional().describe("An explicit destination. Must end in `_annotations.json` — the importer reads the stem off the file name."),
      binary: z.string().optional().describe("Which binary this annotates, recorded in the file. Defaults to the name of prg_path."),
      segments: z.array(segmentSchema).optional(),
      labels: z.array(labelSchema).optional(),
      routines: z.array(routineSchema).optional(),
      pointerTables: z.array(pointerTableSchema).optional(),
      jumpTables: z.array(jumpTableSchema).optional(),
      immediates: z.array(immediateSchema).optional(),
      overwrite: z.boolean().optional().describe("Replace an existing annotations file (default false — a hand-edited file is not clobbered by accident)."),
    },
    safeHandler("write_annotations", async (args: {
      project_dir?: string; prg_path?: string; output_path?: string; binary?: string;
      segments?: unknown[]; labels?: unknown[]; routines?: unknown[];
      pointerTables?: unknown[]; jumpTables?: unknown[]; immediates?: unknown[];
      overwrite?: boolean;
    }) => {
      const pd = context.projectDir(args.project_dir, true);
      const dest = resolveAnnotationsPath(pd, { outputPath: args.output_path, prgPath: args.prg_path });
      if ("refusal" in dest) return text(dest.refusal);

      const binary = args.binary
        ?? (args.prg_path ? basename(args.prg_path) : `${basename(dest.path).replace(/_annotations\.json$/u, "")}.prg`);
      const { doc, problems, notes } = buildAnnotationsDocument({
        segments: args.segments, labels: args.labels, routines: args.routines,
        pointerTables: args.pointerTables, jumpTables: args.jumpTables, immediates: args.immediates,
      }, binary);

      if (problems.length > 0) {
        return text(renderProblems(`REFUSED — the annotations were not written to ${basename(dest.path)}.`, problems));
      }
      const tooLong = nameLengthRefusal(pd, doc);
      if (tooLong) {
        return text([`REFUSED — the annotations were not written to ${basename(dest.path)}.`, ``, tooLong,
          ``, "`disasm` refuses a file whose names are too long before it renders anything, so writing one would write a file nothing can use."].join("\n"));
      }
      if (existsSync(dest.path) && args.overwrite !== true) return text(overwriteRefusal(dest.path));

      mkdirSync(dirname(dest.path), { recursive: true });
      writeFileSync(dest.path, serialiseDocument(doc));

      const lines = [
        `Wrote ${relative(pd, dest.path)} — ${documentSummary(doc)}.`,
        `Annotates: ${binary}`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      const reg = context.tryRegisterKnowledgeArtifacts(pd, {
        toolName: "write_annotations",
        title: `Annotations: ${basename(dest.path)}`,
        parameters: { output_path: dest.path, binary },
        outputs: [{
          path: dest.path, kind: "report", scope: "analysis", role: "annotations",
          format: "json", producedByTool: "write_annotations",
        }],
      });
      if (reg.failed && reg.message) lines.unshift(reg.message, "");
      else if (reg.runPath) lines.push(`Knowledge run: ${reg.runPath}`);
      lines.push(
        ``,
        args.prg_path
          ? `Next: disasm(path="${args.prg_path}") applies it and imports it into the graph.`
          : `Next: disasm on the bytes this sits beside applies it and imports it into the graph.`,
      );
      return text(lines.join("\n"));
    }),
  );

  const fragmentSchema = z.object({
    name: z.string().optional().describe("Who this reading is from — the name a resolution picks a winner by, and the name the recorded judgement quotes. Defaults to the file stem when `path` is given."),
    path: z.string().optional().describe("Read this fragment from an annotations JSON on disk instead of from the arguments"),
    segments: z.array(segmentSchema).optional(),
    labels: z.array(labelSchema).optional(),
    routines: z.array(routineSchema).optional(),
    pointerTables: z.array(pointerTableSchema).optional(),
    jumpTables: z.array(jumpTableSchema).optional(),
    immediates: z.array(immediateSchema).optional(),
  }).passthrough();

  const resolutionSchema = z.object({
    key: z.string().describe("The contested key, exactly as the refusal printed it: `segment:82E6`, `label:8210`, `routine:64BF` or `name:main_loop`"),
    winner: z.string().optional().describe("The fragment whose claim wins, by name. For a `name:` key it is the fragment whose ADDRESS keeps the name."),
    value: z.record(z.unknown()).optional().describe("An entry neither fragment proposed, stating only what it changes — e.g. { label: \"exit_door_probe\" }. Not both this and `winner`."),
    why: z.string().optional().describe("What you read that decides it. REQUIRED — the reason is the record; without it the judgement dies with the session."),
  }).passthrough();

  server.tool(
    "merge_annotations",
    "Merge several readings of one payload into one annotations file, refusing every contradiction by naming both sides and recording each resolution as a finding. "
    + "Use whenever more than one session, subagent or pass produced annotations for the same bytes — it is the door that replaces a hand-written merge script, "
    + "and the reason it exists is that such a script keeps its judgements in a scratchpad that dies with the session, so the project never learns the merge was contested. "
    + "Two fragments saying the same thing collapse into one and you are asked nothing. Two that disagree — one segment start with two ends or kinds, one address with two names, "
    + "one name at two addresses — are REFUSED, naming the key, every claimant and what each of them claimed. "
    + "You answer with resolutions: [{ key, winner | value, why }], where `winner` is a fragment name, `value` is an entry neither side proposed, and `why` is required. "
    + "Each answer is written into the project as a finding carrying who claimed what, which one won and why — that is the point of the door, not the merged file. "
    + "It refuses a resolution for a key nothing disputes, a winner that claimed nothing there, and a resolution with no reason. "
    + "Not for writing one reading (use write_annotations), not for a first guess to review (use propose_annotations), and not for rendering the listing afterwards (use disasm). "
    + "Inputs: fragments, prg_path or output_path, optional resolutions/binary/dry_run/overwrite. "
    + "Returns: the refusal with both sides named, or the path written, the resolutions recorded, and the findings they became.",
    {
      project_dir: z.string().optional(),
      fragments: z.array(fragmentSchema).describe("The readings to merge — each a name plus sections, or a name plus a path"),
      prg_path: z.string().optional().describe("The bytes these annotate; the merged file lands beside them as <stem>_annotations.json"),
      output_path: z.string().optional().describe("An explicit destination. Must end in `_annotations.json`."),
      binary: z.string().optional(),
      resolutions: z.array(resolutionSchema).optional().describe("One per contested key, as the refusal listed them"),
      dry_run: z.boolean().optional().describe("Report the merge and every contradiction without writing the file or recording anything"),
      overwrite: z.boolean().optional().describe("Replace an existing annotations file (default false)"),
    },
    safeHandler("merge_annotations", async (args: {
      project_dir?: string; fragments: FragmentInput[]; prg_path?: string; output_path?: string;
      binary?: string; resolutions?: ResolutionInput[]; dry_run?: boolean; overwrite?: boolean;
    }) => {
      const pd = context.projectDir(args.project_dir, true);
      const dest = resolveAnnotationsPath(pd, { outputPath: args.output_path, prgPath: args.prg_path });
      if ("refusal" in dest) return text(dest.refusal);
      const binary = args.binary
        ?? (args.prg_path ? basename(args.prg_path) : `${basename(dest.path).replace(/_annotations\.json$/u, "")}.prg`);

      const outcome = planMerge(pd, args.fragments ?? [], args.resolutions ?? [], binary);
      if ("refusal" in outcome) return text(outcome.refusal);
      const { doc, contests, settled, notes } = outcome.plan;

      const tooLong = nameLengthRefusal(pd, doc);
      if (tooLong) {
        return text([`REFUSED — the merge was not written. Nothing was recorded.`, ``, tooLong].join("\n"));
      }

      const outRel = relative(pd, dest.path);
      const head = [
        `${args.fragments.length} fragments → ${documentSummary(doc)}.`,
        `${contests.length} contradiction${contests.length === 1 ? "" : "s"}, ${settled.length} resolved.`,
      ];
      for (const n of notes) head.push(`Note: ${n}`);

      if (args.dry_run === true) {
        const lines = [`Dry run — nothing was written and nothing was recorded.`, ``, ...head, ``, `Would write: ${outRel}`];
        for (const s of settled) {
          lines.push(``, `${s.contest.key} → ${s.resolution.winner ? `${s.resolution.winner}'s reading` : "a value neither side proposed"}: ${s.winning.described}`);
          lines.push(`  why: ${s.resolution.why}`);
        }
        return text(lines.join("\n"));
      }

      if (existsSync(dest.path) && args.overwrite !== true) return text(overwriteRefusal(dest.path));

      // The findings go in FIRST. The merged file is reproducible from the fragments;
      // the judgement is not, and it is the thing the measured run lost.
      const service = new ProjectKnowledgeService(pd);
      const recorded: string[] = [];
      for (const s of settled) {
        const r = resolutionFinding(s, outRel);
        const finding = service.saveFinding({
          id: r.id,
          kind: "classification",
          title: r.title,
          summary: r.summary,
          confidence: 0.9,
          tags: r.tags,
          addressRange: { start: r.addressStart, end: r.addressEnd },
        });
        recorded.push(`${finding.id}  ${r.title}`);
      }

      mkdirSync(dirname(dest.path), { recursive: true });
      writeFileSync(dest.path, serialiseDocument(doc));

      const lines = [`Merged ${args.fragments.length} fragments into ${outRel} — ${documentSummary(doc)}.`, ...head.slice(1)];
      if (recorded.length > 0) {
        lines.push(``, `Recorded ${recorded.length} resolution${recorded.length === 1 ? "" : "s"} as findings — who claimed what, which one won, and why:`);
        for (const r of recorded) lines.push(`  ${r}`);
      }
      const reg = context.tryRegisterKnowledgeArtifacts(pd, {
        toolName: "merge_annotations",
        title: `Annotations (merged): ${basename(dest.path)}`,
        parameters: { output_path: dest.path, binary, fragments: args.fragments.map((f, i) => f.name ?? f.path ?? `fragments[${i}]`) },
        outputs: [{
          path: dest.path, kind: "report", scope: "analysis", role: "annotations",
          format: "json", producedByTool: "merge_annotations",
        }],
      });
      if (reg.failed && reg.message) lines.unshift(reg.message, "");
      else if (reg.runPath) lines.push(`Knowledge run: ${reg.runPath}`);
      lines.push(
        ``,
        args.prg_path
          ? `Next: disasm(path="${args.prg_path}") applies it and imports it into the graph.`
          : `Next: disasm on the bytes this sits beside applies it and imports it into the graph.`,
      );
      return text(lines.join("\n"));
    }),
  );
}
