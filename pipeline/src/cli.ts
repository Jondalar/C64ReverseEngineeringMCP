import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseCrt, writeCrtOutputs } from "./lib/crt";
import { exportMenuPayloads, reconstructBootPayloads } from "./lib/easyflash";
import { analyzeBasicProgram, stripPrgHeader, tokenize, toPrg } from "./lib/basic-v2";
import { emitKickAssemblerSources } from "./lib/kickasm";
import { disassemblePrgToKickAsm, RelocationEntry } from "./lib/prg-disasm";
import { analyzePrgFile, analyzeRawFile, writeAnalysisReport } from "./analysis/pipeline";
import { renderPointerTableMarkdown } from "./analysis/pointer-tables";
import { renderRamStateMarkdown } from "./analysis/ram-state";
import { analyzeSampleBuffer } from "./analysis/sample";
import { consumeRegisterFlags, registerCliArtifact, registerCliPayload } from "./lib/artifact-register";
import { readFileSync as readFileSyncFs } from "node:fs";

// Spec 741: parse a relocation map JSON. Accepts addresses as numbers or
// strings ("$FC00", "0xFC00", "64512"). Shape is validated downstream by
// the renderer (normalizeRelocations).
function parseAddr(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\$[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s.slice(1), 16);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s.slice(2), 16);
    return Number.parseInt(s, 10);
  }
  throw new Error(`relocation address is not a number or hex string: ${JSON.stringify(value)}`);
}

