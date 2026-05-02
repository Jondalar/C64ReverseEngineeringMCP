import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseCrt, writeCrtOutputs } from "./lib/crt";
import { exportMenuPayloads, reconstructBootPayloads } from "./lib/easyflash";
import { emitKickAssemblerSources } from "./lib/kickasm";
import { disassemblePrgToKickAsm } from "./lib/prg-disasm";
import { analyzePrgFile, analyzeRawFile, writeAnalysisReport } from "./analysis/pipeline";
import { renderPointerTableMarkdown } from "./analysis/pointer-tables";
import { renderRamStateMarkdown } from "./analysis/ram-state";
import { analyzeSampleBuffer } from "./analysis/sample";
import { consumeRegisterFlags, registerCliArtifact, registerCliPayload } from "./lib/artifact-register";
import { readFileSync as readFileSyncFs } from "node:fs";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  node dist/cli.js extract-crt <crt> [outputDir]",
      "  node dist/cli.js reconstruct-lut [analysisDir]",
      "  node dist/cli.js export-menu [analysisDir]",
      "  node dist/cli.js disasm-menu [analysisDir] [outputDir]",
      "  node dist/cli.js disasm-prg <prg> [outputAsm] [entryHex,...] [analysisJson]",
      "  node dist/cli.js analyze-prg <prg> [outputJson] [entryHex,...]",
      "  node dist/cli.js ram-report <analysisJson> [outputMd]",
      "  node dist/cli.js pointer-report <analysisJson> [outputMd]",
      "  node dist/cli.js analyze-sample [outputJson]",
      "",
      "Append --no-register to suppress automatic artifact registration when",
      "writing into a project that already has knowledge/phase-plan.json.",
    ].join("\n"),
  );
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  const cleaned = consumeRegisterFlags(rawArgs);
  const [command, ...args] = cleaned;
  if (!command) {
    usage();
  }

  if (command === "extract-crt") {
    const crtPath = args[0];
    const outputDir = resolve(args[1] ?? "analysis/extracted");
    if (!crtPath) {
      usage();
    }
    const crtAbs = resolve(crtPath);
    const parsed = parseCrt(readFileSync(crtAbs));
    writeCrtOutputs(parsed, outputDir);
    registerCliArtifact({
      kind: "manifest",
      scope: "generated",
      title: `${basename(crtAbs)} CRT extract`,
      path: resolve(outputDir, "manifest.json"),
      format: "json",
      role: "crt_manifest",
      producedByTool: "pipeline_cli:extract-crt",
    });
    return;
  }

  if (command === "reconstruct-lut") {
    reconstructBootPayloads(resolve(args[0] ?? "analysis"));
    return;
  }

  if (command === "export-menu") {
    exportMenuPayloads(resolve(args[0] ?? "analysis"));
    return;
  }

  if (command === "disasm-menu") {
    const analysisDir = resolve(args[0] ?? "analysis");
    const outputDir = resolve(args[1] ?? `${analysisDir}/kickasm_sources`);
    emitKickAssemblerSources(analysisDir, outputDir);
    return;
  }

  if (command === "disasm-prg") {
    const prgPath = args[0];
    if (!prgPath) {
      usage();
    }
    const outputPath = resolve(args[1] ?? "analysis/main-game/main_disasm.asm");
    const entryPoints = args[2]
      ? args[2].split(",").filter(Boolean).map((value) => Number.parseInt(value, 16))
      : [0x0827];
    const prgAbs = resolve(prgPath);
    disassemblePrgToKickAsm(prgAbs, outputPath, {
      entryPoints,
      title: prgPath,
      analysisPath: args[3] ? resolve(args[3]) : undefined,
    });
    registerCliArtifact({
      kind: "generated-source",
      scope: "generated",
      title: `${basename(prgAbs)} disassembly (KickAssembler)`,
      path: outputPath,
      format: "asm",
      role: "disasm",
      producedByTool: "pipeline_cli:disasm-prg",
    });
    return;
  }

  if (command === "analyze-prg") {
    // Pull --load-address $XXXX (or 0xXXXX) out of args before consuming
    // positional slots so callers can pass it anywhere.
    let loadAddressOverride: number | undefined;
    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--load-address" || arg === "--loadAddress") {
        const value = args[index + 1];
        if (!value) throw new Error("--load-address requires a value");
        const cleanedValue = value.startsWith("$") ? value.slice(1) : value;
        loadAddressOverride = Number.parseInt(cleanedValue, 16);
        if (Number.isNaN(loadAddressOverride)) throw new Error(`Invalid --load-address: ${value}`);
        index += 1;
        continue;
      }
      if (arg.startsWith("--load-address=")) {
        const value = arg.slice("--load-address=".length);
        const cleanedValue = value.startsWith("$") ? value.slice(1) : value;
        loadAddressOverride = Number.parseInt(cleanedValue, 16);
        if (Number.isNaN(loadAddressOverride)) throw new Error(`Invalid --load-address: ${value}`);
        continue;
      }
      positional.push(arg);
    }
    const prgPath = positional[0];
    if (!prgPath) {
      usage();
    }
    const outputPath = resolve(positional[1] ?? "analysis/main-game/main_analysis.json");
    const entryPoints = positional[2]
      ? positional[2].split(",").filter(Boolean).map((value) => Number.parseInt(value, 16))
      : [];
    const prgAbs = resolve(prgPath);
    const report = loadAddressOverride !== undefined
      ? analyzeRawFile(prgAbs, loadAddressOverride, { userEntryPoints: entryPoints })
      : analyzePrgFile(prgAbs, { userEntryPoints: entryPoints });
    writeAnalysisReport(report, outputPath);
    registerCliArtifact({
      kind: "analysis-run",
      scope: "analysis",
      title: `${basename(prgAbs)} analysis`,
      path: outputPath,
      format: "json",
      role: "analysis",
      producedByTool: "pipeline_cli:analyze-prg",
      sourceArtifactIds: [], // resolved later via path; not yet known here
    });
    // Auto-register a payload entity for the input. Idempotent — re-running
    // analyze-prg does not duplicate.
    try {
      const buf = readFileSyncFs(prgAbs);
      if (loadAddressOverride !== undefined) {
        registerCliPayload({
          name: basename(prgAbs).replace(/\.[^.]+$/, ""),
          loadAddress: loadAddressOverride,
          format: "raw",
          sourceArtifactPath: prgAbs,
          size: buf.length,
        });
      } else if (buf.length >= 2) {
        const loadAddr = buf[0]! | (buf[1]! << 8);
        registerCliPayload({
          name: basename(prgAbs).replace(/\.prg$/i, ""),
          loadAddress: loadAddr,
          format: "prg",
          sourceArtifactPath: prgAbs,
          size: buf.length - 2,
        });
      }
    } catch {
      // best effort; payload auto-creation is optional
    }
    return;
  }

  if (command === "analyze-sample") {
    const outputPath = resolve(args[0] ?? "analysis/sample-analysis.json");
    writeAnalysisReport(analyzeSampleBuffer(), outputPath);
    registerCliArtifact({
      kind: "analysis-run",
      scope: "analysis",
      title: "Sample analysis",
      path: outputPath,
      format: "json",
      role: "analysis",
      producedByTool: "pipeline_cli:analyze-sample",
    });
    return;
  }

  if (command === "ram-report") {
    const analysisPath = args[0];
    if (!analysisPath) {
      usage();
    }
    const outputPath = resolve(args[1] ?? "analysis/main-game/RAM_STATE_FACTS.md");
    const report = JSON.parse(readFileSync(resolve(analysisPath), "utf8"));
    writeFileSync(outputPath, renderRamStateMarkdown(report), "utf8");
    registerCliArtifact({
      kind: "report",
      scope: "generated",
      title: "RAM state facts",
      path: outputPath,
      format: "md",
      role: "ram_report",
      producedByTool: "pipeline_cli:ram-report",
    });
    return;
  }

  if (command === "pointer-report") {
    const analysisPath = args[0];
    if (!analysisPath) {
      usage();
    }
    const outputPath = resolve(args[1] ?? "analysis/main-game/POINTER_TABLE_FACTS.md");
    const report = JSON.parse(readFileSync(resolve(analysisPath), "utf8"));
    writeFileSync(outputPath, renderPointerTableMarkdown(report), "utf8");
    registerCliArtifact({
      kind: "report",
      scope: "generated",
      title: "Pointer table facts",
      path: outputPath,
      format: "md",
      role: "pointer_report",
      producedByTool: "pipeline_cli:pointer-report",
    });
    return;
  }

  // Spec 042: propose-annotations 2nd-pass classifier writes
  // *_annotations.draft.json from *_analysis.json + optional listing.
  if (command === "propose-annotations") {
    const analysisPath = args[0];
    if (!analysisPath) {
      usage();
    }
    const analysisAbs = resolve(analysisPath);
    const draftPath = resolve(args[1] ?? analysisAbs.replace(/_analysis\.json$/i, "_annotations.draft.json"));
    const listingPath = args[2] ? resolve(args[2]) : undefined;
    const { proposeAnnotations } = require("./analysis/annotators/index");
    const draft = proposeAnnotations({
      analysisJsonPath: analysisAbs,
      listingPath,
      outputPath: draftPath,
    });
    process.stdout.write(`Draft annotations: ${draftPath}\n`);
    process.stdout.write(`Segments: ${draft.segments.length} | Labels: ${draft.labels.length} | Routines: ${draft.routines.length} | Open questions: ${draft.openQuestions.length}\n`);
    process.stdout.write(`Buckets: high=${draft.buckets.high} medium=${draft.buckets.medium} low=${draft.buckets.low}\n`);
    registerCliArtifact({
      kind: "report",
      scope: "analysis",
      title: "Annotation draft",
      path: draftPath,
      format: "json",
      role: "annotation-draft",
      producedByTool: "pipeline_cli:propose-annotations",
    });
    return;
  }

  usage();
}

main();
