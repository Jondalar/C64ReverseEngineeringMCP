#!/usr/bin/env node
// Spec 836 D3 — `runtime_sandbox_run`: a machine of your own, for one call.
//
// Two halves, and the split is deliberate. The DEFECT this spec is about is a
// write to a machine somebody else is using, and every property that prevents it
// can be checked without a machine existing at all: the tool is reachable, every
// parameter says what it takes, the description says WHOSE machine it touches and
// what it cannot do, and no code path in the sandbox can address the shared
// endpoint. Those run always.
//
// The LIVE half needs the real daemon binary, which this repo does not build. It
// SKIPS LOUDLY when the binary is absent — never silently, because a gate that
// quietly checks nothing is worse than one that is missing. When the binary is
// there it proves the three things only a running machine can: the sandbox is on
// its own port and not the shared one, it ENDS ITSELF on its budget with nobody
// listening, and it leaves nothing behind.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:836-sandbox
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0, failCount = 0;
const ok = (m, d = "") => { pass += 1; console.log(`  PASS  ${m}${d ? `  (${d})` : ""}`); };
const fail = (m, d = "") => { failCount += 1; console.log(`  FAIL  ${m}${d ? `  (${d})` : ""}`); };
const check = (c, m, d = "") => (c ? ok(m, d) : fail(m, d));

console.log("Spec 836 D3 — a machine of your own\n");

const dist = join(ROOT, "dist/server.js");
if (!existsSync(dist)) {
  console.log("  FAIL  dist/server.js is built (run npm run build:mcp)");
  console.log("\nRED  Spec 836 sandbox: 0 pass, 1 fail.");
  process.exit(1);
}
const { collectToolInventory } = await import(pathToFileURL(dist).href);
const { DEFAULT_TOOLS, DEFAULT_TIER_CAP, tierForTool } = await import(
  pathToFileURL(join(ROOT, "dist/server-tools/tier-tools.js")).href
);
const sandboxMod = await import(pathToFileURL(join(ROOT, "dist/reel/run-sandbox.js")).href);
const { SandboxSession } = await import(pathToFileURL(join(ROOT, "dist/reel/sandbox-session.js")).href);
const { resolveDaemonSpawn } = await import(pathToFileURL(join(ROOT, "dist/runtime/resolve-daemon-spawn.js")).href);

const TOOL = "runtime_sandbox_run";
const inventory = collectToolInventory();
const tool = inventory.find((t) => t.name === TOOL);

// ── A. reachable at all ──────────────────────────────────────────────────────
// A tool is INVISIBLE until it is in DEFAULT_TOOLS. This repo has lost three
// tools to that in one day, so it is the first thing checked.
console.log("A. the tool exists and can be reached");
check(tool !== undefined, `${TOOL} is registered on the live surface`);
check(DEFAULT_TOOLS.has(TOOL), `${TOOL} is in DEFAULT_TOOLS — otherwise nobody can call it`);
check(tierForTool(TOOL) === "default", "…and the tier gate agrees it is default");
const defaultCount = inventory.filter((t) => tierForTool(t.name) === "default").length;
check(defaultCount <= DEFAULT_TIER_CAP, "the default surface is still within its documented cap",
  `${defaultCount} of ${DEFAULT_TIER_CAP}`);
const invJson = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
check((invJson.tools ?? []).some((t) => t.name === TOOL),
  "the generated tool surface is regenerated with it (gen:tool-surface --check is a CI step)");

// ── B. every parameter says what it takes ────────────────────────────────────
// Spec 835's rule, applied to the new tool: an undescribed parameter is
// invisible reach — the caller cannot learn it exists from the schema alone.
console.log("\nB. every parameter is described");
const shape = tool?.schema ?? {};
const params = Object.keys(shape);
check(params.length >= 6, `it has ${params.length} parameters worth checking`, params.join(", "));
const undescribed = params.filter((p) => {
  const d = shape[p]?.description ?? shape[p]?._def?.description;
  return !d || !String(d).trim();
});
check(undescribed.length === 0, "every parameter carries a .describe()",
  undescribed.length ? `missing: ${undescribed.join(", ")}` : "all of them");
