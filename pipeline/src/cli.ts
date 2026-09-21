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
import { consumeRegisterFlags, registerCliArtifact } from "./lib/artifact-register";
import { ADDRESS_RULE, parseAddress, parseAddressList, parseCount, looksLikeAddressList } from "./lib/address-rule";

// Spec 741: parse a relocation map JSON.
//
// The rule these fields read by is not written here. It lives in ONE body of code
// (`src/shared/address-rule.ts`, compiled into this half as `./lib/address-rule`), and
// `npm run check:address-rule` refuses a copy. It used to be written twice, and both
// times it drifted: a relocation's `"E800"` went through `parseInt(s, 10)` and became
// NaN while `entry_points` read the same notation as hex, and `"2000"` quietly became
// $07D0. Re-stating the rule here is what caused that; importing it is the fix.
function loadRelocationMap(path: string): RelocationEntry[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.relocations;
  if (!Array.isArray(list)) {
    throw new Error(`relocation map must be a JSON array (or { relocations: [...] }): ${path}`);
  }
  return list.map((entry: Record<string, unknown>) => ({
    fileStart: parseAddress(entry.fileStart, "relocation fileStart"),
    fileEnd: parseAddress(entry.fileEnd, "relocation fileEnd"),
    runtimeAddr: parseAddress(entry.runtimeAddr, "relocation runtimeAddr"),
    label: typeof entry.label === "string" ? entry.label : undefined,
    subSegments: Array.isArray(entry.subSegments)
      ? (entry.subSegments as Record<string, unknown>[]).map((s) => ({
          start: parseAddress(s.start, "relocation subSegments[].start"),
          end: parseAddress(s.end, "relocation subSegments[].end"),
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
      "  node dist/cli.js disasm-prg <prg> [outputAsm] [entryHex,...] [--analysis <json> | --no-analysis] [--platform c64|c1541] [--relocations <json>]",
      "  node dist/cli.js disasm-raw <file> <outputAsm> --load-address <addr> [--offset <n>] [--length <n>] [entryHex,...] [--analysis <json> | --no-analysis] [--platform c64|c1541] [--annotations <json>]",
      "  node dist/cli.js analyze-prg <prg> [outputJson] [entryHex,...]",
      "  node dist/cli.js basic-list <prg> [--json]",
      "  node dist/cli.js basic-tokenize <textFile> <outputPrg> [--load-address $0801]",
      "  node dist/cli.js ram-report <analysisJson> [outputMd]",
      "  node dist/cli.js pointer-report <analysisJson> [outputMd]",
      "  node dist/cli.js analyze-sample [outputJson]",
      "",
      "Run directly, every verb that writes a file registers it in the project's",
      "knowledge/artifacts.json — a shell loop has no parent to do it, and an",
      "unregistered output is invisible to the workspace and to the next session.",
      "Append --no-register to suppress that. The MCP server always passes it: on",
      "that path the tool that spawned this process registers the outputs itself,",
      "and the store has one writer.",
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
    // The analysis JSON as a NAMED argument. It used to be positional slot 3, behind
    // the entry-point list, and a caller with an analysis but no entry points pushed
    // it into slot 2 — where it was read as a list of addresses, became NaN, and left
    // the analysis unset. The renderer then picked up the stem-matched sidecar instead
    // and rendered a different file's segments without a word. A named flag cannot
    // shift; the positional form still works and is checked below.
    let analysisPath: string | undefined;
    let noAnalysis = false;
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
      } else if (args[i] === "--analysis" && args[i + 1]) {
        analysisPath = args[i + 1];
        i += 1;
      } else if (args[i].startsWith("--analysis=")) {
        analysisPath = args[i].slice("--analysis=".length);
      } else if (args[i] === "--no-analysis") {
        noAnalysis = true;
      } else {
        remaining.push(args[i]);
      }
    }
    const prgPath = remaining[0];
    if (!prgPath) {
      usage();
    }
    const outputPath = resolve(remaining[1] ?? "analysis/main-game/main_disasm.asm");
    // No default seed. It used to be `[0x0827]`, a guess at a BASIC stub's SYS target,
    // and it was harmless only because the legacy renderer threw the list away. Now
    // that a seed resyncs the linear decode, a guessed one would split an instruction
    // in a PRG that never loads at $0801 — a default may not decide an alignment.
    //
    // A value here that is not a list of addresses is NOT parsed into NaN. When it is
    // the analysis JSON that slid down a slot, it is read as the analysis and said so;
    // anything else is refused by the one rule.
    let positionalEntries = remaining[2] ?? "";
    let positionalAnalysis = remaining[3];
    if (positionalEntries && !looksLikeAddressList(positionalEntries)) {
      if (/\.json$/i.test(positionalEntries) && positionalAnalysis === undefined) {
        positionalAnalysis = positionalEntries;
        positionalEntries = "";
        // The note names the door the reader came through.
        //
        // It used to say "Pass --analysis <path>" and nothing else. Almost every
        // reader of this line is an LLM on the MCP surface, which has no flags at
        // all: it passes `analysis_json` and `entry_points`, and the only way it
        // can reach this branch is by putting an analysis path in `entry_points`.
        // So it was told to fix its call with a flag it cannot type. Both names
        // now, each labelled with where it belongs.
        process.stdout.write(
          `Note: the entry-points slot held ${basename(positionalAnalysis)}; it was read as the analysis JSON. `
          + `Entry points are addresses — name the analysis as analysis_json (MCP tool disasm_prg) `
          + `or --analysis <path> (this CLI).\n`,
        );
      } else {
        throw new Error(
          `entry points ${JSON.stringify(positionalEntries)} is not a comma-separated list of addresses — ${ADDRESS_RULE}`,
        );
      }
    }
    const entryPoints = parseAddressList(positionalEntries, "entryPoints");
    const prgAbs = resolve(prgPath);
    const relocations = relocationsPath ? loadRelocationMap(resolve(relocationsPath)) : undefined;
    const chosenAnalysis = analysisPath ?? positionalAnalysis;
    disassemblePrgToKickAsm(prgAbs, outputPath, {
      entryPoints,
      title: prgPath,
      analysisPath: chosenAnalysis ? resolve(chosenAnalysis) : undefined,
      noAnalysis,
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

  // Bytes at an address, with no PRG header in front of them. Same renderer, same
  // annotation handling, same pair of outputs — only the way the image is read differs,
  // and that difference is one branch inside `disassemblePrgToKickAsm`.
  if (command === "disasm-raw") {
    let platform: "c64" | "c1541" = "c64";
    let loadAddress: number | undefined;
    let offset: number | undefined;
    let length: number | undefined;
    let annotationsPath: string | undefined;
    let analysisFlagPath: string | undefined;
    let noAnalysis = false;
    const remaining: string[] = [];
    const takeValue = (flag: string, inline: string | undefined, next: string | undefined): string => {
      const value = inline ?? next;
      if (value === undefined) throw new Error(`${flag} requires a value — ${ADDRESS_RULE}`);
      return value;
    };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const [flag, inline] = arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
      if (flag === "--platform") {
        platform = takeValue(flag, inline, args[i + 1]) as "c64" | "c1541";
        if (inline === undefined) i += 1;
      } else if (flag === "--load-address" || flag === "--loadAddress") {
        loadAddress = parseAddress(takeValue(flag, inline, args[i + 1]), "--load-address");
        if (inline === undefined) i += 1;
      } else if (flag === "--offset") {
        offset = parseCount(takeValue(flag, inline, args[i + 1]), "--offset");
        if (inline === undefined) i += 1;
      } else if (flag === "--length") {
        length = parseCount(takeValue(flag, inline, args[i + 1]), "--length");
        if (inline === undefined) i += 1;
      } else if (flag === "--annotations") {
        annotationsPath = takeValue(flag, inline, args[i + 1]);
        if (inline === undefined) i += 1;
      } else if (flag === "--analysis") {
        analysisFlagPath = takeValue(flag, inline, args[i + 1]);
        if (inline === undefined) i += 1;
      } else if (flag === "--no-analysis") {
        noAnalysis = true;
      } else {
        remaining.push(arg);
      }
    }
    const rawPath = remaining[0];
    if (!rawPath || loadAddress === undefined) {
      usage();
    }
    const outputPath = resolve(remaining[1] ?? `${rawPath}_disasm.asm`);
    const entryPoints = parseAddressList(remaining[2] ?? "", "entryPoints");
    const rawAbs = resolve(rawPath);
    const chosenAnalysis = analysisFlagPath ?? remaining[3];
    const stats = disassemblePrgToKickAsm(rawAbs, outputPath, {
      entryPoints,
      title: rawPath,
      analysisPath: chosenAnalysis ? resolve(chosenAnalysis) : undefined,
      noAnalysis,
      platform,
      raw: { loadAddress, offset, length },
      annotationsPath: annotationsPath ? resolve(annotationsPath) : undefined,
    });
    const last = (stats.loadAddress + stats.byteLength - 1) & 0xffff;
    const hex = (value: number) => `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
    process.stdout.write(
      [
        `Disassembled ${stats.byteLength} bytes of ${basename(rawAbs)} at ${hex(stats.loadAddress)}-${hex(last)}.`,
        `Source window: offset ${offset ?? 0}, length ${stats.byteLength} (bytes ${offset ?? 0}..${(offset ?? 0) + stats.byteLength - 1}).`,
        `Listing: ${stats.instructionCount} instructions, ${stats.dataLineCount} data lines (${stats.renderMode} rendering).`,
        `Seeded: ${entryPoints.length > 0 ? entryPoints.map(hex).join(", ") : `${hex(stats.loadAddress)} (the first byte — no entry point was given)`}`,
        // Which files the RENDERER actually read. The wrapper used to re-derive both
        // by guessing the same candidate order, and the two halves resolved different
        // files often enough that a listing could show a human's names while the graph
        // import was handed a path that does not exist.
        `Analysis used: ${stats.analysisPath ?? "none"}`,
        `Annotations used: ${stats.annotationsPath ?? "none"}`,
        `64tass: ${stats.tassPath}`,
      ].join("\n") + "\n",
    );
    registerCliArtifact({
      kind: "generated-source",
      scope: "generated",
      title: `${basename(rawAbs)} @ ${hex(stats.loadAddress)} disassembly (KickAssembler)`,
      path: outputPath,
      format: "asm",
      role: "disasm",
      producedByTool: "pipeline_cli:disasm-raw",
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
        if (!value) throw new Error(`--load-address requires a value — ${ADDRESS_RULE}`);
        loadAddressOverride = parseAddress(value, "--load-address");
        index += 1;
        continue;
      }
      if (arg.startsWith("--load-address=")) {
        loadAddressOverride = parseAddress(arg.slice("--load-address=".length), "--load-address");
        continue;
      }
      positional.push(arg);
    }
    const prgPath = positional[0];
    if (!prgPath) {
      usage();
    }
    const outputPath = resolve(positional[1] ?? "analysis/main-game/main_analysis.json");
    const entryPoints = parseAddressList(positional[2] ?? "", "entryPoints");
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
        if (!value) throw new Error(`--load-address requires a value — ${ADDRESS_RULE}`);
        loadAddress = parseAddress(value, "--load-address");
        index += 1;
        continue;
      }
      if (arg.startsWith("--load-address=")) {
        loadAddress = parseAddress(arg.slice("--load-address=".length), "--load-address");
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
