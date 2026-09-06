#!/usr/bin/env node
// The workspace launchers project_init drops into a project root: `ui.sh` for
// macOS/Linux and `ui.ps1` + the three double-click `.cmd` shims for Windows.
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

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { ensureUiLauncher } = await import(join(ROOT, "dist/project-knowledge/ui-launcher.js"));

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

const r1 = ensureUiLauncher(projectDir, repoDir);
const names = r1.files.map((f) => f.path.replace(`${projectDir}/`, ""));
info(`created: ${names.join(", ")}`);

const WANT = ["ui.sh", "ui.ps1", "ui-start.cmd", "ui-stop.cmd", "ui-restart.cmd"];
check(WANT.every((n) => names.includes(n)), `all five launchers written (${WANT.join(", ")})`);
check(r1.files.every((f) => f.created && existsSync(f.path)), "every file reported created and exists");
check(r1.created === true && r1.path.endsWith("ui.sh"), "the legacy result fields still name ui.sh (callers that predate the Windows set)");

const read = (n) => readFileSync(join(projectDir, n), "utf8");
const sh = read("ui.sh");
const ps1 = read("ui.ps1");
const startCmd = read("ui-start.cmd");

// ---------------------------------------------------------------- idempotence

writeFileSync(join(projectDir, "ui.ps1"), "# hand-edited\n");
const r2 = ensureUiLauncher(projectDir, repoDir);
check(r2.files.every((f) => !f.created), "second run creates nothing");
check(read("ui.ps1") === "# hand-edited\n", "a hand-edited ui.ps1 is NOT overwritten");
writeFileSync(join(projectDir, "ui.ps1"), ps1); // put it back for the parser check

// ---------------------------------------------------------------- quoting

check(sh.includes(`PROJECT='${projectDir.replace(/'/g, `'\\''`)}'`), "ui.sh: the project path is POSIX single-quoted (apostrophe escaped)");
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

// ---------------------------------------------------------------- Windows PowerShell 5.1 only

const ps7Only = [
  [/\?\?/, "null-coalescing ?? (PS7)"],
  [/\)\s*\?\s*[^:\n]+\s*:\s/, "ternary ?: (PS7)"],
  [/\|\s*ForEach-Object\s+-Parallel/, "ForEach-Object -Parallel (PS7)"],
  [/Get-Content[^\n]*-AsByteStream/, "-AsByteStream (PS7)"],
];
for (const [re, what] of ps7Only) check(!re.test(ps1), `ui.ps1: no ${what}`);
check(ps1.includes("#Requires -Version 5.1"), "ui.ps1: declares #Requires -Version 5.1");
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

const bash = spawnSync("bash", ["-n", join(projectDir, "ui.sh")], { encoding: "utf8" });
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

console.log(`\n${failCount ? "RED" : "GREEN"}  UI launchers: ${pass} pass, ${failCount} fail.  project: ${projectDir}`);
process.exit(failCount ? 1 : 0);
