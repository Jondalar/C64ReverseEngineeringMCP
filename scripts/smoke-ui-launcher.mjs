#!/usr/bin/env node
// The workspace starters `project_launchers` writes into a project root, per platform:
// linux `ui.sh` + 3 `.desktop`, macos `ui.sh` + 3 `.command`, windows `ui.ps1` + 3 `.cmd`.
// project_init writes none of them.
//
// The Windows half cannot be run here, so the gate checks what CAN be checked
// off the machine it targets: the shape of the generated text, the quoting of
// the two paths that are pasted into it (a project called `Mike's Disk` must not
// end the string), CRLF line endings, and the 5.1-only constructs the script is
// allowed to use. When PowerShell IS present (`pwsh`), the real parser is run
// over the file and the gate is a syntax check; without it that one step skips
// LOUDLY rather than passing quietly. `bash -n` does the same for ui.sh.
//
// Exit 0 = pass, 1 = fail.   npm run smoke:ui-launcher

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { ensureUiLaunchers } = await import(join(ROOT, "dist/project-knowledge/ui-launcher.js"));

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const info = (msg) => console.log(`  info  ${msg}`);

console.log("Workspace launchers — ui.sh + ui.ps1 + the double-click shims\n");

// ---------------------------------------------------------------- generate

// A project name with an apostrophe and a space: the two characters that break
// naive quoting in both shells. This is not hypothetical — the corpus is full of
// `wasteland_s1[ea_interplay_1988](!)`.
const project = mkdtempSync(join(tmpdir(), "c64re-launcher-"));
const projectDir = join(project, "Mike's Disk (!)");
const repoDir = join(project, "C64RE Tools", "repo");
mkdirSync(projectDir, { recursive: true });
mkdirSync(repoDir, { recursive: true });

const r1 = ensureUiLaunchers(projectDir, repoDir, { platform: "windows" });
const names = r1.files.map((f) => f.path.replace(`${projectDir}/`, ""));
info(`created: ${names.join(", ")}`);

const WANT = ["ui.ps1", "ui-start.cmd", "ui-stop.cmd", "ui-restart.cmd"];
check(WANT.length === names.length && WANT.every((n) => names.includes(n)), `windows: exactly the four starters written (${WANT.join(", ")})`);
check(r1.files.every((f) => f.created && existsSync(f.path)), "every file reported created and exists");
check(r1.created === true && r1.path.endsWith("ui.ps1") && r1.platform === "windows", "the result names the platform and its main script");

const read = (n) => readFileSync(join(projectDir, n), "utf8");
// ui.sh is the Linux/macOS script; the POSIX checks below run on a linux set in a
// separate folder so the windows folder holds nothing else.
const posixProject = join(project, "posix", "Mike's Disk (!)");
mkdirSync(posixProject, { recursive: true });
ensureUiLaunchers(posixProject, repoDir, { platform: "linux" });
const sh = readFileSync(join(posixProject, "ui.sh"), "utf8");
const ps1 = read("ui.ps1");
const startCmd = read("ui-start.cmd");

// ---------------------------------------------------------------- idempotence

writeFileSync(join(projectDir, "ui.ps1"), "# hand-edited\n");
const r2 = ensureUiLaunchers(projectDir, repoDir, { platform: "windows" });
check(r2.files.every((f) => !f.created), "second run creates nothing");
check(read("ui.ps1") === "# hand-edited\n", "a hand-edited ui.ps1 is NOT overwritten");
const r2b = ensureUiLaunchers(projectDir, repoDir, { platform: "windows", refresh: true });
check(r2b.files.every((f) => f.created) && read("ui.ps1") === ps1, "refresh rewrites this platform's files (the hand edit is gone)");

// ---------------------------------------------------------------- quoting

