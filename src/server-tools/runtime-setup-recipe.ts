// Spec 800 §B/§D — the single source of truth for runtime setup guidance.
//
// This is the ONE customer-reachable place the runtime backend is named, and it is emitted
// ONLY when the runtime daemon is unavailable or its protocol version does not match. During
// normal RE work the agent never sees any of this — it drives one runtime through the
// `runtime_*` tools and stays blind to what is behind them (see docs/agent-doctrine.md §1.1).
//
// Keep this recipe accurate + per-OS. It is authoritative (a typed const, not a doc read at
// runtime), so it can never be missing and is covered by the grep gate.

/**
 * Breaking-epoch protocol version (Spec 800 §D). The daemon announces `runtime_version:
 * "trx64-runtime/N"`. Bump this ONLY on a wire-breaking protocol change, in lockstep with
 * the daemon (one commit across both repos). The client requires an EXACT match and
 * hard-fails otherwise — a stale/ahead daemon is a setup error, not a silent best-effort.
 */
export const EXPECTED_RUNTIME_PROTOCOL = 1;

/** Parse the integer N out of a daemon version string like "trx64-runtime/1". */
export function parseRuntimeProtocol(version: string | undefined | null): number | null {
  if (!version) return null;
  const m = /\/(\d+)\s*$/.exec(String(version).trim());
  return m ? Number(m[1]) : null;
}

/**
 * The per-OS setup recipe. `reason` (optional) is the one-line cause the caller detected
 * (e.g. "no daemon reachable at ws://127.0.0.1:4312" or a version mismatch). Returned as
 * plain text so a tool can drop it straight into its response for the user to act on.
 */
export function runtimeSetupRecipe(reason?: string): string {
  const win = process.platform === "win32";
  const bin = win ? "trx64-daemon.exe" : "trx64-daemon";
  const setEnv = (k: string, v: string) => (win ? `set ${k}=${v}` : `export ${k}=${v}`);
  const head = reason ? `The runtime is not available: ${reason}\n\n` : "";
  return (
    head +
    [
      "The RE runtime is a separate daemon process reached over WebSocket. Set one up (any one):",
      "",
      "  1) Build it from the sibling checkout (developer default):",
      "       cd ../TRX64",
      "       cargo build --release -p trx64-daemon",
      `     Needs the Rust toolchain + a C++ compiler (for the bundled audio core).`,
      `     Produces target/release/${bin}; C64RE finds the sibling path automatically`,
      "     and auto-spawns it.",
      "",
      "  2) Or point C64RE at a daemon you provide (prebuilt binary or another host):",
      `       ${setEnv("C64RE_TRX64_BIN", `<absolute path to ${bin}>`)}   # a built binary to auto-spawn`,
      `       ${setEnv("C64RE_RUNTIME_ENDPOINT", "ws://<host>:4312")}   # a daemon already running`,
      "",
      "  3) Or run the packaged container and point C64RE_RUNTIME_ENDPOINT at its WS port.",
      "",
      "After setup, retry — the runtime tools will connect. (For the internal parity oracle",
      "only, developers may set C64RE_ALLOW_INPROC_RUNTIME=1; not for normal use.)",
    ].join("\n")
  );
}