function loadRelocationMap(path: string): RelocationEntry[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.relocations;
  if (!Array.isArray(list)) {
    throw new Error(`relocation map must be a JSON array (or { relocations: [...] }): ${path}`);
  }
  return list.map((entry: Record<string, unknown>) => ({
    fileStart: parseAddr(entry.fileStart),
    fileEnd: parseAddr(entry.fileEnd),
    runtimeAddr: parseAddr(entry.runtimeAddr),
    label: typeof entry.label === "string" ? entry.label : undefined,
    subSegments: Array.isArray(entry.subSegments)
      ? (entry.subSegments as Record<string, unknown>[]).map((s) => ({
          start: parseAddr(s.start),
          end: parseAddr(s.end),
          kind: String(s.kind ?? "code"),
          label: typeof s.label === "string" ? s.label : undefined,
          comment: typeof s.comment === "string" ? s.comment : undefined,
        }))
      : undefined,
  }));
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  node dist/cli.js extract-crt <crt> [outputDir]",
      "  node dist/cli.js reconstruct-lut [analysisDir]",
      "  node dist/cli.js export-menu [analysisDir]",
      "  node dist/cli.js disasm-menu [analysisDir] [outputDir]",
      "  node dist/cli.js disasm-prg <prg> [outputAsm] [entryHex,...] [analysisJson] [--platform c64|c1541] [--relocations <json>]",
      "  node dist/cli.js analyze-prg <prg> [outputJson] [entryHex,...]",
      "  node dist/cli.js basic-list <prg> [--json]",
      "  node dist/cli.js basic-tokenize <textFile> <outputPrg> [--load-address $0801]",
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
    // Spec 048: optional --platform <c64|c1541> flag. Strip it from
    // the positional args before the existing arg parsing so we keep
    // the public CLI shape stable.
    let platform: "c64" | "c1541" = "c64";
    // Spec 741: optional --relocations <path-to-json> with a relocation map.
    let relocationsPath: string | undefined;
    const remaining: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--platform" && args[i + 1]) {
        platform = args[i + 1] as "c64" | "c1541";
        i += 1;
      } else if (args[i].startsWith("--platform=")) {
        platform = args[i].slice("--platform=".length) as "c64" | "c1541";
      } else if (args[i] === "--relocations" && args[i + 1]) {
        relocationsPath = args[i + 1];
        i += 1;
      } else if (args[i].startsWith("--relocations=")) {
        relocationsPath = args[i].slice("--relocations=".length);
      } else {
        remaining.push(args[i]);
      }
    }
    const prgPath = remaining[0];
    if (!prgPath) {
      usage();
    }
    const outputPath = resolve(remaining[1] ?? "analysis/main-game/main_disasm.asm");
    const entryPoints = remaining[2]
      ? remaining[2].split(",").filter(Boolean).map((value) => Number.parseInt(value, 16))
      : [0x0827];
    const prgAbs = resolve(prgPath);
    const relocations = relocationsPath ? loadRelocationMap(resolve(relocationsPath)) : undefined;
    disassemblePrgToKickAsm(prgAbs, outputPath, {
      entryPoints,
      title: prgPath,
      analysisPath: remaining[3] ? resolve(remaining[3]) : undefined,
      platform,
      relocations,
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

  // Spec 829 D7 — the pipeline half of `basic_list`. `src/` (ESM) cannot import
  // `pipeline/src/` (CommonJS) (Spec 817 §1), so this verb IS how the MCP tool
  // reaches the detokenizer: server-tools/basic.ts spawns it via runCli.
  if (command === "basic-list") {
    const asJson = args.includes("--json");
    const prgPath = args.find((arg) => !arg.startsWith("--"));
    if (!prgPath) {
      usage();
    }
    const prgAbs = resolve(prgPath);
    const file = readFileSync(prgAbs);
    if (file.length < 3) {
      throw new Error(`PRG too small: ${prgAbs} is ${file.length} bytes; need at least 3 (2-byte header + body).`);
    }
    const { loadAddress, body } = stripPrgHeader(file);

    const walk = analyzeBasicProgram(body, loadAddress);
    if (!walk.ok) {
      // Spec 829 D2 — a broken chain is reported as NOT BASIC with the offset
      // where it broke. It is not an exception: "this file is machine code"
      // is a real answer, and half-rendering is how issue #11 became a bug.
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ok: false, file: prgAbs, loadAddress, reason: walk.reason, offset: walk.offset }, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            `File: ${prgAbs}`,
            `Load address: $${loadAddress.toString(16).toUpperCase().padStart(4, "0")}`,
            "",
            `NOT a tokenized BASIC V2 program: ${walk.reason}`,
            `Chain broke at body offset ${walk.offset} ($${(loadAddress + walk.offset).toString(16).toUpperCase().padStart(4, "0")}).`,
            "",
            "Use analyze_prg / disasm_prg — this is machine code, not BASIC.",
          ].join("\n") + "\n",
        );
      }
      return;
    }

    const { listing, facts } = walk;
    const hex4 = (value: number): string => `$${value.toString(16).toUpperCase().padStart(4, "0")}`;

    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            file: prgAbs,
            loadAddress,
            programRange: walk.programRange,
            endAddress: walk.endAddress,
            lineCount: walk.lines.length,
            isStub: walk.isStub,
            ascendingLineNumbers: walk.ascendingLineNumbers,
            listing,
            facts,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const lines: string[] = [
      `File: ${prgAbs}`,
      `Load address: ${hex4(loadAddress)}`,
      `BASIC ${walk.isStub ? "SYS launcher" : "program"}: ${hex4(walk.programRange.start)}-${hex4(walk.programRange.end)}, ` +
        `${walk.lines.length} line(s), terminator at ${hex4(walk.endAddress)}; anything from ${hex4(walk.programRange.end + 1)} on is not BASIC.`,
      ...(walk.ascendingLineNumbers ? [] : ["Line numbers do NOT ascend — the listing was written by machine code, not the editor."]),
      "",
      listing.replace(/\n+$/, ""),
      "",
    ];
    if (facts.length === 0) {
      lines.push("Facts: none (no SYS, USR or LOAD in this program).");
    } else {
      lines.push("Facts:");
      for (const fact of facts) {
        const where = `line ${fact.lineNumber}, token at ${hex4(fact.site)}`;
        if (fact.kind === "load") {
          lines.push(`  LOAD ${fact.fileName !== undefined ? `"${fact.fileName}"` : "(name unresolved)"} — ${where}`);
        } else if (fact.value === undefined) {
          lines.push(`  ${fact.kind.toUpperCase()} UNRESOLVED: ${fact.expression ?? "expression is not constant"} — ${where} [${fact.confidence}]`);
        } else {
          lines.push(`  ${fact.kind.toUpperCase()} ${hex4(fact.value)} (${fact.value}) — ${where} [${fact.confidence}]`);
        }
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  // Spec 829 D3 — the inverse of basic-list. The round trip is the gate: a
  // lister nobody can invert is a lister nobody can trust.
  if (command === "basic-tokenize") {
    let loadAddress = 0x0801;
    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--load-address" || arg === "--loadAddress") {
        const value = args[index + 1];
        if (!value) throw new Error("--load-address requires a value");
        loadAddress = Number.parseInt(value.startsWith("$") ? value.slice(1) : value, 16);
        if (Number.isNaN(loadAddress)) throw new Error(`Invalid --load-address: ${value}`);
        index += 1;
        continue;
      }
      if (arg.startsWith("--load-address=")) {
        const value = arg.slice("--load-address=".length);
        loadAddress = Number.parseInt(value.startsWith("$") ? value.slice(1) : value, 16);
        if (Number.isNaN(loadAddress)) throw new Error(`Invalid --load-address: ${value}`);
        continue;
      }
      positional.push(arg);
    }
    const textPath = positional[0];
    const outputPrg = positional[1];
    if (!textPath || !outputPrg) {
      usage();
    }
    const textAbs = resolve(textPath);
    const outputAbs = resolve(outputPrg);
    const text = readFileSync(textAbs, "utf8");
    const body = tokenize(text, loadAddress);
    const prg = Buffer.from(toPrg(loadAddress, body));
    writeFileSync(outputAbs, prg);
    registerCliArtifact({
      kind: "prg",
      scope: "generated",
      title: `${basename(outputAbs)} (tokenized BASIC V2)`,
      path: outputAbs,
      format: "prg",
      role: "basic_program",
      producedByTool: "pipeline_cli:basic-tokenize",
    });
    process.stdout.write(
      [
        `Source: ${textAbs}`,
        `Output: ${outputAbs}`,
        `Load address: $${loadAddress.toString(16).toUpperCase().padStart(4, "0")}`,
        `Bytes: ${prg.length} (2-byte header + ${body.length} body)`,
      ].join("\n") + "\n",
    );
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
    // 820.2: the access table reads knowledge/graph.sqlite for this owner when it
    // exists (owner = the analysis stem); absent → the JSON walk with a loud note.
    const owner = basename(resolve(analysisPath)).replace(/_analysis\.json$/u, "").toLowerCase();
    writeFileSync(outputPath, renderRamStateMarkdown(report, { projectDir: process.env.C64RE_PROJECT_DIR, owner }), "utf8");
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
    process.stdout.write(`Segments: ${draft.segments.length} | Labels: ${draft.labels.length} | Routines: ${draft.routines.length} | Relocations: ${draft.relocations.length} | Open questions: ${draft.openQuestions.length}\n`);
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