for (const required of ["media_path", "steps", "read_memory", "budget_seconds"]) {
  check(params.includes(required), `the schema has \`${required}\``);
}
const budgetDesc = String(shape.budget_seconds?.description ?? shape.budget_seconds?._def?.description ?? "");
check(/ends? ITSELF|ends itself/i.test(budgetDesc),
  "budget_seconds says the machine ends ITSELF — the property that makes starting one safe");
const readDesc = String(shape.read_memory?.description ?? shape.read_memory?._def?.description ?? "");
check(/only way|no session/i.test(readDesc),
  "read_memory says it is the only way to see this machine's memory — there is no session to ask later");

// ── C. the description says whose machine, and what it cannot do ─────────────
console.log("\nC. the description says whose machine it is");
const desc = tool?.description ?? "";
check(/MACHINE OF YOUR OWN|your own/i.test(desc), "it says the machine is your own");
check(/own port/i.test(desc), "…on its own port");
check(/budget/i.test(desc), "…and that it ends on a budget");
check(/shared/i.test(desc) && /never/i.test(desc),
  "…and that the SHARED machine is never reached — the defect this spec is about");
check(/cannot|CANNOT/.test(desc), "it states what it CANNOT do, not only what it can");
check(/no session id|NO session id/i.test(desc),
  "…naming the missing session id, which is the whole scope decision");
check(/breakpoint/i.test(desc) && /monitor/i.test(desc) && /step/i.test(desc),
  "…and names the interactive things that are out: stepping, breakpoints, the monitor");
