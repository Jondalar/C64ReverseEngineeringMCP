export interface HeadlessCpuState {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface HeadlessBankInfo {
  cpuPortDirection: number;
  cpuPortValue: number;
  basicVisible: boolean;
  kernalVisible: boolean;
  ioVisible: boolean;
  charVisible: boolean;
}

export interface HeadlessIrqState {
  irqPending: boolean;
  nmiPending: boolean;
  irqCount: number;
  nmiCount: number;
}

export interface HeadlessIoInterruptState {
  vicIrqStatus: number;
  vicIrqMask: number;
  cia1Status: number;
  cia1Mask: number;
  cia2Status: number;
  cia2Mask: number;
}

export type HeadlessCartridgeMapperType = "easyflash" | "magicdesk" | "ocean";

export interface HeadlessCartridgeState {
  path: string;
  name: string;
  mapperType: HeadlessCartridgeMapperType;
  currentBank: number;
  controlRegister?: number;
  exrom: number;
  game: number;
  romlBanks: number[];
  romhBanks: number[];
}

export type HeadlessAccessKind = "read" | "write";

export interface HeadlessMemoryAccess {
  kind: HeadlessAccessKind;
  address: number;
  value: number;
  region: string;
}

export interface HeadlessStackSnapshot {
  sp: number;
  bytes: number[];
}

export interface HeadlessWatchRange {
  id: string;
  name: string;
  start: number;
  end: number;
  includeBytes: boolean;
}

export interface HeadlessWatchHit {
  id: string;
  name: string;
  start: number;
  end: number;
  touchedBy: HeadlessAccessKind[];
  bytes?: number[];
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
  beforeStack: HeadlessStackSnapshot;
  afterStack: HeadlessStackSnapshot;
  bankInfo: HeadlessBankInfo;
  irqState: HeadlessIrqState;
  accesses: HeadlessMemoryAccess[];
  watchHits: HeadlessWatchHit[];
  trap?: string;
  note?: string;
}

export interface HeadlessBreakpoint {
  id: string;
  kind: "exec" | "read" | "write" | "access";
  start: number;
  end: number;
  temporary?: boolean;
  label?: string;
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
  crtPath?: string;
  entryPoint?: number;
  inferredBasicSys?: number;
  currentPc: number;
  lastTrap?: string;
  lastError?: string;
  loaderState: HeadlessLoaderState;
  breakpoints: HeadlessBreakpoint[];
  watchRanges: HeadlessWatchRange[];
  irqState: HeadlessIrqState;
  ioInterrupts: HeadlessIoInterruptState;
  cartridge?: HeadlessCartridgeState;
  recentTrace: HeadlessTraceEvent[];
  loadEvents: HeadlessLoadEvent[];
  savedFiles: HeadlessSavedFile[];
}

export interface HeadlessRunResult {
  reason: "step_limit" | "breakpoint" | "watchpoint" | "stop_pc" | "trap_error";
  stepsExecuted: number;
  currentPc: number;
  lastTrap?: string;
  breakpointId?: string;
}
