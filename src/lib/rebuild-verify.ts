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
//
// Spec 914 D4: the assembler is fixed by the file. A listing written in 64tass is built by
// 64tass and nothing else; if that assembler is not here the verdict says so by name. The old
// silent fallback to the other assembler read a file the renderer had never written. The verdict
// is stored on the listing's record, and the stamp in the listing's head — in its dialect's
// comment syntax — is information for the person reading the file.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { assembleSource, find64tassBinary, findKickAssemblerJar } from "../assemble-source.js";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { assemblerOf, dialectLabel, dialectOfPath, rebuildCheckPath, type Dialect } from "./dialect.js";
import { listingHash, stampListing } from "./rebuild-stamp.js";

export interface RebuildVerdict {
  /** The line written into the listing head and returned to the caller, without its comment marker. */
  line: string;
  /** true only when the rebuild matched byte for byte. */
  verified: boolean;
  /** true when the assembler itself could not be run at all (absent jar / no java / no 64tass). */
  assemblerUnavailable: boolean;
  /** The dialect (and so the assembler) the listing was built as. */
  dialect: Dialect;
}

/** Is the assembler of this dialect installed here? */
export function assemblerInstalled(dialect: Dialect): boolean {
  return dialect === "64tass" ? find64tassBinary() !== undefined : findKickAssemblerJar() !== undefined;
}

/** Why a dialect cannot be built here, said by name; undefined when it can. */
export function assemblerMissingReason(dialect: Dialect): string | undefined {
  if (assemblerInstalled(dialect)) return undefined;
  return dialect === "64tass"
    ? "64tass is not installed (set C64RE_64TASS_BIN or put 64tass on PATH), and this listing is written in 64tass — only 64tass builds it"
    : "KickAssembler is not installed (jar not found: set C64RE_KICKASS_JAR, or install it in /Applications/KickAssembler), and this listing is written in KickAssembler — only KickAssembler builds it";
}

export async function rebuildVerification(args: {
  projectDir: string;
  /** The listing. */
  asmPath: string;
  /** The dialect it is written in. Absent: the one its file name says. */
  dialect?: Dialect;
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
  const dialect = args.dialect ?? dialectOfPath(args.asmPath);
  if (dialect === undefined) {
    return {
      line: `WARNING: rebuild verification failed to run: cannot tell which assembler dialect ${basename(args.asmPath)} is written in (name it .asm for KickAssembler or .tas for 64tass)`,
      verified: false,
      assemblerUnavailable: true,
      dialect: "kickass",
    };
  }
  const compared = args.compareLabel ?? basename(args.prgPath);
  const headerless = args.rawBlob === true || args.compareRange !== undefined;
  const tempPrg = rebuildCheckPath(args.asmPath);
  let summaryLine: string;
  let assemblyOk = false;
  let verified = false;
  let assemblerUnavailable = false;
  const assemblerUsed = dialectLabel(dialect);
  try {
    const missing = assemblerMissingReason(dialect);
    if (missing) throw new Error(missing);
    if (!existsSync(args.asmPath)) throw new Error(`${assemblerUsed} is the assembler to use but ${args.asmPath} does not exist`);
    const result = await assembleSource({
      projectDir: args.projectDir,
      sourcePath: args.asmPath,
      assembler: assemblerOf(dialect),
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
      summaryLine = `WARNING: rebuild assembler exited ${result.exitCode}; this listing is not byte-identical with ${compared}`;
      const reason = firstAssemblerError(result.stdout, result.stderr);
      if (reason) summaryLine += ` — ${reason}`;
    } else if (result.compareMatches === false) {
      assemblyOk = true;
      const offset = result.firstDiffOffset !== undefined ? `0x${result.firstDiffOffset.toString(16).toUpperCase()}` : "?";
      summaryLine = `WARNING: rebuild diverges from ${compared} at body offset ${offset}; disassembly is not byte-identical`;
    } else if (result.compareMatches) {
      assemblyOk = true;
      verified = true;
      summaryLine = `rebuild verified byte-identical against ${compared} (${result.comparedBytes ?? "?"} bytes) with ${assemblerUsed}`;
    } else {
      summaryLine = `rebuild verification skipped (no compare result)`;
    }
  } catch (error) {
    // The assembler is absent or would not start: not a verdict about the listing.
    assemblerUnavailable = true;
    summaryLine = `WARNING: rebuild verification failed to run: ${error instanceof Error ? error.message : String(error)}`;
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

  // The stamp in the head of the listing, in the listing's own comment syntax, so a human
  // reading the file sees the verdict without consulting the tool stdout.
  try {
    writeFileSync(args.asmPath, stampListing(readFileSync(args.asmPath, "utf8"), dialect, summaryLine), "utf8");
  } catch {
    // best-effort header injection; don't fail the disasm flow over it
  }

  // The verdict itself lives on the listing's record (D4), measured against the file as it is
  // now — stamp included — so that any later edit reads as "not proven".
  if (!assemblerUnavailable) {
    try {
      const service = new ProjectKnowledgeService(args.projectDir);
      const row = service.listArtifacts().find((a) => a.path === args.asmPath);
      const hash = listingHash(args.asmPath);
      if (row) {
        service.setArtifactDialectFields(row.id, {
          rebuild: {
            verified,
            assembler: dialect,
            line: summaryLine,
            ...(hash ? { listingHash: hash } : {}),
            checkedAt: new Date().toISOString(),
          },
        });
      }
    } catch {
      // the stamp stands even when the record could not be written
    }
  }

  return { line: summaryLine, verified, assemblerUnavailable, dialect };
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
