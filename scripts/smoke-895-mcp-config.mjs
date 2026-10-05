// Spec 895 — the host config is written by C64RE, never typed.
//
// Temp directories only. Every spawned MCP server gets C64RE_RUNTIME_AUTOSTART=0 and no
// runtime endpoint: no daemon is started and nothing touches :4312.
//
//   1  project_init in a fresh dir writes a .mcp.json that parses, names the project
//      absolutely, reproduces THIS server's command/args, is git-ignored and not committed;
//      an existing one is left alone (byte-identical)
//   2  a Windows-style path with backslashes, \t and \n round-trips byte-exact (unit)
//   3  merge keeps another server and unknown keys; an unparsable file is refused,
//      untouched, and the error names line and column (unit and CLI)
//   4  `c64re mcp-config --print` prints valid JSON and writes nothing; without --print it writes
//   5  the check reports a broken file, a foreign C64RE_PROJECT_DIR, a missing command and a
//      missing path; project_status and agent_onboard carry it
//   6  describeLaunch: package install -> npx; checkout run from TypeScript keeps the loader flags
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const M = await import(join(ROOT, "dist/project-knowledge/mcp-config.js"));

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${String(d).replace(/\s+/g, " ").slice(0, 240)})` : ""}`); };

const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "c64re-895-")));
const scratch = (name) => { const d = join(base, name); mkdirSync(d, { recursive: true }); return d; };

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
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-895", version: "1" } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await fn(tool);
  } finally {
    mcp.kill("SIGKILL");
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const runCli = (args, env = cleanEnv()) => spawnSync(process.execPath, [cli, "mcp-config", ...args], { env, encoding: "utf8", cwd: tmpdir() });

console.log("Spec 895 — .mcp.json written by C64RE\n");
try {
  // ── 1 — project_init ──────────────────────────────────────────────────────────────
  const tools = scratch("tools-dir");
  const tass = join(base, "fake-64tass"); writeFileSync(tass, "");
  const P = join(base, "P1");
  const env1 = cleanEnv({ C64RE_PROJECT_DIR: scratch("elsewhere"), C64RE_TOOLS_DIR: tools, C64RE_64TASS_BIN: tass, C64RE_FULL_TOOLS: "1" });
  await session(env1, async (tool) => {
    const out = await tool("project_init", { project_dir: P, name: "smoke895" });
    const cfg = join(P, ".mcp.json");
    check(existsSync(cfg) && out.includes("Host config:") && out.includes(cfg) && /written/.test(out), "1a project_init says it wrote .mcp.json", out.split("\n").find((l) => l.startsWith("Host config:")));
    let parsed; try { parsed = readJson(cfg); } catch (e) { parsed = undefined; }
    check(parsed !== undefined, "1b the file parses as JSON");
    const e = parsed?.mcpServers?.["c64-re"];
    check(e?.env?.C64RE_PROJECT_DIR === P, "1c C64RE_PROJECT_DIR is the TARGET project, absolute (not the server's env project)", e?.env?.C64RE_PROJECT_DIR);
    check(e?.command === process.execPath && JSON.stringify(e?.args) === JSON.stringify([realpathSync(cli)]), "1d command/args reproduce this server's own launch (node + dist/cli.js)", JSON.stringify([e?.command, e?.args]));
    check(e?.env?.C64RE_TOOLS_DIR === tools && e?.env?.C64RE_64TASS_BIN === tass, "1e tool/binary variables of the server's environment are carried", JSON.stringify(e?.env));
    check(!("C64RE_FULL_TOOLS" in (e?.env ?? {})) && !("C64RE_RUNTIME_AUTOSTART" in (e?.env ?? {})) && !("C64RE_RUNTIME_ENDPOINT" in (e?.env ?? {})), "1f switches and transient variables are not carried", Object.keys(e?.env ?? {}).join(","));
    const text = readFileSync(cfg, "utf8");
    check(text === JSON.stringify(parsed, null, 2) + "\n", "1g serialised by JSON.stringify: 2-space indent, trailing newline");
    const ig = readFileSync(join(P, ".gitignore"), "utf8");
    check(/^\.mcp\.json$/m.test(ig), "1h the .gitignore block names .mcp.json");
    const tracked = git(P, ["ls-files"]).stdout.split("\n");
    check(git(P, ["rev-list", "--count", "HEAD"]).stdout.trim() === "1" && !tracked.includes(".mcp.json"), "1i the file is not in the scaffold commit", tracked.slice(0, 5).join(","));

    // an existing file is left alone and checked
    const mine = `{\n  "mcpServers": { "other": { "command": "x" } },\n  "keep": 1\n}\n`;
    writeFileSync(cfg, mine);
    const again = await tool("project_init", { project_dir: P, name: "smoke895" });
    check(readFileSync(cfg, "utf8") === mine && /left alone/.test(again), "1j project_init with an existing .mcp.json leaves it byte-identical and says so", again.split("\n").filter((l) => l.startsWith("Host config") || l.startsWith("WARNING")).join(" | "));
    check(/WARNING[^\n]*no "c64-re" server/.test(again), "1k ... and checks it (no c64-re entry is reported)");
  });

  // ── 2 — Windows path round trip ────────────────────────────────────────────────────
  const winProject = "C:\\Users\\te\\temp\\new\\proj";
  const winTools = "D:\\tools\\trxdis\\tab\\newline";
  const winNode = "C:\\Program Files\\nodejs\\node.exe";
  const winScript = "C:\\src\\tools\\new\\dist\\cli.js";
  const entry = M.buildServerEntry({
    projectDir: winProject,
    launch: { command: winNode, args: [winScript] },
    env: { C64RE_TOOLS_DIR: winTools, C64RE_RUNTIME_ENDPOINT: "ws://127.0.0.1:4312" },
  });
  const wtext = M.standaloneConfig(entry);
  const wback = JSON.parse(wtext)?.mcpServers?.["c64-re"];
  check(wback?.env?.C64RE_PROJECT_DIR === winProject && wback?.env?.C64RE_TOOLS_DIR === winTools && wback?.command === winNode && wback?.args?.[0] === winScript,
    "2a backslash paths with \\t and \\n sequences round-trip byte-exact through JSON.parse", JSON.stringify(wback?.env));
  check(wtext.includes('"C:\\\\Users\\\\te\\\\temp\\\\new\\\\proj"') && !/[\t]/.test(wtext), "2b the file text carries them escaped (\\\\), not as raw escapes");
  check(!("C64RE_RUNTIME_ENDPOINT" in wback.env), "2c the runtime endpoint is not carried");

  // ── 3 — merge, refusal ────────────────────────────────────────────────────────────
  const existing = JSON.stringify({ theme: { a: [1, 2] }, mcpServers: { other: { command: "o", args: ["1"] }, "c64-re": { command: "old" }, last: { url: "http://x" } }, z: null }, null, 2);
  const merged = M.mergeServerEntry(existing, entry);
  const mj = merged.ok ? JSON.parse(merged.text) : undefined;
  check(merged.ok && merged.replaced && JSON.stringify(mj.mcpServers.other) === JSON.stringify({ command: "o", args: ["1"] }) && mj.mcpServers.last.url === "http://x"
    && JSON.stringify(mj.theme) === JSON.stringify({ a: [1, 2] }) && mj.z === null && mj.mcpServers["c64-re"].command === winNode
    && Object.keys(mj.mcpServers).join() === "other,c64-re,last", "3a merge replaces only c64-re (in place); other servers and unknown keys are kept");
  const d3 = scratch("merge-file");
  writeFileSync(join(d3, ".mcp.json"), existing);
  const w = M.writeMcpConfig(d3, entry);
  check(w.kind === "updated" && M.writeMcpConfig(d3, entry).kind === "unchanged", "3b writeMcpConfig: updated, then unchanged on a repeat");

  const bad = `{\n  "mcpServers": {\n    "c64-re": { "command": "C:\\Users\\x" }\n  }\n}\n`;
  const badDir = scratch("bad-file");
  writeFileSync(join(badDir, ".mcp.json"), bad);
  // expected position computed independently: the character after the backslash in \U
  const lines = bad.split("\n");
  const wantLine = lines.findIndex((l) => l.includes("\\U")) + 1;
  const wantCol = lines[wantLine - 1].indexOf("\\U") + 2;
  const refused = M.writeMcpConfig(badDir, entry);
  check(refused.kind === "refused" && readFileSync(join(badDir, ".mcp.json"), "utf8") === bad, "3c an unparsable file is refused and left byte-identical");
  check(refused.failure?.line === wantLine && refused.failure?.column === wantCol, `3d the failure names line ${wantLine}, column ${wantCol}`, JSON.stringify(refused.failure));
  const trunc = `{\n  "a": 1,\n  "b": `;
  const tr = M.mergeServerEntry(trunc, entry);
  check(!tr.ok && tr.failure.line === 3 && tr.failure.column === 8, "3e a truncated file reports where the text stops", JSON.stringify(tr.failure));
  check(!M.mergeServerEntry("[1]", entry).ok && !M.mergeServerEntry(`{"mcpServers": []}`, entry).ok, "3f a wrong shape (array top level, mcpServers not an object) is refused too");
  const cr = runCli(["--project", badDir]);
  check(cr.status === 1 && cr.stderr.includes(`line ${wantLine}, column ${wantCol}`) && /Nothing was written/.test(cr.stderr) && readFileSync(join(badDir, ".mcp.json"), "utf8") === bad,
    "3g the CLI refuses it: exit 1, line and column on stderr, file untouched", cr.stderr.trim());

  // ── 4 — CLI ──────────────────────────────────────────────────────────────────────
  const d4 = scratch("cli-print");
  const pr = runCli(["--project", d4, "--print"], cleanEnv({ C64RE_KICKASS_JAR: tass }));
  let pj; try { pj = JSON.parse(pr.stdout); } catch { pj = undefined; }
  check(pr.status === 0 && pj !== undefined && !existsSync(join(d4, ".mcp.json")), "4a --print prints valid JSON and writes nothing", pr.stderr.trim());
  const pe = pj?.mcpServers?.["c64-re"];
  check(pe?.env?.C64RE_PROJECT_DIR === d4 && pe?.command === process.execPath && pe?.args?.[0] === realpathSync(cli) && pe?.env?.C64RE_KICKASS_JAR === tass,
    "4b it describes the CLI's own launch and its own environment", JSON.stringify(pe));
  const wr = runCli(["--project", d4]);
  check(wr.status === 0 && existsSync(join(d4, ".mcp.json")) && /created/.test(wr.stdout) && JSON.stringify(readJson(join(d4, ".mcp.json"))) === JSON.stringify(pj === undefined ? null : { mcpServers: { "c64-re": { ...pe, env: { C64RE_PROJECT_DIR: d4 } } } }),
    "4c without --print it writes the file", wr.stdout.trim());
  check(/unchanged/.test(runCli(["--project", d4]).stdout), "4d running it again changes nothing");
  check(runCli(["--project", join(base, "nope")]).status === 1, "4e a project directory that does not exist is refused");

  // ── 5 — the check ──────────────────────────────────────────────────────────────────
  const d5 = scratch("check");
  const cfg5 = join(d5, ".mcp.json");
  check(M.checkMcpConfig(d5).length === 0, "5a no .mcp.json: nothing to report");
  writeFileSync(cfg5, bad);
  const w5 = M.checkMcpConfig(d5);
  check(w5.length === 1 && w5[0].includes(`line ${wantLine}, column ${wantCol}`) && /drops the c64-re server without an error/.test(w5[0]), "5b a broken file: line, column and the silent drop are reported", w5[0]);
  const good = (over) => JSON.stringify({ mcpServers: { "c64-re": { command: process.execPath, args: [realpathSync(cli)], env: { C64RE_PROJECT_DIR: d5, ...over } } } }, null, 2);
  writeFileSync(cfg5, good({}));
  check(M.checkMcpConfig(d5).length === 0, "5c a correct entry reports nothing");
  writeFileSync(cfg5, good({ C64RE_PROJECT_DIR: scratch("other-project") }));
  const w5d = M.checkMcpConfig(d5);
  check(w5d.length === 1 && /C64RE_PROJECT_DIR[^\n]*not this project/.test(w5d[0]), "5d a foreign C64RE_PROJECT_DIR is reported", w5d[0]);
  writeFileSync(cfg5, JSON.stringify({ mcpServers: { "c64-re": { command: join(base, "no-such-node"), args: [join(base, "no-such", "cli.js")], env: { C64RE_PROJECT_DIR: d5, C64RE_TOOLS_DIR: join(base, "no-tools") } } } }));
  const w5e = M.checkMcpConfig(d5);
  check(w5e.some((l) => /command[^\n]*no-such-node[^\n]*does not exist/.test(l)) && w5e.some((l) => /script[^\n]*cli\.js[^\n]*does not exist/.test(l)) && w5e.some((l) => /C64RE_TOOLS_DIR[^\n]*does not exist/.test(l)),
    "5e a missing command, script and path-valued C64RE_* are each reported", w5e.length);
  writeFileSync(cfg5, JSON.stringify({ mcpServers: { "c64-re": { command: "definitely-not-a-command-895", args: [], env: { C64RE_PROJECT_DIR: d5 } } } }));
  check(M.checkMcpConfig(d5).some((l) => /definitely-not-a-command-895[^\n]*does not exist/.test(l)), "5f a bare command is looked up on PATH");

  // through the tools: a project whose .mcp.json is broken
  const P5 = join(base, "P5");
  await session(cleanEnv({ C64RE_PROJECT_DIR: P5 }), async (tool) => {
    await tool("project_init", { project_dir: P5, name: "smoke895-check" });
    writeFileSync(join(P5, ".mcp.json"), bad);
    const st = await tool("project_status", { project_dir: P5 });
    check(/WARNING[^\n]*not valid JSON[^\n]*line 3/.test(st), "5g project_status carries the warning", st.split("\n").find((l) => l.startsWith("WARNING")));
    await tool("agent_onboard", { project_dir: P5 });
    const ob = await tool("agent_onboard", { project_dir: P5 });
    check(/WARNING[^\n]*not valid JSON[^\n]*line 3/.test(ob), "5h agent_onboard carries the warning", ob.split("\n").find((l) => l.startsWith("WARNING")));
    writeFileSync(join(P5, ".mcp.json"), good({}).replace(d5, P5));
    const st2 = await tool("project_status", { project_dir: P5 });
    check(!/WARNING/.test(st2), "5i a correct file: no warning", st2.split("\n").find((l) => l.startsWith("WARNING")) ?? "");
  });

  // ── 6 — the launch shapes ───────────────────────────────────────────────────────────
  const pk = M.describeLaunch({ execPath: "/n/node", argv: ["/n/node", "/cache/_npx/x/node_modules/@trex64/c64re/dist/cli.js"], execArgv: [], repoDir: "/cache", packaged: true });
  check(pk.command === "npx" && JSON.stringify(pk.args) === JSON.stringify(["-y", "@trex64/c64re"]), "6a an installed package is launched as npx -y @trex64/c64re", JSON.stringify(pk));
  const ts = M.describeLaunch({ execPath: "/n/node", argv: ["/n/node", join(ROOT, "src/cli.ts")], execArgv: ["--import", "file:///tsx/loader.mjs"], repoDir: ROOT, packaged: false });
  check(ts.command === "/n/node" && JSON.stringify(ts.args) === JSON.stringify(["--import", "file:///tsx/loader.mjs", realpathSync(join(ROOT, "src/cli.ts"))]), "6b a checkout run from TypeScript keeps its loader flags", JSON.stringify(ts));
  const built = M.describeLaunch({ execPath: "/n/node", argv: ["/n/node", cli], execArgv: ["--max-old-space-size=1"], repoDir: ROOT, packaged: false });
  check(JSON.stringify(built.args) === JSON.stringify([realpathSync(cli)]), "6c a built checkout is node + dist/cli.js, no stray flags", JSON.stringify(built));
  check(M.describeLaunch({ execPath: process.execPath, argv: [process.execPath, cli], execArgv: [], repoDir: ROOT }).command === process.execPath, "6d this checkout is detected as not packaged");
} catch (e) {
  fail++;
  console.log(`  FAIL  unexpected error: ${e instanceof Error ? e.stack : e}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
