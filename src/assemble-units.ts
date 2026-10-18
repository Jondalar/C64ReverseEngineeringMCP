// Spec 914 D5 — sources of different dialects build together.
//
// A project works in one assembler and mixes in code it did not render: a reporter's loader in
// 64tass, template code in 64tass, its own listings in KickAssembler. Those files are never
// translated and never touched. Each is built by ITS assembler; what one unit defines is read
// back from its label table into one neutral list (name, address, scope) and written as equates
// in the dialect of the unit that consumes it. The consumer sees them through a wrapper source
// that includes the equates and then the consumer's own file, so no source on disk is edited —
// the foreign file least of all.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assembleWithLabels, resolveAssemblerSelection, type AssemblerSelection, type SupportedAssembler } from "./assemble-source.js";
import { dialectOfAssembler, listingExtension, type Dialect } from "./lib/dialect.js";

/** One symbol of a unit's label table, whichever assembler wrote it. */
export interface NeutralSymbol {
  name: string;
  address: number;
  /** "" for a global name; a dotted path for one inside a namespace/scope. */
  scope: string;
}

export interface BuildUnitInput {
  /** The source, absolute or relative to the project. */
  path: string;
  /** Default `auto`: by extension (.asm KickAssembler, .tas/.tass 64tass). */
  assembler?: AssemblerSelection;
  /** Other units (by the `path` they were given with) whose symbols this one uses. */
  uses?: string[];
  /** Compare this unit's PRG byte for byte against this file. */
  compareTo?: string;
  /** A file we did not render: registered with its dialect, hashed before and after, never written. */
  foreign?: boolean;
}

export interface BuiltUnit {
  path: string;
  sourcePath: string;
  dialect: Dialect;
  assembler: SupportedAssembler;
  outputPath: string;
  labelsPath: string;
  /** The symbols the unit defines itself (the ones it imported are left out). */
  symbols: NeutralSymbol[];
  /** Unit paths whose symbols were handed to this one as equates. */
  imported: string[];
  /** The equates file written for it, when it imported anything. */
  equatesPath?: string;
  /** The source's sha256 before and after: a foreign file must be equal. */
  sourceHashBefore: string;
  sourceHashAfter: string;
  foreign: boolean;
  compareTo?: string;
  compareMatches?: boolean;
  comparedBytes?: number;
  firstDiffOffset?: number;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class UnitBuildRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitBuildRefusal";
  }
}

// ── the label tables ─────────────────────────────────────────────────────────

function parseNumber(text: string): number | undefined {
  if (text.startsWith("$")) return Number.parseInt(text.slice(1), 16);
  if (text.startsWith("%")) return Number.parseInt(text.slice(1), 2);
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 64tass `-l`: `name<TAB>= $c000`, scoped names dotted. */
export function parse64tassLabels(text: string): NeutralSymbol[] {
  const out: NeutralSymbol[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^\s=;]+)\s*=\s*(\$[0-9A-Fa-f]+|%[01]+|\d+)\b/.exec(line);
    if (!m) continue;
    const address = parseNumber(m[2]!);
    if (address === undefined) continue;
    const full = m[1]!;
    const cut = full.lastIndexOf(".");
    out.push(cut < 0 ? { name: full, address, scope: "" } : { name: full.slice(cut + 1), address, scope: full.slice(0, cut) });
  }
  return out;
}

/** KickAssembler `-symbolfile`: `.label name=$c000`, namespaces as `.namespace x { … }`. */
export function parseKickAssLabels(text: string): NeutralSymbol[] {
  const out: NeutralSymbol[] = [];
  const stack: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ns = /^\s*\.namespace\s+([^\s{]+)\s*\{/.exec(line);
    if (ns) { stack.push(ns[1]!); continue; }
    if (/^\s*\}\s*$/.test(line)) { stack.pop(); continue; }
    const m = /^\s*\.label\s+([^=\s]+)\s*=\s*(\$[0-9A-Fa-f]+|\d+)\b/.exec(line);
    if (!m) continue;
    const address = parseNumber(m[2]!);
    if (address === undefined) continue;
    out.push({ name: m[1]!, address, scope: stack.join(".") });
  }
  return out;
}

export function parseLabels(assembler: SupportedAssembler, text: string): NeutralSymbol[] {
  return assembler === "64tass" ? parse64tassLabels(text) : parseKickAssLabels(text);
}