check(/runtime_session_start/.test(desc), "it points at the shared machine for an interactive loop");
check(/runtime_scene_reel/.test(desc), "…and at the reel for a scenario file");
check(!/\bSpec\s+\d/i.test(desc), "no Spec NNN citation in a default description (the surface rule)");
check(/\bUse [a-z]/i.test(desc) && /Not for|use [a-z_]+ instead|\(use [a-z_]+/.test(desc),
  "it carries the Use-trigger + alternative pointer every default description needs");

// The reel, the other door to the same machine, keeps saying so. If D2's line
// ever goes, the two private doors stop being findable as a pair.
const reelDesc = inventory.find((t) => t.name === "runtime_scene_reel")?.description ?? "";
check(/own|private/i.test(reelDesc) && /budget/i.test(reelDesc),
  "runtime_scene_reel still says its machine is private and budgeted");

// ── D. no path reaches the shared machine ────────────────────────────────────
console.log("\nD. the shared machine is unreachable from here");
const driver = readFileSync(join(ROOT, "src/reel/run-sandbox.ts"), "utf8");
const toolSrc = readFileSync(join(ROOT, "src/server-tools/runtime-sandbox.ts"), "utf8");
const spawner = readFileSync(join(ROOT, "src/reel/sandbox-session.ts"), "utf8");
// The check is on IMPORTS and on what is CONNECTED to — a comment naming the
// shared client is documentation, an edge into it is the defect.
const importsOf = (src) => [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
for (const [name, src] of [["the driver", driver], ["the tool", toolSrc], ["the spawner", spawner]]) {
  const bad = importsOf(src).filter((m) => /daemon-client|runtime\/daemon/.test(m));
  check(bad.length === 0, `${name} imports nothing from the shared daemon client`, bad.join(",") || "none");
  check(!/\bruntimeDaemon\b\s*\./.test(src), `${name} never calls the shared singleton`);
  check(!/DEFAULT_RUNTIME_ENDPOINT/.test(src), `${name} does not reach for the shared endpoint constant`);
}
// The ONE WebSocket in this path is built from the sandbox's own port.
const sockets = [...(driver + toolSrc + spawner).matchAll(/new WebSocket\(([^)]*)\)/g)].map((m) => m[1].trim());
check(sockets.length === 1 && /this\.port/.test(sockets[0]),
  "the only WebSocket in the sandbox path is built from its OWN port", sockets.join(" | ") || "none");
// The shared endpoint appears exactly once, inside the function that PARSES it in
// order to refuse it. Nothing in this path connects to it.
check(!/ws:\/\/127\.0\.0\.1:4312/.test(toolSrc + spawner),
  "neither the tool nor the spawner contains the shared endpoint at all");
const guard = driver.slice(driver.indexOf("export function sharedRuntimePort"));
const guardBody = guard.slice(0, guard.indexOf("\n}\n") + 2);
const endpointHits = (driver.match(/4312/g) ?? []).length;
const guardHits = (guardBody.match(/4312/g) ?? []).length;
check(endpointHits > 0 && endpointHits === guardHits,
  "the driver names the shared port only inside the guard that refuses it",
  `${guardHits} of ${endpointHits} occurrences`);
check(/return m \? Number\(m\[1\]\) : 4312;/.test(guardBody),
  "…and that guard only parses it into a number — it never opens it");

// The refusal, exercised. A free port that happens to BE the shared port would
// make the sandbox answer as the co-driven session, so it is refused outright.
check(typeof sandboxMod.assertNotShared === "function", "the shared-port refusal is a real function, not a comment");
let refused = "";
try { sandboxMod.assertNotShared(sandboxMod.sharedRuntimePort()); } catch (e) { refused = e.message; }
check(/SHARED machine/.test(refused) && /Nothing was run/.test(refused),
  "…and it refuses the shared port loudly, having run nothing", refused.slice(0, 60));
let allowed = true;
try { sandboxMod.assertNotShared(sandboxMod.sharedRuntimePort() + 1); } catch { allowed = false; }
check(allowed, "…while any other port passes");
check(sandboxMod.sharedRuntimePort({}) === 4312, "the shared port defaults to 4312");
check(sandboxMod.sharedRuntimePort({ C64RE_RUNTIME_ENDPOINT: "ws://host:9999" }) === 9999,
  "…and follows C64RE_RUNTIME_ENDPOINT, so an overridden shared machine is protected too");

// ── E. the budget is written down, and it is what ends the machine ───────────
console.log("\nE. the budget-and-die contract is intact");
check(/ENDS ITSELF|ends itself/i.test(spawner), "the spawner still states the ends-itself contract");
check(/detached: false/.test(spawner), "the daemon is a CHILD, so it cannot outlive the process");
check(/s\.reaper = setTimeout/.test(spawner), "a reaper is armed at start, before the machine is used");
check(/void s\.close\(\)/.test(spawner), "…and it closes the sandbox when it fires, listener or not");
check(/rmSync\(this\.ownTmp/.test(spawner), "…and the scratch dir it made is removed with it");
check(/budgetMs: budget \* 1000/.test(toolSrc), "the tool hands its budget to the sandbox in milliseconds");
check(/MAX_BUDGET_SECONDS = 600/.test(toolSrc), "the budget is capped, so no call can ask for an immortal machine");

// ── F. the schedule is parsed before any machine starts ──────────────────────
console.log("\nF. a bad request is refused before a daemon is spawned");
const { parseStep } = await import(pathToFileURL(join(ROOT, "dist/project-knowledge/scenario-gherkin.js")).href);
check(parseStep("I wait 170 frames")?.step?.kind === "wait",
  "the step notation is the capture scenario's own parser, not a second dialect");
check(parseStep('I wait until the drive is idle within 8000 frames')?.step?.kind === "waitUntil",
  "…so a run-until is expressible: it is bounded, and the call answers it itself");
check(parseStep('I capture "title"')?.step?.kind === "capture",
  "…and a capture step parses, which is why the tool has to refuse it explicitly");
check(/a sandbox run reports, it does not assemble a reel/.test(toolSrc),
  "…and it does refuse it, naming runtime_scene_reel");
const badStep = toolSrc.indexOf("the schedule does not parse");
check(badStep > 0 && badStep < toolSrc.indexOf("runSandbox({"),
  "the schedule is parsed BEFORE the sandbox starts — a typo costs no daemon");

// A machine the runtime has dropped onto its isolated CPU core is not a C64, and
// the report says so instead of showing a stale screen as if it were live. This
// is the one thing Spec 836 assumed needed no runtime work and does.
check(/EXERCISER/.test(driver), "a machine that is not whole is reported as not whole");
check(/advance_to_frame/.test(driver) && /not sweeping\|raster/.test(driver),
  "…detected by asking the runtime whether its VIC is sweeping, not by guessing");
check(/no frame was taken/.test(driver), "…and no picture is offered for a VIC that is not drawing");
check(/NOT A WHOLE MACHINE/.test(toolSrc), "…and the caller sees it above the numbers, not in a footnote");

const { parseMemoryRead, hexDump } = sandboxMod;
check(parseMemoryRead("$0400:1000").read?.addr === 0x0400, "a memory read parses $ADDR:LEN");
check(parseMemoryRead("$d020:2@io").read?.lens === "io", "…with an explicit lens");
check(parseMemoryRead("$0400:40").read?.lens === "cpu", "…defaulting to the CPU's view of the bus");
check(!!parseMemoryRead("$fff0:32").error, "…and refuses a read that runs past $FFFF");
check(!!parseMemoryRead("nonsense").error, "…and refuses what is not a read at all");
check(hexDump(0x0400, Uint8Array.from([0x41, 0x42])).length === 1, "the dump renders 16 bytes to the line");

// ── G. LIVE — only with a real daemon binary ─────────────────────────────────
console.log("\nG. one real private machine");
const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "0" });
if (plan.mode === "none") {
  console.log("  SKIPPED — no runtime daemon binary. Build it in the sibling TRX64 checkout");
  console.log("            (cd ../TRX64 && cargo build --release -p trx64-daemon), or set");
  console.log("            C64RE_TRX64_BIN, then re-run. The live half asserts the private");
  console.log("            port, the self-ending budget and that nothing is left behind.");
} else {
  const shared = sandboxMod.sharedRuntimePort();
  const sharedWasUp = await listening(shared);

  // G1 — one real run on a machine of its own.
  const run = await sandboxMod.runSandbox({
    steps: [parseStep("I wait 60 frames").step], budgetMs: 120_000, wantFrame: true,
  });
  check(run.port !== shared, "the run happened on its OWN port, not the shared one", `port ${run.port}`);
  check(run.endCycle > 0, "a real machine advanced", `cycle ${run.endCycle}`);
  check(run.pc >= 0 && run.pc <= 0xffff, "…and reported a real PC", `$${run.pc.toString(16).toUpperCase()}`);
  const screen = (run.screenRows ?? []).join(" ");
  check(/BASIC|READY/i.test(screen), "…that booted to the BASIC prompt", screen.trim().slice(0, 48));
  check(run.log.some((l) => /warmed to the BASIC prompt/.test(l)),
    "…because the sandbox switches it on and waits for the prompt before anything goes in");
  check(run.coreOnly === undefined, "…and it is a WHOLE machine: VIC, CIAs, SID, drive");
  const gif = run.frame?.bytes;
  check(!!gif && Buffer.from(gif.subarray(0, 6)).toString("latin1") === "GIF89a",
    "a frame came off the VIC as a GIF", gif ? `${gif.length} bytes` : "none");
  check(run.endedBecause === null, "it was ended by the call, not by its budget");

  // G2 — it is gone. Nothing to attach to is the whole scope decision.
  check(!(await listening(run.port)), "nothing is listening on the sandbox port afterwards — the machine is gone");
  check(await sameSharedState(shared, sharedWasUp),
    sharedWasUp
      ? "the shared machine was running before and is still running after — untouched"
      : "no shared machine was running, and the sandbox did not become one");

  // G3 — the budget ends it with NOBODY listening. This is the property doctrine
  // rule 2 actually asks for, and the only way to see it is to walk away.
  const before = scratchDirs();
  const box = await SandboxSession.start({ budgetMs: 1500 });
  const boxPort = box.port;
  check(boxPort !== shared, "a bare sandbox also takes its own port", `port ${boxPort}`);
  check(await listening(boxPort), "…and its daemon is answering while the budget lasts");
  await new Promise((r) => setTimeout(r, 4000));
  check(!(await listening(boxPort)), "…and it ended ITSELF when the budget ran out, with nobody listening");
  check(box.ended !== null && /budget/i.test(box.ended ?? ""), "…and said so", box.ended ?? "(silent)");
  const after = scratchDirs();
  check(after.length <= before.length, "…leaving no scratch directory behind",
    `${before.length} before, ${after.length} after`);
  await box.close();
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 836 sandbox: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);

/** Is anything accepting connections on this local port? */
function listening(port) {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); res(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref?.();
  });
}

/** The shared machine must be exactly as we found it: up if it was up, absent if not. */
async function sameSharedState(port, wasUp) {
  return (await listening(port)) === wasUp;
}

/** The temp dirs a sandbox makes for its daemon's scratch. */
function scratchDirs() {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("c64re-reel-"));
  } catch {
    return [];
  }
}
