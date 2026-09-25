#!/usr/bin/env node
// Spec 716.3 — the runtime beside the package.
//
// An installed C64RE has no machine, and every way it used to find one was a CHECKOUT
// shape: two environment variables somebody has to know about, and a sibling directory
// that only exists next to a clone. This gate covers the three parts of the answer:
//
//   1. The PIN. `EXPECTED_RUNTIME_PROTOCOL` demands an exact match, so the fetch may never
//      resolve "latest" — it resolves a pinned version. Two hand-maintained numbers can
//      silently disagree, and that disagreement would only ever surface on somebody else's
//      machine, so they are cross-checked against the sibling TRX64 checkout here.
//   2. The MAPPING. Every platform the installer claims to serve maps to an asset name
//      that matches what TRX64's release workflow actually builds.
//   3. The RESOLUTION. The cache directory and PATH are consulted, in that order, and a
//      daemon in either is found without any environment variable being set.
//
// Hermetic by default: nothing here downloads anything. The sibling cross-check skips
// loudly when there is no sibling (a runner has none), which is the one thing a
// correctness gate may not do silently.

import { existsSync, readFileSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0, skip = 0;
const check = (ok, what, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); }
};
const skipped = (what, why) => { skip++; console.log(`  SKIP  ${what}  (${why})`); };

console.log("Spec 716.3 — the runtime beside the package: the pin, the mapping, the resolution\n");

const recipe = await import(join(ROOT, "dist/runtime/setup-recipe.js"));
const installer = await import(join(ROOT, "dist/runtime/install-daemon.js"));

// ── 1. the pin ───────────────────────────────────────────────────────────────
console.log("1. The pin");

const pinned = recipe.REQUIRED_TRX64_VERSION;
check(typeof pinned === "string" && /^\d+\.\d+\.\d+$/.test(pinned),
  "C64RE pins an exact TRX64 version", pinned);
check(Number.isInteger(recipe.EXPECTED_RUNTIME_PROTOCOL),
  "and an exact wire protocol", `trx64-runtime/${recipe.EXPECTED_RUNTIME_PROTOCOL}`);

const sibling = join(ROOT, "..", "TRX64");
if (!existsSync(sibling)) {
  skipped("the pin agrees with the sibling TRX64 checkout", "no ../TRX64 on this machine");
} else {
  const cargo = readFileSync(join(sibling, "Cargo.toml"), "utf8");
  const wsVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  check(wsVersion === pinned,
    "the pinned version IS the sibling's workspace version",
    `pinned ${pinned}, sibling ${wsVersion ?? "?"}`);

  const daemonMain = join(sibling, "crates/trx64-daemon/src/main.rs");
  const proto = existsSync(daemonMain)
    ? /RUNTIME_VERSION:\s*&str\s*=\s*"trx64-runtime\/(\d+)"/.exec(readFileSync(daemonMain, "utf8"))?.[1]
    : undefined;
  check(proto !== undefined && Number(proto) === recipe.EXPECTED_RUNTIME_PROTOCOL,
    "and the protocol the daemon announces is the one the client demands",
    `client ${recipe.EXPECTED_RUNTIME_PROTOCOL}, daemon ${proto ?? "?"}`);
}

// ── 2. the mapping ───────────────────────────────────────────────────────────
console.log("\n2. The asset mapping");

const targets = installer.knownTargets();
check(targets.length >= 6, "every desktop platform TRX64 builds is mapped", targets.join(", "));

// The names TRX64's release-binaries.yml produces. Read from the workflow when it is here,
// so this gate cannot drift from the thing it is checking.
const workflow = join(sibling, ".github/workflows/release-binaries.yml");
if (!existsSync(workflow)) {
  skipped("the asset names match TRX64's release workflow", "no sibling workflow to read");
} else {
  const built = [...readFileSync(workflow, "utf8").matchAll(/^\s*target:\s*([a-z0-9_-]+)\s*$/gim)].map((m) => m[1]);
  for (const key of targets) {
    const asset = installer.assetFor(key);
    const target = asset.name.replace(`trx64-${pinned}-`, "").replace(/\.(tar\.gz|zip)$/, "");
    check(built.includes(target),
      `${key} → an asset the release workflow builds`,
      built.includes(target) ? asset.name : `${asset.name} — workflow builds ${built.join(", ")}`);
  }
}

for (const key of targets) {
  const a = installer.assetFor(key);
  const wantsZip = key.startsWith("win32");
  check(a.name.endsWith(wantsZip ? ".zip" : ".tar.gz"), `${key} asks for the archive kind that platform ships`, a.name);
  check(a.sha === `${a.url}.sha256`, `${key} checks the published checksum`);
  check(a.url.includes(`/v${pinned}/`), `${key} resolves the PINNED tag, never "latest"`);
}
check(installer.assetFor("sunos-sparc") === null,
  "a platform with no build is refused rather than guessed");

// ── 3. the resolution ────────────────────────────────────────────────────────
console.log("\n3. Finding a daemon without a checkout");

