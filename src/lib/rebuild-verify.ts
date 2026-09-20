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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { assembleSource } from "../assemble-source.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";

export interface RebuildVerdict {
  /** The `//`-prefixed line written into the listing head and returned to the caller. */
  line: string;
  /** true only when the rebuild matched byte for byte. */
  verified: boolean;
  /** true when the assembler itself could not be run at all (absent jar / no java). */
  assemblerUnavailable: boolean;
}

export async function rebuildVerification(args: {
  projectDir: string;
  asmPath: string;
  prgPath: string;
  sourceArtifactId?: string;
  /** The compared file has no 2-byte PRG header (an extracted raw blob). */
  rawBlob?: boolean;
}): Promise<RebuildVerdict> {
  const tempPrg = args.asmPath.replace(/\.asm$/i, "_rebuild_check.prg");
  let summaryLine: string;
  let assemblyOk = false;
  let verified = false;
  let assemblerUnavailable = false;
  try {
    const result = await assembleSource({
      projectDir: args.projectDir,
      sourcePath: args.asmPath,
      assembler: "kickassembler",
      outputPath: tempPrg,
      // A raw blob is compared here instead, past the load header the assembler adds.
      ...(args.rawBlob ? {} : { compareToPath: args.prgPath }),
    });
    if (args.rawBlob && result.exitCode === 0 && existsSync(tempPrg)) {
      const built = readFileSync(tempPrg).subarray(2);
      const original = readFileSync(args.prgPath);
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
      summaryLine = `// WARNING: rebuild assembler exited ${result.exitCode}; this listing is not byte-identical with ${basename(args.prgPath)}`;
    } else if (result.compareMatches === false) {
      assemblyOk = true;
      const offset = result.firstDiffOffset !== undefined ? `0x${result.firstDiffOffset.toString(16).toUpperCase()}` : "?";
      summaryLine = `// WARNING: rebuild diverges from ${basename(args.prgPath)} at body offset ${offset}; disassembly is not byte-identical`;
    } else if (result.compareMatches) {
      assemblyOk = true;
      verified = true;
      summaryLine = `// rebuild verified byte-identical against ${basename(args.prgPath)} (${result.comparedBytes ?? "?"} bytes)`;
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
        producedByTool: "disasm_prg",
        sourceArtifactIds: args.sourceArtifactId ? [args.sourceArtifactId] : undefined,
        tags: ["rebuild-check", "auto"],
      });
    } catch {
      // best effort; don't fail the disasm flow over a registration hiccup
    }
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
