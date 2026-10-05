// The rebuild verdict — assemble the listing back and compare it with the bytes it
// came from. This is the half of "extract ⇒ always disasm + analyse" that was missing.
//
// `disasm_prg` has always emitted `rebuild verified byte-identical`; the L2 auto-chain
// that `extract_disk` / `extract_crt` run went through `runPrgReverseWorkflow`, which
// calls the pipeline directly and never verified. One run disassembled 245 files and
// not one listing carried a verdict — the agent had to drive `assemble_source` itself
// to learn whether any of them rebuilt.
//
// Two shapes, because an extracted payload has two shapes. A PRG rebuilds to a PRG and
// compares whole. A RAW blob has no 2-byte load header, while KickAssembler's output
// always does, so its rebuild is compared from byte 2 — otherwise every raw payload
// would report a divergence at offset 0, which is a false alarm and worse than silence.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assembleSource, find64tassBinary, findKickAssemblerJar, type SupportedAssembler } from "../assemble-source.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";

export interface RebuildVerdict {
  /** The `//`-prefixed line written into the listing head and returned to the caller. */
  line: string;
  /** true only when the rebuild matched byte for byte. */
  verified: boolean;
  /** true when the assembler itself could not be run at all (absent jar / no java). */
  assemblerUnavailable: boolean;
}

/**
 * Which assembler checks the listing: the project's `preferredAssembler` first, when it
 * can run here; otherwise whichever is installed, KickAssembler before 64tass.
 * Undefined when neither can run.
 */
export function chooseRebuildAssembler(projectDir: string): SupportedAssembler | undefined {
  let preferred: SupportedAssembler | undefined;
  try {
    const meta = JSON.parse(readFileSync(join(projectDir, "knowledge", "project.json"), "utf8")) as { preferredAssembler?: string };
    if (meta.preferredAssembler === "64tass") preferred = "64tass";
    else if (meta.preferredAssembler === "kickass") preferred = "kickassembler";
  } catch { /* no project record: no preference */ }
  const order: SupportedAssembler[] = preferred === "64tass" ? ["64tass", "kickassembler"] : ["kickassembler", "64tass"];
  return order.find((a) => (a === "kickassembler" ? findKickAssemblerJar() : find64tassBinary()) !== undefined);
}

