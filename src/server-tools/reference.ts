import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type C64RefRomKnowledge,
  buildC64RefRomKnowledge,
  defaultC64RefKnowledgePath,
  loadC64RefRomKnowledge,
  lookupC64RefByAddress,
  searchC64RefKnowledge,
} from "../c64ref-rom-knowledge.js";
import type { ServerToolContext } from "./types.js";

const C64REF_BUILD_ESTIMATE_SECONDS = 5;

type C64RefEntry = NonNullable<ReturnType<typeof lookupC64RefByAddress>>;

function parseHexWord(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
    throw new Error(`Invalid 16-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function c64refEntryToText(entry: C64RefEntry): string {
  const lines = [
    `Address: ${entry.addressHex}`,
    `Heading: ${entry.primaryHeading}`,
  ];
  if (entry.primaryLabel) {
    lines.push(`Primary label: ${entry.primaryLabel}`);
  }
  if (entry.labels.length > 0) {
    lines.push(`Labels: ${entry.labels.join(", ")}`);
  }
  for (const annotation of entry.annotations) {
    lines.push("");
    lines.push(`[${annotation.sourceId}] ${annotation.heading}`);
    if (annotation.section) {
      lines.push(`Section: ${annotation.section}`);
    }
    if (annotation.bytes && annotation.bytes.length > 0) {
      lines.push(`Bytes: ${annotation.bytes.map((value) => formatHexByte(value)).join(" ")}`);
    }
    lines.push(annotation.description);
  }
  return lines.join("\n");
}

/**
 * Spec 828 — what a snapshot actually covers, so a miss can be explained.
 *
 * The snapshot is built from a list of c64ref source files. Before 2026-09-05 that
 * list was ROM-only, so every RAM vector and zero-page cell ($0291 MODE, $0328
 * ISTOP, …) missed — and the tool answered with an empty line, which is why
 * issue #10 asked for a live fetch from sta.c64.org. The data is local; the
 * snapshot just has to be rebuilt.
 */
function describeCoverage(knowledge: C64RefRomKnowledge): { hasMemoryMap: boolean; lines: (address: number | undefined) => string[] } {
  const kinds = new Set((knowledge.sourceFiles ?? []).map((f) => f.kind));
  const hasMemoryMap = kinds.has("memory_map") || kinds.has("symbols");
  return {
    hasMemoryMap,
    lines(address) {
      const out: string[] = [];
      const isLowRam = address !== undefined && address < 0x0400;
      if (!hasMemoryMap) {
        out.push(
          `Snapshot coverage: ROM only (${knowledge.entryCount} entries, built ${knowledge.generatedAt.slice(0, 10)}).`,
          `It carries no memory-map or symbol sources, so RAM vectors and zero page are absent${isLowRam ? " — which is exactly what you asked for" : ""}.`,
          "Rebuild it once with `c64ref_build_rom_knowledge`; the memory map is part of the same upstream and needs no extra source.",
        );
      } else {
        out.push(`Snapshot coverage: ROM + memory map + symbols (${knowledge.entryCount} entries, built ${knowledge.generatedAt.slice(0, 10)}) — this address is genuinely not documented upstream.`);
        if (isLowRam) out.push("For a project-specific meaning at this address use save_finding / list_findings; c64ref only carries what the reference books say.");
      }
      return out;
    },
  };
}

export function registerReferenceTools(server: McpServer, context: ServerToolContext, repoRoot: string): void {
  const c64refKnowledgePath = () => defaultC64RefKnowledgePath(repoRoot);

  server.tool(
    "c64ref_build_rom_knowledge",
    "Fetch and rebuild the local BASIC/KERNAL ROM knowledge snapshot from mist64/c64ref sources.",
    {
      output_path: z.string().optional().describe("Optional output path for the generated JSON knowledge file."),
    },
    async ({ output_path }) => {
      try {
        const outputPath = output_path ? resolve(context.projectDir(output_path, true), output_path) : c64refKnowledgePath();
        const knowledge = await buildC64RefRomKnowledge(outputPath);
        return {
          content: [{
            type: "text" as const,
            text: [
              "C64Ref ROM knowledge rebuilt.",
              `Output: ${outputPath}`,
              `Entries: ${knowledge.entryCount}`,
              `Sources: ${knowledge.sourceFiles.length}`,
              `Generated: ${knowledge.generatedAt}`,
              `Source repo: ${knowledge.sourceRepo} @ ${knowledge.sourceRevision}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  server.tool(
    "c64ref_lookup",
    "Look up C64 BASIC/KERNAL ROM knowledge by address or search term from the local reference snapshot. Use to identify a ROM routine/vector while reading disassembly. Not for project-specific labels (use list_findings / list_entities). Inputs: address or query string. Returns: matching ROM entries.",
    {
      address: z.string().optional().describe("Exact ROM/system address in hex, e.g. FFD5."),
      query: z.string().optional().describe("Search term such as LOAD, SYS, CHRGET, keyboard queue, or NMI."),
      limit: z.number().int().positive().max(20).optional().describe("Maximum number of search hits to return for query searches."),
      auto_build: z.boolean().optional().describe("When true, automatically build the local c64ref snapshot if it does not exist yet."),
    },
    async ({ address, query, limit, auto_build }) => {
      try {
        if (!address && !query) {
          throw new Error("Provide either address or query.");
        }
        const knowledgePath = c64refKnowledgePath();
        if (!existsSync(knowledgePath)) {
          if (auto_build) {
            await buildC64RefRomKnowledge(knowledgePath);
          } else {
            return {
              content: [{
                type: "text" as const,
                text: [
                  "Status: knowledge_missing",
                  `Snapshot: ${knowledgePath}`,
                  `Estimated build time: ${C64REF_BUILD_ESTIMATE_SECONDS}-${C64REF_BUILD_ESTIMATE_SECONDS + 5} seconds`,
                  "Run `c64ref_build_rom_knowledge` first or call `c64ref_lookup` again with `auto_build=true`.",
                ].join("\n"),
              }],
            };
          }
        }
        const knowledge = loadC64RefRomKnowledge(knowledgePath);
        // Spec 828 D2 — a miss says WHY. Returning an empty result taught callers
        // to go and check sta.c64.org by hand (issue #10), when the real cause is
        // usually a snapshot built before the memory-map sources were parsed.
        const coverage = describeCoverage(knowledge);
        if (address) {
          const parsedAddress = parseHexWord(address);
          const entry = lookupC64RefByAddress(knowledge, parsedAddress);
          if (!entry) {
            return { content: [{ type: "text" as const, text: [
              `No C64Ref entry for ${formatHexWord(parsedAddress)}.`,
              ...coverage.lines(parsedAddress),
            ].join("\n") }] };
          }
          return { content: [{ type: "text" as const, text: c64refEntryToText(entry) }] };
        }
        const hits = searchC64RefKnowledge(knowledge, query!, limit ?? 5);
        if (hits.length === 0) {
          return { content: [{ type: "text" as const, text: [
            `No C64Ref hits for query: ${query}`,
            ...coverage.lines(undefined),
          ].join("\n") }] };
        }
        const text = hits
          .map((entry) => `${entry.addressHex} ${entry.primaryLabel ? `[${entry.primaryLabel}] ` : ""}${entry.primaryHeading}`)
          .join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );
}
