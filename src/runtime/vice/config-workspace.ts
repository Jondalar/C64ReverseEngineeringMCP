import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ViceConfigWorkspace } from "./types.js";

const DEFAULT_VICE_CONFIG_DIR = join(homedir(), ".config", "vice");

interface CreateViceConfigWorkspaceOptions {
  projectDir: string;
  monitorPort: number;
  monitorChisLines?: number;
}

export async function createViceConfigWorkspace(
  options: CreateViceConfigWorkspaceOptions,
): Promise<ViceConfigWorkspace> {
  const sourceConfigPath = resolveViceConfigPath();
  if (!existsSync(sourceConfigPath)) {
    throw new Error(`VICE config not found at ${sourceConfigPath}. Set C64RE_VICE_CONFIG_PATH if needed.`);
  }

  const sourceConfigDir = dirname(sourceConfigPath);
  const sessionId = createSessionId();
  const sessionDir = join(options.projectDir, "analysis", "runtime", sessionId);
  const traceDir = join(sessionDir, "trace");
  const viceDir = join(sessionDir, "vice");
  const xdgConfigHome = join(sessionDir, "xdg");
  const viceUserDir = join(xdgConfigHome, "vice");
  const sessionPath = join(sessionDir, "session.json");
  const eventsLogPath = join(traceDir, "events.jsonl");
  const summaryPath = join(traceDir, "summary.json");
  const traceSnapshotPath = join(traceDir, "trace-snapshot.json");
  const traceAnalysisPath = join(traceDir, "trace-analysis.json");
  const runtimeTracePath = join(traceDir, "runtime-trace.jsonl");
  const stdoutLogPath = join(viceDir, "stdout.log");
  const stderrLogPath = join(viceDir, "stderr.log");
  const viceLogPath = join(viceDir, "vice.log");
  const monitorLogPath = join(viceDir, "monitor.log");
  const vicercPath = join(viceUserDir, "vicerc");
  const overlayPath = join(viceUserDir, "overlay.vicerc");

  await mkdir(traceDir, { recursive: true });
  await mkdir(viceDir, { recursive: true });
  await mkdir(viceUserDir, { recursive: true });

  await copyFile(sourceConfigPath, vicercPath);

  const copiedHotkeyFiles: string[] = [];
  for (const entry of await readdir(sourceConfigDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".vhk")) {
      continue;
    }
    const sourcePath = join(sourceConfigDir, entry.name);
    const targetPath = join(viceUserDir, entry.name);
    await copyFile(sourcePath, targetPath);
    copiedHotkeyFiles.push(targetPath);
  }

  const vicercText = await readFile(vicercPath, "utf8");
  const emulatorSection = detectPrimaryEmulatorSection(vicercText);
  const overlayText = [
    `[${emulatorSection}]`,
    "SaveResourcesOnExit=0",
    "ConfirmOnExit=0",
    ...(options.monitorChisLines ? [`MonitorChisLines=${options.monitorChisLines}`] : []),
    `BinaryMonitorServerAddress=${encodeViceString(`127.0.0.1:${options.monitorPort}`)}`,
    `LogFileName=${encodeViceString(viceLogPath)}`,
    "",
  ].join("\n");
  await writeFile(overlayPath, overlayText, "utf8");

  return {
    sourceConfigPath,
    sourceConfigDir,
    emulatorSection,
    copiedHotkeyFiles,
    paths: {
      sessionDir,
      traceDir,
      viceDir,
      xdgConfigHome,
      viceUserDir,
      sessionPath,
      eventsLogPath,
      summaryPath,
      traceSnapshotPath,
      traceAnalysisPath,
      runtimeTracePath,
      stdoutLogPath,
      stderrLogPath,
      viceLogPath,
      monitorLogPath,
      vicercPath,
      overlayPath,
    },
  };
}

function resolveViceConfigPath(): string {
  if (process.env.C64RE_VICE_CONFIG_PATH) {
    return resolve(process.env.C64RE_VICE_CONFIG_PATH);
  }
  if (process.env.C64RE_VICE_CONFIG_DIR) {
    return resolve(process.env.C64RE_VICE_CONFIG_DIR, "vicerc");
  }
  return resolve(DEFAULT_VICE_CONFIG_DIR, "vicerc");
}

function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function detectPrimaryEmulatorSection(vicercText: string): string {
  const matches = [...vicercText.matchAll(/^\[([^\]]+)\]\s*$/gm)];
  for (const match of matches) {
    const section = match[1]?.trim();
    if (section && section !== "Version") {
      return section;
    }
  }
  return "C64SC";
}

function encodeViceString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
