export interface HeadlessCpuState {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface HeadlessLoaderState {
  logicalFile: number | null;
  device: number | null;
  secondaryAddress: number | null;
  fileName: string;
  fileNameBytes: number[];
}

export interface HeadlessSavedFile {
  name: string;
  bytes: Uint8Array;
  startAddress: number;
  endAddress: number;
  createdAt: string;
}

export interface HeadlessLoadEvent {
  name: string;
  device: number;
  secondaryAddress: number;
  startAddress: number;
  endAddress: number;
  source: string;
  createdAt: string;
}

export interface HeadlessTraceEvent {
  index: number;
  pc: number;
  opcode: number;
  bytes: number[];
  before: HeadlessCpuState;
  after: HeadlessCpuState;
  trap?: string;
  note?: string;
}

export interface HeadlessBreakpoint {
  address: number;
  temporary?: boolean;
}

export type HeadlessSessionState = "idle" | "running" | "stopped" | "error";

export interface HeadlessSessionRecord {
  sessionId: string;
  projectDir: string;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  state: HeadlessSessionState;
  prgPath?: string;
  diskPath?: string;
  entryPoint?: number;
  inferredBasicSys?: number;
  currentPc: number;
  lastTrap?: string;
  lastError?: string;
  loaderState: HeadlessLoaderState;
  recentTrace: HeadlessTraceEvent[];
  loadEvents: HeadlessLoadEvent[];
  savedFiles: HeadlessSavedFile[];
}

export interface HeadlessRunResult {
  reason: "step_limit" | "breakpoint" | "stop_pc" | "trap_error";
  stepsExecuted: number;
  currentPc: number;
  lastTrap?: string;
}
