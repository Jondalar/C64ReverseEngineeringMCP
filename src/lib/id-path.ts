// Spec 838 D1 — an entity id is not a path.
//
// `src/lib/prg-workflow.ts` composed `artifacts/generated/payloads/${payload.id}`
// at the call site, and a payload id looks like
// `crazy-news-c64:ram/loader:payload:0801` — Spec 818's grammar is
// `slug ":" ctx ":" kind ":" addr`, and the ctx carries its owner behind a `/`.
// On Windows `:` is reserved (drive letters, NTFS alternate data streams), so
// `mkdir` throws ENOENT, `extract_disk`'s automatic L2 step fails, and the
// doctrine guarantee — there is no raw extract without a disassembly — silently
// does not hold on that platform while the extraction reports success
// (issue #15, reproduced on Windows 11).
//
// An id identifies; a path is a filesystem write. So every path segment derived
// from an id goes through here, and it is sanitised for the STRICTEST platform
// we target rather than the one the developer happens to be on. This is Spec
// 827's rule one level down: a path policy is a library with a gate, not an
// expression inlined at a call site. Everything below is pure except
// `ensureIdDirUnder` / `ensureIdDirIn`, which own the one mkdir.
//
// The mapping is stable (a pure function of the id) and never merges: whenever
// sanitisation changed anything, the segment carries eight hex of the id's own
// hash, so two ids can no longer land in one directory. A segment that needed
// no change keeps the id verbatim — which is also why a project written before
// this change is not orphaned: `idDirUnder` returns a PRE-EXISTING directory
// where it already is.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * The characters Windows refuses inside a path component. `/` and `\` are on the
 * list because an id must become ONE segment: `ram/loader` is one owner, not a
 * directory plus a subdirectory. Exported so the gate asserts the same list the
 * policy is written against.
 */
export const WINDOWS_RESERVED_CHARS: readonly string[] = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];

/**
 * Reserved as a whole component, WITH ANY EXTENSION — `CON.txt` is the console
 * device just as much as `CON` is. Matched case-insensitively against the stem.
 */
export const DOS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Everything outside this is replaced — a superset of the reserved set, and it
 *  also takes control characters, spaces and anything non-ASCII with it. */
const KEEP = /[^A-Za-z0-9._-]+/gu;
/** The disambiguator's own shape. A body that already ends this way gets one of
 *  its own, so a verbatim id can never be mistaken for a sanitised one. */
const HASH_SUFFIX = /-[0-9a-f]{8}$/u;
/** Long enough to stay recognisable, short enough that <root>/<base>/<seg>/<file>
 *  survives a Windows MAX_PATH of 260. */
const DEFAULT_MAX_BODY = 64;

export interface SegmentOptions {
  /** Replaces an id that sanitises away to nothing. Default `"id"`. */
  fallback?: string;
  /** Body length before the hash suffix. Default 64. */
  maxBody?: number;
}

function hash8(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 8);
}

/** The stem a Windows device check looks at: everything before the first dot. */
function stemOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/** True when this component would be a DOS device on Windows, extension or not. */
export function isDosDeviceName(name: string): boolean {
  return DOS_DEVICE_NAMES.has(stemOf(name).toLowerCase());
}

/**
 * The one policy. Returns a component every filesystem we target accepts:
 * `[A-Za-z0-9._-]`, no leading `.` `-` `_`, no trailing `.` or `-`, never a DOS
 * device, never empty, never `.` or `..`, bounded in length.
 *
 * It returns the input VERBATIM only when the input already satisfies all of
 * that AND is entirely lower case — Windows compares components
 * case-insensitively, so `Foo` and `foo` are one directory there and may not
 * both pass through untouched. Anything else comes back as
 * `<sanitised body>-<8 hex of the id>`, which is stable across runs and
 * different for different ids.
 */
export function safeSegment(raw: string, opts: SegmentOptions = {}): string {
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const fallback = opts.fallback ?? "id";

  let body = raw.trim().replace(KEEP, "_");
  body = body.replace(/^[._-]+/u, "");       // no dotfile (half the walkers here skip those), no leading dash
  body = body.replace(/[.\s-]+$/u, "");      // Windows silently drops a trailing dot or space; `-` is the suffix separator
  if (body.length > maxBody) body = body.slice(0, maxBody).replace(/[.\s-]+$/u, "");
  if (isDosDeviceName(body)) {
    const stem = stemOf(body);
    body = `${stem}_${body.slice(stem.length)}`;
  }
  if (body.length === 0) body = fallback;

  const verbatim = body === raw && !/[A-Z]/u.test(body) && !HASH_SUFFIX.test(body);
  return verbatim ? body : `${body}-${hash8(raw)}`;
}

