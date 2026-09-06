// Spec 822.2 — `c64re graph export`: the graph written back into the legacy
// record shapes as text, for humans and for `git diff`. This is the ONLY code
// outside the migration that produces files of those shapes, and it never
// reads one — the gate `check:822-no-json-readers` allows this file by name.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeRecords } from "./records.js";

export interface ExportResult {
  outDir: string;
  files: Array<{ path: string; records: number }>;
}

export function exportGraphRecords(projectDir: string, outDir?: string): ExportResult {
  const dir = outDir ?? join(projectDir, "knowledge", "export");
  mkdirSync(dir, { recursive: true });
  const records = new KnowledgeRecords(projectDir);
  const now = new Date().toISOString();
  const files: ExportResult["files"] = [];
  const write = (name: string, items: unknown[]) => {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, exportedAt: now, source: "knowledge/graph.sqlite (Spec 822 export)", items }, null, 2)}\n`);
    files.push({ path, records: items.length });
  };
  write("entities.json", records.listEntities());
  write("findings.json", records.listFindings());
  write("relations.json", records.listRelations());
  write("open-questions.json", records.listOpenQuestions());
  write("labels.user.json", records.listUserLabels());
  return { outDir: dir, files };
}