export async function rebuildVerification(args: {
  projectDir: string;
  asmPath: string;
  prgPath: string;
  sourceArtifactId?: string;
  /** The compared file has no 2-byte PRG header (an extracted raw blob). */
  rawBlob?: boolean;
  /**
   * Compare only this window of `prgPath`. A listing of a block lifted out of a
   * bigger file must be held against the bytes it was rendered from, not against the
   * whole file — otherwise every window reports a length divergence. Implies rawBlob.
   */
  compareRange?: { offset: number; length: number };
  /** What to call the compared bytes in the verdict. Default: the file's basename. */
  compareLabel?: string;
  /** Which tool asked. Recorded on the rebuild-check artifact a divergence leaves. */
  toolName?: string;
  /**
   * Delete the rebuild-check PRG when it VERIFIED. A verified check is a byte-for-byte
   * copy of bytes that are already on disk, plus a load header the assembler insists
   * on — and for a headerless block that stray .prg is precisely the artefact the raw
   * path exists to stop producing. A divergence is kept: then it is evidence.
   */
  discardCheckOnSuccess?: boolean;
}): Promise<RebuildVerdict> {
  const compared = args.compareLabel ?? basename(args.prgPath);
  const headerless = args.rawBlob === true || args.compareRange !== undefined;
  const tempPrg = args.asmPath.replace(/\.asm$/i, "_rebuild_check.prg");
  let summaryLine: string;
  let assemblyOk = false;
  let verified = false;
  let assemblerUnavailable = false;
  let assemblerUsed = "";
  try {
    const assembler = chooseRebuildAssembler(args.projectDir);
    assemblerUsed = assembler === "64tass" ? "64tass" : "KickAssembler";
    if (!assembler) {
      throw new Error("no assembler available: KickAssembler jar not found (set C64RE_KICKASS_JAR) and 64tass not found (set C64RE_64TASS_BIN or put 64tass on PATH)");
    }
    const sourcePath = assembler === "64tass" ? args.asmPath.replace(/\.asm$/i, ".tas") : args.asmPath;
    if (!existsSync(sourcePath)) throw new Error(`${assembler} is the assembler to use but ${sourcePath} does not exist`);
    const result = await assembleSource({
      projectDir: args.projectDir,
      sourcePath,
      assembler,
      outputPath: tempPrg,
      // A raw blob is compared here instead, past the load header the assembler adds.
      ...(headerless ? {} : { compareToPath: args.prgPath }),
    });
    if (headerless && result.exitCode === 0 && existsSync(tempPrg)) {
      const built = readFileSync(tempPrg).subarray(2);
      const whole = readFileSync(args.prgPath);
      const original = args.compareRange
        ? whole.subarray(args.compareRange.offset, args.compareRange.offset + args.compareRange.length)
        : whole;
      let firstDiff: number | undefined;
      for (let i = 0; i < Math.min(built.length, original.length); i++) {
        if (built[i] !== original[i]) { firstDiff = i; break; }
      }
      if (firstDiff === undefined && built.length !== original.length) firstDiff = Math.min(built.length, original.length);
      result.compareMatches = firstDiff === undefined;
      result.comparedBytes = original.length;
      result.firstDiffOffset = firstDiff;
    }
    if (result.exitCode !== 0) {
      // Say WHY. A listing the assembler refuses is the commonest way a round trip
      // fails — an undefined symbol, a branch whose target wrapped out of the block —
      // and an exit code alone sends the caller back to run the assembler by hand.
      summaryLine = `// WARNING: rebuild assembler exited ${result.exitCode}; this listing is not byte-identical with ${compared}`;
      const reason = firstAssemblerError(result.stdout, result.stderr);
      if (reason) summaryLine += ` — ${reason}`;
    } else if (result.compareMatches === false) {
      assemblyOk = true;
      const offset = result.firstDiffOffset !== undefined ? `0x${result.firstDiffOffset.toString(16).toUpperCase()}` : "?";
      summaryLine = `// WARNING: rebuild diverges from ${compared} at body offset ${offset}; disassembly is not byte-identical`;
    } else if (result.compareMatches) {
      assemblyOk = true;
      verified = true;
      summaryLine = `// rebuild verified byte-identical against ${compared} (${result.comparedBytes ?? "?"} bytes) with ${assemblerUsed}`;
    } else {
      summaryLine = `// rebuild verification skipped (no compare result)`;
    }
  } catch (error) {
    // The assembler is absent or would not start: not a verdict about the listing.
    assemblerUnavailable = true;
    summaryLine = `// WARNING: rebuild verification failed to run: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Bug 14: classify the rebuild-check PRG as a verification report rather
  // than letting blanket *.prg globs file it as a regular source PRG.
  //
  // …but ONLY when it diverges. A rebuild that verified is byte-identical to the file
  // it was compared against — that is what "verified" means — and `saveArtifact` dedups
  // by content hash, so registering it OVERWROTE the source artifact's own row: the
  // payload's `01_test.prg` became `01_test_disasm_rebuild_check.prg`, kind `report`,
  // internal `true`, and the payload entity went internal with it. The check that found
  // this only fires once verification runs on the L2 chain, which is why the hazard sat
  // in `disasm_prg` unseen. A byte-identical copy is not a second artifact; blanket
  // globs are already kept off it by DEFAULT_EXCLUDE_GLOBS.
  if (assemblyOk && !verified && existsSync(tempPrg)) {
    try {
      const service = new ProjectKnowledgeService(args.projectDir);
      service.saveArtifact({
        kind: "report",
        scope: "analysis",
        title: `Rebuild check (DIVERGED): ${basename(tempPrg)}`,
        path: tempPrg,
        format: "prg",
        role: "rebuild-check",
        producedByTool: args.toolName ?? "disasm",
        sourceArtifactIds: args.sourceArtifactId ? [args.sourceArtifactId] : undefined,
        tags: ["rebuild-check", "auto"],
      });
    } catch {
      // best effort; don't fail the disasm flow over a registration hiccup
    }
  }

  if (verified && args.discardCheckOnSuccess && existsSync(tempPrg)) {
    try { rmSync(tempPrg, { force: true }); } catch { /* best effort */ }
  }

  // Bake the verdict into the head of the ASM so a human reading the file
  // sees it immediately without having to consult the tool stdout.
  try {
    const asm = readFileSync(args.asmPath, "utf8");
    // Keep the file's own line endings: a CRLF listing must not come back with one LF line in it.
    const eol = asm.includes("\r\n") ? "\r\n" : "\n";
    const lines = asm.split(/\r?\n/);
    const header = lines.findIndex((line) => line.startsWith("//****************"));
    if (header >= 0) {
      // insert before the closing banner
      const closing = lines.findIndex((line, index) => index > header && line.startsWith("//****************"));
      const insertAt = closing >= 0 ? closing : Math.min(lines.length, header + 1);
      // Drop any prior verification line so re-runs don't accumulate.
      const filtered = lines.filter((line) => !line.startsWith("// rebuild verified") && !line.startsWith("// WARNING: rebuild "));
      filtered.splice(insertAt, 0, summaryLine);
      writeFileSync(args.asmPath, filtered.join(eol), "utf8");
    } else {
      writeFileSync(args.asmPath, `${summaryLine}${eol}${asm}`, "utf8");
    }
  } catch {
    // best-effort header injection; don't fail the disasm flow over it
  }

  return { line: summaryLine, verified, assemblerUnavailable };
}

/** The assembler's first complaint, on one line, or nothing when it did not say. */
function firstAssemblerError(stdout: string, stderr: string): string | undefined {
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const text = line.trim();
    if (/^(Error|error:|\*\*\* Error)/.test(text) && text.length > 6) {
      return text.replace(/\s+/g, " ").slice(0, 200);
    }
  }
  return undefined;
}
