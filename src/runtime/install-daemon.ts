// Spec 716.3 — fetching the runtime, on first use and never at install time.
//
// An installed C64RE has no machine. TRX64 is a separate daemon, and until this existed
// the recipe a user met told them to `cargo build --release` in a sibling checkout they
// do not have. This module is the other answer: one explicit act, once, that puts the
// pinned daemon in a cache directory where `resolve-daemon-spawn.ts` looks.
//
// **Not a postinstall.** `npx -y @trex64/c64re` has to start immediately; a postinstall that
// pulls 27 MB from GitHub turns every cold start into a download, and it is also the first
// thing a `--ignore-scripts` install silently skips. The fetch happens when something
// actually needs a machine, it says what it is doing, and it verifies the checksum that
// TRX64 already publishes beside every archive.
//
// **Never "latest".** The client requires an EXACT protocol match (`setup-recipe.ts`), so
// a daemon that is ahead is a setup error rather than a best-effort. The version is
// therefore pinned here and cross-checked by `scripts/e2e-716-runtime.mjs`.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, chmodSync, renameSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { REQUIRED_TRX64_VERSION } from "./setup-recipe.js";

const RELEASE_BASE = "https://github.com/Jondalar/TRX64/releases/download";

/** The five-and-one targets TRX64's release matrix builds, keyed as node reports them. */
const TARGETS: Readonly<Record<string, { target: string; ext: "tar.gz" | "zip" }>> = {
  "darwin-arm64": { target: "macos-arm64", ext: "tar.gz" },
  "darwin-x64": { target: "macos-x86_64", ext: "tar.gz" },
  "linux-x64": { target: "linux-x86_64", ext: "tar.gz" },
  "linux-arm64": { target: "linux-arm64", ext: "tar.gz" },
  "win32-x64": { target: "windows-x86_64", ext: "zip" },
  "win32-arm64": { target: "windows-arm64", ext: "zip" },
};

export function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

/** The asset this machine needs, or `null` with the key that has no build. */
export function assetFor(key = platformKey()): { name: string; url: string; sha: string } | null {
  const t = TARGETS[key];
  if (!t) return null;
  const name = `trx64-${REQUIRED_TRX64_VERSION}-${t.target}.${t.ext}`;
  const base = `${RELEASE_BASE}/v${REQUIRED_TRX64_VERSION}/${name}`;
  return { name, url: base, sha: `${base}.sha256` };
}

/** Every platform key this module claims to serve — the gate walks it. */
export function knownTargets(): string[] {
  return Object.keys(TARGETS);
}

/**
 * Where a managed daemon lives. One directory per version, so an upgrade is a new
 * directory and a rollback is the old one still being there.
 */
export function cacheRoot(): string {
  const local = process.platform === "win32" ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME;
  const base = local?.trim() || join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache");
  return join(base, "c64re", "trx64");
}

export function cachedDaemonPath(version = REQUIRED_TRX64_VERSION): string {
  return join(cacheRoot(), version, `trx64-daemon${process.platform === "win32" ? ".exe" : ""}`);
}

async function fetchTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface InstallResult {
  path: string;
  version: string;
  alreadyPresent: boolean;
  bytes: number;
  sha256: string;
}

/**
 * Fetch, verify and unpack the pinned daemon into the cache. Idempotent: a verified copy
 * already there is returned untouched.
 *
 * `tar` handles both archive kinds — bsdtar ships with macOS and Windows 10+, GNU tar with
 * every Linux — so there is one extraction path rather than a zip branch that only the
 * author's machine never takes.
 */
export async function installDaemon(opts: { force?: boolean } = {}): Promise<InstallResult> {
  const key = platformKey();
  const asset = assetFor(key);
  if (!asset) {
    throw new Error(
      `No TRX64 release is built for ${key}. Built targets: ${knownTargets().join(", ")}. `
      + `Build it from source instead — the recipe is in the runtime setup message.`,
    );
  }

  const dest = cachedDaemonPath();
  if (!opts.force && existsSync(dest)) {
    return { path: dest, version: REQUIRED_TRX64_VERSION, alreadyPresent: true, bytes: statSync(dest).size, sha256: "" };
  }

  const stage = join(tmpdir(), `c64re-trx64-${process.pid}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    const archive = join(stage, asset.name);
    await fetchTo(asset.url, archive);

    // The checksum is published beside the archive as `<hash>  <filename>`. Verifying it
    // is the whole reason this is not a `curl | tar` in a documentation page.
    const shaFile = `${archive}.sha256`;
    await fetchTo(asset.sha, shaFile);
    const expected = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    const actual = sha256(archive);
    if (!expected || expected !== actual) {
      throw new Error(`checksum mismatch for ${asset.name}: published ${expected ?? "(none)"}, downloaded ${actual}`);
    }

    execFileSync("tar", ["-xf", archive, "-C", stage], { stdio: ["ignore", "ignore", "pipe"] });

    // The archive holds trx64cli and trx64-daemon at its root; find the daemon rather than
    // assume a layout, so a future archive that nests one level does not break this.
    const wanted = `trx64-daemon${process.platform === "win32" ? ".exe" : ""}`;
    const found = findFile(stage, wanted);
    if (!found) throw new Error(`${asset.name} contained no ${wanted}`);

    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    renameSync(found, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);

    return { path: dest, version: REQUIRED_TRX64_VERSION, alreadyPresent: false, bytes: statSync(dest).size, sha256: actual };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function findFile(dir: string, name: string, depth = 3): string | null {
  if (depth < 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const hit = findFile(p, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
