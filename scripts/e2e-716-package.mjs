#!/usr/bin/env node
// Spec 716.2 — the package gate.
//
// Everything here runs against a PACKED TARBALL installed into an empty directory, never
// against this checkout. That distinction is the whole point: C64RE has always worked from
// a source tree, and every way it quietly depends on one — a gitignored `dist/`, a sibling
// directory, a path resolved against the cwd — is invisible from inside the tree and fatal
// outside it.
//
// It answers three questions in order, and stops at the first no:
//
//   1. Does the tarball carry what it must, and nothing it must not?
//   2. Does it install into an empty directory?
//   3. Does the installed executable start, speak MCP, read its own shipped resources,
//      and spawn its own pipeline child?
//
// `npm pack` runs `prepack`, so this also proves the tarball cannot be built from a stale
// tree. Expect it to take a minute: it installs real dependencies, including a native one.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Running npm from a script is three problems on Windows and none on POSIX. `npm` is a
// `.cmd` shim, `execFileSync` does not consult PATHEXT so it reports ENOENT, and naming
// `npm.cmd` then hits EINVAL, because Node refuses to spawn a batch file without a shell
// (the BatBadBut fix). Reaching for `shell: true` at that point trades the problem for
// quoting: every path here comes from `mkdtemp`, and a temp path with a space would break
// silently.
//
// So npm is run the way it is already running: `npm_execpath` is set inside any npm
// script, and it points at npm-cli.js. Spawning that with this Node is one code path on
// every platform, with no shell and no shim. The fallback exists for a direct
// `node scripts/e2e-716-package.mjs`, where nothing set the variable.
const NPM_CLI = process.env.npm_execpath;
const npmArgv = (args) => (NPM_CLI ? [NPM_CLI, ...args] : args);
const NPM = NPM_CLI ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
let pass = 0;
let fail = 0;
const check = (ok, what, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); }
};

console.log("Spec 716.2 — the package gate: a tarball, an empty directory, a running server\n");

const work = mkdtempSync(join(tmpdir(), "c64re-716-"));
const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

// ── 1. what the tarball carries ──────────────────────────────────────────────
console.log("1. The tarball");

let packed;
try {
  const out = execFileSync(NPM, npmArgv(["pack", "--json", "--pack-destination", work]), {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024,
  });
  // `--json` does not silence the lifecycle scripts it runs, and `prepack` is a full
  // build that prints. So the report is the LAST JSON value on stdout, not all of it.
  packed = JSON.parse(out.slice(out.lastIndexOf("\n[\n") + 1))[0];
} catch (e) {
  check(false, "npm pack succeeds (runs prepack → build)", String(e.message).slice(0, 200));
  console.log("\nRED  spec 716 package: cannot continue without a tarball.");
  process.exit(1);
}