check(sh.includes(`PROJECT='${posixProject.replace(/'/g, `'\\''`)}'`), "ui.sh: the project path is POSIX single-quoted (apostrophe escaped)");
// The project is NOT baked: a folder carried to another machine must still work.
check(/^\$PROJECT\s+= \$PSScriptRoot\s*$/m.test(ps1), "ui.ps1: $PROJECT is $PSScriptRoot — the folder the script sits in, not a path from the generating machine");
check(!ps1.includes(projectDir) && !ps1.includes(projectDir.replace(/\//g, "\\")), "ui.ps1: the generating machine's project path appears nowhere");
// The repo cannot be derived, so it is baked — as the SECOND choice.
const bakedLine = ps1.split("\r\n").find((l) => l.startsWith("$REPO_BAKED")) ?? "";
check(bakedLine.includes("C64RE Tools\\repo") && !bakedLine.includes("/"), `ui.ps1: $REPO_BAKED holds the repo path with backslashes (${bakedLine.trim()})`);
check(ps1.includes("if ($env:C64RE_REPO) { $candidates += $env:C64RE_REPO }") && ps1.indexOf("$env:C64RE_REPO) { $candidates") < ps1.indexOf("$candidates += $REPO_BAKED"),
  "ui.ps1: $env:C64RE_REPO outranks the baked path");
check(ps1.includes("Join-Path $candidate 'scripts\\workspace.mjs'"), "ui.ps1: a repo candidate is accepted only when it really holds scripts\\workspace.mjs");
check(ps1.includes("setx C64RE_REPO"), "ui.ps1: a missing repo tells the user the exact setx command, not just a path");

// ---------------------------------------------------------------- line endings

check(!sh.includes("\r\n") && sh.startsWith("#!/usr/bin/env bash"), "ui.sh: LF only, with the shebang");
for (const n of ["ui.ps1", "ui-start.cmd", "ui-stop.cmd", "ui-restart.cmd"]) {
  const text = read(n);
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length;
  check(text.includes("\r\n") && lf === 0, `${n}: CRLF throughout (${text.split("\r\n").length - 1} lines, ${lf} bare LF)`);
}

// ---------------------------------------------------------------- the shims

for (const action of ["start", "stop", "restart"]) {
  const text = read(`ui-${action}.cmd`);
  check(text.includes("-ExecutionPolicy Bypass") && text.includes("-NoProfile") && text.includes(`"%~dp0ui.ps1" ${action}`),
    `ui-${action}.cmd: powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ui.ps1" ${action}`);
  check(text.includes("if errorlevel 1 pause"), `ui-${action}.cmd: pauses on error so a double-click shows what broke`);
}
check(startCmd.startsWith("@echo off"), "the shims start with @echo off");
for (const n of ["ui-start.cmd", "ui-stop.cmd", "ui-restart.cmd"]) {
  // a .cmd is read in the console's OEM codepage — anything above 7-bit is a guess
  const nonAscii = [...read(n)].filter((c) => c.charCodeAt(0) > 126);
  check(nonAscii.length === 0, `${n}: pure ASCII (OEM codepage)${nonAscii.length ? ` — found ${JSON.stringify(nonAscii.join(""))}` : ""}`);
}
// Windows PowerShell 5.1 reads a BOM-less file in the ANSI codepage.
const ps1Raw = readFileSync(join(projectDir, "ui.ps1"));
check(ps1Raw[0] === 0xef && ps1Raw[1] === 0xbb && ps1Raw[2] === 0xbf, "ui.ps1: starts with a UTF-8 BOM (5.1 reads a BOM-less file as ANSI)");
check(readFileSync(join(posixProject, "ui.sh"))[0] !== 0xef, "ui.sh: no BOM (a shebang must be the first two bytes)");

// ---------------------------------------------------------------- Windows PowerShell 5.1 only

const ps7Only = [
  [/\?\?/, "null-coalescing ?? (PS7)"],
  [/\)\s*\?\s*[^:\n]+\s*:\s/, "ternary ?: (PS7)"],
  [/\|\s*ForEach-Object\s+-Parallel/, "ForEach-Object -Parallel (PS7)"],
  [/Get-Content[^\n]*-AsByteStream/, "-AsByteStream (PS7)"],
];
for (const [re, what] of ps7Only) check(!re.test(ps1), `ui.ps1: no ${what}`);
check(ps1.replace("\uFEFF", "").startsWith("#Requires -Version 5.1") && ps1.includes("#Requires -Version 5.1"), "ui.ps1: #Requires -Version 5.1 is the first line after the BOM");
check(!/`\r?\n/.test(ps1), "ui.ps1: no backtick line continuations (they do not survive a copy-paste)");

// ---------------------------------------------------------------- behaviour the script must have

const must = [
  ["Get-NetTCPConnection", "finds the port owner with Get-NetTCPConnection"],
  ["if (Get-Command 'Get-NetTCPConnection'", "asks whether the cmdlet exists instead of catching (a throw inside a catch is not caught)"],
  ["netstat -ano", "falls back to netstat when the cmdlet is missing"],
  ["taskkill.exe /PID $TargetPid /T /F", "kills the process TREE (a parent kill leaves children listening on Windows)"],
  ["cmd.exe", "starts the workspace through cmd.exe (this platform's nohup)"],
  ["> \"' + $LOG + '\" 2>&1", "both streams into ONE log, like ui.sh"],
  ["Start-Process @startArgs", "starts the workspace hidden, via splatting"],
  ["Start-Process ('http://localhost:' + $HTTP_PORT)", "opens the browser once the port answers"],
  ["$proc.HasExited", "reports an early exit with the log tail instead of waiting 90 s"],
  ["Set-Content -Path $PIDFILE", "writes the pid file"],
  ["node:sqlite", "names the Node 22 requirement in its own error text"],
];
for (const [needle, what] of must) check(ps1.includes(needle), `ui.ps1: ${what}`);
check(ps1.includes(`$argLine = '/c "' + $inner + '"'`),
  "ui.ps1: ONE pre-quoted argument line (the only form Start-Process passes through on 5.1)");
// comments explain both traps, so test the CODE lines only
const ps1Code = ps1.split("\r\n").filter((l) => !l.trim().startsWith("#")).join("\n");
// The parameter-set rule that bit the first draft: -WindowStyle belongs to
// Start-Process's UseShellExecute set, -RedirectStandard* to the default set.
// Combining them throws "Parameter set cannot be resolved" at the user.
const startBlock = ps1.slice(ps1.indexOf("$startArgs = @{"), ps1.indexOf("$proc = Start-Process"));
check(!/^\s*(?!#)[^\n]*RedirectStandard/m.test(ps1Code), "ui.ps1: no -RedirectStandard* in the code at all (cmd.exe does the redirect)");
check(startBlock.includes("WindowStyle") && !/RedirectStandard/.test(startBlock),
  "ui.ps1: -WindowStyle is never combined with -RedirectStandard* (different Start-Process parameter sets)");
check(!ps1Code.includes("-NoNewWindow"),
  "ui.ps1: no -NoNewWindow in the code (it would kill the workspace when the double-click console closes)");
check(/\$inner\s+= '"' \+ \$node\.Source \+ '"/.test(ps1),
  "ui.ps1: node is invoked by its resolved absolute path, not by name inside cmd");
check(/\[ValidateSet\('start', 'stop', 'restart', 'status', 'build-ui', 'logs'\)\]/.test(ps1),
  "ui.ps1: the same six actions as ui.sh, validated by the parameter");
for (const verb of ["start", "stop", "restart", "status", "build-ui", "logs"]) {
  check(sh.includes(`  ${verb})`) || sh.includes(`${verb})`), `ui.sh still has ${verb}`);
}

// ---------------------------------------------------------------- real parsers

const bash = spawnSync("bash", ["-n", join(posixProject, "ui.sh")], { encoding: "utf8" });
check(bash.status === 0, `bash -n ui.sh (${bash.stderr.trim() || "clean"})`);

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
if (pwsh.status === 0) {
  const script = `$errs = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${join(projectDir, "ui.ps1").replace(/'/g, "''")}', [ref]$tokens, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { $_.ToString() }; exit 1 }; exit 0`;
  const parsed = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  check(parsed.status === 0, `PowerShell parser accepts ui.ps1 (pwsh ${pwsh.stdout.trim()})${parsed.status === 0 ? "" : `\n        ${parsed.stdout.trim()}`}`);
  // …and then actually RUN the one action that is safe off-Windows. `status`
  // exercises the parameter binding, the switch and Get-PortOwner's fallback;
  // on a machine without Get-NetTCPConnection it must answer "down", not throw.
  const ran = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(projectDir, "ui.ps1"), "status"], { encoding: "utf8" });
  const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  check(ran.status === 0 && /:4310 (UP|down)/.test(out) && /:4312 (UP|down)/.test(out) && !/Exception|ParameterBindingException|is not recognized/i.test(out),
    `pwsh runs 'ui.ps1 status' end to end (${out.trim().split("\n").join(" | ") || "no output"})`);
  const bad = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(projectDir, "ui.ps1"), "frobnicate"], { encoding: "utf8" });
  check(bad.status !== 0, "an unknown action is refused by the ValidateSet, not silently started");

  // Get-Repo, for real: `build-ui` is the one action that needs the repo and
  // nothing Windows-only, so it proves the whole resolution chain on any OS.
  const psRun = (args, env) => spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(projectDir, "ui.ps1"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const missing = psRun(["build-ui"], { C64RE_REPO: join(project, "nowhere") });
  check(missing.status !== 0 && /setx C64RE_REPO/.test(`${missing.stdout}${missing.stderr}`),
    "no repo anywhere → it fails with the setx recipe (the baked path is dead on the other machine)");

  const fakeRepo = join(project, "fake-repo");
  mkdirSync(join(fakeRepo, "scripts"), { recursive: true });
  writeFileSync(join(fakeRepo, "scripts", "workspace.mjs"), "// marker\n");
  writeFileSync(join(fakeRepo, "package.json"), JSON.stringify({ name: "fake", scripts: { "ui:build": "node -e \"console.log('vite build ran')\"" } }, null, 2));
  const built = psRun(["build-ui"], { C64RE_REPO: fakeRepo });
  const builtOut = `${built.stdout}${built.stderr}`;
  check(built.status === 0 && builtOut.includes("vite build ran") && builtOut.includes("ui/dist rebuilt"),
    "C64RE_REPO → Get-Repo finds it, npm runs in it, and the script reports the rebuild");
} else {
  console.log("  skip  PowerShell parser + run: pwsh not installed here — loudly skipped, not passed");
  console.log("  skip  install it without sudo: dotnet tool install --global PowerShell (or brew install --cask powershell)");
}

// ── per platform: exactly its set, and nothing else ───────────────────────────
console.log("\nPer platform");
const SETS = {
  linux: ["ui.sh", "ui-start.desktop", "ui-stop.desktop", "ui-restart.desktop"],
  macos: ["ui.sh", "ui-start.command", "ui-stop.command", "ui-restart.command"],
  windows: ["ui.ps1", "ui-start.cmd", "ui-stop.cmd", "ui-restart.cmd"],
};
const listDir = (d) => readdirSync(d).sort();
for (const [platform, want] of Object.entries(SETS)) {
  const dir = join(project, `set-${platform}`);
  mkdirSync(dir, { recursive: true });
  const r = ensureUiLaunchers(dir, repoDir, { platform });
  check(JSON.stringify(listDir(dir)) === JSON.stringify([...want].sort()) && r.files.length === want.length,
    `${platform}: writes exactly ${want.join(", ")} and nothing else`);
  // no-refresh keeps a hand edit, refresh rewrites it
  const target = join(dir, want[1]);
  const original = readFileSync(target, "utf8");
  writeFileSync(target, "# hand edit\n");
  ensureUiLaunchers(dir, repoDir, { platform });
  check(readFileSync(target, "utf8") === "# hand edit\n", `${platform}: no refresh keeps a hand edit in ${want[1]}`);
  ensureUiLaunchers(dir, repoDir, { platform, refresh: true });
  check(readFileSync(target, "utf8") === original, `${platform}: refresh rewrites ${want[1]}`);
}

// ── the Linux .desktop files ──────────────────────────────────────────────────
{
  const dir = join(project, "set-linux");
  const files = [];
  for (const action of ["start", "stop", "restart"]) {
    const f = join(dir, `ui-${action}.desktop`);
    files.push(f);
    const t = readFileSync(f, "utf8");
    check(t.includes(`Path=${dir}\n`) && dir.startsWith("/"), `ui-${action}.desktop: Path= is the absolute project dir`);
    check(t.includes("Type=Application") && t.includes("Terminal=true") && t.includes("Icon=utilities-terminal"), `ui-${action}.desktop: Type=Application, Terminal=true, Icon=utilities-terminal`);
    const open = action === "stop" ? "" : " --open";
    check(t.includes(`Exec=bash -c "./ui.sh ${action}${open}; read -rp 'Press Enter to close'"`), `ui-${action}.desktop: Exec runs ui.sh ${action}${open} and waits for Enter`);
    check((statSync(f).mode & 0o111) === 0o111, `ui-${action}.desktop: executable`);
  }
  const dfv = spawnSync("desktop-file-validate", files, { encoding: "utf8" });
  if (dfv.error) console.log("  skip  desktop-file-validate: not installed here — loudly skipped, not passed");
  else check(dfv.status === 0, `desktop-file-validate accepts the .desktop files (${(dfv.stdout + dfv.stderr).trim() || "clean"})`);

  const mdir = join(project, "set-macos");
  for (const action of ["start", "stop", "restart"]) {
    const f = join(mdir, `ui-${action}.command`);
    const t = readFileSync(f, "utf8");
    const open = action === "stop" ? "" : " --open";
    check(t === `#!/bin/bash\ncd "$(dirname "$0")" || exit 1\n./ui.sh ${action}${open}\n` && (statSync(f).mode & 0o111) === 0o111,
      `ui-${action}.command: bash, cd to its own folder, ./ui.sh ${action}${open}, executable`);
    check(spawnSync("bash", ["-n", f]).status === 0, `ui-${action}.command: bash -n clean`);
  }
}