/** True when the id may be written to disk unchanged on every platform we target. */
export function isPathSafeSegment(raw: string, opts?: SegmentOptions): boolean {
  return safeSegment(raw, opts) === raw;
}

/**
 * The narrow guard for a component derived from an EXISTING FILE NAME rather
 * than from an id — a disk image's stem, say. The host already accepted those
 * characters, so the only thing that has to change is the one name Windows
 * refuses outright; renaming everything else would move every directory an
 * existing project already has for no defect.
 */
export function deviceSafeName(name: string): string {
  if (!isDosDeviceName(name)) return name;
  const stem = stemOf(name);
  return `${stem}_${name.slice(stem.length)}`;
}

export interface IdDir {
  /** Absolute path of the directory this id owns. */
  absolute: string;
  /** Its final component. */
  name: string;
  /** True when a directory written before Spec 838 was found and reused. */
  legacy: boolean;
}

export interface IdDirIn extends IdDir {
  /** POSIX-separated and relative to the root — the shape the knowledge store keeps. */
  relative: string;
}

function isInside(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where this id's directory lives under `baseAbsolute`.
 *
 * A project written before Spec 838 has it under the raw id — on POSIX
 * `payloads/crazy-news-c64:ram/loader:payload:0801` even nested itself two deep,
 * because the id carries a `/`. That directory is read WHERE IT IS: nothing is
 * migrated, nothing is orphaned. Only when it does not exist does the sanitised
 * name apply, so from here a new project is portable and an old one keeps
 * working on the platform it was written on.
 *
 * `join`, never `resolve`, for the legacy candidate: on Windows
 * `resolve(base, "c:ram/x")` reads `c:` as a drive and leaves the project
 * entirely — a project slug is allowed to be a single letter. The containment
 * check is the belt on top of that.
 */
export function idDirUnder(baseAbsolute: string, id: string, opts?: SegmentOptions): IdDir {
  const base = resolve(baseAbsolute);
  const legacy = join(base, id);
  if (isInside(base, legacy) && isDirectory(legacy)) {
    return { absolute: legacy, name: id, legacy: true };
  }
  const name = safeSegment(id, opts);
  return { absolute: join(base, name), name, legacy: false };
}

/** `idDirUnder` for a project-relative base, carrying the relative path back. */
export function idDirIn(projectRoot: string, baseRelative: string, id: string, opts?: SegmentOptions): IdDirIn {
  const root = resolve(projectRoot);
  const baseRel = baseRelative.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const dir = idDirUnder(resolve(root, baseRel), id, opts);
  const rel = dir.legacy
    ? `${baseRel}/${id.replace(/\\/gu, "/")}`
    : `${baseRel}/${dir.name}`;
  return { ...dir, relative: rel };
}

/** The one mkdir. */
export function ensureIdDirUnder(baseAbsolute: string, id: string, opts?: SegmentOptions): IdDir {
  const dir = idDirUnder(baseAbsolute, id, opts);
  mkdirSync(dir.absolute, { recursive: true });
  return dir;
}

/** The one mkdir, project-relative. */
export function ensureIdDirIn(projectRoot: string, baseRelative: string, id: string, opts?: SegmentOptions): IdDirIn {
  const dir = idDirIn(projectRoot, baseRelative, id, opts);
  mkdirSync(dir.absolute, { recursive: true });
  return dir;
}

/**
 * A FILE named after an id inside a directory that already exists. Same
 * contract: a file written before Spec 838 under the raw id is used where it
 * is, so a store keeps writing to the record it already has.
 */
export function idFileUnder(dirAbsolute: string, id: string, extension = "", opts?: SegmentOptions): IdDir {
  const dir = resolve(dirAbsolute);
  const legacy = join(dir, `${id}${extension}`);
  if (isInside(dir, legacy) && existsSync(legacy)) {
    return { absolute: legacy, name: `${id}${extension}`, legacy: true };
  }
  const name = `${safeSegment(id, opts)}${extension}`;
  return { absolute: join(dir, name), name, legacy: false };
}

// ------------------------------------------------------------------ the L2 mirror

/** Where `run_prg_reverse_workflow` mirrors one payload entity's analysis. */
export const PAYLOAD_OUTPUT_BASE = "artifacts/generated/payloads";

/** `artifacts/generated/payloads/<segment>` for one payload entity id. */
export function payloadOutputDir(projectRoot: string, entityId: string): IdDirIn {
  return idDirIn(projectRoot, PAYLOAD_OUTPUT_BASE, entityId);
}
