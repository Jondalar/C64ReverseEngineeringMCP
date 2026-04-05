import { extname } from "node:path";

export type ViceMediaType = "prg" | "crt" | "d64" | "g64";

export type ViceSessionState = "starting" | "running" | "stopping" | "stopped" | "failed";

export type ViceStopReason =
  | "user_request"
  | "process_exit"
  | "launch_failed"
  | "sigterm"
  | "sigkill"
  | "already_stopped";

export interface ViceMediaConfig {
  path: string;
  type: ViceMediaType;
  autostart: boolean;
}

export interface ViceRuntimeTraceConfig {
  enabled: boolean;
  intervalMs: number;
  cpuHistoryCount: number;
  monitorChisLines: number;
}

export interface ViceWorkspacePaths {
  sessionDir: string;
  traceDir: string;
  viceDir: string;
  xdgConfigHome: string;
  viceUserDir: string;
  sessionPath: string;
  eventsLogPath: string;
  summaryPath: string;
  traceSnapshotPath: string;
  traceAnalysisPath: string;
  runtimeTracePath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  viceLogPath: string;
  monitorLogPath: string;
  vicercPath: string;
  overlayPath: string;
}

export interface ViceConfigWorkspace {
  sourceConfigPath: string;
  sourceConfigDir: string;
  emulatorSection: string;
  copiedHotkeyFiles: string[];
  paths: ViceWorkspacePaths;
}

export interface ViceSessionRecord {
  sessionId: string;
  projectDir: string;
  state: ViceSessionState;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  pid?: number;
  viceBinary?: string;
  command?: string[];
  monitorPort: number;
  monitorReady: boolean;
  media?: ViceMediaConfig;
  runtimeTrace?: ViceRuntimeTraceConfig;
  workspace: ViceWorkspacePaths;
  configWorkspace: {
    sourceConfigPath: string;
    sourceConfigDir: string;
    emulatorSection: string;
    copiedHotkeyFiles: string[];
  };
  stopReason?: ViceStopReason;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastError?: string;
}

export interface ViceSessionStartOptions {
  mediaPath?: string;
  mediaType?: ViceMediaType;
  autostart?: boolean;
  runtimeTrace?: ViceRuntimeTraceConfig;
}

export interface ViceSessionStopResult {
  record: ViceSessionRecord;
  stopMethod: "wait" | "sigterm" | "sigkill" | "already_stopped";
}

export interface ViceTraceSummary {
  sessionId: string;
  state: ViceSessionState;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  durationMs?: number;
  pid?: number;
  viceBinary?: string;
  monitorPort: number;
  monitorReady: boolean;
  media?: ViceMediaConfig;
  stopReason?: ViceStopReason;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastError?: string;
}

export interface ViceTraceAnalysis {
  sessionId: string;
  media?: ViceMediaConfig;
  state: ViceSessionState;
  stopReason?: ViceStopReason;
  durationMs?: number;
  cpuHistoryItems: number;
  currentPc?: number;
  currentPcName?: string;
  regionBuckets: Record<string, number>;
  topPcs: Array<{ pc: number; count: number }>;
  eventCounts: Record<string, number>;
  artifacts: {
    sessionPath: string;
    summaryPath: string;
    eventsLogPath: string;
    traceSnapshotPath: string;
    traceAnalysisPath: string;
    runtimeTracePath: string;
  };
}

export function inferViceMediaType(filePath: string): ViceMediaType | undefined {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".prg":
      return "prg";
    case ".crt":
      return "crt";
    case ".d64":
      return "d64";
    case ".g64":
      return "g64";
    default:
      return undefined;
  }
}