const hexValue = (address: number): string =>
  address <= 0xff ? `$${address.toString(16).toUpperCase().padStart(2, "0")}` : `$${address.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The equates a consumer includes, in ITS dialect. Only global names travel: a name inside a
 * namespace or scope cannot be spelled the same way in the other assembler.
 */
export function equatesFor(consumer: Dialect, from: ReadonlyArray<{ unit: string; symbols: NeutralSymbol[] }>): string {
  const marker = consumer === "64tass" ? ";" : "//";
  const lines = [`${marker} Symbols exported by the units this one builds against — generated, never edited.`];
  for (const { unit, symbols } of from) {
    lines.push(`${marker} from ${basename(unit)}`);
    for (const symbol of symbols.filter((s) => s.scope === "").sort((a, b) => a.address - b.address || a.name.localeCompare(b.name))) {
      lines.push(consumer === "64tass" ? `${symbol.name} = ${hexValue(symbol.address)}` : `.label ${symbol.name} = ${hexValue(symbol.address)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function wrapperFor(dialect: Dialect, equatesPath: string | undefined, sourcePath: string): string {
  const include = (path: string): string => dialect === "64tass" ? `.include "${path}"` : `.import source "${path}"`;
  return `${[...(equatesPath ? [include(equatesPath)] : []), include(sourcePath)].join("\n")}\n`;
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The names an assembler's error output says are not defined. */
export function undefinedSymbols(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/Unknown symbol '([^']+)'|not defined (?:symbol )?'([^']+)'/g)) names.add((m[1] ?? m[2])!);
  return [...names];
}

// ── the build ────────────────────────────────────────────────────────────────

export interface AssembleUnitsOptions {
  projectDir: string;
  units: BuildUnitInput[];
  /** Where the PRGs, label tables, equates and wrappers go. Default `<project>/analysis/build`. */
  outputDir?: string;
}

export interface AssembleUnitsResult {
  outputDir: string;
  /** In the order they were built. */
  built: BuiltUnit[];
}

