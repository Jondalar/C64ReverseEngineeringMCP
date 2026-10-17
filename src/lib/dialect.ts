// Spec 914 D2 — the assembler dialect a listing is written in is decided in ONE place.
//
// Order, and nothing else: the explicit argument of the call, then the `assembler` the file's
// own artifact record carries, then the project's `preferredAssembler`. There is no default
// (D6): a project that has not chosen is asked at onboarding, and a render whose dialect
// resolves to nothing is refused by name instead of quietly writing KickAssembler.
//
// The pipeline half (`pipeline/src/lib/listing.ts`) writes the lines down; this half decides
// WHICH dialect, and everything in the MCP server that used to build `_disasm.asm` by hand asks
// here for the extension.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupportedAssembler } from "../assemble-source.js";

export type Dialect = "kickass" | "64tass";

export const DIALECTS: readonly Dialect[] = ["kickass", "64tass"];

export function isDialect(value: unknown): value is Dialect {
  return value === "kickass" || value === "64tass";
}

/** The two spellings callers use for KickAssembler: the project setting's, and `assemble_source`'s. */
export function parseDialect(value: string | undefined): Dialect | undefined {
  const text = value?.trim().toLowerCase();
  if (text === "kickass" || text === "kickassembler") return "kickass";
  if (text === "64tass") return "64tass";
  return undefined;
}

/** The dialect a file name says it is written in, or undefined for any other name. */
export function dialectOfPath(path: string): Dialect | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (ext === "tas" || ext === "tass") return "64tass";
  if (ext === "asm") return "kickass";
  return undefined;
}

/** The extension the renderer gives a listing in this dialect. */
export function listingExtension(dialect: Dialect): ".asm" | ".tas" {
  return dialect === "64tass" ? ".tas" : ".asm";
}

/** What a person calls the assembler. */
export function dialectLabel(dialect: Dialect): string {
  return dialect === "64tass" ? "64tass" : "KickAssembler";
}

/** The `format` an artifact record of a listing in this dialect carries (the values the store has always used). */
export function listingFormat(dialect: Dialect): "asm" | "tass" {
  return dialect === "64tass" ? "tass" : "asm";
}

/** The assembler that builds a dialect. */
export function assemblerOf(dialect: Dialect): SupportedAssembler {
  return dialect === "64tass" ? "64tass" : "kickassembler";
}

export function dialectOfAssembler(assembler: SupportedAssembler): Dialect {
  return assembler === "64tass" ? "64tass" : "kickass";
}

/** The comment marker of a dialect — the stamp in a listing and the header a reader looks for. */
export function commentMarker(dialect: Dialect): "//" | ";" {
  return dialect === "64tass" ? ";" : "//";
}

/** Matches the start of a comment in either dialect, for the readers that take a listing as they find it. */
export const ANY_COMMENT_MARKER = /^(?:\/\/|;)/;

/** The project's `preferredAssembler`, or undefined when the project has not chosen. */
export function readProjectDialect(projectDir: string): Dialect | undefined {
  const file = join(projectDir, "knowledge", "project.json");
  if (!existsSync(file)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(file, "utf8")) as { preferredAssembler?: unknown };
    return isDialect(meta.preferredAssembler) ? meta.preferredAssembler : undefined;
  } catch {
    return undefined;
  }
}

export type DialectResolution =
  | { ok: true; dialect: Dialect; via: "argument" | "file" | "project" }
  | { ok: false; refusal: string };

/** What the caller is told when no dialect resolves — how to set each of the three places. */
export function noDialectRefusal(subject?: string): string {
  return [
    `No assembler dialect is set${subject ? ` for ${subject}` : ""}, and nothing is rendered without one: there is no default.`,
    `Choose it for this file with assembler="kickass" or assembler="64tass" on the call (it is remembered on the file),`,
    `or for the whole project with project_init(preferred_assembler="kickass" | "64tass") — the human decides which assembler this project works in.`,
  ].join("\n");
}

/**
 * The one resolver. `artifact` is the file the bytes came from (its record carries the
 * per-file choice); `explicit` is the call's `assembler` argument.
 */
export function resolveDialect(args: {
  projectDir: string;
  artifact?: { assembler?: Dialect } | undefined;
  explicit?: string | undefined;
  subject?: string;
}): DialectResolution {
  if (args.explicit !== undefined && args.explicit !== "") {
    const asked = parseDialect(args.explicit);
    if (!asked) return { ok: false, refusal: `assembler ${JSON.stringify(args.explicit)} is not a dialect: use "kickass" or "64tass".` };
    return { ok: true, dialect: asked, via: "argument" };
  }
  if (args.artifact?.assembler && isDialect(args.artifact.assembler)) {
    return { ok: true, dialect: args.artifact.assembler, via: "file" };
  }
  const project = readProjectDialect(args.projectDir);
  if (project) return { ok: true, dialect: project, via: "project" };
  return { ok: false, refusal: noDialectRefusal(args.subject) };
}

/**
 * The part of a listing's file name that names what it is a listing OF: `x_disasm.asm`,
 * `x_disasm.tas` and a pre-rename `x_disasm.tass` are all `x`. Sidecars (`x_annotations.json`)
 * and the rebuild-check PRG are named from this, never from a replaced extension.
 */
export function listingStem(listingPath: string): string {
  return listingPath.replace(/\.(asm|tas|tass)$/i, "").replace(/_disasm$/i, "");
}

/** `<stem>_disasm.<ext>` — the default listing next to the bytes it was rendered from. */
export function defaultListingName(stem: string, dialect: Dialect): string {
  return `${stem}_disasm${listingExtension(dialect)}`;
}

/** Where the rebuild-check PRG of a listing goes — derived from the stem, whatever the dialect. */
export function rebuildCheckPath(listingPath: string): string {
  return `${listingPath.replace(/\.(asm|tas|tass)$/i, "")}_rebuild_check.prg`;
}
