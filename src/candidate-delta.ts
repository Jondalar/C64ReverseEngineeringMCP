// candidate-delta.ts — the chosen variant as a build-ready delta.
//
// Turn the chosen variant of a candidate (`{ id, patches: [{ space, bank, addr, source, bytes }] }`)
// into a BUILD-READY delta on
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
  /** the source it was assembled from; empty when only the bytes are known */
  source: string;
  /** the assembled bytes — written out as `.byte` lines under the target's org when there is no source */
  bytes?: number[];
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
    files[name] = p.source.trim().length > 0 ? (p.source.endsWith("\n") ? p.source : `${p.source}\n`) : bytesAsSource(p);
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

/** A target with no source: its bytes under its own org, in the syntax both supported assemblers read. */
function bytesAsSource(p: DeltaPatch): string {
  const lines = [`* = $${hex4(p.addr)}`];
  const b = p.bytes ?? [];
  for (let i = 0; i < b.length; i += 16) lines.push(`.byte ${b.slice(i, i + 16).map((x) => `$${(x & 0xff).toString(16).padStart(2, "0")}`).join(",")}`);
  return `${lines.join("\n")}\n`;
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
