// Spec 902 D6 — the ONE place that knows what an operating system calls a process.
//
// Everything that has to ask "who is pid N, who listens on port P, end this one" goes through
// here, and nothing else in the code branches on the platform for it:
//
//   identity   POSIX   `ps -ww -o pid=,lstart=,command= -p <pids>`
//              Windows `powershell.exe -NoProfile` + Get-CimInstance Win32_Process
//                      (CreationDate, CommandLine; `wmic` is gone from current Windows)
//   listeners  POSIX   `lsof -nP -iTCP -sTCP:LISTEN -F pcn` (`ss -ltnpH` when there is no lsof)
//              Windows Get-NetTCPConnection -State Listen, `netstat -ano -p TCP` as the fallback
//   ending     POSIX   SIGTERM, then SIGKILL after the grace
//              Windows no SIGTERM exists (process.kill there is a hard kill that skips the
//                      child's cleanup): ask through C64RE's own channel first, and only after
//                      the grace `taskkill /PID <pid> /T /F` (/T takes the tree: the UI
//                      launcher's children and npm shims are separate processes there)
//   spawning   a detached or hidden child never opens a console window (`windowsHide`)
//
// The command line is stored exactly as the OS reports it, never rebuilt. A pid that cannot be
// read is not ours.

import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ProcInfo {
  /** The OS's own start time of the process, as a string: only ever compared for equality. */
  start: string;
  /** The command line as the OS reports it. */
  command: string;
}

export interface Listener {
  port: number;
  pid: number;
  address: string;
}

export interface ExecResult { stdout: string; code: number | null; missing?: boolean }
/** How a command is run. The seam the Windows branches are tested through on a POSIX machine. */
export type Exec = (file: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

const realExec: Exec = (file, args, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }, (err, stdout) => {
      if (!err) { resolve({ stdout, code: 0 }); return; }
      const e = err as NodeJS.ErrnoException & { code?: string | number };
      resolve({ stdout: stdout ?? "", code: typeof e.code === "number" ? e.code : null, missing: e.code === "ENOENT" });
    });
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Grace between asking a process to end and the hard stop. C64RE_DOWN_GRACE_MS shortens it for a test. */
export function graceMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.C64RE_DOWN_GRACE_MS);
  return Number.isFinite(n) && n >= 0 && env.C64RE_DOWN_GRACE_MS !== undefined && env.C64RE_DOWN_GRACE_MS !== "" ? n : 5000;
}

const PS = (script: string): [string, string[]] => ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]];

// ---- parsing (pure, so the Windows shapes are testable anywhere) -----------------------------------

const LSTART = /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*?)\s*$/;

export function parsePosixPs(stdout: string): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>();
  for (const line of stdout.split("\n")) {
    const m = LSTART.exec(line);
    if (m) out.set(Number(m[1]), { start: m[2], command: m[3] });
  }
  return out;
}

/** `ConvertTo-Json -Compress` of zero, one or many {pid,start,cmd} objects. */
export function parseWindowsProcs(stdout: string): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>();
  const text = stdout.trim();
  if (!text) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return out; }
  for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
    const o = r as { pid?: unknown; start?: unknown; cmd?: unknown };
    if (typeof o?.pid === "number" && typeof o.start === "string" && o.start) {
      out.set(o.pid, { start: o.start, command: typeof o.cmd === "string" ? o.cmd : "" });
    }
  }
  return out;
}

/** `lsof -F pcn`: `p<pid>` opens a process, `c<command>`, then one `n<address>:<port>` per socket. */
export function parseLsof(stdout: string): Listener[] {
  const out: Listener[] = [];
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const m = /^n(.*):(\d+)$/.exec(line);
      if (m) out.push({ pid, port: Number(m[2]), address: m[1] });
    }
  }
  return dedupe(out);
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:4312 0.0.0.0:* users:(("node",pid=123,fd=19))`. */
export function parseSs(stdout: string): Listener[] {
  const out: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s*(.*)$/.exec(line);
    if (!m) continue;
    for (const p of m[3].matchAll(/pid=(\d+)/g)) out.push({ pid: Number(p[1]), port: Number(m[2]), address: m[1] });
  }
  return dedupe(out);
}

/** `Get-NetTCPConnection | Select LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`. */
export function parseNetTcp(stdout: string): Listener[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const out: Listener[] = [];
  for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
    const o = r as { LocalAddress?: unknown; LocalPort?: unknown; OwningProcess?: unknown };
    if (typeof o?.LocalPort === "number" && typeof o.OwningProcess === "number") {
      out.push({ pid: o.OwningProcess, port: o.LocalPort, address: typeof o.LocalAddress === "string" ? o.LocalAddress : "" });
    }
  }
  return dedupe(out);
}

/** `netstat -ano -p TCP`: `  TCP    127.0.0.1:4312   0.0.0.0:0   LISTENING   1234`. */
export function parseNetstat(stdout: string): Listener[] {
  const out: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line.replace(/\r/g, ""));
    if (m) out.push({ address: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return dedupe(out);
}

function dedupe(l: Listener[]): Listener[] {
  const seen = new Set<string>();
  return l.filter((x) => { const k = `${x.pid}:${x.port}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- the layer -------------------------------------------------------------------------------------