// ── ui.sh start --open, against a stub opener and a stand-in workspace ────────
{
  const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const httpPort = await freePort();
  const wsPort = await freePort();
  const work = join(project, "open-test");
  const fakeRepo = join(work, "repo");
  const proj = join(work, "proj");
  const bin = join(work, "bin");
  for (const d of [join(fakeRepo, "scripts"), proj, bin]) mkdirSync(d, { recursive: true });
  // the stand-in workspace: listens on the port ui.sh waits for, after a short delay
  writeFileSync(join(fakeRepo, "scripts", "workspace.mjs"), `setTimeout(() => import("node:http").then((h) => h.createServer((q, r) => r.end("ok")).listen(${httpPort}, "127.0.0.1")), 1500);\n`);
  writeFileSync(join(fakeRepo, "package.json"), JSON.stringify({ name: "fake", scripts: { workspace: "node scripts/workspace.mjs" } }));
  const record = join(work, "opened.txt");
  for (const opener of ["xdg-open", "open"]) {
    writeFileSync(join(bin, opener), `#!/bin/sh\necho "$1" >> "${record}"\n`);
    chmodSync(join(bin, opener), 0o755);
  }
  ensureUiLaunchers(proj, fakeRepo, { platform: "linux" });
  // ui.sh bakes 4310/4312; the test must not touch the real ports
  const script = readFileSync(join(proj, "ui.sh"), "utf8").replace("HTTP_PORT=4310", `HTTP_PORT=${httpPort}`).replace("WS_PORT=4312", `WS_PORT=${wsPort}`);
  check(script.includes(`HTTP_PORT=${httpPort}`), "test setup: ui.sh port substituted");
  writeFileSync(join(proj, "ui.sh"), script);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (...args) => spawnSync("bash", [join(proj, "ui.sh"), ...args], { encoding: "utf8", env, cwd: proj, timeout: 60000 });
  // Probe from a child process: `lsof -ti:PORT` (what ui.sh's stop uses) also lists a
  // client holding a connection to the port, and this smoke must not be killed by it.
  const upNow = () => spawnSync("curl", ["-s", "-o", "/dev/null", "--max-time", "1", `http://127.0.0.1:${httpPort}/`]).status === 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const noOpen = run("start");
    check(noOpen.status === 0 && !existsSync(record), "ui.sh start without --open opens nothing");
    // let the stand-in come up, then stop it so the next start is a cold one
    for (let i = 0; i < 40 && !upNow(); i++) await wait(250);
    run("stop");
    for (let i = 0; i < 20; i++) { if (!upNow()) break; await wait(250); }
    const opened = run("start", "--open");
    await wait(500);
    const calls = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [];
    check(opened.status === 0 && calls.length === 1 && calls[0] === `http://localhost:${httpPort}`,
      `ui.sh start --open waits for the port, then opens http://localhost:${httpPort} once (${calls.join(",") || "never opened"})`);
    // already running: must return, not exit, so --open still opens the browser
    const again = run("start", "--open");
    await wait(500);
    const calls2 = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [];
    check(again.status === 0 && /already running/.test(again.stdout) && calls2.length === 2,
      `start --open on a running UI still opens the browser (${calls2.length} opens in total)`);
  } finally {
    run("stop");
  }
  // a workspace that dies while we wait: tail the log, exit non-zero
  const deadRepo = join(work, "dead-repo");
  mkdirSync(join(deadRepo, "scripts"), { recursive: true });
  writeFileSync(join(deadRepo, "scripts", "workspace.mjs"), `console.log("boom from the workspace"); process.exit(3);\n`);
  writeFileSync(join(deadRepo, "package.json"), JSON.stringify({ name: "dead", scripts: { workspace: "node scripts/workspace.mjs" } }));
  const deadProj = join(work, "dead-proj");
  mkdirSync(deadProj, { recursive: true });
  ensureUiLaunchers(deadProj, deadRepo, { platform: "linux" });
  const deadPort = await freePort();
  writeFileSync(join(deadProj, "ui.sh"), readFileSync(join(deadProj, "ui.sh"), "utf8").replace("HTTP_PORT=4310", `HTTP_PORT=${deadPort}`).replace("WS_PORT=4312", `WS_PORT=${await freePort()}`));
  const dead = spawnSync("bash", [join(deadProj, "ui.sh"), "start", "--open"], { encoding: "utf8", env, cwd: deadProj, timeout: 60000 });
  check(dead.status !== 0 && /boom from the workspace/.test(dead.stdout) && /exited/.test(dead.stdout),
    "a workspace that exits while waited on: log tail shown, exit non-zero");
}

