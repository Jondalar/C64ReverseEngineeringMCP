// Spec 771.1 — the ONE place that decides HOW to launch the runtime daemon process.
//
// Default = the TS daemon (built `dist/` preferred for full V8 speed, `tsx`-from-src
// fallback). Override with `C64RE_RUNTIME_BIN=<path>` to launch an EXTERNAL daemon
// binary instead — e.g. the TRX64 Rust daemon, which speaks the same WS JSON-RPC 2.0
// on `--port` and accepts `--project` (ADR-066: the drop-in boundary is the daemon
// PROCESS, not an in-process core swap). The TS runtime stays the default + golden
// oracle; the swap is A/B-able by setting/unsetting one env var.
//
// All three spawn sites — the MCP client (`runtime-daemon-client.ts`), the workspace
// bootstrap (`scripts/workspace.mjs`), and the UI dev plugin (`ui/vite.config.ts`) —
// route through this helper so the backend choice can never drift between them.
//
// CLI contract (verified 2026-06-25 against trx64-daemon clap):
//   universal : --project <dir> --port <port>     (both TS + external bin)
//   TS-only   : --dev-samples                      (trx64-daemon has NO such flag →
//                                                    NEVER passed to the external bin)
//   external  : extra args via `C64RE_RUNTIME_BIN_ARGS` (space-split) and/or env
//               passthrough (e.g. `TRX64_STREAM=1` to enable A/V push for the UI).

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type DaemonSpawnMode = "external-bin" | "dist" | "tsx" | "none";

export interface DaemonSpawn {
  /** Executable to spawn ("" only when mode === "none"). */
  cmd: string;
  /** Full argv (entry file already included for node/tsx modes). */
  args: string[];
  /** Which backend was chosen — for logging / acceptance checks. */
  mode: DaemonSpawnMode;
  /** Non-fatal warning to log (e.g. the slow tsx fallback). */
  warn?: string;
}

/**
 * Resolve how to launch the runtime daemon. Pure (no spawn, no side effects) so every
 * caller can decide + log consistently. `repoRoot` is the c64re repo root; `projectDir`
 * the resolved per-project dir; `port` the WS port; `devSamples` opts the repo
 * `samples/` corpus in (TS daemon only).
 */
export function resolveDaemonSpawn(opts: {
  repoRoot: string;
  projectDir: string;
  port: string;
  devSamples?: boolean;
}): DaemonSpawn {
  const { repoRoot, projectDir, port, devSamples } = opts;
  const stdArgs = ["--project", projectDir, "--port", port];

  // 1) explicit external binary (TRX64 etc.) — highest precedence. NEVER pass
  //    --dev-samples (trx64-daemon's clap rejects unknown args). Extra args opt-in
  //    via C64RE_RUNTIME_BIN_ARGS; A/V for the UI is best enabled via env passthrough
  //    (TRX64_STREAM=1), which the spawning caller already forwards.
  const bin = process.env.C64RE_RUNTIME_BIN?.trim();
  if (bin) {
    const extra = (process.env.C64RE_RUNTIME_BIN_ARGS?.trim() || "")
      .split(/\s+/)
      .filter(Boolean);
    return { cmd: bin, args: [...stdArgs, ...extra], mode: "external-bin" };
  }

  const tsArgs = [...stdArgs, ...(devSamples ? ["--dev-samples"] : [])];

  // 2) built TS daemon (preferred — tsx-from-src runs the ~1MHz loop ~12× slower).
  const distEntry = resolvePath(repoRoot, "dist/runtime/headless/daemon/run.js");
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry, ...tsArgs], mode: "dist" };
  }

  // 3) tsx-from-src fallback (loud — ≈4fps vs 50fps).
  const tsxBin = resolvePath(repoRoot, "node_modules", ".bin", "tsx");
  const srcEntry = resolvePath(repoRoot, "src/runtime/headless/daemon/run.ts");
  if (existsSync(tsxBin) && existsSync(srcEntry)) {
    return {
      cmd: tsxBin,
      args: [srcEntry, ...tsArgs],
      mode: "tsx",
      warn:
        "runtime daemon falling back to tsx-from-src — ~12× slower (≈4fps). " +
        "Run `npm run build:mcp` for full speed (50fps).",
    };
  }

  return { cmd: "", args: [], mode: "none" };
}
