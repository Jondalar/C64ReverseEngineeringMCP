import { existsSync } from "node:fs";
import { platformKb } from "../platform-kb/read.js";
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


// Spec 817 built ONE table for what c64ref does not cover — EasyFlash registers, the
// 1541's zero page and VIAs, the DOS ROM symbols, and since issue #21 the $01 banking
// semantics with their descriptions. `c64ref_lookup` could not see any of it: asking for
// $DE00 returned c64ref's "Reserved for I/O Expansion" while our own EF_BANK entry sat
// in the other store, and "current track" returned nothing at all.
//
// So the lookup consults both. c64ref stays the producer for everything it covers; the
// extension table is appended, and it is the only one of the two that carries prose.
function platformKbLines(address: number): string[] {
  try {
    const kb = platformKb();
    const node = kb.node("c64", address) ?? kb.node("c1541", address);
    if (!node) return [];
    const out = [`Platform KB: ${node.symbol ? `${node.symbol} — ` : ""}${node.name} [${node.source}]`];
    if (node.description) out.push(node.description);
    return out;
  } catch { return []; }
}

function platformKbSearch(query: string, limit: number): string[] {
  try {
    const kb = platformKb();
    const hits = [...kb.search("c64", query, limit), ...kb.search("c1541", query, limit)].slice(0, limit);
    return hits.map((n) => `$${n.address.toString(16).toUpperCase().padStart(4, "0")} ${n.symbol ? `[${n.symbol}] ` : ""}${n.name} [${n.source}]`);
  } catch { return []; }
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
            // Spec 716.1 — the snapshot is a 27 MB derived file. It is gitignored, so it
            // is in no package, and building it FETCHES FROM THE NETWORK. An installed
            // C64RE therefore met a hard prerequisite here where it did not need to: the
            // platform KB is seeded from the same sources, ships at 1.4 MB, and the two
            // fallbacks below already existed — they were simply unreachable, because this
            // branch returned before anything consulted them.
            //
            // So answer from what shipped, and offer the snapshot as the enrichment it is.
            const kb = address
              ? platformKbLines(parseHexWord(address))
              : platformKbSearch(query ?? "", limit ?? 10);
            if (kb.length) {
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    ...kb,
                    "",
                    "From the bundled platform KB. The fuller C64Ref snapshot is not built here —",
                    "`c64ref_lookup` with `auto_build=true` builds it, which needs network access.",
                  ].join("\n"),
                }],
              };
            }
            return {
              content: [{
                type: "text" as const,
                text: [
                  "Status: knowledge_missing",
                  `Snapshot: ${knowledgePath}`,
                  "The bundled platform KB has nothing for this either.",
                  `Estimated build time: ${C64REF_BUILD_ESTIMATE_SECONDS}-${C64REF_BUILD_ESTIMATE_SECONDS + 5} seconds, and it needs network access.`,
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
          const kbLines = platformKbLines(parsedAddress);
          if (!entry) {
            return { content: [{ type: "text" as const, text: [
              ...(kbLines.length ? kbLines : [`No C64Ref entry for ${formatHexWord(parsedAddress)}.`]),
              ...(kbLines.length ? [] : coverage.lines(parsedAddress)),
            ].join("\n") }] };
          }
          return { content: [{ type: "text" as const, text: [c64refEntryToText(entry), ...kbLines].join("\n") }] };
        }
        const hits = searchC64RefKnowledge(knowledge, query!, limit ?? 5);
        const asAddress = /^(?:\$|0x)?([0-9A-F]{1,4})$/iu.exec(query!.trim());
        const kbExtra = asAddress
          ? platformKbLines(parseInt(asAddress[1]!, 16))
          : platformKbSearch(query!, limit ?? 5);
        if (hits.length === 0) {
          return { content: [{ type: "text" as const, text: [
            ...(kbExtra.length ? kbExtra : [`No C64Ref hits for query: ${query}`]),
            ...(kbExtra.length ? [] : coverage.lines(undefined)),
          ].join("\n") }] };
        }
        const text = [
          ...hits.map((entry) => `${entry.addressHex} ${entry.primaryLabel ? `[${entry.primaryLabel}] ` : ""}${entry.primaryHeading}`),
          ...kbExtra,
        ].join("\n");
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