const paths = packed.files.map((f) => f.path);
const has = (p) => paths.includes(p);
const anyUnder = (d) => paths.some((p) => p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`));

check(has("package.json") && has("LICENSE"), "the manifest and the licence ship");
check(has("dist/cli.js"), "the built server ships", "dist/cli.js");
check(has("dist/pipeline/cli.cjs"), "the pipeline child ships", "dist/pipeline/cli.cjs");
check(has("resources/platform-kb.sqlite"), "the knowledge base ships",
  `${(packed.files.find((f) => f.path === "resources/platform-kb.sqlite")?.size ?? 0) / 1024 | 0} KB`);

// A source tree is not a package. Each of these is something a user pays to download and
// can never use; `samples/` and `.githooks/` are also things that simply have no business
// on someone else's machine.
for (const d of ["specs", "bugs", "scripts", "samples", "tests", ".githooks", ".github", "pipeline/src", "src", "ui/src"]) {
  check(!anyUnder(d), `no ${d}/ in the tarball`);
}

// Nothing that is anybody's media, by extension rather than by directory — a stray disk
// image somewhere unexpected is exactly what a directory list would miss.
const media = paths.filter((p) => /\.(d64|g64|d81|crt|prg|t64|tap|nib|c64re|c64retrace|duckdb)$/i.test(p));
check(media.length === 0, "no media, image or trace file of any kind", media.slice(0, 3).join(", "));

const roms = paths.filter((p) => /resources\/roms\//.test(p) || /\.bin$/i.test(p));
check(roms.length === 0, "no ROM — Commodore's property, never in a package", roms.slice(0, 3).join(", "));

console.log(`        ${packed.entryCount} files, ${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked, ${(packed.size / 1024 / 1024).toFixed(1)} MB tarball`);

// ── 2. install into an empty directory ───────────────────────────────────────
console.log("\n2. Installing into an empty directory");

const home = join(work, "install");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "package.json"), JSON.stringify({ name: "c64re-716-probe", version: "1.0.0", private: true }, null, 2));

let installed = false;
try {
  execFileSync(NPM, npmArgv(["install", join(work, packed.filename), "--no-audit", "--no-fund", "--loglevel", "error"]), {
    cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 10 * 60 * 1000,
  });
  installed = true;
} catch (e) {
  check(false, "npm install <tarball> into an empty directory", String(e.message).slice(0, 300));
}
check(installed, "the tarball installs with no repository around it");
if (!installed) { console.log("\nRED  spec 716 package."); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pkgDir = join(home, "node_modules", manifest.name);
const binName = Object.keys(manifest.bin ?? {})[0];
check(Boolean(binName), "the manifest declares an executable", binName ?? "no `bin` field");
// npm writes a symlink on POSIX and a pair of shims (.cmd, .ps1) on Windows, so the
// question is "did npm link it", not "is there a file with exactly this name".
const binDir = join(home, "node_modules", ".bin");
const linked = binName && existsSync(binDir)
  ? readdirSync(binDir).filter((f) => f === binName || f.startsWith(`${binName}.`))
  : [];
check(linked.length > 0, "and npm linked it into .bin", linked.join(", ") || binName);
check(existsSync(join(pkgDir, "resources", "platform-kb.sqlite")),
  "the knowledge base is on disk in the installed package");

// ── 3. the installed server answers ──────────────────────────────────────────
console.log("\n3. The installed server");

const proj = join(work, "project");
mkdirSync(proj, { recursive: true });

const entry = join(pkgDir, manifest.bin?.[binName] ?? "dist/cli.js");

/**
 * One MCP session over stdio, against whatever command is handed in.
 *
 * It takes a command rather than a path because HOW the server is started is part of what
 * this gate is for. A harness writes `"command": "npx"` into its config; npm installs a
 * `.cmd`/`.ps1` shim on Windows and a symlink elsewhere; and Node will not spawn a batch
 * file without a shell. Checking that the shim EXISTS, which is all this did before, says
 * nothing about whether it runs.
 */
function session(cmd, args, { useShell = false, cwd = tmpdir() } = {}) {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_SLOT_GATE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
  });

  let buf = "";
  const pend = new Map();
  let nid = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ln = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!ln) continue;
      let m;
      try { m = JSON.parse(ln); } catch { continue; }
      if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nid++;
    const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 300000);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const call = async (name, args2) => {
    const r = await rpc("tools/call", { name, arguments: args2 });
    if (r.error) return `ERROR ${JSON.stringify(r.error)}`;
    const text = (r.result?.content || []).map((c) => c.text).join("\n");
    // A tool that failed answers with a rendered "# Tool Error" and a 200 status. The
    // first version of this gate read that as success, which is the same mistake the tool
    // text is there to prevent.
    return /^#\s*Tool Error/m.test(text) ? `ERROR ${text.split("\n").find((l) => /^Error:/.test(l)) ?? text.slice(0, 160)}` : text;
  };

  const initialize = () => rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "spec-716-gate", version: "1.0.0" },
  });

  return { proc, rpc, call, initialize, stderrText: () => stderr };
}

// Windows needs a shell to run npm's `.cmd` shims at all, which is exactly what a harness
// ends up doing, so the gate does it the same way — and quotes the command, because a path
// handed to a shell is a string and temp directories are not guaranteed to be space-free.
const win = process.platform === "win32";
const shimCmd = (name) => {
  const p = join(binDir, win ? `${name}.cmd` : name);
  return win ? { cmd: `"${p}"`, args: [], useShell: true } : { cmd: p, args: [], useShell: false };
};

const { proc, rpc, call, initialize } = session(process.execPath, [entry]);
const stderrOf = () => "";

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "spec-716-gate", version: "1.0.0" },
  });
  check(!init.error && Boolean(init.result?.serverInfo), "it completes an MCP initialize",
    init.result?.serverInfo?.name);

  const listed = await rpc("tools/list", {});
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  check(names.length > 0, "and offers a tool surface", `${names.length} tools`);
  check(names.includes("analyze") && names.includes("disasm"),
    "including the two byte doors under their live names");

  // Reads resources/platform-kb.sqlite, which is why it proves the resource shipped.
  const ref = await call("c64ref_lookup", { address: "FFD2" });
  check(!ref.startsWith("ERROR") && /chrout/i.test(ref),
    "a tool reads the SHIPPED knowledge base", ref.split("\n")[0]?.slice(0, 70));

  // Spawns dist/pipeline/cli.cjs as a child, which is why it proves the pipeline shipped
  // AND that run-cli resolves it relative to its own module rather than the cwd.
  // project_init before anything else: an uninitialised directory is refused by design,
  // and a gate that skips it is testing the refusal instead of the package. It also
  // scaffolds the project and ingests whatever loose files it finds, so the payload is
  // written AFTER it — a file dropped in first is swept into the scaffold and the analyse
  // call then refuses a path that no longer exists.
  const inited = await call("project_init", { project_dir: proj, name: "spec-716-probe" });
  check(!inited.startsWith("ERROR"), "project_init works in an installed package", inited.split("\n")[0]?.slice(0, 70));

  // A two-byte load header and four bytes of code: the smallest thing `analyze` can be
  // asked about, and enough to prove the pipeline child ran.
  mkdirSync(join(proj, "input"), { recursive: true });
  writeFileSync(join(proj, "input", "tiny.prg"), Buffer.from([0x00, 0x10, 0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60]));

  await call("agent_onboard", { project_dir: proj });
  const analysed = await call("analyze", { path: "input/tiny.prg" });
  check(!analysed.startsWith("ERROR") && /segment|analysis|\$1000/i.test(analysed),
    "and a tool spawns the pipeline child from node_modules",
    analysed.split("\n").find((l) => l.trim())?.slice(0, 70));
} catch (e) {
  check(false, "the installed server answers", String(e.message).slice(0, 200));
} finally {
  proc.kill();
}

// ── 4. started the way a harness starts it ───────────────────────────────────
//
// Everything above ran `node <entry>`. No harness does that: a harness runs the name, and
// the name is a shim npm wrote. On Windows that shim is a `.cmd`, which Node refuses to
// spawn without a shell, and a config saying `"command": "npx"` goes through a second one.
// This section is the whole reason the Windows job exists, and until now it was the one
// thing the job did not do.
console.log("\n4. Started the way a harness starts it");

const shim = shimCmd(binName);
{
  const s2 = session(shim.cmd, shim.args, { useShell: shim.useShell });
  try {
    const init = await s2.initialize();
    check(!init.error && Boolean(init.result?.serverInfo),
      `the executable runs through npm's own shim (${win ? `${binName}.cmd` : binName})`,
      init.result?.serverInfo?.name);
    const ref = await s2.call("c64ref_lookup", { address: "FFD2" });
    check(!ref.startsWith("ERROR"), "and answers a tool call started that way", ref.split("\n")[0]?.slice(0, 50));
  } catch (e) {
    check(false, "the executable runs through npm's own shim", String(e.message).slice(0, 160));
    const err = s2.stderrText();
    if (err) console.log(`        stderr: ${err.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
  } finally {
    s2.proc.kill();
  }
}

// `npx <name>` from the directory that installed it. This is the documented shape one step
// short of the registry — `npx -y @c64re/mcp` adds only the fetch, and that cannot be
// proved before the package is published (716.6).
{
  const npxPath = join(binDir, win ? "npx.cmd" : "npx");
  const haveLocalNpx = existsSync(npxPath);
  const npx = haveLocalNpx ? npxPath : (win ? "npx.cmd" : "npx");
  // cwd is the directory that installed it, not a temp directory: that is how `npx`
  // finds a locally installed bin at all. Everything else in this gate deliberately runs
  // from elsewhere, to prove the server does not lean on the cwd — this one cannot.
  const s3 = session(win ? `"${npx}"` : npx, [binName], { useShell: win, cwd: home });
  try {
    const init = await s3.initialize();
    check(!init.error && Boolean(init.result?.serverInfo),
      "and through `npx`, which is what an MCP host config names", init.result?.serverInfo?.name);
  } catch (e) {
    check(false, "and through `npx`, which is what an MCP host config names", String(e.message).slice(0, 160));
    const err = s3.stderrText();
    if (err) console.log(`        stderr: ${err.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
  } finally {
    s3.proc.kill();
  }
}

console.log(`\n${fail ? "RED " : "GREEN"}  spec 716 package: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