export interface EndOptions {
  /**
   * C64RE's own request to end (a `daemon/shutdown`, the UI server's shutdown). Used first where the
   * platform has no polite signal, and by anything that sets `askFirst`. Resolves true when the
   * request was accepted.
   */
  ask?: () => Promise<boolean>;
  graceMs?: number;
}

export type EndHow =
  /** it went within the grace after it was asked */
  | "asked"
  /** it went after SIGTERM */
  | "term"
  /** it needed the hard stop (SIGKILL; `taskkill /T /F` on Windows) after the grace */
  | "forced"
  | "gone"
  /** still there after everything */
  | "survived";

export interface EndResult { how: EndHow; ms: number; askAccepted?: boolean }

export class PlatformProc {
  constructor(
    readonly platform: NodeJS.Platform = process.platform,
    private readonly exec: Exec = realExec,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
    private readonly signal: (pid: number, sig: NodeJS.Signals | 0) => void = (pid, sig) => { process.kill(pid, sig); },
    /** Test seam: C64RE_DOWN_ASK_FIRST=1 puts a POSIX machine through the Windows order (ask, wait, hard stop). */
    private readonly askFirstOverride: boolean = process.env.C64RE_DOWN_ASK_FIRST === "1",
  ) {}

  private get win(): boolean { return this.platform === "win32"; }
  get asksFirst(): boolean { return this.win || this.askFirstOverride; }

  /** Is anything with this pid running (a signal-0 probe; EPERM = alive, not ours to touch)? */
  alive(pid: number | undefined): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try { this.signal(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  }

  /** Start time and command line of each pid that exists; a pid that cannot be read is simply absent. */
  async infoMany(pids: number[]): Promise<Map<number, ProcInfo>> {
    const ids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (ids.length === 0) return new Map();
    if (this.win) {
      const script =
        `$ids=@(${ids.join(",")}); ` +
        "Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { " +
        "[pscustomobject]@{ pid=[int]$_.ProcessId; start=$_.CreationDate.ToUniversalTime().ToString('o'); cmd=$_.CommandLine } } | ConvertTo-Json -Compress";
      const r = await this.exec(...PS(script), 30_000);
      return parseWindowsProcs(r.stdout);
    }
    const r = await this.exec("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", ids.join(",")]);
    return parsePosixPs(r.stdout);
  }

  async info(pid: number): Promise<ProcInfo | undefined> {
    return (await this.infoMany([pid])).get(pid);
  }

  /** Every TCP listener on this machine with the pid that owns it. */
  async listeners(): Promise<Listener[]> {
    if (this.win) {
      const ps = await this.exec(...PS("Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress"), 30_000);
      const a = parseNetTcp(ps.stdout);
      if (a.length > 0 || ps.code === 0) return a;
      return parseNetstat((await this.exec("netstat", ["-ano", "-p", "TCP"], 30_000)).stdout);
    }
    const r = await this.exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], 30_000);
    if (!r.missing) return parseLsof(r.stdout);
    return parseSs((await this.exec("ss", ["-ltnpH"])).stdout);
  }

  async listenersOn(port: number): Promise<Listener[]> {
    return (await this.listeners()).filter((l) => l.port === port);
  }

  private async waitGone(pid: number, ms: number): Promise<boolean> {
    const until = this.now() + ms;
    for (;;) {
      if (!this.alive(pid)) return true;
      if (this.now() >= until) return false;
      await this.wait(50);
    }
  }

  private async hardStop(pid: number): Promise<void> {
    if (this.win) { await this.exec("taskkill", ["/PID", String(pid), "/T", "/F"]); return; }
    try { this.signal(pid, "SIGKILL"); } catch { /* already gone */ }
  }

  /**
   * End one process. The caller has already checked that the pid is the one it recorded: nothing
   * in here looks at identity. POSIX: SIGTERM, the grace, SIGKILL. Windows (or the test override):
   * ask, the grace, then the hard stop — never before the grace is over.
   */
  async end(pid: number, o: EndOptions = {}): Promise<EndResult> {
    const t0 = this.now();
    const grace = o.graceMs ?? graceMs();
    const done = (how: EndHow, askAccepted?: boolean): EndResult => ({ how, ms: this.now() - t0, askAccepted });
    if (!this.alive(pid)) return done("gone");
    if (this.asksFirst) {
      let accepted = false;
      if (o.ask) { try { accepted = await o.ask(); } catch { accepted = false; } }
      if (await this.waitGone(pid, grace)) return done("asked", accepted);
      await this.hardStop(pid);
      return (await this.waitGone(pid, 3000)) ? done("forced", accepted) : done("survived", accepted);
    }
    try { this.signal(pid, "SIGTERM"); } catch { /* raced with its own exit */ }
    if (await this.waitGone(pid, grace)) return done("term");
    await this.hardStop(pid);
    return (await this.waitGone(pid, 3000)) ? done("forced") : done("survived");
  }
}

export const platformProc = new PlatformProc();

// ---- spawning --------------------------------------------------------------------------------------

/**
 * Every child C64RE starts for itself goes through one of these two, so none of them opens a console
 * window (`windowsHide`) and none is a shell (`shell: true` makes the recorded pid a cmd.exe that
 * can die while the child it started keeps running).
 */
export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { stdio: "ignore", ...opts, detached: true, windowsHide: true, shell: false });
}

/** A child that lives and dies with its parent. */
export function spawnHidden(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { ...opts, windowsHide: true, shell: false });
}
