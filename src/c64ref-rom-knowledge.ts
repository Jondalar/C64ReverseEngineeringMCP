import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface C64RefSourceSpec {
  id: string;
  path: string;
  kind: "c64disasm" | "kernal_api";
  titleHint: string;
}

export interface C64RefKnowledgeAnnotation {
  sourceId: string;
  sourcePath: string;
  sourceTitle: string;
  kind: "code" | "data" | "api";
  heading: string;
  description: string;
  section?: string;
  bytes?: number[];
}

export interface C64RefKnowledgeEntry {
  address: number;
  addressHex: string;
  primaryHeading: string;
  primaryLabel?: string;
  annotations: C64RefKnowledgeAnnotation[];
  labels: string[];
  sections: string[];
  searchableText: string;
}

export interface C64RefRomKnowledge {
  generatedAt: string;
  sourceRepo: string;
  sourceRevision: string;
  sourceFiles: Array<{ id: string; path: string; title: string; kind: string }>;
  entryCount: number;
  entries: C64RefKnowledgeEntry[];
}

const SOURCE_REPO = "https://github.com/mist64/c64ref";
const RAW_BASE = "https://raw.githubusercontent.com/mist64/c64ref/master";
const SOURCE_REVISION = "master";

export const C64REF_SOURCE_SPECS: C64RefSourceSpec[] = [
  { id: "c64disasm_cbm", path: "src/c64disasm/c64disasm_cbm.txt", kind: "c64disasm", titleHint: "Commodore KERNAL source comments" },
  { id: "c64disasm_en", path: "src/c64disasm/c64disasm_en.txt", kind: "c64disasm", titleHint: "Lee Davison disassembly" },
  { id: "c64disasm_de", path: "src/c64disasm/c64disasm_de.txt", kind: "c64disasm", titleHint: "Data Becker German disassembly" },
  { id: "c64disasm_mn", path: "src/c64disasm/c64disasm_mn.txt", kind: "c64disasm", titleHint: "Magnus Nyman disassembly" },
  { id: "c64disasm_mm", path: "src/c64disasm/c64disasm_mm.txt", kind: "c64disasm", titleHint: "Marko Makela disassembly" },
  { id: "c64disasm_ms", path: "src/c64disasm/c64disasm_ms.txt", kind: "c64disasm", titleHint: "Microsoft BASIC source comments" },
  { id: "c64disasm_sc", path: "src/c64disasm/c64disasm_sc.txt", kind: "c64disasm", titleHint: "Bob Sander-Cederlof BASIC comments" },
  { id: "kernal_ld", path: "src/kernal/kernal_ld.txt", kind: "kernal_api", titleHint: "Lee Davison KERNAL API" },
  { id: "kernal_prg", path: "src/kernal/kernal_prg.txt", kind: "kernal_api", titleHint: "Programmer's Reference Guide KERNAL API" },
  { id: "kernal_mapc64", path: "src/kernal/kernal_mapc64.txt", kind: "kernal_api", titleHint: "Mapping the Commodore 64 KERNAL API" },
  { id: "kernal_sta", path: "src/kernal/kernal_sta.txt", kind: "kernal_api", titleHint: "STA KERNAL API" },
  { id: "kernal_fk", path: "src/kernal/kernal_fk.txt", kind: "kernal_api", titleHint: "Frank Kontros KERNAL jump table" },
  { id: "kernal_pm", path: "src/kernal/kernal_pm.txt", kind: "kernal_api", titleHint: "Cracking the KERNAL" },
  { id: "kernal_ct", path: "src/kernal/kernal_ct.txt", kind: "kernal_api", titleHint: "Craig Taylor KERNAL" },
  { id: "kernal_dh", path: "src/kernal/kernal_dh.txt", kind: "kernal_api", titleHint: "Dan Heeb KERNAL" },
  { id: "kernal_mlr", path: "src/kernal/kernal_mlr.txt", kind: "kernal_api", titleHint: "Machine Language Routines KERNAL" },
  { id: "kernal_64intern", path: "src/kernal/kernal_64intern.txt", kind: "kernal_api", titleHint: "64 intern KERNAL" },
  { id: "kernal_128intern", path: "src/kernal/kernal_128intern.txt", kind: "kernal_api", titleHint: "128 intern KERNAL" },
];

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function cleanHeading(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function defaultTitleFromText(text: string, fallback: string): string {
  const line = text.split("\n").find((entry) => entry.startsWith("- "));
  return line ? line.slice(2).trim() : fallback;
}

async function fetchSourceText(spec: C64RefSourceSpec): Promise<{ title: string; text: string }> {
  const url = `${RAW_BASE}/${spec.path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return {
    title: defaultTitleFromText(text, spec.titleHint),
    text,
  };
}

function parseByteList(fragment: string): number[] {
  return fragment
    .trim()
    .split(/\s+/u)
    .filter((part) => /^[0-9A-F]{2}$/iu.test(part))
    .map((part) => parseInt(part, 16));
}

function parseDisasmLine(line: string): { kind: "code" | "data"; address: number; bytes: number[]; heading: string } | null {
  const match = line.match(/^\.([:,])([0-9A-F]{4})\s+(.*)$/u);
  if (!match) {
    return null;
  }
  const kind = match[1] === "," ? "code" : "data";
  const address = parseInt(match[2]!, 16);
  const remainder = match[3]!;
  const tokenized = remainder.split(/\s+/u).filter(Boolean);
  const bytes: number[] = [];
  let index = 0;
  while (index < tokenized.length && /^[0-9A-F]{2}$/iu.test(tokenized[index]!)) {
    bytes.push(parseInt(tokenized[index]!, 16));
    index += 1;
  }
  if (bytes.length === 0) {
    return null;
  }
  return {
    kind,
    address,
    bytes,
    heading: cleanHeading(tokenized.slice(index).join(" ")),
  };
}

function parseC64Disasm(spec: C64RefSourceSpec, title: string, text: string): Array<C64RefKnowledgeAnnotation & { address: number }> {
  const annotations: Array<C64RefKnowledgeAnnotation & { address: number }> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let currentSection: string | undefined;
  let current: (C64RefKnowledgeAnnotation & { address: number }) | undefined;

  const flush = () => {
    if (!current) return;
    current.heading = cleanHeading(current.heading);
    current.description = cleanHeading(current.description);
    annotations.push(current);
    current = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const sectionCandidate = trimmed.trim();
    if (sectionCandidate.startsWith(".LIB")) {
      flush();
      currentSection = cleanHeading(sectionCandidate.replace(/^\.LIB\s+/u, ""));
      continue;
    }
    if (sectionCandidate.startsWith("***") || sectionCandidate.startsWith("###")) {
      flush();
      currentSection = cleanHeading(sectionCandidate.replace(/^(?:\*\*\*|###)\s*/u, ""));
      continue;
    }

    const parsedLine = parseDisasmLine(trimmed);
    if (parsedLine) {
      flush();
      current = {
        address: parsedLine.address,
        sourceId: spec.id,
        sourcePath: spec.path,
        sourceTitle: title,
        kind: parsedLine.kind,
        heading: parsedLine.heading,
        description: parsedLine.heading,
        section: currentSection,
        bytes: parsedLine.bytes,
      };
      current.description = parsedLine.heading;
      current.heading = parsedLine.heading || currentSection || formatHexWord(parsedLine.address);
      continue;
    }

    if (current) {
      const overflow = trimmed.trim();
      if (!overflow) {
        continue;
      }
      if (trimmed.startsWith("                                ")) {
        current.description = cleanHeading(`${current.description} ${overflow}`);
      }
    }
  }
  flush();

  return annotations.map((annotation) => ({
    ...annotation,
    description: annotation.description || annotation.heading,
    heading: annotation.heading || annotation.description || formatHexWord(annotation.address),
    bytes: annotation.bytes?.length ? annotation.bytes : undefined,
    section: annotation.section || undefined,
  }));
}

function parseKernalApi(spec: C64RefSourceSpec, title: string, text: string): Array<C64RefKnowledgeAnnotation & { address: number }> {
  const annotations: Array<C64RefKnowledgeAnnotation & { address: number }> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let current: (C64RefKnowledgeAnnotation & { address: number; bodyLines: string[] }) | undefined;

  const flush = () => {
    if (!current) return;
    const description = cleanHeading(current.bodyLines.join(" "));
    annotations.push({
      address: current.address,
      sourceId: current.sourceId,
      sourcePath: current.sourcePath,
      sourceTitle: current.sourceTitle,
      kind: current.kind,
      heading: cleanHeading(current.heading),
      description: description || cleanHeading(current.heading),
      section: current.section,
    });
    current = undefined;
  };

  for (const line of lines) {
    const match = line.match(/^\$([0-9A-F]{4})(.*)$/u);
    if (match) {
      flush();
      const address = parseInt(match[1]!, 16);
      const tail = match[2] ?? "";
      const symbol = tail.slice(0, 10).trim();
      const heading = cleanHeading(tail.slice(10).trim());
      current = {
        address,
        sourceId: spec.id,
        sourcePath: spec.path,
        sourceTitle: title,
        kind: "api",
        heading: heading || symbol || formatHexWord(address),
        description: heading || symbol || formatHexWord(address),
        section: undefined,
        bodyLines: [],
      };
      if (symbol) {
        current.section = symbol;
      }
      continue;
    }

    if (current) {
      const trimmed = line.trim();
      if (trimmed) {
        current.bodyLines.push(trimmed);
      }
    }
  }

  flush();
  return annotations;
}

function collectLabels(annotation: C64RefKnowledgeAnnotation): string[] {
  const labels = new Set<string>();
  if (annotation.section && /^[A-Z0-9_#$@.+/-]{2,}$/u.test(annotation.section)) {
    labels.add(annotation.section);
  }
  const headingWords = annotation.heading.match(/\b[A-Z][A-Z0-9_]{2,}\b/gu) ?? [];
  for (const word of headingWords) {
    labels.add(word);
  }
  return [...labels];
}

function mergeKnowledgeEntries(
  parsed: Array<{
    sourceId: string;
    sourcePath: string;
    sourceTitle: string;
    kind: string;
    entries: Array<C64RefKnowledgeAnnotation & { address: number }>;
  }>,
): C64RefRomKnowledge {
  const byAddress = new Map<number, C64RefKnowledgeEntry>();
  const sourceFiles = parsed.map((entry) => ({
    id: entry.sourceId,
    path: entry.sourcePath,
    title: entry.sourceTitle,
    kind: entry.kind,
  }));

  for (const source of parsed) {
    for (const annotation of source.entries) {
      const labels = collectLabels(annotation);
      const existing = byAddress.get(annotation.address) ?? {
        address: annotation.address,
        addressHex: formatHexWord(annotation.address),
        primaryHeading: annotation.heading,
        primaryLabel: labels[0],
        annotations: [],
        labels: [],
        sections: [],
        searchableText: "",
      };
      existing.annotations.push({
        sourceId: annotation.sourceId,
        sourcePath: annotation.sourcePath,
        sourceTitle: annotation.sourceTitle,
        kind: annotation.kind,
        heading: annotation.heading,
        description: annotation.description,
        section: annotation.section,
        bytes: annotation.bytes,
      });
      for (const label of labels) {
        if (!existing.labels.includes(label)) {
          existing.labels.push(label);
        }
      }
      if (annotation.section && !existing.sections.includes(annotation.section)) {
        existing.sections.push(annotation.section);
      }
      if (!existing.primaryHeading || existing.primaryHeading === existing.addressHex) {
        existing.primaryHeading = annotation.heading;
      }
      if (!existing.primaryLabel && labels.length > 0) {
        existing.primaryLabel = labels[0];
      }
      byAddress.set(annotation.address, existing);
    }
  }

  const entries = [...byAddress.values()]
    .sort((a, b) => a.address - b.address)
    .map((entry) => {
      entry.searchableText = normalizeSearchText([
        entry.addressHex,
        entry.primaryHeading,
        entry.primaryLabel ?? "",
        ...entry.labels,
        ...entry.sections,
        ...entry.annotations.flatMap((annotation) => [annotation.heading, annotation.description, annotation.sourceTitle]),
      ].join(" "));
      return entry;
    });

  return {
    generatedAt: new Date().toISOString(),
    sourceRepo: SOURCE_REPO,
    sourceRevision: SOURCE_REVISION,
    sourceFiles,
    entryCount: entries.length,
    entries,
  };
}

export async function buildC64RefRomKnowledge(outputPath: string): Promise<C64RefRomKnowledge> {
  const parsedSources: Array<{
    sourceId: string;
    sourcePath: string;
    sourceTitle: string;
    kind: string;
    entries: Array<C64RefKnowledgeAnnotation & { address: number }>;
  }> = [];

  for (const spec of C64REF_SOURCE_SPECS) {
    const { title, text } = await fetchSourceText(spec);
    const entries = spec.kind === "c64disasm"
      ? parseC64Disasm(spec, title, text)
      : parseKernalApi(spec, title, text);
    parsedSources.push({
      sourceId: spec.id,
      sourcePath: spec.path,
      sourceTitle: title,
      kind: spec.kind,
      entries,
    });
  }

  const knowledge = mergeKnowledgeEntries(parsedSources);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(knowledge, null, 2)}\n`, "utf8");
  return knowledge;
}

