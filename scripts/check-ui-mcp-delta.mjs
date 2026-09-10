#!/usr/bin/env node
/**
 * Spec 839 — what the human can do, the LLM can do.
 *
 * The workspace UI and the MCP tool surface drive the SAME daemon. Every time the UI
 * grows a button for something the tools cannot reach, an LLM debugging the machine
 * the human is watching goes blind in one more place — and nobody notices, because
 * nothing compares the two.
 *
 * This compares them. It is a REPORT, not a block (CI reports, never gates): a human
 * reads it and judges.
 *
 * How the first attempt at this got it wrong, so nobody repeats it: it compared verb
 * STRINGS and concluded the MCP was missing 15 of them. The MCP reaches most of the
 * machine through `monitor/exec` — the whole monitor REPL, including the verbs the
 * daemon FORWARDS to other RPCs (Spec 839) — so a verb absent from `src/` is not an
 * absent capability. That is why `monitor_forward` is parsed out of the daemon below
 * and counted as reach, and why every allowlist entry carries a REASON rather than
 * just a name. The reason is the part that makes the next reading of this file
 * possible.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_SRC = resolve(REPO, "..", "TRX64", "crates", "trx64-daemon", "src", "main.rs");

/**
 * UI-only ON PURPOSE. Each entry says WHY the LLM does not need this verb — either
 * because it reaches the same capability another way, or because the verb is not a
 * capability at all (a server→client push, an acknowledgment).
 *
 * This list follows `KNOWN_HINTLESS` from Spec 834: it MAY SHRINK AND MAY NOT GROW.
 * A new UI verb with no LLM path is a finding to fix, not a line to add here.
 */
const UI_ONLY_BY_DESIGN = new Map([
  // -- acknowledgments, not switches --
  ["audio/start", "an ack: the A/V push is a singleton hub stream that is already flowing, and these do not gate it. The LLM also has no ears — runtime_session_export_audio is the capability"],
  ["audio/stop", "an ack (see audio/start)"],

  // -- same capability, different door --
  ["session/power", "runtime_monitor `power on|off`"],
  ["session/reset", "runtime_monitor `reset [warm|cold]`"],
  ["session/set_pacing", "runtime_monitor `warp on|off` / `turbo …`"],
  ["session/read_memory", "runtime_monitor_memory"],
  ["session/key_down", "runtime_type types; a HELD key is a scenario step (src/reel), not a tool call"],
  ["session/key_up", "see session/key_down"],
  ["session/release_keys", "see session/key_down"],
  ["session/frame_indices", "runtime_monitor `rewind` / `goto` — the transport owns frame positions"],
  ["session/input_journal", "runtime_monitor `rewind`; the journal is the transport's own record"],
  ["transport/key", "runtime_monitor `play`/`pause`/`frame ±N`/`goto` — the same transport, by name"],
  ["debug/step", "runtime_step_into / runtime_step_over"],
  ["media/mount", "runtime_media_mount → media/ingress, and runtime_monitor `mount`"],
  ["media/swap", "runtime_media_swap → media/ingress"],
  ["media/browse", "runtime_media_browse (local fs) and the monitor's own `!ls`/`!cd`"],
  ["media/list_paths", "runtime_media_list_paths"],
  ["snapshot/dump", "runtime_save_vsf, and runtime_monitor `dump <path>`"],
  ["trace/current", "runtime_trace_status"],
  ["checkpoint/thumbnails", "pictures for a filmstrip; the LLM restores a checkpoint and calls runtime_render_screen"],
  ["vic/inspect/at", "runtime_vic_inspect_at uses vic/inspect/at_capture, which captures and pins first"],

  // -- deliberately NOT exposed (Spec 839 §D10) --
  ["vic/inspect/promote", "stores evidence in the DAEMON session, which dies with it. C64RE's half of the Leitregel is meaning and memory: save_finding, into the graph"],
  ["vic/inspect/open", "at_capture captures and pins per call; a pin the LLM must remember to release is a leak with no caller"],
  ["vic/inspect/close", "see vic/inspect/open"],
]);

// NOT in the list above, and deliberately: the comparison is over the daemon's own
// DISPATCH ARMS, so a name that is only ever broadcast — `debug/paused`,
// `debug/running`, `debug/stopped`, `debug/breakpoint_hit`, `debug/observer_hit`,
// `debug/observer_log`, `debug/checkpoint_restored`, `media/events`,
// `media/cart_persisted`, `media/disk_persisted`, `batch/progress` — never enters it.
// Those are server→client pushes: the UI subscribes to them, and there is nothing for
// a tool to "call". Likewise `runtime/export_screenshot|_video|_audio` and
// `runtime/scenario_load_ws`, which are the workspace server's own verbs rather than
// the daemon's (runtime_render_screen, runtime_scene_reel and
// runtime_session_export_audio are the capabilities). Allowlisting any of them would
// put a permanent stale entry in a list that is only allowed to shrink.

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

