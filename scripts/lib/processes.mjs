// The processes on this machine, for the e2e scripts — on every platform.
//
// The scripts used to call `ps -axo pid=,command=`, `ps -o args= -p PID` and `ps -o rss= -p PID`
// inline. Windows has no such ps: Git Bash's MSYS `ps` knows neither -a/-x nor -o ("unknown
// option"), and without Git Bash there is no ps at all. The lookups came back empty, so a "no
// process is left" check passed without looking, an RSS reading was -1 and a command line was "".
// Synchronous, like port-listeners.mjs next to it.
//
// Windows asks Get-CimInstance Win32_Process (`wmic` is gone from current Windows): the command
// line as the OS reports it, and WorkingSetSize — the resident set — for RSS.
// When the list cannot be read these throw: a check must not pass on an empty answer.
import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";
const RUN = { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };

/** `filter`: a WQL condition, or "" for every process. */
function winProcs(filter) {
  const where = filter ? ` -Filter "${filter}"` : "";
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
    + `@(Get-CimInstance Win32_Process${where} | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; command = [string]$_.CommandLine; rss = [double]$_.WorkingSetSize } }) | ConvertTo-Json -Compress`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], RUN).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.pid, command: p.command ?? "", rssKiB: Math.round(p.rss / 1024) }));
}

/** Every process: pid and command line as the OS reports it. */
export function processes() {
  if (WIN) return winProcs("").map(({ pid, command }) => ({ pid, command }));
  const out = execFileSync("ps", ["-axo", "pid=,command="], RUN);
  return out.split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), command: m[2] }));
}

/** Every process whose command line contains `needle` (pid + command), this lookup's own process left out. */
export function processesMatching(needle) {
  return processes().filter((p) => p.command.includes(needle) && !/ps -axo|Get-CimInstance Win32_Process/.test(p.command));
}

/** One process's command line; "" when it does not exist. */
export function commandLine(pid) {
  if (WIN) return winProcs(`ProcessId = ${Number(pid)}`)[0]?.command ?? "";
  try { return execFileSync("ps", ["-o", "args=", "-p", String(pid)], RUN).trim(); } catch { return ""; }
}

/** One process's resident set in KiB (Windows: its working set); -1 when it does not exist. */
export function rssKiB(pid) {
  if (WIN) return winProcs(`ProcessId = ${Number(pid)}`)[0]?.rssKiB ?? -1;
  try { const n = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], RUN).trim()); return n > 0 ? n : -1; } catch { return -1; }
}
