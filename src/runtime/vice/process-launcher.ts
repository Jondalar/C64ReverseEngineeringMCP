import { accessSync, closeSync, constants, openSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { connect } from "node:net";
import type { ViceMediaConfig, ViceWorkspacePaths } from "./types.js";

interface LaunchViceProcessOptions {
  workspace: ViceWorkspacePaths;
  projectDir: string;
  monitorPort: number;
  media?: ViceMediaConfig;
}

export interface LaunchedViceProcess {
  child: ChildProcess;
  command: string[];
  binaryPath: string;
}

export async function launchViceProcess(options: LaunchViceProcessOptions): Promise<LaunchedViceProcess> {
  const binaryPath = resolveViceBinaryPath();
  const args = buildViceArgs(options.workspace, options.monitorPort, options.media);
  const stdoutFd = openSync(options.workspace.stdoutLogPath, "a");
  const stderrFd = openSync(options.workspace.stderrLogPath, "a");

  try {
    const child = spawn(binaryPath, args, {
      cwd: options.projectDir,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: options.workspace.xdgConfigHome,
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    await waitForChildSpawn(child);

    return {
      child,
      command: [binaryPath, ...args],
      binaryPath,
    };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

export async function waitForMonitorPort(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

export async function isMonitorPortOpen(port: number): Promise<boolean> {
  return canConnect(port);
}

function buildViceArgs(workspace: ViceWorkspacePaths, monitorPort: number, media?: ViceMediaConfig): string[] {
  const args = [
    "-config",
    workspace.vicercPath,
    "-addconfig",
    workspace.overlayPath,
    "-binarymonitor",
    "-binarymonitoraddress",
    `ip4://127.0.0.1:${monitorPort}`,
    "-monlog",
    "-monlogname",
    workspace.monitorLogPath,
    "-logfile",
    workspace.viceLogPath,
  ];

  if (media) {
    switch (media.type) {
      case "prg":
        if (!media.autostart) {
          throw new Error("PRG media currently requires autostart on session start.");
        }
        args.push("-autostart", media.path);
        break;
      case "crt":
        args.push("-cartcrt", media.path);
        break;
      case "d64":
      case "g64":
        if (media.autostart) {
          args.push("-autostart", media.path);
        } else {
          args.push("-8", media.path);
        }
        break;
      default:
        throw new Error(`Unsupported media type: ${media.type}`);
    }
  }

  return args;
}

function resolveViceBinaryPath(): string {
  const candidates = [
    process.env.C64RE_VICE_BIN,
    ...resolveFromPath("x64sc"),
    "/Applications/vice-arm64-gtk3-3.10/bin/x64sc",
    "/Applications/vice-arm64-gtk3-3.9/bin/x64sc",
    "/Applications/vice-arm64-gtk3-3.8/bin/x64sc",
    "/Applications/vice-arm64-gtk3-3.7/bin/x64sc",
    "/Applications/vice-arm64-gtk3-3.6.0/bin/x64sc",
    "/Applications/vice-arm64-gtk3-3.6/bin/x64sc",
    "/Applications/vice-gtk3-3.10/bin/x64sc",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    try {
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      // try next
    }
  }

  throw new Error("Could not find x64sc. Put it in PATH or set C64RE_VICE_BIN.");
}

function resolveFromPath(binaryName: string): string[] {
  const pathValue = process.env.PATH ?? "";
  const parts = pathValue.split(delimiter).filter(Boolean);
  return parts.map((entry) => join(entry, binaryName));
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
