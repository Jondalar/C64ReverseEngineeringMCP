// Spec 893 — the project you name is the project you get, and every project is in git.
//
// Every case spawns its own MCP server (dist/cli.js) over stdio with an explicit
// environment, in temp directories only. No runtime daemon is started
// (C64RE_RUNTIME_AUTOSTART=0, no endpoint) and nothing touches :4312.
//
//   1  env = A, project_dir = B  -> contract_set writes B; A's contract.json is byte-identical
//   2  project_dir = a directory with no project -> refused, A untouched
//   3  env = A, a file inside B, no project_dir -> refused, both roots named
//   4  env = A, a file outside every project -> A, as before
//   5  agent_onboard(project_dir=B) onboards B; a B call is gated on B (and A is not B)
//   6  project_init, no git on PATH -> refused, first line exact, nothing written
//   7  project_init, fresh directory -> a repository with one commit and a .gitignore;
//      inside an existing repository -> no nested repository; no identity -> repo kept,
//      the git config lines named
//   8  agent_onboard on a project outside a work tree -> first line exact, git not run;
//      no git -> refused; uncommitted knowledge/ files -> one counted line
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));

const LINE = "PLEASE USE GIT TO AVOID LOSS OF DATA!";
let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${String(d).replace(/\s+/g, " ").slice(0, 200)})` : ""}`); };

const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "c64re-893-")));
const scratch = (name) => { const d = join(base, name); mkdirSync(d, { recursive: true }); return d; };

// The environment of every spawned process: nothing of the caller's C64RE_* or repository
// selection (a pre-push hook sets GIT_DIR), an identity from env only, never global config.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("C64RE_") || /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX|NAMESPACE)$/.test(k)) delete env[k];
  return {
    ...env,
    GIT_AUTHOR_NAME: "c64re smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "c64re smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    C64RE_RUNTIME_AUTOSTART: "0",
    ...extra,
  };
}
const git = (cwd, args) => spawnSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8" });
const commitCount = (dir) => { const r = git(dir, ["rev-list", "--count", "HEAD"]); return r.status === 0 ? Number(r.stdout.trim()) : 0; };

/** A project the way the store makes it, without any git. */
function makeProject(name) {
  const dir = scratch(name);
  new ProjectKnowledgeService(dir).initProject({ name });
  return dir;
}
const gitCommitAll = (dir) => { git(dir, ["init"]); git(dir, ["add", "-A"]); git(dir, ["commit", "-m", "base"]); };

