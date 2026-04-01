import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCrt, writeCrtOutputs } from "./lib/crt";
import { exportMenuPayloads, reconstructBootPayloads } from "./lib/easyflash";
import { emitKickAssemblerSources } from "./lib/kickasm";
import { disassemblePrgToKickAsm } from "./lib/prg-disasm";
import { analyzePrgFile, writeAnalysisReport } from "./analysis/pipeline";
import { renderPointerTableMarkdown } from "./analysis/pointer-tables";
import { renderRamStateMarkdown } from "./analysis/ram-state";
import { analyzeSampleBuffer } from "./analysis/sample";

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
    ].join("\n"),
  );
}

function main(): void {
  const [, , command, ...args] = process.argv;
  if (!command) {
    usage();
  }

  if (command === "extract-crt") {
    const crtPath = args[0];
    const outputDir = resolve(args[1] ?? "analysis/extracted");
    if (!crtPath) {
      usage();
    }
    const parsed = parseCrt(readFileSync(resolve(crtPath)));
    writeCrtOutputs(parsed, outputDir);
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
    disassemblePrgToKickAsm(resolve(prgPath), outputPath, {
      entryPoints,
      title: prgPath,
      analysisPath: args[3] ? resolve(args[3]) : undefined,
    });
    return;
  }

  if (command === "analyze-prg") {
    const prgPath = args[0];
    if (!prgPath) {
      usage();
    }
    const outputPath = resolve(args[1] ?? "analysis/main-game/main_analysis.json");
    const entryPoints = args[2]
      ? args[2].split(",").filter(Boolean).map((value) => Number.parseInt(value, 16))
      : [];
    const report = analyzePrgFile(resolve(prgPath), {
      userEntryPoints: entryPoints,
    });
    writeAnalysisReport(report, outputPath);
    return;
  }

  if (command === "analyze-sample") {
    const outputPath = resolve(args[0] ?? "analysis/sample-analysis.json");
    writeAnalysisReport(analyzeSampleBuffer(), outputPath);
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
    return;
  }

  usage();
}

main();