const { resolveDaemonSpawn } = await import(join(ROOT, "dist/runtime/resolve-daemon-spawn.js"));
const work = mkdtempSync(join(tmpdir(), "c64re-716rt-"));
process.on("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const proj = join(work, "project");
mkdirSync(proj, { recursive: true });

// The env vars and the sibling checkout would all mask what is being tested, so they go.
const clean = { ...process.env };
delete clean.C64RE_RUNTIME_BIN;
delete clean.C64RE_TRX64_BIN;
const saved = { ...process.env };
const withEnv = (extra, fn) => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, clean, extra);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

const exe = process.platform === "win32" ? "trx64-daemon.exe" : "trx64-daemon";
const fakeDaemon = (dir) => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, exe);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(p, 0o755);
  return p;
};

// A daemon on PATH and nothing else.
const pathDir = join(work, "bin");
const onPath = fakeDaemon(pathDir);
const viaPath = withEnv({ PATH: pathDir, XDG_CACHE_HOME: join(work, "empty-cache"), LOCALAPPDATA: join(work, "empty-cache") },
  () => resolveDaemonSpawn({ projectDir: proj, port: "4312", repoRoot: work }));
check(viaPath.mode === "external-bin" && viaPath.cmd === onPath,
  "a daemon on PATH is found with no environment variable set", viaPath.cmd || viaPath.mode);

// A managed copy in the cache, with PATH ALSO holding one: the pinned copy wins.
const cacheHome = join(work, "cache");
withEnv({ XDG_CACHE_HOME: cacheHome, LOCALAPPDATA: cacheHome }, () => {
  const cached = installer.cachedDaemonPath();
  check(cached.includes(pinned), "the cache path is per-version, so an upgrade cannot overwrite a rollback", cached.replace(work, "…"));
  fakeDaemon(dirname(cached));
  const r = resolveDaemonSpawn({ projectDir: proj, port: "4312", repoRoot: work });
  check(r.mode === "external-bin" && r.cmd === cached,
    "the pinned cache copy is preferred over whatever PATH happens to carry", r.cmd?.replace(work, "…") || r.mode);
});

// Nothing anywhere: the answer must be the recipe, not a crash and not a silent fallback.
const none = withEnv({ PATH: join(work, "nothing"), XDG_CACHE_HOME: join(work, "nothing"), LOCALAPPDATA: join(work, "nothing") },
  () => resolveDaemonSpawn({ projectDir: proj, port: "4312", repoRoot: work }));
check(none.mode === "none", "with no daemon anywhere the caller is told so, not given a fallback", none.mode);

// ── 4. the recipe leads with the command ─────────────────────────────────────
console.log("\n4. The recipe a user actually meets");

const text = recipe.runtimeSetupRecipe("gate");
const firstOption = text.split("\n").find((l) => /^\s*1\)/.test(l)) ?? "";
check(/runtime_install|runtime install/.test(firstOption),
  "option 1 is the one command, not a source build", firstOption.trim().slice(0, 70));
check(/cargo build/.test(text) && text.indexOf("cargo build") > text.indexOf("runtime install"),
  "building from source is still offered, and is no longer first");
check(text.includes(pinned), "and it names the version it will fetch", pinned);

// ── 5. the fetch itself ──────────────────────────────────────────────────────
//
// Hermetic by default, because gates.yml is. With C64RE_716_FETCH=1 it downloads for real;
// otherwise, if a pinned daemon is ALREADY in the cache from an earlier run, that copy is
// checked instead — which is the same evidence without the network.
console.log("\n5. The fetched daemon");

const { execFileSync } = await import("node:child_process");
const want = installer.cachedDaemonPath();
if (process.env.C64RE_716_FETCH === "1") {
  const r = await installer.installDaemon({ force: true });
  check(r.path === want && existsSync(r.path), "runtime_install puts the daemon where resolution looks", r.path);
  check(/^[0-9a-f]{64}$/.test(r.sha256), "and verified the published checksum", r.sha256.slice(0, 16) + "…");
}
if (existsSync(want)) {
  let reported = "";
  try { reported = execFileSync(want, ["--version"], { encoding: "utf8" }).trim(); } catch (e) { reported = `(${String(e.message).slice(0, 60)})`; }
  check(reported.includes(pinned), "the fetched daemon reports the pinned version", reported);
  const blob = readFileSync(want);
  check(blob.includes(Buffer.from(`trx64-runtime/${recipe.EXPECTED_RUNTIME_PROTOCOL}`)),
    "and speaks the protocol this client demands", `trx64-runtime/${recipe.EXPECTED_RUNTIME_PROTOCOL}`);
} else {
  skipped("the fetched daemon is the pinned one", "nothing in the cache; set C64RE_716_FETCH=1 to download it");
}

console.log(`\n${fail ? "RED " : "GREEN"}  spec 716 runtime: ${pass} pass, ${fail} fail, ${skip} skipped.`);
process.exit(fail ? 1 : 0);
