// Who listens on a TCP port, for the e2e scripts — on every platform.
//
// The scripts used to inline `lsof -ti tcp:PORT -sTCP:LISTEN | xargs kill -9`. Windows has
// no lsof: the lookup returned nothing, the cleanup did nothing, and a daemon from an
// earlier step stayed on the port (#104). Synchronous, like the helpers it replaces.
// Windows uses `netstat -ano` (about 0.1 s; Get-NetTCPConnection takes seconds).
import { execFileSync, execSync } from "node:child_process";

/** The pids listening on `port`, each once (none: an empty list). */
export function listenerPids(port) {
  let out = "";
  if (process.platform === "win32") {
    try { out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }); } catch { return []; }
    // "  TCP    127.0.0.1:4310    0.0.0.0:0    LISTENING    1234"
    const pids = out.split(/\r?\n/u)
      .map((l) => l.trim().split(/\s+/u))
      .filter((c) => c.length >= 5 && c[3] === "LISTENING" && Number(c[1].slice(c[1].lastIndexOf(":") + 1)) === port)
      .map((c) => Number(c[4]))
      .filter((p) => p > 0);
    return [...new Set(pids)];
  }
  // -sTCP:LISTEN keeps our own client sockets to the port out of the answer.
  try { out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return []; }
  return [...new Set(out.split("\n").map((s) => Number(s.trim())).filter((p) => p > 0))];
}

/** Kill whatever listens on `port` (SIGKILL; TerminateProcess on Windows). */
export function killPortListeners(port) {
  for (const pid of listenerPids(port)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
