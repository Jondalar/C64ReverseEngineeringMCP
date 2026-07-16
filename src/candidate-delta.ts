// candidate-delta.ts — Spec 797 final-code-delta.
//
// Turn a candidate's exported source-patch-set (Spec 796 `candidate_export`:
// `{ id, patches: [{ space, bank, addr, source }] }`) into a BUILD-READY delta on
// disk — the code that goes into the real build (the yardstick #4 payoff, the
// meaning bridge). Build-agnostic by default: one `.asm` per target (the source
// already carries its own org) + a machine `delta-manifest.json` + a human
// `DELTA.md`. Drop the files into whatever build you use, or apply per the manifest.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DeltaPatch {
  space: string; // "ram" | "roml" | "romh"
  bank?: number | null;
  addr: number;
  source: string;
}

export interface CandidateExport {
  id: string;
  patches: DeltaPatch[];
}

export interface DeltaEntry {
  file: string;
  space: string;
  bank: number | null;
  addr: number;
}

const hex4 = (n: number): string => (n & 0xffff).toString(16).padStart(4, "0");

/** Deterministic per-patch filename. */
export function deltaFileName(p: DeltaPatch, i: number): string {
  const bank = p.space === "ram" ? "" : `_b${p.bank ?? 0}`;
  return `patch_${i}_${p.space}${bank}_${hex4(p.addr)}.asm`;
}

/** Build the in-memory delta (files + manifest + readme) from an export. Pure. */
export function buildDelta(exp: CandidateExport): {
  files: Record<string, string>;
  manifest: { candidateId: string; patchCount: number; patches: DeltaEntry[] };
} {
  const files: Record<string, string> = {};
  const entries: DeltaEntry[] = [];
  exp.patches.forEach((p, i) => {
    const name = deltaFileName(p, i);
    files[name] = p.source.endsWith("\n") ? p.source : `${p.source}\n`;
    entries.push({
      file: name,
      space: p.space,
      bank: p.space === "ram" ? null : p.bank ?? 0,
      addr: p.addr,
    });
  });
  const manifest = { candidateId: exp.id, patchCount: exp.patches.length, patches: entries };
  files["delta-manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  files["DELTA.md"] = renderReadme(exp, entries);
  return { files, manifest };
}

function renderReadme(exp: CandidateExport, entries: DeltaEntry[]): string {
  const rows = entries.map((e) => {
    const target = e.space === "ram" ? `ram $${hex4(e.addr)}` : `${e.space} bank ${e.bank} $${hex4(e.addr)}`;
    return `| ${target} | \`${e.file}\` |`;
  });
  return [
    `# Candidate delta — ${exp.id}`,
    ``,
    `The code that goes into the real build: **${entries.length} overlay patch(es)**.`,
    `Each \`.asm\` carries its own org; drop them into your build, or apply per`,
    `\`delta-manifest.json\` (each entry = target space/bank/addr + its file).`,
    ``,
    `| target | file |`,
    `|---|---|`,
    ...rows,
    ``,
  ].join("\n");
}

/** Write the delta to `outDir`. Returns the written file names + the manifest. */
export function writeDelta(
  exp: CandidateExport,
  outDir: string,
): { outDir: string; files: string[]; manifest: { candidateId: string; patchCount: number; patches: DeltaEntry[] } } {
  const { files, manifest } = buildDelta(exp);
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content, "utf8");
    written.push(name);
  }
  return { outDir, files: written, manifest };
}