/** Verb literals: `"a/b"` or `"a/b/c"`, lowercase + underscores. */
const VERB = /"([a-z][a-z0-9_]*(?:\/[a-z0-9_]+)+)"/g;

function verbsIn(files) {
  const found = new Set();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(VERB)) found.add(m[1]);
  }
  return found;
}

/** The daemon's own dispatch arms — the authority on what a verb IS. */
function daemonVerbs() {
  if (!existsSync(DAEMON_SRC)) return null;
  const src = readFileSync(DAEMON_SRC, "utf8");
  const known = new Set();
  for (const m of src.matchAll(/"([a-z][a-z0-9_]*(?:\/[a-z0-9_]+)+)"\s*=>/g)) known.add(m[1]);
  return known;
}

/**
 * The verbs `monitor_forward` sends on. These ARE MCP reach: the monitor is one
 * `runtime_monitor` call away, which is the whole point of Spec 839.
 */
function forwardedVerbs() {
  if (!existsSync(DAEMON_SRC)) return new Set();
  const src = readFileSync(DAEMON_SRC, "utf8");
  const i = src.indexOf("fn monitor_forward(");
  if (i < 0) return new Set();
  const body = src.slice(i, src.indexOf("\nfn ", i + 10));
  const out = new Set();
  for (const m of body.matchAll(VERB)) out.add(m[1]);
  return out;
}

const known = daemonVerbs();
if (!known) {
  console.log("check:ui-mcp-delta — SKIPPED: no TRX64 checkout at ../TRX64, so there is no");
  console.log("authority on what a daemon verb is. This check compares reach, and guessing");
  console.log("the verb list from string shapes alone is how the first attempt went wrong.");
  process.exit(0);
}

const uiVerbs = new Set([...verbsIn(walk(join(REPO, "ui", "src")))].filter((v) => known.has(v)));
// `src/reel` is excluded on purpose. It is a scenario RUNNER — it speaks key_down,
// frame_indices and media/mount to replay a `.feature` file — and counting it as reach
// would answer the wrong question. What matters here is what an LLM can reach by making
// a CALL, so the doors are the tools and the monitor. (Writing a scenario file is a real
// path to a held key; that is why session/key_down is allowlisted WITH that reason,
// rather than silently counted here.)
const mcpVerbs = new Set(
  [...verbsIn(walk(join(REPO, "src")).filter((f) => !f.includes("/src/reel/")))].filter((v) => known.has(v)),
);
const forwarded = forwardedVerbs();
for (const v of forwarded) mcpVerbs.add(v);

const delta = [...uiVerbs].filter((v) => !mcpVerbs.has(v)).sort();
const unexplained = delta.filter((v) => !UI_ONLY_BY_DESIGN.has(v));
const stale = [...UI_ONLY_BY_DESIGN.keys()].filter((v) => !delta.includes(v)).sort();

console.log(`check:ui-mcp-delta — ${uiVerbs.size} verbs reached by the UI, ${mcpVerbs.size} by the MCP`);
console.log(`  (${forwarded.size} of the MCP's come from the daemon's monitor_forward — Spec 839)`);
console.log(`  ${delta.length} UI-only, ${UI_ONLY_BY_DESIGN.size} explained, ${unexplained.length} NOT explained`);

if (stale.length) {
  console.log("");
  console.log("Allowlist entries that no longer describe anything (the LLM reaches these now).");
  console.log("The list may shrink: delete them.");
  for (const v of stale) console.log(`  - ${v}`);
}

if (unexplained.length) {
  console.log("");
  console.log("The human can reach these and the LLM cannot:");
  for (const v of unexplained) console.log(`  ✗ ${v}`);
  console.log("");
  console.log("Each is either a capability to expose (a tool, or a forwarded monitor verb");
  console.log("in the daemon) or a line in UI_ONLY_BY_DESIGN **with the reason written out**.");
  console.log("A name with no reason is what made the first measurement of this delta wrong.");
  process.exitCode = 1;
} else {
  console.log("");
  console.log("No unexplained delta: everything the UI reaches, the LLM reaches or is");
  console.log("accounted for by name and reason.");
}
