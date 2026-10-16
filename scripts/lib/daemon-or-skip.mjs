// The trx64-daemon a runtime smoke needs, found the one standard way (findDaemon: C64RE_RUNTIME_BIN,
// the sibling build, the installed pin) — or a LOUD skip. A runner without a daemon is not a failure
// and it is not a pass: the script says SKIPPED, names what it did not prove, and exits 0.
import { findDaemon } from "./e2e-906-harness.mjs";

export async function daemonOrSkip(title) {
  const bin = await findDaemon();
  if (bin) { process.env.C64RE_RUNTIME_BIN = bin; return bin; } // children resolving a daemon (runtime-daemon.mjs, the MCP) get the same one
  console.log(`SKIPPED ${title}: no trx64-daemon found (set C64RE_RUNTIME_BIN=<binary>) — the runtime half is NOT passed.`);
  process.exit(0);
}

/** `n` consecutive free ports on 127.0.0.1 (a daemon, its relay, a UI), never :4312. */
export async function freePortBlock(n) {
  const { freePort, listening } = await import("./e2e-906-harness.mjs");
  for (let tries = 0; tries < 50; tries++) {
    const base = await freePort();
    if (base + n > 65000 || (base <= 4312 && base + n > 4312)) continue;
    let all = true;
    for (let i = 1; i < n; i++) if (await listening(base + i)) { all = false; break; }
    if (all) return base;
  }
  throw new Error(`no block of ${n} free ports`);
}
