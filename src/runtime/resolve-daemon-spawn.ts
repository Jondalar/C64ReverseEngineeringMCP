// Spec 771.1 — the ONE place that decides HOW to launch the runtime daemon process.
//
// The runtime is the sibling TRX64 release daemon (`../TRX64/target/release/trx64-daemon`).
// It speaks WS JSON-RPC 2.0 on `--port` and accepts `--project` (ADR-066: the drop-in
// boundary is the daemon PROCESS, not an in-process core swap).
//
//   - `C64RE_RUNTIME_BIN=<path>`  → launch a specific external daemon binary (highest).
//   - `C64RE_TRX64_BIN=<path>`    → a TRX64 daemon elsewhere than the sibling default.
//
// Spec 806: there is no second tier. The in-repo TypeScript daemon is gone, so a missing
// binary returns `"none"` and the caller emits the actionable setup recipe — never a
// silent downgrade to something slower or different.
//
// All three spawn sites — the MCP client (`daemon-client.ts`), the workspace bootstrap
// (`scripts/workspace.mjs`), and the UI dev plugin (`ui/vite.config.ts`) — route through
// this helper so the backend choice can never drift between them.
//
// CLI contract (verified 2026-06-25 against trx64-daemon clap):
//   universal : --project <dir> --port <port>
//   external  : extra args via `C64RE_RUNTIME_BIN_ARGS` (space-split) and/or env
//               passthrough (e.g. `TRX64_STREAM=1` to enable A/V push for the UI).

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type DaemonSpawnMode = "external-bin" | "none";

export interface DaemonSpawn {
  /** Executable to spawn ("" only when mode === "none"). */
  cmd: string;
  /** Full argv. */
  args: string[];
  /** Which backend was chosen — for logging / acceptance checks. */
  mode: DaemonSpawnMode;
  /** Non-fatal warning to log. */
  warn?: string;
}

/**
 * Resolve how to launch the runtime daemon. Pure (no spawn, no side effects) so every
 * caller can decide + log consistently. `repoRoot` is the c64re repo root; `projectDir`
 * the resolved per-project dir; `port` the WS port.
 */
export function resolveDaemonSpawn(opts: {
  repoRoot: string;
  projectDir: string;
  port: string;
  devSamples?: boolean;
}): DaemonSpawn {
  const { repoRoot, projectDir, port } = opts;
  const stdArgs = ["--project", projectDir, "--port", port];

  // 1) explicit external binary — highest precedence. Extra args opt-in via
  //    C64RE_RUNTIME_BIN_ARGS; A/V for the UI is best enabled via env passthrough
  //    (TRX64_STREAM=1), which the spawning caller already forwards.
  const bin = process.env.C64RE_RUNTIME_BIN?.trim();
  if (bin) {
    const extra = (process.env.C64RE_RUNTIME_BIN_ARGS?.trim() || "")
      .split(/\s+/)
      .filter(Boolean);
    return { cmd: bin, args: [...stdArgs, ...extra], mode: "external-bin" };
  }

  // 2) the sibling release daemon — the default and only runtime. Path overridable via
  //    `C64RE_TRX64_BIN` (on Windows the .exe suffix is added / accepted automatically).
  const winExe = process.platform === "win32" ? ".exe" : "";
  // Spec 836 — a git WORKTREE is not beside the sibling. `repoRoot/..` resolves
  // to `.claude/worktrees/` for an agent working in one, so the daemon looked
  // like it was not installed and every gate that needs it skipped "loudly"
  // while being wrong. The main checkout is two levels up from a worktree
  // (`<repo>/.claude/worktrees/<name>`), so that candidate is tried too. Found
  // by an agent whose live half was skipping for a runtime that was right
  // there.
  const siblingFrom = (root: string) => resolvePath(root, "..", "TRX64", "target", "release", `trx64-daemon${winExe}`);
  const worktreeMain = /[/\\]\.claude[/\\]worktrees[/\\][^/\\]+$/.test(repoRoot)
    ? resolvePath(repoRoot, "..", "..", "..")
    : undefined;
  let trx64 =
    process.env.C64RE_TRX64_BIN?.trim() ||
    [siblingFrom(repoRoot), ...(worktreeMain ? [siblingFrom(worktreeMain)] : [])].find((p) => existsSync(p)) ||
    siblingFrom(repoRoot);
  // Accept an explicit C64RE_TRX64_BIN given without the .exe suffix on Windows.
  if (winExe && !existsSync(trx64) && existsSync(trx64 + winExe)) trx64 += winExe;
  if (existsSync(trx64)) {
    const extra = (process.env.C64RE_RUNTIME_BIN_ARGS?.trim() || "")
      .split(/\s+/)
      .filter(Boolean);
    // Spec 767 — the daemon streams BY DEFAULT (the C64's work is always visible;
    // presentation is no longer gated behind `--stream`). So no flag here; `--headless`
    // would be the opt-out (byte-exact oracle / silent tool daemons), which the UI never
    // wants. Legacy `--stream` is still accepted by the daemon as a no-op.
    return { cmd: trx64, args: [...stdArgs, ...extra], mode: "external-bin" };
  }

  // Not built → "none" makes the caller surface the actionable setup recipe. There is
  // no fallback tier to downgrade to (Spec 806).
  return { cmd: "", args: [], mode: "none" };
}
