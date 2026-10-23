// A variant target is a source file in the project assembled at an address, in RAM or in a window of one
// cartridge bank. The bytes are assembled when a feature file is run (with the project's assembler) and
// kept in the candidate record, so a later step never depends on the assembler being there.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assembleSource } from "../assemble-source.js";
import { safeSegment } from "../lib/id-path.js";
import type { PatchSpace, VariantTarget } from "./store.js";

export interface TargetInput {
  addr: number;
  space?: PatchSpace;
  bank?: number;
  /** a source file, absolute or relative to the project; assembled here */
  source_path: string;
  /** which assembler; default: chosen by the file's extension */
  assembler?: "kickassembler" | "64tass";
}

/**
 * Assemble one target. `scratchDir` is where the assembler's output goes (the caller removes it); the
 * source's own origin must equal the target — that origin is what the delta and the build will use.
 */
export async function assembleTarget(projectDir: string, variantName: string, index: number, t: TargetInput, scratchDir: string): Promise<VariantTarget> {
  const space: PatchSpace = t.space ?? "ram";
  const base = { space, ...(space === "ram" ? {} : { bank: t.bank ?? 0 }), addr: t.addr & 0xffff };
  const abs = resolve(projectDir, t.source_path);
  const inProject = relative(projectDir, abs);
  const sourcePath = inProject.startsWith("..") || resolve(inProject) === inProject ? abs : inProject.split("\\").join("/");
  const outputPath = join(scratchDir, `${safeSegment(variantName)}_${index}.prg`);
  const res = await assembleSource({ projectDir, sourcePath: abs, assembler: t.assembler ?? "auto", outputPath });
  if (res.exitCode !== 0) throw new Error(`assemble failed (${sourcePath}): ${res.stderr || res.stdout}`);
  const prg = readFileSync(res.outputPath);
  if (prg.length < 3) throw new Error(`${sourcePath} assembled to ${prg.length} byte(s) — nothing to put in the machine`);
  const org = prg[0]! | (prg[1]! << 8);
  if (org !== base.addr) {
    throw new Error(`${sourcePath} assembles at $${org.toString(16).padStart(4, "0")} but the target is $${base.addr.toString(16).padStart(4, "0")} — the source's own org is what the delta and the build will use; make them agree`);
  }
  return { ...base, source: readFileSync(res.sourcePath, "utf8"), sourcePath, bytes: Array.from(prg.subarray(2)) };
}

export interface LoadInput {
  space?: PatchSpace;
  bank?: number;
  /** Absent only for a `.prg`: the file's own load address. */
  addr?: number;
  /** a built file, absolute */
  file: string;
}

/**
 * Take built bytes as they are. A `.prg` has a two-byte load address in front: it is the address when none is
 * given, and never part of the bytes. Any other file is headerless and needs its address — none is guessed.
 */
export function loadTarget(projectDir: string, t: LoadInput): VariantTarget {
  const space: PatchSpace = t.space ?? "ram";
  if (!existsSync(t.file)) throw new Error(`no such file: ${t.file}`);
  const raw = readFileSync(t.file);
  const inProject = relative(projectDir, t.file);
  const shown = inProject.startsWith("..") || resolve(inProject) === inProject ? t.file : inProject.split("\\").join("/");
  const isPrg = /\.prg$/iu.test(t.file);
  let body = raw;
  let addr = t.addr;
  if (isPrg) {
    if (raw.length < 3) throw new Error(`${shown} is a PRG of ${raw.length} byte(s) — nothing to put in the machine`);
    addr ??= raw[0]! | (raw[1]! << 8);
    body = raw.subarray(2);
  } else if (addr === undefined) {
    throw new Error(`${shown} is not a .prg, so it has no load address of its own and none is guessed from the bytes — give \`at $<address>\``);
  }
  if (body.length === 0) throw new Error(`${shown} holds no bytes`);
  addr &= 0xffff;
  if (space === "ram" && addr + body.length > 0x10000) throw new Error(`${shown}: ${body.length} byte(s) at $${addr.toString(16).padStart(4, "0")} run past $FFFF`);
  return {
    space, ...(space === "ram" ? {} : { bank: t.bank ?? 0 }), addr, source: "",
    loaded: { path: shown, sha256: createHash("sha256").update(body).digest("hex") },
    bytes: Array.from(body),
  };
}
