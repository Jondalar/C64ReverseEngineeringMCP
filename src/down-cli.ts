// Spec 902 D2 / D3 / D4 — `c64re down`, `c64re up`, `c64re status`.

import { resolve } from "node:path";
import { KEEP_GROUPS, runDown, runStatus, type KeepGroup } from "./runtime/down.js";
import { clearHold, readHold, holdMessage } from "./runtime/hold.js";

const DOWN_HELP = [
  "c64re down [--project <dir>] [--keep ui|bridge|sandbox|daemon]... [--json]",
  "",
  "  Shuts C64RE down: the workbench UI, the C64 Ultimate bridges, the sandboxes and the runtime",
  "  daemon, in that order, each one only if its pid, start time and command line still match what it",
  "  recorded. Then the runtime selection and the bridge registry are removed, and a hold is written:",
  "  nothing starts again by itself until `c64re up`, `c64re ui`, runtime_session_start or selecting a",
  "  C64 Ultimate. A process on a known port that C64RE did not start is named and never touched.",
  "  Exit code 0 only when nothing of C64RE is left.",
  "",
  "  --project <dir>   end only that project's processes; no hold, the selection stays",
  "  --keep <kind>     leave one kind running (repeatable); no hold either",
  "  --json            the report as JSON",
].join("\n");

function values(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`); out.push(...v.split(",")); i++; }
  }
  return out;
}

export async function runDownCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(DOWN_HELP); return; }
  const keep = values(argv, "--keep").map((k) => k.trim()).filter(Boolean);
  const bad = keep.find((k) => !(KEEP_GROUPS as readonly string[]).includes(k));
  if (bad) throw new Error(`--keep ${JSON.stringify(bad)} is not one of ${KEEP_GROUPS.join(", ")}`);
  const project = values(argv, "--project")[0];
  const r = await runDown({ by: "c64re down", project: project ? resolve(project) : undefined, keep: keep as KeepGroup[] });
  if (argv.includes("--json")) console.log(JSON.stringify({ ...r, text: undefined }, null, 2));
  else console.log(r.text);
  process.exitCode = r.exitCode;
}

const UP_HELP = [
  "c64re up [--project <dir>]",
  "",
  "  Clears the hold that `c64re down` wrote and starts the runtime daemon (the project is --project or",
  "  C64RE_PROJECT_DIR). The workbench is `c64re ui`, which clears the hold as well.",
].join("\n");

export async function runUpCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(UP_HELP); return; }
  const { resolveProjectDir } = await import("./workspace-ui/resolve-project-dir.js");
  const projectDir = resolveProjectDir(argv, process.env);
  const had = clearHold();
  const { startRuntimeDaemon, runtimeEndpoint } = await import("./runtime/daemon-client.js");
  const r = await startRuntimeDaemon({ projectDir, startedBy: "cli" });
  console.log(`${had ? "hold cleared; " : ""}runtime ${r === "already-up" ? "was already running" : r === "spawned" ? "started" : "COULD NOT BE STARTED"} at ${runtimeEndpoint()} (project ${projectDir})`);
  if (r === "failed") {
    console.error("no runtime daemon could be started or answered in time — `c64re runtime install`, or set C64RE_RUNTIME_BIN; `c64re status` shows what runs.");
    process.exitCode = 1;
  }
}

export async function runStatusCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("c64re status [--json]\n\n  What C64RE has running on this machine: every process in the ledger (kind, pid, port, project, started by,\n  uptime, idle deadline), the runtime selection and the hold. Starts and ends nothing.");
    return;
  }
  const s = await runStatus();
  if (argv.includes("--json")) console.log(JSON.stringify({ processes: s.rows, selection: s.selection, hold: s.hold ?? null, foreign: s.foreign }, null, 2));
  else console.log(s.text);
}


