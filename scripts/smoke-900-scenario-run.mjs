// Spec 900 — `c64re scenario run` and `Then` in runtime_sandbox_run, against a daemon.
//
// One generated PRG: `10 SYS2061`, then SEI · $C000 := $01 · wait for joystick 2 fire ·
// $C000 := $02 · JMP *. So the same byte is $01 before the fire press and $02 after it,
// and a check that is decided in the wrong place gives the wrong answer.
//   - pass.feature: checks before and after the press, the PC, the screen → PASS, exit 0
//   - mixed.feature: a failing check (expected vs actual), prose only (UNCHECKED), a mark
//     (SKIP), a missing medium (ERROR) → exit 1, and --json says the same
//   - runtime_sandbox_run with Then entries in steps → the same verdicts
// Needs a TRX64 daemon (the sibling release build, or TRX64_DAEMON_BIN). Every machine is
// a child of its run and gone when it returns.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const dir = mkdtempSync(join(tmpdir(), "c64re-900-"));
const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
const code = [
  0x78,                   // $080D SEI — the KERNAL's key scan writes $DC00 and would fake a fire
  0xa9, 0x01,             // $080E LDA #$01
  0x8d, 0x00, 0xc0,       // $0810 STA $C000
  0xad, 0x00, 0xdc,       // $0813 LDA $DC00
  0x29, 0x10,             // $0816 AND #$10   fire = bit 4, low when pressed
  0xd0, 0xf9,             // $0818 BNE $0813
  0xa9, 0x02,             // $081A LDA #$02
  0x8d, 0x00, 0xc0,       // $081C STA $C000
  0x4c, 0x1f, 0x08,       // $081F JMP $081F
];
writeFileSync(join(dir, "fire.prg"), Buffer.from([...stub, ...code]));

writeFileSync(join(dir, "pass.feature"), [
  "Feature: the fire gate",
  "  Scenario: $C000 moves from $01 to $02 when fire is pressed",
  '    Given the disk "fire.prg"',
  "    When I wait 10 frames",
  "    Then $C000 is $01",
  "    And $C000 is one of $01, $03",
  "    And I hold joystick 2 fire for 3 frames",
  "    And I wait 2 frames",
  "    Then $C000 is $02",
  "    And $C000@ram is not $01",
  "    And $C000 is $02 $00",
  "    And the CPU is at $081F",
  '    And the screen shows "RUN:"',
].join("\n"));

writeFileSync(join(dir, "mixed.feature"), [
  "Feature: every verdict",
  "  Scenario: a check that fails",
  '    Given the disk "fire.prg"',
  "    When I wait 10 frames",
  "    Then $C000 is $02",
  "  Scenario: prose only",
  '    Given the disk "fire.prg"',
  "    When I wait 10 frames",
  "    Then the game is fun",
  "  Scenario: from a mark",
  '    Given the mark "somewhere"',
  '    When branch "b" runs for 2 frames',
  "    Then $C000 is $01",
  "  Scenario: a missing medium",
  '    Given the disk "nope.prg"',
  "    When I wait 10 frames",
  "    Then $C000 is $01",
].join("\n"));

const env = { ...process.env, C64RE_RUNTIME_AUTOSTART: "0" };
const runCli = (...args) => spawnSync(process.execPath, [cli, "scenario", "run", ...args], { cwd: dir, env, encoding: "utf8", timeout: 300_000 });

try {
  console.log("Spec 900 — scenario checks, through the CLI and the tool\n");

  const a = runCli("pass.feature");
  check(a.status === 0, "1 pass.feature exits 0", `exit ${a.status}; ${(a.stdout + a.stderr).slice(-300)}`);
  check(/^PASS\s+pass\.feature:2 .*\(7 checked, 0 unchecked/m.test(a.stdout), "1b one PASS line with 7 checks", a.stdout.split("\n")[0]);

  const b = runCli("mixed.feature");
  check(b.status === 1, "2 mixed.feature exits 1", `exit ${b.status}`);
  check(/^FAIL\s+mixed\.feature:2 /m.test(b.stdout) && /line 5: \$C000 is \$02 — got \$01/.test(b.stdout),
    "2b the failing check names its line, what it wanted and what was there", (/line 5:[^\n]*/.exec(b.stdout) ?? ["none"])[0]);
  check(/^UNCHECKED\s+mixed\.feature:6 /m.test(b.stdout) && /\? line 9: the game is fun/.test(b.stdout), "2c prose is UNCHECKED and listed, not failed");
  check(/^SKIP\s+mixed\.feature:10 /m.test(b.stdout), "2d a mark scenario is SKIPPED with its reason");
  check(/^ERROR\s+mixed\.feature:14 /m.test(b.stdout) && /no such medium/.test(b.stdout), "2e a missing medium is an ERROR");

  const c = runCli("mixed.feature", "--json", "--jobs", "2");
  let doc; try { doc = JSON.parse(c.stdout); } catch { doc = null; }
  const verdicts = doc?.results?.map((r) => r.verdict).join(",");
  check(c.status === 1 && verdicts === "FAIL,UNCHECKED,SKIP,ERROR", "3 --json (two machines at once) carries the same verdicts, in file order", verdicts);
  const failed = doc?.results?.[0]?.checks?.[0];
  check(failed?.pass === false && failed?.actual === "$01" && failed?.line === 5, "3b …with the check's line and actual bytes", JSON.stringify(failed));

  // ── the tool door, same evaluator ──────────────────────────────────────────────
  const server = spawn(process.execPath, [cli], { cwd: tmpdir(), env: { ...env, C64RE_PROJECT_DIR: dir, C64RE_FULL_TOOLS: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pending = new Map(); let nextId = 1;
  server.stdout.on("data", (d) => {
    buf += d.toString(); let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => ((await rpc("tools/call", { name, arguments: args })).result?.content ?? []).map((x) => x.text).join("\n");
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-900", version: "1" } });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await call("project_init", { project_dir: dir, name: "s900" });
    await call("agent_onboard", { project_dir: dir });
    writeFileSync(join(dir, "fire.prg"), Buffer.from([...stub, ...code])); // project_init sorts media into input/
    const t = await call("runtime_sandbox_run", {
      project_dir: dir, media_path: "fire.prg",
      steps: ["I wait 10 frames", "Then $C000 is $01", "I hold joystick 2 fire for 3 frames", "I wait 2 frames", "Then $C000 is $02", "Then $C000 is $07"],
    });
    check(/checks: 2 passed, 1 failed/.test(t), "4 runtime_sandbox_run decides Then entries where they stand", (/checks:[^\n]*/.exec(t) ?? [t.slice(0, 200)])[0]);
    check(/FAIL\s+\$C000 is \$07 — got \$02/.test(t), "4b …and a failed one says what was there");
    const refused = await call("runtime_sandbox_run", { project_dir: dir, media_path: "fire.prg", steps: ["Then the game is fun"] });
    check(/in a tool call a Then has to be decidable/.test(refused), "4c prose in a tool call is refused before a machine starts");
  } finally {
    server.stdin.end(); server.kill();
  }
} catch (e) {
  check(false, "harness", e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-900: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