export function defaultC64RefKnowledgePath(repoRoot: string): string {
  return join(repoRoot, "resources", "c64ref-rom-knowledge.json");
}

export function loadC64RefRomKnowledge(knowledgePath: string): C64RefRomKnowledge {
  if (!existsSync(knowledgePath)) {
    throw new Error(`C64Ref ROM knowledge file not found: ${knowledgePath}. Run the builder first.`);
  }
  return JSON.parse(readFileSync(knowledgePath, "utf8")) as C64RefRomKnowledge;
}

export function lookupC64RefByAddress(knowledge: C64RefRomKnowledge, address: number): C64RefKnowledgeEntry | undefined {
  const normalized = address & 0xffff;
  return knowledge.entries.find((entry) => entry.address === normalized);
}

export function searchC64RefKnowledge(knowledge: C64RefRomKnowledge, query: string, limit = 5): C64RefKnowledgeEntry[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const exactAddress = trimmed.match(/^\$?([0-9A-F]{4})$/iu);
  if (exactAddress) {
    const hit = lookupC64RefByAddress(knowledge, parseInt(exactAddress[1]!, 16));
    return hit ? [hit] : [];
  }
  const normalized = normalizeSearchText(trimmed);
  return knowledge.entries
    .map((entry) => {
      let score = 0;
      if (entry.addressHex.toLowerCase() === normalized) score += 200;
      if (normalizeSearchText(entry.primaryHeading).includes(normalized)) score += 100;
      if ((entry.primaryLabel && normalizeSearchText(entry.primaryLabel).includes(normalized))) score += 90;
      if (entry.labels.some((label) => normalizeSearchText(label).includes(normalized))) score += 80;
      if (entry.annotations.some((annotation) => normalizeSearchText(annotation.heading).includes(normalized))) score += 50;
      if (entry.searchableText.includes(normalized)) score += 10;
      return { entry, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.address - b.entry.address)
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

export async function buildDefaultC64RefRomKnowledge(repoRoot: string): Promise<C64RefRomKnowledge> {
  return buildC64RefRomKnowledge(defaultC64RefKnowledgePath(resolve(repoRoot)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const outputPath = process.argv[2] ? resolve(process.argv[2]) : defaultC64RefKnowledgePath(repoRoot);
  buildC64RefRomKnowledge(outputPath)
    .then((knowledge) => {
      console.log(`Built C64Ref ROM knowledge: ${knowledge.entryCount} address entries -> ${outputPath}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
