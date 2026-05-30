// BUG-018 — the product UI must show runtime connection + session status in an
// always-visible header area (human/LLM coordination), like the old v3 UI.
// Asserts the source wiring (conn subscribe on mount, NOT gated on the Live tab;
// cycle poll; status-bar JSX) + the built v1 bundle markers.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-018 — always-visible runtime connection/session status\n");

const app = readFileSync(join(ROOT, "ui/src/App.tsx"), "utf8");

// 1. the conn subscription runs on mount (empty deps), NOT gated on the Live tab.
const connEffect = app.match(/useEffect\(\(\) => \{\s*return getClient\(\)\.onState\(setLiveConn\);\s*\}, \[\]\);/);
ok(!!connEffect, "1 runtime conn is subscribed on mount (always-visible, not Live-tab-gated)", "");

// 2. cycle is polled while connected.
ok(/session\/state/.test(app) && /setLiveCycle/.test(app), "2 cycle counter polled from session/state", "");

// 3. the header renders the status bar with conn + session + run state + cycle.
ok(/runtime-status-bar/.test(app), "3 header renders a runtime-status-bar", "");
ok(/rt-conn-\$\{liveConn\}/.test(app), "4 conn chip reflects liveConn (connecting/open/closed/error)", "");
ok(/session:\s*<strong>\{liveSessionId/.test(app), "5 session id shown in the header", "");
ok(/\{liveRunState\}/.test(app) && /cycle:.*liveCycle/.test(app), "6 run state + cycle shown in the header", "");

// ---- built bundle markers ----
const distDir = join(ROOT, "ui/dist/assets");
if (!existsSync(distDir)) { console.log("  PENDING ui/dist not built"); console.log("\nPENDING."); process.exit(0); }
const js = readFileSync(join(distDir, readdirSync(distDir).find((f) => /^index-.*\.js$/.test(f))), "utf8");
const css = readFileSync(join(distDir, readdirSync(distDir).find((f) => /^index-.*\.css$/.test(f))), "utf8");
ok(js.includes("runtime-status-bar"), "7 status bar present in the built product bundle", "");
ok(css.includes(".rt-conn-open") && css.includes(".runtime-status-bar"), "8 status-bar styling present in the built CSS", "");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug018: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
