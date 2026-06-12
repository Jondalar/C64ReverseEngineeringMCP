// Spec 744.4 — ONE runtime session authority shared by MCP + UI. In-process service
// test (Spec 744 §10.3: in-process is acceptable when the product keeps one process):
// a session created "as MCP would" is visible + controllable "as the UI would", and
// vice-versa, through the same RuntimeSessionService — real shared state, not mirrors.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeSessions } from "../dist/runtime/headless/runtime-session-service.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 744.4 — shared runtime session authority (MCP + UI)\n");

// --- MCP creates a session through the authority.
const mcp = runtimeSessions.start({ mode: "true-drive", driveDispatchMode: "vice-whole-instruction" });
ok(!!mcp.sessionId && !!mcp.controller, "MCP-style start() registers session + controller", mcp.sessionId);
ok(mcp.controller.runState === "paused", "session starts PAUSED (no autonomous loop)", mcp.controller.runState);

// --- UI sees the SAME session by id (get / list).
const uiView = runtimeSessions.get(mcp.sessionId);
ok(uiView?.session === mcp.session, "UI get(id) resolves the SAME IntegratedSession instance");
ok(uiView?.controller === mcp.controller, "UI get(id) resolves the SAME controller (not a mirror)");
ok(runtimeSessions.list().some((s) => s.sessionId === mcp.sessionId), "session is visible in list()");

// --- UI attaches its broadcast sink to the MCP session and observes it.
let frames = 0;
const ui = runtimeSessions.attach(mcp.sessionId, () => { frames++; });
ok(ui?.controller === mcp.controller, "UI attach(id) binds to the SAME controller (broadcast re-wired)");

// --- A control command from one surface changes the state the other surface sees.
mcp.session.runFor(100000); // advance a bit so cycles move
const before = runtimeSessions.status(mcp.sessionId).cycles;
runtimeSessions.run(mcp.sessionId);                      // "UI clicks Run"
ok(runtimeSessions.status(mcp.sessionId).runState === "running", "run() (UI) flips shared runState the MCP status sees");
runtimeSessions.pause(mcp.sessionId);                    // "UI clicks Pause"
ok(runtimeSessions.status(mcp.sessionId).runState === "paused", "pause() (UI) flips shared runState back");
ok(runtimeSessions.status(mcp.sessionId).cycles >= before, "both surfaces read the same cycle counter", `${before}→${runtimeSessions.status(mcp.sessionId).cycles}`);

// --- ONE MACHINE PER PROCESS (Option A, docs/headless-runtime-singleton-audit.md):
// a "second" start() does NOT build a second machine (that would rebind the
// process-global VIC/drive and corrupt the first) — it ATTACHES to the existing
// one (shared-attach). The UI and MCP co-drive the SAME machine.
const uiSess = runtimeSessions.start({ mode: "true-drive", driveDispatchMode: "vice-whole-instruction" });
ok(uiSess.sessionId === mcp.sessionId, "second start() ATTACHES to the same machine (no second machine)", uiSess.sessionId);
ok(uiSess.attached === true, "second start() reports attached=true");
ok(runtimeSessions.list().length === 1, "exactly ONE machine in the process", `${runtimeSessions.list().length}`);

// --- close releases through the authority (idempotent).
const closed = await runtimeSessions.close(mcp.sessionId);
ok(closed.released.includes("session") && closed.released.includes("controller"),
  "close() releases controller + session through the authority", closed.released.join(","));
ok(runtimeSessions.get(mcp.sessionId) === undefined, "closed session is gone from the authority");
const again = await runtimeSessions.close(mcp.sessionId);
ok(again.existed === false, "close() is idempotent");

// --- No product INTERACTIVE entry point constructs a private session outside the
//     authority: the MCP runtime_session_start tool and the UI bootstrap must call
//     runtimeSessions.start, NOT startIntegratedSession directly.
const headless = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");
// Spec 757 — the standalone start-v3-server.mjs (a second WS-start path) is
// retired; the ONE WS bootstrap is the Runtime Daemon entry (daemon/run.ts →
// WsServer). Verify it does not construct a private session outside the authority.
const daemonRun = readFileSync(join(ROOT, "src/runtime/headless/daemon/run.ts"), "utf8");
ok(/runtimeSessions\.start\(/.test(headless) && !/= startIntegratedSession\(/.test(headless),
  "MCP runtime_session_start uses the authority (no direct startIntegratedSession)");
ok(/new WsServer\(/.test(daemonRun) && !/= startIntegratedSession\(/.test(daemonRun),
  "UI WS bootstrap (daemon run.ts → WsServer) uses the authority, no private startIntegratedSession");

console.log(`\nSpec 744.4: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
