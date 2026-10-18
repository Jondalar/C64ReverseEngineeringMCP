// Spec 914 D3 — ONE lookup for "the listing of these bytes".
//
// Every reader that needed a listing used to build its path: replace `.asm` in a name, look for
// `_disasm.asm` beside the PRG, search the tree for the one extension it knew. That worked while
// the renderer wrote both dialects next to each other and broke the day a project kept one — the
// auto-close hint waited for a file that was never written, the status looked for a stamp in a
// file that did not exist, the inventory listed what a human had deleted.
//
// A listing is found through the project's own records first (the artifact whose source is these
// bytes), and, for a project that never registered it, through the names the renderer has always
// given it beside the bytes. Which of several wins is decided here and only here: the dialect the
// FILE says, then the project's, then KickAssembler (the only one a project from before the
// choice existed can hold alone).

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dialectOfPath, isDialect, readProjectDialect, type Dialect } from "../lib/dialect.js";
import type { ArtifactRecord } from "./types.js";

export interface ListingRef {
  /** Absolute path of the listing file. */
  path: string;
  dialect: Dialect;
  /** The project's record of it, when it has one. */
  artifact?: ArtifactRecord;
}

/** What names a registered file a rendered listing rather than a hand-written source. */
const LISTING_ROLES = new Set(["disasm", "disasm-tass", "kickassembler-source", "64tass-source"]);

/** A record the renderer made, as opposed to a source a person wrote. */
export function isListingRecord(artifact: Pick<ArtifactRecord, "path" | "kind" | "role">): boolean {
  if (dialectOfPath(artifact.path) === undefined) return false;
  if (artifact.kind === "listing") return true;
  if (artifact.role !== undefined && LISTING_ROLES.has(artifact.role)) return true;
  return /_disasm\.(asm|tas|tass)$/i.test(artifact.path);
}

/** `<stem>_disasm.<ext>` beside the bytes, in every extension a listing has ever had. */
export function conventionalListingPaths(sourcePath: string): string[] {
  const stem = sourcePath.replace(/\.[^./\\]+$/, "");
  return ["asm", "tas", "tass"].map((ext) => `${stem}_disasm.${ext}`);
}

/** The order in which the dialects are tried: the file's, the project's, then KickAssembler, then 64tass — every dialect is in it. */
export function dialectOrder(fileDialect: Dialect | undefined, projectDialect: Dialect | undefined): Dialect[] {
  const order: Dialect[] = [];
  for (const d of [fileDialect, projectDialect, "kickass" as Dialect, "64tass" as Dialect]) {
    if (d !== undefined && isDialect(d) && !order.includes(d)) order.push(d);
  }
  return order;
}

/** The best of several listings of the same bytes. */
export function chooseListing(
  candidates: readonly ListingRef[],
  ctx: { fileDialect?: Dialect; projectDialect?: Dialect },
): ListingRef | undefined {
  if (candidates.length === 0) return undefined;
  const order = dialectOrder(ctx.fileDialect, ctx.projectDialect);
  return [...candidates].sort((a, b) => {
    const byDialect = order.indexOf(a.dialect) - order.indexOf(b.dialect);
    if (byDialect !== 0) return byDialect;
    const aTime = Date.parse(a.artifact?.updatedAt ?? "") || 0;
    const bTime = Date.parse(b.artifact?.updatedAt ?? "") || 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.path.length - b.path.length || a.path.localeCompare(b.path);
  })[0];
}

export interface ListingSubject {
  /** The artifact id of the bytes. */
  artifactId?: string;
  /** Or their path, absolute or relative to the project. */
  path?: string;
}

/** The record of the bytes a subject names, if the project holds one. */
export function subjectRecord(projectDir: string, subject: ListingSubject, artifacts: readonly ArtifactRecord[]): ArtifactRecord | undefined {
  if (subject.artifactId) {
    const byId = artifacts.find((a) => a.id === subject.artifactId);
    if (byId) return byId;
  }
  if (subject.path) {
    const abs = resolve(projectDir, subject.path);
    return artifacts.find((a) => a.path === abs);
  }
  return undefined;
}

/**
 * The current listing of a subject — its path and the dialect it is written in — or undefined
 * when there is none ON DISK. A record whose file is gone is not a listing.
 */
export function listingFor(
  projectDir: string,
  subject: ListingSubject,
  artifacts: readonly ArtifactRecord[],
  projectDialect: Dialect | undefined = readProjectDialect(projectDir),
): ListingRef | undefined {
  const source = subjectRecord(projectDir, subject, artifacts);
  const sourcePath = source?.path ?? (subject.path ? resolve(projectDir, subject.path) : undefined);
  const found = new Map<string, ListingRef>();
  const add = (path: string, artifact?: ArtifactRecord): void => {
    const dialect = dialectOfPath(path);
    if (!dialect || !existsSync(path)) return;
    const known = found.get(path);
    if (known && !artifact) return;
    found.set(path, { path, dialect, ...(artifact ?? known?.artifact ? { artifact: artifact ?? known?.artifact } : {}) });
  };
  if (source) {
    for (const a of artifacts) {
      if (isListingRecord(a) && (a.sourceArtifactIds ?? []).includes(source.id)) add(a.path, a);
    }
  }
  if (sourcePath) {
    for (const path of conventionalListingPaths(sourcePath)) {
      add(path, artifacts.find((a) => a.path === path));
    }
  }
  return chooseListing([...found.values()], { fileDialect: source?.assembler, projectDialect });
}

/**
 * One listing per directory and stem, for the walkers that index a tree. An old project holds
 * `x_disasm.asm` beside `x_disasm.tas` (and `.tass` before that) — one disassembly, two spellings;
 * the one that is read is the file's/the project's dialect, KickAssembler otherwise.
 */
export function walkListings(
  roots: readonly string[],
  projectRoot: string,
  onFile: (relPath: string) => void,
  projectDialect: Dialect | undefined = readProjectDialect(projectRoot),
  limitPerDir = 200,
  depthLimit = 6,
): void {
  const order = dialectOrder(undefined, projectDialect);
  const walk = (dir: string, depth: number): void => {
    if (depth > depthLimit || !existsSync(dir)) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const byStem = new Map<string, ListingRef[]>();
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) { try { isDir = statSync(abs).isDirectory(); } catch { continue; } }
      if (isDir) { walk(abs, depth + 1); continue; }
      const m = /^(.*)\.(asm|tas|tass)$/i.exec(entry.name);
      if (!m) continue;
      const dialect = dialectOfPath(entry.name)!;
      const list = byStem.get(m[1]!) ?? [];
      list.push({ path: abs, dialect });
      byStem.set(m[1]!, list);
    }
    let count = 0;
    for (const list of byStem.values()) {
      if (count >= limitPerDir) break;
      const best = [...list].sort((a, b) => order.indexOf(a.dialect) - order.indexOf(b.dialect) || a.path.localeCompare(b.path))[0]!;
      count++;
      onFile(relative(projectRoot, best.path));
    }
  };
  for (const root of roots) walk(root, 0);
}

/** The stem the annotation sidecars of a listing are named from, whatever the listing's dialect. */
export function annotationsPathFor(listingPath: string): string {
  return `${listingPath.replace(/\.(asm|tas|tass)$/i, "")}_annotations.json`;
}
