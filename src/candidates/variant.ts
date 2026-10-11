// A variant is a name and, per target, the bytes it writes. The bytes are assembled when the variant
// is set (with the project's assembler) and kept, so a run never depends on the assembler being
// there and a restart does not lose them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assembleSource } from "../assemble-source.js";
import { safeSegment } from "../lib/id-path.js";
import { candidateScratchDir, type PatchSpace, type Variant, type VariantTarget } from "./store.js";

export interface TargetInput {
  addr: number;
  space?: PatchSpace;
  bank?: number;
  /** a source file in the project, assembled here */
  source_path?: string;
  /** source text, written under the candidate's scratch folder and assembled there */
  source?: string;
  /** which assembler for inline source (default KickAssembler); a file is chosen by its extension */
  assembler?: "kickassembler" | "64tass";
  /** bytes already assembled */
  bytes?: number[];
}

export async function assembleTarget(projectDir: string, candId: string, variantName: string, index: number, t: TargetInput): Promise<VariantTarget> {
  const space: PatchSpace = t.space ?? "ram";
  const base = { space, ...(space === "ram" ? {} : { bank: t.bank ?? 0 }), addr: t.addr & 0xffff };
  if (t.bytes && t.bytes.length > 0) {
    return { ...base, source: t.source ?? "", bytes: t.bytes.map((b) => b & 0xff) };
  }
  let sourcePath = t.source_path;
  if (!sourcePath) {
    if (!t.source || t.source.trim() === "") throw new Error(`target ${index} of variant "${variantName}" has no bytes, source or source_path`);
    const dir = candidateScratchDir(projectDir, candId);
    mkdirSync(dir, { recursive: true });
    const ext = t.assembler === "64tass" ? "tas" : "asm";
    sourcePath = relative(projectDir, join(dir, `${safeSegment(variantName)}_${index}.${ext}`));
    writeFileSync(resolve(projectDir, sourcePath), t.source.endsWith("\n") ? t.source : `${t.source}\n`);
  }
  const outputPath = relative(projectDir, join(candidateScratchDir(projectDir, candId), `${safeSegment(variantName)}_${index}.prg`));
  const res = await assembleSource({ projectDir, sourcePath, assembler: t.assembler ?? "auto", outputPath });
  if (res.exitCode !== 0) throw new Error(`assemble failed (${sourcePath}): ${res.stderr || res.stdout}`);
  const prg = readFileSync(res.outputPath);
  if (prg.length < 3) throw new Error(`${sourcePath} assembled to ${prg.length} byte(s) — nothing to put in the machine`);
  const org = prg[0]! | (prg[1]! << 8);
  if (org !== base.addr) {
    throw new Error(`${sourcePath} assembles at $${org.toString(16).padStart(4, "0")} but the target is $${base.addr.toString(16).padStart(4, "0")} — the source's own org is what the delta and the build will use; make them agree`);
  }
  return { ...base, source: readFileSync(res.sourcePath, "utf8"), sourcePath, bytes: Array.from(prg.subarray(2)) };
}

export function setVariant(variants: Variant[], name: string, targets: VariantTarget[]): Variant[] {
  const without = variants.filter((v) => v.name !== name);
  const prev = variants.find((v) => v.name === name);
  // a changed variant has no verdict until it runs again
  const next: Variant = { name, targets, ...(prev && JSON.stringify(prev.targets) === JSON.stringify(targets) && prev.verdict ? { verdict: prev.verdict } : {}) };
  const at = variants.findIndex((v) => v.name === name);
  if (at < 0) return [...without, next];
  const out = [...variants];
  out[at] = next;
  return out;
}