// ── project_init writes no starter; project_launchers does ────────────────────
{
  const handlers = new Map();
  const fakeServer = { tool: (name, _desc, _schema, handler) => handlers.set(name, handler) };
  const { registerProjectKnowledgeTools } = await import(join(ROOT, "dist/project-knowledge/mcp-tools.js"));
  registerProjectKnowledgeTools(fakeServer, { repoDir: ROOT });
  const dir = join(project, "init-test");
  mkdirSync(dir, { recursive: true });
  const text = (r) => r.content.map((c) => c.text).join("\n");
  const init = text(await handlers.get("project_init")({ project_dir: dir, name: "smoke" }));
  const starters = readdirSync(dir).filter((n) => /^ui[.-]/.test(n));
  check(!init.includes("Tool Error") && starters.length === 0, `project_init writes no starter (${starters.join(", ") || "none"})`);
  check(init.includes("project_launchers"), "project_init names project_launchers in its answer");
  const ans = text(await handlers.get("project_launchers")({ project_dir: dir, platform: "linux" }));
  check(JSON.stringify(readdirSync(dir).filter((n) => /^ui[.-]/.test(n)).sort()) === JSON.stringify([...SETS.linux].sort()), "project_launchers {platform: linux} writes the linux set");
  check(ans.includes("absolute path") && ans.includes("refresh"), "its linux answer says the .desktop files hold the absolute path and how to regenerate");
  const ans2 = text(await handlers.get("project_launchers")({ project_dir: dir, platform: "linux" }));
  check(/Written: \(none\)/.test(ans2), "a second call writes nothing and says what it kept");
}

