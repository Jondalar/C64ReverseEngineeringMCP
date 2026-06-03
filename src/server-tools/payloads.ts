import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { subjectIdForArtifact } from "../project-knowledge/artifact-versions.js";
import { autoAnalyzeExtractedPayloads, summarizeAutoChain } from "../lib/extract-auto-chain.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

const PAYLOAD_FORMATS = [
  "raw", "prg",
  "exomizer-raw", "exomizer-sfx",
  "byteboozer", "byteboozer-lykia",
  "rle",
  "bwc-bitstream", "bwc-raw",
  "pucrunch",
  "unknown",
] as const;

const mediumSpanSchema = z.union([
  z.object({
    kind: z.literal("sector"),
    track: z.number().int().positive(),
    sector: z.number().int().nonnegative(),
    offsetInSector: z.number().int().nonnegative().optional(),
    length: z.number().int().nonnegative(),
    // Spec 750 — which disk IMAGE this span is on (disk-manifest artifact id OR the
    // image basename, resolved to the id). Omit for a single-disk project or when the
    // image isn't yet attributed (it shows on all disks, badged "unscoped").
    image: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slot"),
    bank: z.number().int().nonnegative(),
    slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH", "EEPROM", "OTHER"]),
    offsetInBank: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    image: z.string().optional(), // Spec 750 — which cart image (crt-manifest artifact id or basename)
  }),
]);

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerPayloadTools(server: McpServer, ctx: ServerToolContext): void {
  server.tool(
    "register_payload",
    "Register an extracted byte-blob as a first-class payload — the working abstraction across mediums (a disk file, a LUT cart chunk, a hand-carved custom-loader/DD00 block, a PRG). Use after carving a code-derived load (no CBM dir / no on-disk LUT — common in cracks): pass source_prg_path (the carved .prg), load_address, format, and medium_spans (its track/sector on the disk) — it registers the .prg, auto-links the matching disassembly, and the block then shows on the disk view at its T/S, in the memory map at its load address, and in list_payloads with load/fmt/src/asm, exactly like a CBM/LUT-extracted payload. Not for thin name-only records (do NOT use save_entity kind=payload — it omits load/format/source) and not for ASM-only links (use link_payload_to_asm).",
    {
      project_dir: z.string().optional(),
      id: z.string().optional(),
      name: z.string().describe("Human-readable payload name (e.g. 'chunk_42_$8C95', 'engine_4000.prg')."),
      summary: z.string().optional(),
      load_address: z.number().int().min(0).max(0xffff).optional().describe("Where this payload lands at runtime."),
      format: z.enum(PAYLOAD_FORMATS).optional().describe("Format / packer of the source bytes. Default 'unknown'."),
      packer: z.string().optional().describe("Packer name when format is more specific than the enum (e.g. 'lykia-bb2-vM3')."),
      source_artifact_id: z.string().optional().describe("Artifact id of the raw packed bytes (chip dump, disk file, etc.)."),
      source_prg_path: z.string().optional().describe("Path to a carved/extracted .prg (a code-derived custom-loader block). Registered as the source artifact and linked automatically — no need to run project_inventory_sync + look up an id first. Use this OR source_artifact_id."),
      depacked_artifact_id: z.string().optional().describe("Artifact id of the unpacked bytes if a depack ran."),
      asm_artifact_ids: z.array(z.string()).optional().describe("Artifact id(s) of disassembly outputs that cover this payload."),
      content_hash: z.string().optional().describe("Optional sha256/etc. for deduplication."),
      address_start: z.number().int().min(0).max(0xffff).optional().describe("Start of the runtime range covered by this payload. Defaults to load_address."),
      address_end: z.number().int().min(0).max(0xffff).optional().describe("End of the runtime range. Defaults to load_address + length - 1 if depacked."),
      bank: z.number().int().nonnegative().optional(),
      medium_spans: z.array(mediumSpanSchema).optional().describe("Where this payload lives on its source medium. Use sector{track,sector,length} for disk, slot{bank,slot,length} for cart."),
      tags: z.array(z.string()).optional(),
    },
    safeHandler("register_payload", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const addressRange = args.address_start !== undefined && args.address_end !== undefined
        ? { start: args.address_start, end: args.address_end, bank: args.bank }
        : args.load_address !== undefined
          ? { start: args.load_address, end: args.load_address, bank: args.bank }
          : undefined;

      // BUG-024 — accept a carved .prg PATH directly: register it as an artifact
      // and use it as the source (no project_inventory_sync + id lookup first).
      let sourceArtifactId = args.source_artifact_id;
      if (!sourceArtifactId && args.source_prg_path) {
        const prgAbs = resolve(projectRoot, args.source_prg_path);
        if (!existsSync(prgAbs)) throw new Error(`source_prg_path not found: ${prgAbs}`);
        ctx.tryRegisterKnowledgeArtifacts(projectRoot, {
          toolName: "register_payload",
          title: `Payload source: ${basename(prgAbs)}`,
          parameters: { name: args.name },
          inputs: [],
          outputs: [{
            path: prgAbs, kind: "prg", scope: "generated",
            role: "payload-source", format: "prg", producedByTool: "register_payload",
          }],
        });
        sourceArtifactId = service.listArtifacts().find((a) => a.path === prgAbs)?.id;
        if (!sourceArtifactId) throw new Error(`failed to register source .prg: ${prgAbs}`);
      }

      // BUG-024 — auto stem-match disassembly artifacts (block_X.prg ↔
      // block_X_disasm.asm/.tass) so list_payloads shows asm coverage, like the
      // extraction pipeline does. Explicit asm_artifact_ids override.
      let asmArtifactIds = args.asm_artifact_ids;
      if ((!asmArtifactIds || asmArtifactIds.length === 0) && sourceArtifactId) {
        const src = service.listArtifacts().find((a) => a.id === sourceArtifactId);
        if (src) {
          const stem = subjectIdForArtifact(src);
          const matched = service.listArtifacts().filter((a) =>
            a.id !== src.id
            && (a.format === "asm" || a.format === "tass" || /\.(asm|tass)$/i.test(a.path ?? a.relativePath ?? ""))
            && subjectIdForArtifact(a) === stem,
          ).map((a) => a.id);
          if (matched.length > 0) asmArtifactIds = matched;
        }
      }

      // Spec 750 — resolve a span's `image` (disk-/crt-manifest artifact id OR the
      // image's basename/dir) to the manifest artifact id stored as mediumRef. No
      // match (or omitted) ⇒ undefined ⇒ unscoped (shown on all images, badged).
      const mediumArtifacts = service.listArtifacts().filter((a) => a.role === "disk-manifest" || a.role === "crt-manifest");
      const normKey = (s: string) => s.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/g, "");
      const imageKey = (a: { relativePath?: string; path?: string; title?: string }) => {
        const p = a.relativePath ?? a.path ?? "";
        const parts = p.split("/").filter(Boolean);
        const parent = parts.length >= 2 ? parts[parts.length - 2] : (a.title ?? "");
        return parent;
      };
      const resolveImage = (image?: string): string | undefined => {
        if (!image) return undefined;
        if (mediumArtifacts.some((a) => a.id === image)) return image;
        const want = normKey(image);
        const hit = mediumArtifacts.find((a) => {
          const k = normKey(imageKey(a)), t = normKey(a.title ?? "");
          return k.includes(want) || want.includes(k) || t.includes(want);
        });
        return hit?.id;
      };

      const entity = service.saveEntity({
        id: args.id,
        kind: "payload",
        name: args.name,
        summary: args.summary,
        addressRange,
        mediumSpans: args.medium_spans?.map((span) => span.kind === "sector"
          ? { kind: "sector", track: span.track, sector: span.sector, offsetInSector: span.offsetInSector ?? 0, length: span.length, mediumRef: resolveImage(span.image) }
          : { kind: "slot", bank: span.bank, slot: span.slot, offsetInBank: span.offsetInBank, length: span.length, mediumRef: resolveImage(span.image) }),
        payloadLoadAddress: args.load_address,
        payloadFormat: args.format,
        payloadPacker: args.packer,
        payloadSourceArtifactId: sourceArtifactId,
        payloadDepackedArtifactId: args.depacked_artifact_id,
        payloadAsmArtifactIds: asmArtifactIds,
        payloadContentHash: args.content_hash,
        artifactIds: [
          ...(sourceArtifactId ? [sourceArtifactId] : []),
          ...(args.depacked_artifact_id ? [args.depacked_artifact_id] : []),
          ...(asmArtifactIds ?? []),
        ],
        tags: args.tags,
      });
      return textContent([
        `Payload registered.`,
        `ID: ${entity.id}`,
        `Name: ${entity.name}`,
        `Load: ${entity.payloadLoadAddress !== undefined ? `$${entity.payloadLoadAddress.toString(16)}` : "(none)"}`,
        `Format: ${entity.payloadFormat ?? "unknown"}`,
        `Source artifact: ${entity.payloadSourceArtifactId ?? "(none)"}`,
        `Depacked artifact: ${entity.payloadDepackedArtifactId ?? "(none)"}`,
        `ASM artifacts: ${(entity.payloadAsmArtifactIds ?? []).length}`,
      ].join("\n"));
    },
));

  server.tool(
    "link_payload_to_asm",
    "Attach an ASM artifact to a payload entity when the automatic stem-match is wrong. Use after registering a disassembly that covers a payload's bytes. Not for creating the payload (use the extraction tools) or generic entity links (use link_entities). Inputs: payload id, asm artifact id. Returns: updated payload. Idempotent.",
    {
      project_dir: z.string().optional(),
      payload_id: z.string(),
      asm_artifact_id: z.string(),
    },
    safeHandler("link_payload_to_asm", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const payload = service.listEntities({ kind: "payload" }).find((e) => e.id === args.payload_id);
      if (!payload) throw new Error(`No payload with id ${args.payload_id}`);
      const next = new Set(payload.payloadAsmArtifactIds ?? []);
      next.add(args.asm_artifact_id);
      service.saveEntity({
        id: payload.id,
        kind: "payload",
        name: payload.name,
        payloadAsmArtifactIds: [...next],
      });
      return textContent(`payload ${payload.id} now links ${next.size} asm artifact(s).`);
    },
));

  server.tool(
    "link_payload_to_runtime",
    "Record a runtime-trace artifact that proves where this payload lands at runtime. Used by the memory-map view to tag the runtime range as 'has trace evidence'.",
    {
      project_dir: z.string().optional(),
      payload_id: z.string(),
      trace_artifact_id: z.string(),
      load_address: z.number().int().min(0).max(0xffff).optional().describe("Override / record the payload's runtime load address if not already set."),
    },
    safeHandler("link_payload_to_runtime", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const payload = service.listEntities({ kind: "payload" }).find((e) => e.id === args.payload_id);
      if (!payload) throw new Error(`No payload with id ${args.payload_id}`);
      const artifactIds = new Set(payload.artifactIds);
      artifactIds.add(args.trace_artifact_id);
      service.saveEntity({
        id: payload.id,
        kind: "payload",
        name: payload.name,
        artifactIds: [...artifactIds],
        payloadLoadAddress: args.load_address ?? payload.payloadLoadAddress,
      });
      return textContent(`payload ${payload.id} linked to runtime trace ${args.trace_artifact_id}.`);
    },
));

  server.tool(
    "list_payloads",
    "List every payload entity in the project (extracted/loadable byte-blobs). Use to see payloads and their disassembly coverage. Not for files/artifacts on disk (use list_artifacts). Inputs: none. Returns: name, load address, format, source artifact, ASM count per payload.",
    {
      project_dir: z.string().optional(),
      format: z.enum(PAYLOAD_FORMATS).optional().describe("Filter by format."),
      limit: z.number().int().positive().max(500).optional(),
    },
    safeHandler("list_payloads", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const all = service.listEntities({ kind: "payload" });
      const filtered = args.format ? all.filter((p) => p.payloadFormat === args.format) : all;
      const slice = filtered.slice(0, args.limit ?? 100);
      const lines: string[] = [];
      lines.push(`Payloads: ${filtered.length}${filtered.length !== all.length ? ` (of ${all.length})` : ""}`);
      lines.push(``);
      for (const p of slice) {
        const load = p.payloadLoadAddress !== undefined ? `$${p.payloadLoadAddress.toString(16).padStart(4, "0")}` : "—";
        const fmt = p.payloadFormat ?? "?";
        const asm = (p.payloadAsmArtifactIds ?? []).length;
        const source = p.payloadSourceArtifactId ?? "—";
        lines.push(`  ${p.id} | ${p.name} | load=${load} fmt=${fmt} asm=${asm} src=${source}`);
      }
      if (slice.length < filtered.length) {
        lines.push(``);
        lines.push(`(${filtered.length - slice.length} more — raise limit to see)`);
      }
      return textContent(lines.join("\n"));
    },
));

  server.tool(
    "bulk_create_cart_chunk_payloads",
    "Use after extract_crt to promote all cartridge LUT chunks to payload entities in the project knowledge store — run once per cartridge to make every bank/slot chunk visible for analysis, linking, and ASM output. Not for single-chunk operations (use link_cart_chunk_to_asm or record_cart_chunk_packer) or for disk payloads (use extract_disk). Inputs: project dir (optional); dry_run=true previews without writing. Writes payload entities to the knowledge store; the cartridge layout view reflects them after build_all_views.",
    {
      project_dir: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    safeHandler("bulk_create_cart_chunk_payloads", async (args) => {
      const projectRoot = ctx.projectDir(args.project_dir);
      const service = new ProjectKnowledgeService(projectRoot);
      const cartView = service.buildCartridgeLayoutView().view;
      const existingTags = new Set<string>();
      for (const entity of service.listEntities({ kind: "payload" })) {
        for (const tag of entity.tags ?? []) {
          if (tag.startsWith("cart-chunk:")) existingTags.add(tag);
        }
      }
      const artifacts = service.listArtifacts();
      const chipArtifactByPath = new Map<string, string>();
      for (const a of artifacts) {
        if (/\.bin$/i.test(a.relativePath)) chipArtifactByPath.set(a.relativePath, a.id);
      }
      let planned = 0;
      let created = 0;
      let skipped = 0;
      const createdPayloadIds: string[] = []; // Spec 752 L2 — auto-chain targets
      for (const cartridge of cartView.cartridges) {
        const manifestArtifact = artifacts.find((a) => a.id === cartridge.artifactId);
        const manifestDir = manifestArtifact?.relativePath.includes("/") ? manifestArtifact.relativePath.slice(0, manifestArtifact.relativePath.lastIndexOf("/")) : "";
        for (const chunk of cartridge.lutChunks ?? []) {
          const key = `${chunk.bank}:${chunk.slot}:${chunk.offsetInBank}:${chunk.length}`;
          const tag = `cart-chunk:${key}`;
          planned += 1;
          if (existingTags.has(tag)) {
            skipped += 1;
            continue;
          }
          const chip = cartridge.chips.find((c) => {
            const cs = c.slot ?? "ROML";
            if (chunk.slot === "ROML" && cs !== "ROML") return false;
            if ((chunk.slot === "ROMH" || chunk.slot === "ULTIMAX_ROMH") && cs === "ROML") return false;
            return c.bank === chunk.bank;
          });
          const chipPath = chip?.file ? (manifestDir ? `${manifestDir}/${chip.file}` : chip.file) : undefined;
          const chipArtifactId = chipPath ? chipArtifactByPath.get(chipPath) : undefined;
          const slotBase = chunk.slot === "ROMH"
            ? (cartridge.slotLayout?.isUltimax ? 0xe000 : 0xa000)
            : (chunk.slot === "ULTIMAX_ROMH" ? 0xe000 : 0x8000);
          const sourceAddress = slotBase + chunk.offsetInBank;
          if (!args.dry_run) {
            const chunkEntity = service.saveEntity({
              kind: "payload",
              name: chunk.label ?? `${chunk.lut}.${String(chunk.index).padStart(2, "0")} bank ${chunk.bank} ${chunk.slot}`,
              summary: `${chunk.length} bytes, ${chunk.packer ?? chunk.format ?? "raw"}; origin chip $${sourceAddress.toString(16)}`,
              addressRange: chunk.destAddress !== undefined
                ? { start: chunk.destAddress, end: chunk.destAddress + Math.max(chunk.length - 1, 0) }
                : undefined,
              mediumSpans: (chunk.spans ?? [{ bank: chunk.bank, offsetInBank: chunk.offsetInBank, length: chunk.length }]).map((s) => ({
                kind: "slot",
                bank: s.bank,
                slot: chunk.slot,
                offsetInBank: s.offsetInBank,
                length: s.length,
              })),
              payloadLoadAddress: chunk.destAddress,
              payloadFormat: chunk.format ? (chunk.format as any) : "unknown",
              payloadPacker: chunk.packer,
              payloadSourceArtifactId: chipArtifactId,
              tags: ["cart-chunk", "payload", tag],
            });
            createdPayloadIds.push(chunkEntity.id);
            created += 1;
          }
        }
      }
      const lines = [
        `bulk_create_cart_chunk_payloads ${args.dry_run ? "(dry run)" : "complete"}.`,
        `Cartridges scanned: ${cartView.cartridges.length}`,
        `Chunks planned: ${planned}`,
        `Already-payload (skipped): ${skipped}`,
        `Created: ${created}`,
      ];
      // Spec 752 L2 — auto-disasm + analyse the promoted chunk payloads (those
      // with a known load address). Soft-fail; chunk-level carving + depack is
      // a refinement (the chip blob is the available extract today).
      if (!args.dry_run && createdPayloadIds.length > 0) {
        try {
          const chain = await autoAnalyzeExtractedPayloads(projectRoot, createdPayloadIds, { mode: "quick" });
          lines.push(summarizeAutoChain(chain));
        } catch (chainErr) {
          lines.push(`Auto-disasm skipped: ${chainErr instanceof Error ? chainErr.message : String(chainErr)}`);
        }
      }
      return textContent(lines.join("\n"));
    },
));

  void existsSync; void statSync; void resolve; // tree-shake guard
}
