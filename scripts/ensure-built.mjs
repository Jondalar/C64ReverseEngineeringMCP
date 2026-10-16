#!/usr/bin/env node
/**
 * ensure-built.mjs <mcp|pipeline|ui|all> — build only when the sources changed.
 *
 * A test script used to start with `npm run build:mcp`, and one gate run rebuilt identical code
 * over a hundred times. This builds when the content hash of the inputs differs from the hash
 * stored after the last successful build, or when an output is missing. A touched but unchanged
 * file does not rebuild; a reverted edit does.
 *
 *   mcp       inputs: src/**, tsconfig.json, package.json, the tsc version   (npm run build:mcp)
 *   pipeline  inputs: pipeline/src/**, pipeline/tsconfig.json, scripts/fix-pipeline-ext.mjs,
 *             the tsc version                                                (npm run build:pipeline)
 *   all       both; when both are stale, one full `npm run build`
 *   ui        inputs: ui/** except ui/dist and node_modules, src/** (the bundle imports from it),
 *             tsconfig.json, package.json, the vite version                  (npm run ui:build)
 *   --stamp   record the current hashes of mcp and pipeline (the last step of `npm run build`)
 *   --stamp ui   record the hash of the bundle (the last step of `prepack`, after `npm run ui:build`)
 *
 * The stamp is dist/.build-stamp.json. `npm run build` wipes dist and so wipes the stamp, then
 * rewrites it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const STAMP = "dist/.build-stamp.json";
const OUTPUTS = {
  mcp: ["dist/cli.js", "dist/server.js"],
  pipeline: ["dist/pipeline/cli.cjs"],
  ui: ["ui/dist/index.html"],
};

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === "ui/dist" || e.name === "node_modules") continue;
      walk(p, out);
    }
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function hashOf(kind) {
  const h = createHash("sha1");
  const files =
    kind === "mcp"
      ? [...walk("src", []), "tsconfig.json", "package.json"]
      : kind === "ui"
        ? [...walk("ui", []), ...walk("src", []), "tsconfig.json", "package.json"]
        : [...walk("pipeline/src", []), "pipeline/tsconfig.json", "scripts/fix-pipeline-ext.mjs"];
  for (const f of files) {
    h.update(f + "\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  for (const tool of kind === "ui" ? ["vite"] : ["typescript"]) {
    try {
      h.update(tool + " " + JSON.parse(readFileSync(`node_modules/${tool}/package.json`, "utf8")).version);
    } catch {
      h.update(tool + " ?");
    }
  }
  return h.digest("hex");
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP, "utf8"));
  } catch {
    return {};
  }
}

function writeStamp(patch) {
  mkdirSync("dist", { recursive: true });
  writeFileSync(STAMP, JSON.stringify({ ...readStamp(), ...patch }) + "\n");
}

const outputsPresent = (kind) => OUTPUTS[kind].every((f) => existsSync(f));
const fresh = (kind, stamp, hash) => stamp[kind] === hash && outputsPresent(kind);

function npm(script) {
  const r = spawnSync("npm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Several steps may run side by side and find the tree stale at once; one builds, the others wait
// for it and then find the stamp current. The lock lives outside dist, which a full build wipes.
const lockDir = join(tmpdir(), "c64re-build-" + createHash("sha1").update(root).digest("hex").slice(0, 12));
function lock() {
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 600_000) rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() - t0 > 900_000) throw new Error("ensure-built: build lock held for 15 minutes");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
const unlock = () => rmSync(lockDir, { recursive: true, force: true });

const kind = process.argv[2];
if (kind === "--stamp" && process.argv[3] === "ui") {
  writeStamp({ ui: hashOf("ui") });
  process.exit(0);
}
if (kind === "--stamp") {
  writeStamp({ mcp: hashOf("mcp"), pipeline: hashOf("pipeline") });
  process.exit(0);
}
if (!["mcp", "pipeline", "all", "ui"].includes(kind)) {
  console.error("usage: node scripts/ensure-built.mjs <mcp|pipeline|ui|all> | --stamp");
  process.exit(2);
}

const kinds = kind === "all" ? ["mcp", "pipeline"] : [kind];
const hashes = Object.fromEntries(kinds.map((k) => [k, hashOf(k)]));
if (kinds.every((k) => fresh(k, readStamp(), hashes[k]))) process.exit(0);

lock();
try {
  const stamp = readStamp();
  const stale = kinds.filter((k) => !fresh(k, stamp, hashes[k]));
  if (stale.length === 2) {
    npm("build"); // wipes dist and writes the stamp itself
  } else {
    for (const k of stale) {
      npm({ mcp: "build:mcp", pipeline: "build:pipeline", ui: "ui:build" }[k]);
      writeStamp({ [k]: hashes[k] });
    }
  }
} finally {
  unlock();
}