// ── the PACKAGED variant ──────────────────────────────────────────────────────
//
// Spec 716. The launchers above are the checkout's. An installed package has no
// scripts/workspace.mjs and no TypeScript, so `npm run workspace` cannot run there — 0.1.1
// shipped exactly that and the workbench could not be started. A package is recognised
// positively: the built orchestrator present, the source entry absent.
{
  const pkgProject = join(tmpdir(), `c64re-launcher-pkg-${process.pid}`);
  const pkgRoot = join(pkgProject, "node_modules", "@trex64", "c64re");
  mkdirSync(join(pkgRoot, "dist", "workspace-ui"), { recursive: true });
  writeFileSync(join(pkgRoot, "dist", "workspace-ui", "launch.js"), "// built orchestrator\n");

  mkdirSync(pkgProject, { recursive: true });
  const r = ensureUiLaunchers(pkgProject, pkgRoot, { platform: "windows" });
  ensureUiLaunchers(pkgProject, pkgRoot, { platform: "macos" });
  const sh = readFileSync(join(pkgProject, "ui.sh"), "utf8");
  const ps = readFileSync(join(pkgProject, "ui.ps1"), "utf8");

  check(r.files.length > 0, "packaged: the launchers are written");
  check(!/npm run workspace/.test(sh), "packaged ui.sh: does not run `npm run workspace`");
  check(!/npm run workspace/.test(ps), "packaged ui.ps1: does not run `npm run workspace`");
  check(/\$C64RE ui --project/.test(sh), "packaged ui.sh: starts the workbench through the package");
  check(/command -v c64re/.test(sh) && sh.includes("@trex64/c64re"),
    "packaged ui.sh: prefers a c64re on PATH, else npx by NAME");
  check(!sh.includes(pkgRoot) && !ps.includes(pkgRoot),
    "packaged: no path into the package is baked — the npx cache moves");
  check(/\$C64RE_PKG = '@trex64\/c64re'/.test(ps), "packaged ui.ps1: carries the package name, not a path");
  check(/nothing to rebuild/.test(sh) && /nothing to rebuild/.test(ps),
    "packaged: build-ui says the bundle already shipped");
  rmSync(pkgProject, { recursive: true, force: true });
}

console.log(`\n${failCount ? "RED" : "GREEN"}  UI launchers: ${pass} pass, ${failCount} fail.  project: ${projectDir}`);
process.exit(failCount ? 1 : 0);
