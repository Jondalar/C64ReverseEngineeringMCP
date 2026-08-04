// Spec 771.1 — the ONE place that decides HOW to launch the runtime daemon process.
//
// Default = the TRX64 Rust daemon (the sibling `../TRX64/target/release/trx64-daemon`,
// launched with `--stream` for the UI A/V hub). It speaks the same WS JSON-RPC 2.0 on
// `--port` and accepts `--project` (ADR-066: the drop-in boundary is the daemon PROCESS,
// not an in-process core swap). The TS daemon is now the FALLBACK + golden oracle:
//   - `C64RE_RUNTIME_TS=1`        → force the TS daemon (A/B against the oracle).
//   - `C64RE_RUNTIME_BIN=<path>`  → launch a specific external daemon binary (highest).
//   - `C64RE_TRX64_BIN=<path>`    → a TRX64 daemon elsewhere than the sibling default.
// If no TRX64 binary is found (and TS isn't forced) it falls back to the built TS `dist/`
// (preferred for V8 speed) then `tsx`-from-src.
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

  // 2) TRX64 is the DEFAULT + ONLY customer runtime — the sibling release daemon. The TS
  //    daemon (tiers 3/4 below) is dev/oracle-only and reachable ONLY behind
  //    `C64RE_RUNTIME_TS=1`, NEVER as a silent fallback: a missing TRX64 binary returns
  //    `"none"` so the caller emits the actionable "start the daemon" error instead of
  //    leaking the TS runtime onto the MCP customer surface. Path overridable via
  //    `C64RE_TRX64_BIN` (on Windows the .exe suffix is added / accepted automatically).
  const forceTs = process.env.C64RE_RUNTIME_TS?.trim() === "1";
  if (!forceTs) {
    const winExe = process.platform === "win32" ? ".exe" : "";
    let trx64 =
      process.env.C64RE_TRX64_BIN?.trim() ||
      resolvePath(repoRoot, "..", "TRX64", "target", "release", `trx64-daemon${winExe}`);
    // Accept an explicit C64RE_TRX64_BIN given without the .exe suffix on Windows.
    if (winExe && !existsSync(trx64) && existsSync(trx64 + winExe)) trx64 += winExe;
    if (existsSync(trx64)) {
      const extra = (process.env.C64RE_RUNTIME_BIN_ARGS?.trim() || "")
        .split(/\s+/)
        .filter(Boolean);
      // Spec 767 — the TRX64 daemon streams BY DEFAULT (the C64's work is always visible;
      // presentation is no longer gated behind `--stream`). So no flag here; `--headless`
      // would be the opt-out (byte-exact oracle / silent tool daemons), which the UI never
      // wants. Legacy `--stream` is still accepted by the daemon as a no-op.
      return { cmd: trx64, args: [...stdArgs, ...extra], mode: "external-bin" };
    }
    // TRX64 wanted but not built → do NOT silently spawn the TS daemon. "none" makes the
    // caller surface the actionable error; the TS runtime stays a dev-only opt-in.
    return { cmd: "", args: [], mode: "none" };
  }

  // ---- DEV / ORACLE ONLY (C64RE_RUNTIME_TS=1) ----------------------------------------
  // The in-repo TypeScript daemon. Never the customer default; this is the A/B parity
  // oracle + fidelity harness for TRX64 development. Unreachable by the LLM (env-gated).
  const tsArgs = [...stdArgs, ...(devSamples ? ["--dev-samples"] : [])];

  // 3) built TS daemon.
  const distEntry = resolvePath(repoRoot, "dist/runtime/headless/daemon/run.js");
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry, ...tsArgs], mode: "dist" };
  }

  // 4) tsx-from-src fallback (loud — ≈4fps vs 50fps).
  const tsxBin = resolvePath(repoRoot, "node_modules", ".bin", "tsx");
  const srcEntry = resolvePath(repoRoot, "src/runtime/headless/daemon/run.ts");
  if (existsSync(tsxBin) && existsSync(srcEntry)) {
    return {
      cmd: tsxBin,
      args: [srcEntry, ...tsArgs],
      mode: "tsx",
      warn:
        "TS runtime daemon (C64RE_RUNTIME_TS=1) falling back to tsx-from-src — ~12× slower " +
        "(≈4fps). Run `npm run build:mcp` for full speed (50fps).",
    };
  }

  return { cmd: "", args: [], mode: "none" };
}
