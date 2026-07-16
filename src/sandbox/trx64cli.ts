// Shared TRX64 `trx64cli sandbox` bridge (Spec 788).
//
// Spec 788 reroutes the C64RE sandbox tools off the flat-64K TS `Cpu6502`
// shadow onto the sibling TRX64 real 6502 core (`trx64cli sandbox --json`).
// Slice 1 (`sandbox_depack`) and the tail reroute (`sandbox_6502_run`) both
// need to (a) resolve the sibling binary, (b) shell out with `--json`, and
// (c) parse the result — so those helpers live here, one copy, reused by both.
//
// A missing `trx64cli` is an actionable error, not a silent drop back onto the
// shadow (single-path doctrine): the caller must build it in ../TRX64 or point
// `C64RE_TRX64CLI_BIN` at the binary.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// The c64re repo root, from this module's location
// (<repo>/{dist,src}/sandbox/trx64cli.{js,ts} → ../.. = <repo>).
// Mirrors runtime-daemon-client.ts's repo-root derivation.
export function repoRoot(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// Resolve the sibling TRX64 `trx64cli` binary, mirroring resolveDaemonSpawn's
// sibling resolution for `trx64-daemon`. `C64RE_TRX64CLI_BIN` overrides.
export function resolveTrx64Cli(): string {
  const override = process.env.C64RE_TRX64CLI_BIN?.trim();
  if (override) return override;
  return resolvePath(repoRoot(), "..", "TRX64", "target", "release", "trx64cli");
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const hx4 = (n: number): string => `$${(n & 0xffff).toString(16).padStart(4, "0")}`;
export const hx2 = (n: number): string => `$${(n & 0xff).toString(16).padStart(2, "0")}`;

// The `trx64cli sandbox --json` result envelope (see
// TRX64/crates/trx64-cli/src/sandbox_cmd.rs `run_sandbox`).
export interface Trx64SandboxJson {
  ok: boolean;
  stopReason: string; // sentinel_rts | stop_pc | max_steps | stream_exhausted
  pc: number;
  cycles: number;
  steps: number;
  writtenSpan: { lo: number; hi: number } | null;
  writtenRuns: Array<{ lo: number; hi: number }>;
  finalRegs: { a: number; x: number; y: number; sp: number; p: number };
  streamPos: number;
  harvest: { addr: number; len: number; hex: string };
  harvests: Array<{ addr: number; len: number; hex: string }>;
}

export class Trx64CliError extends Error {}

// Run `trx64cli sandbox …` and parse the `--json` envelope. `args` must already
// include "sandbox" as the first element and "--json". Throws Trx64CliError on a
// missing binary or a non-zero exit (surfacing stderr).
export function runTrx64Sandbox(cli: string, args: string[]): Trx64SandboxJson {
  if (!existsSync(cli)) {
    throw new Trx64CliError(
      `trx64cli not found at ${cli}. Build it with ` +
        `\`cargo build --release --bin trx64cli\` in the sibling TRX64 repo, ` +
        `or point C64RE_TRX64CLI_BIN at the binary.`,
    );
  }
  let stdout: string;
  try {
    stdout = execFileSync(cli, args, {
      env: { ...process.env, C64RE_ROOT: process.env.C64RE_ROOT ?? repoRoot() },
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Trx64CliError(`trx64cli sandbox failed: ${stderr || err.message || "unknown error"}`);
  }
  return JSON.parse(stdout) as Trx64SandboxJson;
}

// Run any `trx64cli … --json` subcommand and return the parsed JSON (generic — e.g.
// `diff A.c64re B.c64re --json`, Spec 794). Throws Trx64CliError on a missing binary
// or non-zero exit (surfacing stderr).
export function runTrx64CliJson(cli: string, args: string[]): unknown {
  if (!existsSync(cli)) {
    throw new Trx64CliError(
      `trx64cli not found at ${cli}. Build it with ` +
        `\`cargo build --release --bin trx64cli\` in the sibling TRX64 repo, ` +
        `or point C64RE_TRX64CLI_BIN at the binary.`,
    );
  }
  let stdout: string;
  try {
    stdout = execFileSync(cli, args, {
      env: { ...process.env, C64RE_ROOT: process.env.C64RE_ROOT ?? repoRoot() },
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Trx64CliError(`trx64cli ${args[0] ?? ""} failed: ${stderr || err.message || "unknown error"}`);
  }
  return JSON.parse(stdout);
}