async function session(env, fn) {
  const mcp = spawn(process.execPath, [cli], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pend = new Map(); let n = 1;
  mcp.stdout.on("data", (b) => { buf += b; let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  const call = (method, params) => new Promise((res, rej) => {
    const id = n++; const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout: ${method}`)); }, 90000);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const m = await call("tools/call", { name, arguments: args });
    if (m.error) return `[rpc error] ${m.error.message}`;
    return (m.result?.content ?? []).map((c) => c.text).join("\n");
  };
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-893", version: "1" } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await fn(tool);
  } finally {
    mcp.kill("SIGKILL");
  }
}

const GOAL = "Smoke goal: prove which project a call writes to.";
const contractPath = (dir) => join(dir, "knowledge", "contract.json");

console.log("Spec 893 — the named project, and git\n");
try {
  const A = makeProject("A"), B = makeProject("B"), C = scratch("C-not-a-project");
  gitCommitAll(A); gitCommitAll(B);
  const envA = cleanEnv({ C64RE_PROJECT_DIR: A });

  // ── 1, 2, 5 — one server, env = A ─────────────────────────────────────────────────
  await session(envA, async (tool) => {
    await tool("agent_onboard", {});
    const wroteA = await tool("contract_set", { goal: `${GOAL} (A)` });
    check(existsSync(contractPath(A)) && wroteA.includes(contractPath(A)), "0 baseline: contract_set with no project_dir writes the env project A", wroteA.split("\n").pop());
    const aBefore = readFileSync(contractPath(A));

    // 5 — the gate on a B call asks for B, not for A
    const gated = await tool("contract_set", { project_dir: B, goal: `${GOAL} (B)` });
    check(/not onboarded into/.test(gated) && gated.includes(`agent_onboard(project_dir="${B}")`) && !existsSync(contractPath(B)),
      "5a a call naming B is gated on B (asks for agent_onboard on B) and writes nothing", gated.split("\n").slice(0, 3).join(" | "));
    check(!gated.includes(`agent_onboard(project_dir="${A}")`), "5b the gate does not ask for the env project", "");

    const onboardB = await tool("agent_onboard", { project_dir: B });
    check(onboardB.includes(B) && !onboardB.includes(`Root: ${A}`) && !/^# c64re error/.test(onboardB),
      "5c agent_onboard(project_dir=B) onboards B (B's paths in the answer)", onboardB.split("\n").slice(0, 3).join(" | "));

    // 1 — env A, project_dir B: B is written, A is not
    const wroteB = await tool("contract_set", { project_dir: B, goal: `${GOAL} (B)` });
    check(existsSync(contractPath(B)) && wroteB.includes(contractPath(B)) && wroteB.includes(`Project: ${B}`),
      "1a contract_set(project_dir=B) with env=A writes B's contract.json and names B", wroteB.split("\n").slice(-3).join(" | "));
    check(Buffer.compare(aBefore, readFileSync(contractPath(A))) === 0, "1b A's contract.json is byte-identical before and after");

    // 2 — a directory that is no project
    const refused = await tool("contract_set", { project_dir: C, goal: `${GOAL} (C)` });
    check(refused.includes(C) && /project_init|No project marker/.test(refused) && !existsSync(join(C, "knowledge")),
      "2a project_dir with no project marker is refused, naming the directory, and writes nothing", refused);
    check(Buffer.compare(aBefore, readFileSync(contractPath(A))) === 0 && !refused.includes(contractPath(A)), "2b it did not fall back to A: A is untouched");

    // 3 — a file inside B with env = A and no project_dir
    const inB = join(B, "notes-in-b.txt"); writeFileSync(inB, "belongs to B\n");
    const crossed = await tool("read_artifact", { path: inB });
    check(/refuses/.test(crossed) && crossed.includes(A) && crossed.includes(B) && !crossed.includes("belongs to B"),
      "3 a file inside B with env=A and no project_dir is refused, both roots named", crossed);

    // 4 — a file outside every project
    const outside = join(scratch("outside"), "input.txt"); writeFileSync(outside, "plain input\n");
    const fine = await tool("read_artifact", { path: outside });
    check(fine.includes("plain input"), "4 a file outside any project is read through A, as before", fine);
    const inRepo = await tool("read_artifact", { path: join(ROOT, "package.json") });
    check(inRepo.includes('"name"') && !/refuses/.test(inRepo), "4b a file inside the MCP repo (samples, fixtures) is not another project's file", inRepo.slice(0, 80));
  });

  // ── 6 — no git on PATH ────────────────────────────────────────────────────────────
  const noGitPath = scratch("empty-path");
  const noGitEnv = cleanEnv({ PATH: noGitPath, C64RE_PROJECT_DIR: A });
  const probe = spawnSync("git", ["--version"], { env: noGitEnv });
  check(probe.error?.code === "ENOENT", "6 baseline: the stripped PATH really has no git", probe.error?.code ?? probe.status);
  {
    const fresh = scratch("fresh-no-git");
    await session(noGitEnv, async (tool) => {
      const out = await tool("project_init", { project_dir: fresh, name: "NoGit" });
      check(out.split("\n")[0] === LINE, "6a project_init without git: the first line is exactly the warning", out.split("\n")[0]);
      check(/winget install Git\.Git/.test(out) && /xcode-select --install/.test(out) && /apt install git/.test(out) && /project_init|again/.test(out),
        "6b … and carries install hints for Windows, macOS and Linux", "");
      check(readdirSync(fresh).length === 0, "6c … and nothing was written", readdirSync(fresh).join(","));
    });
  }

  // ── 7 — project_init and git ──────────────────────────────────────────────────────
  {
    const fresh = join(base, "fresh-init");
    await session(envA, async (tool) => {
      const out = await tool("project_init", { project_dir: fresh, name: "Fresh" });
      check(out.split("\n").slice(0, 3).some((l) => /^Git: repository created/.test(l) && /committed/.test(l)), "7a a fresh directory: the answer says so on its first lines", out.split("\n").slice(0, 3).join(" | "));
      check(existsSync(join(fresh, ".git")) && commitCount(fresh) === 1, "7b … a repository with exactly one commit", `commits=${commitCount(fresh)}`);
      const log = git(fresh, ["log", "-1", "--format=%s"]).stdout.trim();
      check(log === "c64re: project_init Fresh", "7c … the commit is the scaffold's", log);
      const ig = existsSync(join(fresh, ".gitignore")) ? readFileSync(join(fresh, ".gitignore"), "utf8") : "";
      check(/ui-\*\.desktop/.test(ig) && /\*\.duckdb/.test(ig) && /knowledge\/\.cache\//.test(ig) && /ui\.log/.test(ig) && !/^knowledge\/?$/m.test(ig),
        "7d … a .gitignore that leaves out launchers, traces and caches but not knowledge/", "");
      const tracked = git(fresh, ["ls-files"]).stdout;
      check(tracked.includes("knowledge/phase-plan.json") && tracked.includes(".gitignore"), "7e … knowledge/ and .gitignore are tracked", "");
      check(git(fresh, ["status", "--porcelain"]).stdout.trim() === "", "7f … and the tree is clean after the commit", git(fresh, ["status", "--porcelain"]).stdout);
      const again = await tool("project_init", { project_dir: fresh, name: "Fresh" });
      check(commitCount(fresh) === 1 && /inside the repository/.test(again), "7g running it again leaves git alone (still one commit)", again.split("\n").slice(0, 2).join(" | "));
    });

    // inside an existing repository: no nested repo
    const outer = scratch("outer-repo");
    writeFileSync(join(outer, "README.txt"), "an existing repo\n");
    gitCommitAll(outer);
    const inner = join(outer, "game");
    await session(envA, async (tool) => {
      const out = await tool("project_init", { project_dir: inner, name: "Inner" });
      check(existsSync(join(inner, "knowledge", "phase-plan.json")) && !existsSync(join(inner, ".git")), "7h inside an existing repository: the project is created and no nested repository", "");
      check(commitCount(outer) === 1 && out.includes(outer), "7i … the outer repository gets no commit and is named in the answer", out.split("\n").slice(0, 3).join(" | "));
    });

    // no identity: the repo stays, the lines are named, no identity is invented
    const noId = scratch("no-identity-home");
    const envNoId = cleanEnv({
      HOME: noId, USERPROFILE: noId, XDG_CONFIG_HOME: join(noId, "xdg"), GIT_CONFIG_GLOBAL: join(noId, "none"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true",
    });
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete envNoId[k];
    const noIdDir = join(base, "no-identity");
    await session(envNoId, async (tool) => {
      const out = await tool("project_init", { project_dir: noIdDir, name: "NoId" });
      check(existsSync(join(noIdDir, ".git")) && existsSync(join(noIdDir, "knowledge", "phase-plan.json")) && commitCount(noIdDir) === 0,
        "7j no git identity: the project and the repository exist, nothing is committed", `commits=${commitCount(noIdDir)}`);
      check(/NOT committed/.test(out) && /git config --global user\.name/.test(out) && /git config --global user\.email/.test(out) && /commit -m/.test(out),
        "7k … and the answer names the git config lines and the commit to run", out.split("\n").slice(0, 8).join(" | "));
      const cfg = spawnSync("git", ["config", "--global", "--get", "user.name"], { env: envNoId, encoding: "utf8" });
      check(cfg.status !== 0, "7l … and no identity was invented", cfg.stdout);
    });
  }

  // ── 8 — agent_onboard and git ─────────────────────────────────────────────────────
  {
    const bare = makeProject("no-repo-project");
    await session(cleanEnv({ C64RE_PROJECT_DIR: bare }), async (tool) => {
      const out = await tool("agent_onboard", {});
      check(out.split("\n")[0] === LINE, "8a a project outside a work tree: the first line is exactly the warning", out.split("\n")[0]);
      check(/git -C ".*" init && git -C ".*" add -A && git -C ".*" commit -m/.test(out.split("\n").slice(0, 4).join("\n")), "8b … followed by the one fixing command", out.split("\n")[1]);
      check(/# Agent Onboarding/.test(out) && !existsSync(join(bare, ".git")), "8c … onboarding proceeds and does not run git itself", "");
    });

    await session(noGitEnv, async (tool) => {
      const out = await tool("agent_onboard", { project_dir: bare });
      check(out.split("\n")[0] === LINE && !/# Agent Onboarding/.test(out), "8d no git on PATH: agent_onboard is refused with the same first line", out.split("\n")[0]);
      const before = readFileSync(join(bare, "knowledge", "steering.md"), "utf8").length;
      check(before > 0 && !existsSync(join(bare, ".git")), "8e … and it wrote nothing", "");
    });

    const repoProject = join(base, "repo-project");
    await session(envA, async (tool) => {
      await tool("project_init", { project_dir: repoProject, name: "Repo" });
    });
    await session(cleanEnv({ C64RE_PROJECT_DIR: repoProject }), async (tool) => {
      const clean = await tool("agent_onboard", {});
      check(!/^Git:/m.test(clean) && clean.split("\n")[0] === "# Agent Onboarding", "8f a committed project: no git line at all", clean.split("\n").slice(0, 2).join(" | "));
    });
    // onboarding itself writes session state under knowledge/: commit it, so the count below is only what is added next
    git(repoProject, ["add", "-A"]); git(repoProject, ["commit", "-m", "after first onboarding"]);
    appendFileSync(join(repoProject, "knowledge", "notes.md"), "a note nobody committed\n");
    writeFileSync(join(repoProject, "knowledge", "extra.md"), "another one\n");
    await session(cleanEnv({ C64RE_PROJECT_DIR: repoProject }), async (tool) => {
      const out = await tool("agent_onboard", {});
      check(/^Git: 2 file\(s\) under knowledge\/ are not committed/m.test(out) && !out.startsWith(LINE), "8g uncommitted files under knowledge/: one line with the count, not a refusal", (/^Git:.*$/m.exec(out) ?? [out.slice(0, 120)])[0]);
    });
  }
} catch (e) {
  fail++; console.log(`  FAIL  harness threw: ${e?.stack ?? e}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