export async function assembleUnits(options: AssembleUnitsOptions): Promise<AssembleUnitsResult> {
  if (options.units.length === 0) throw new UnitBuildRefusal("units is empty: name at least one source.");
  const outputDir = resolve(options.projectDir, options.outputDir ?? join("analysis", "build"));
  mkdirSync(outputDir, { recursive: true });

  type Resolved = { input: BuildUnitInput; sourcePath: string; assembler: SupportedAssembler; dialect: Dialect; key: string };
  const resolved: Resolved[] = options.units.map((input) => {
    const sourcePath = resolve(options.projectDir, input.path);
    if (!existsSync(sourcePath)) throw new UnitBuildRefusal(`unit ${JSON.stringify(input.path)} does not exist (${sourcePath}).`);
    let assembler: SupportedAssembler;
    try {
      assembler = resolveAssemblerSelection(input.assembler ?? "auto", sourcePath);
    } catch (error) {
      throw new UnitBuildRefusal(`${error instanceof Error ? error.message : String(error)}`);
    }
    return { input, sourcePath, assembler, dialect: dialectOfAssembler(assembler), key: input.path };
  });
  const byRef = (ref: string): Resolved | undefined =>
    resolved.find((u) => u.key === ref || u.sourcePath === resolve(options.projectDir, ref))
    ?? (resolved.filter((u) => basename(u.sourcePath) === basename(ref)).length === 1 ? resolved.find((u) => basename(u.sourcePath) === basename(ref)) : undefined);

  // dependency order — a unit is built after everything it uses
  const order: Resolved[] = [];
  const state = new Map<Resolved, "visiting" | "done">();
  const visit = (unit: Resolved, trail: string[]): void => {
    const seen = state.get(unit);
    if (seen === "done") return;
    if (seen === "visiting") throw new UnitBuildRefusal(`the units use each other in a circle: ${[...trail, unit.key].join(" -> ")}. A unit can only be built after the units it uses.`);
    state.set(unit, "visiting");
    for (const ref of unit.input.uses ?? []) {
      const used = byRef(ref);
      if (!used) throw new UnitBuildRefusal(`unit ${unit.key} uses ${JSON.stringify(ref)}, which is not one of the units given (${resolved.map((u) => u.key).join(", ")}).`);
      if (used === unit) throw new UnitBuildRefusal(`unit ${unit.key} lists itself in uses.`);
      visit(used, [...trail, unit.key]);
    }
    state.set(unit, "done");
    order.push(unit);
  };
  for (const unit of resolved) visit(unit, []);

  const built = new Map<Resolved, BuiltUnit>();
  for (const unit of order) {
    const stem = basename(unit.sourcePath).replace(/\.[^.]+$/u, "");
    const used = (unit.input.uses ?? []).map((ref) => byRef(ref)!);
    const imports = used.map((u) => ({ unit: u.key, symbols: built.get(u)!.symbols }));
    const importedNames = new Set(imports.flatMap((i) => i.symbols.filter((s) => s.scope === "").map((s) => s.name)));

    const equatesPath = used.length > 0 ? join(outputDir, `${stem}_imports${listingExtension(unit.dialect)}`) : undefined;
    if (equatesPath) writeFileSync(equatesPath, equatesFor(unit.dialect, imports), "utf8");
    const wrapperPath = join(outputDir, `${stem}_unit${listingExtension(unit.dialect)}`);
    writeFileSync(wrapperPath, wrapperFor(unit.dialect, equatesPath, unit.sourcePath), "utf8");

    const outputPath = join(outputDir, `${stem}.prg`);
    const labelsPath = join(outputDir, `${stem}.labels`);
    const hashBefore = sha256(unit.sourcePath);
    const run = await assembleWithLabels({ projectDir: options.projectDir, sourcePath: wrapperPath, assembler: unit.assembler, outputPath, labelsPath });
    const hashAfter = sha256(unit.sourcePath);
    if (hashAfter !== hashBefore) {
      throw new UnitBuildRefusal(`${unit.key} changed on disk during its build (sha256 ${hashBefore.slice(0, 12)} -> ${hashAfter.slice(0, 12)}). A unit is only ever read.`);
    }

    if (run.exitCode !== 0) {
      // A label the unit uses and no unit it listed exports is the commonest way a mixed build fails,
      // and "exit code 1" does not say which.
      const missing = undefinedSymbols(`${run.stdout}\n${run.stderr}`);
      if (missing.length > 0) {
        const exported = imports.flatMap((i) => i.symbols.filter((s) => s.scope === "").map((s) => ({ unit: i.unit, name: s.name })));
        const elsewhere = missing.map((name) => {
          const owner = [...built.entries()].find(([u, b]) => u !== unit && !used.includes(u) && b.symbols.some((s) => s.scope === "" && s.name === name));
          return owner ? ` ${name} is exported by ${owner[0].key}, which ${unit.key} does not list in uses.` : "";
        }).join("");
        throw new UnitBuildRefusal(
          `${unit.key} uses ${missing.map((n) => JSON.stringify(n)).join(", ")}, which ${used.length === 0 ? "no unit it uses defines (it lists none in uses)" : `none of the units it uses exports (${used.map((u) => u.key).join(", ")} export ${exported.length} symbol${exported.length === 1 ? "" : "s"}: ${exported.slice(0, 12).map((e) => e.name).join(", ")}${exported.length > 12 ? ", …" : ""})`}.${elsewhere}`,
        );
      }
    }

    const symbols = run.labelsWritten
      ? parseLabels(unit.assembler, readFileSync(labelsPath, "utf8")).filter((s) => !(s.scope === "" && importedNames.has(s.name)))
      : [];
    const result: BuiltUnit = {
      path: unit.key,
      sourcePath: unit.sourcePath,
      dialect: unit.dialect,
      assembler: unit.assembler,
      outputPath,
      labelsPath,
      symbols,
      imported: used.map((u) => u.key),
      ...(equatesPath ? { equatesPath } : {}),
      sourceHashBefore: hashBefore,
      sourceHashAfter: hashAfter,
      foreign: unit.input.foreign === true,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
    };
    if (run.exitCode === 0 && unit.input.compareTo) {
      const compareTo = resolve(options.projectDir, unit.input.compareTo);
      const left = readFileSync(outputPath);
      const right = readFileSync(compareTo);
      const common = Math.min(left.length, right.length);
      let diff: number | undefined;
      for (let i = 0; i < common; i++) if (left[i] !== right[i]) { diff = i; break; }
      if (diff === undefined && left.length !== right.length) diff = common;
      result.compareTo = compareTo;
      result.compareMatches = diff === undefined;
      result.comparedBytes = diff === undefined ? left.length : common;
      if (diff !== undefined) result.firstDiffOffset = diff;
    }
    built.set(unit, result);
    if (run.exitCode !== 0) break;
  }
  return { outputDir, built: order.filter((u) => built.has(u)).map((u) => built.get(u)!) };
}
