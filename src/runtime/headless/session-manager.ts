import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Cpu6510 } from "./cpu6510.js";
import { HeadlessMemoryBus } from "./memory-bus.js";
import { DiskProvider, readPrgFile, type PrgFile } from "./providers.js";
import type {
  HeadlessBreakpoint,
  HeadlessCpuState,
  HeadlessLoadEvent,
  HeadlessLoaderState,
  HeadlessRunResult,
  HeadlessSavedFile,
  HeadlessSessionRecord,
  HeadlessTraceEvent,
} from "./types.js";

const KERNAL_SETLFS = 0xffba;
const KERNAL_SETNAM = 0xffbd;
const KERNAL_LOAD = 0xffd5;
const KERNAL_SAVE = 0xffd8;

const TRACE_LIMIT = 256;

export interface HeadlessSessionStartOptions {
  prgPath?: string;
  diskPath?: string;
  entryPc?: number;
}

export interface HeadlessRunOptions {
  maxInstructions?: number;
  stopPc?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function inferBasicSysEntry(payload: Uint8Array, loadAddress: number): number | undefined {
  if (loadAddress !== 0x0801 || payload.length < 8) {
    return undefined;
  }
  const sysToken = 0x9e;
  const tokenIndex = payload.indexOf(sysToken);
  if (tokenIndex < 0) {
    return undefined;
  }
  let index = tokenIndex + 1;
  while (index < payload.length && payload[index] === 0x20) index++;
  let digits = "";
  while (index < payload.length) {
    const value = payload[index]!;
    if (value < 0x30 || value > 0x39) break;
    digits += String.fromCharCode(value);
    index += 1;
  }
  if (!digits) {
    return undefined;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed & 0xffff : undefined;
}

function cloneTraceEvent(event: HeadlessTraceEvent): HeadlessTraceEvent {
  return {
    ...event,
    bytes: [...event.bytes],
    before: { ...event.before },
    after: { ...event.after },
  };
}

class HeadlessSession {
  public readonly sessionId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  public readonly createdAt = nowIso();
  public readonly bus = new HeadlessMemoryBus();
  public readonly cpu = new Cpu6510(this.bus);
  public readonly loaderState: HeadlessLoaderState = {
    logicalFile: null,
    device: null,
    secondaryAddress: null,
    fileName: "",
    fileNameBytes: [],
  };
  public readonly loadEvents: HeadlessLoadEvent[] = [];
  public readonly savedFiles: HeadlessSavedFile[] = [];
  public readonly recentTrace: HeadlessTraceEvent[] = [];
  public readonly breakpoints = new Map<number, HeadlessBreakpoint>();
  public state: HeadlessSessionRecord["state"] = "idle";
  public startedAt?: string;
  public stoppedAt?: string;
  public lastTrap?: string;
  public lastError?: string;
  public prgPath?: string;
  public diskPath?: string;
  public entryPoint?: number;
  public inferredBasicSys?: number;
  private prgFile?: PrgFile;
  private diskProvider?: DiskProvider;
  private traceIndex = 0;

  constructor(public readonly projectDir: string) {
    this.bus.reset();
    this.seedVectors();
  }

  start(options: HeadlessSessionStartOptions): HeadlessSessionRecord {
    this.state = "running";
    this.startedAt = nowIso();
    this.stoppedAt = undefined;
    this.lastTrap = undefined;
    this.lastError = undefined;
    this.prgPath = options.prgPath ? resolve(options.prgPath) : undefined;
    this.diskPath = options.diskPath ? resolve(options.diskPath) : undefined;
    this.loadEvents.length = 0;
    this.savedFiles.length = 0;
    this.recentTrace.length = 0;
    this.traceIndex = 0;
    this.loaderState.logicalFile = null;
    this.loaderState.device = null;
    this.loaderState.secondaryAddress = null;
    this.loaderState.fileName = "";
    this.loaderState.fileNameBytes = [];
    this.bus.ram.fill(0);
    this.bus.io.fill(0);
    this.bus.reset();
    this.seedVectors();
    this.diskProvider = this.diskPath ? DiskProvider.fromImagePath(this.diskPath) : undefined;

    if (this.prgPath) {
      this.prgFile = readPrgFile(this.prgPath);
      this.bus.loadBytes(this.prgFile.loadAddress, this.prgFile.payload);
      this.inferredBasicSys = inferBasicSysEntry(this.prgFile.payload, this.prgFile.loadAddress);
      this.entryPoint = options.entryPc ?? this.inferredBasicSys ?? this.prgFile.loadAddress;
    } else {
      this.prgFile = undefined;
      this.inferredBasicSys = undefined;
      this.entryPoint = options.entryPc;
    }

    this.cpu.reset(this.entryPoint ?? 0x0000);
    return this.getRecord();
  }

  getRecord(): HeadlessSessionRecord {
    return {
      sessionId: this.sessionId,
      projectDir: this.projectDir,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      state: this.state,
      prgPath: this.prgPath,
      diskPath: this.diskPath,
      entryPoint: this.entryPoint,
      inferredBasicSys: this.inferredBasicSys,
      currentPc: this.cpu.pc,
      lastTrap: this.lastTrap,
      lastError: this.lastError,
      loaderState: {
        logicalFile: this.loaderState.logicalFile,
        device: this.loaderState.device,
        secondaryAddress: this.loaderState.secondaryAddress,
        fileName: this.loaderState.fileName,
        fileNameBytes: [...this.loaderState.fileNameBytes],
      },
      recentTrace: this.recentTrace.map(cloneTraceEvent),
      loadEvents: this.loadEvents.map((entry) => ({ ...entry })),
      savedFiles: this.savedFiles.map((entry) => ({
        ...entry,
        bytes: new Uint8Array(entry.bytes),
      })),
    };
  }

  getRegisters(): HeadlessCpuState {
    return this.cpu.getState();
  }

  readMemory(start: number, endInclusive: number): Uint8Array {
    return this.bus.readRange(start, endInclusive);
  }

  addBreakpoint(address: number, temporary = false): void {
    this.breakpoints.set(address & 0xffff, { address: address & 0xffff, temporary });
  }

  clearBreakpoints(): void {
    this.breakpoints.clear();
  }

  step(): HeadlessRunResult {
    return this.run({ maxInstructions: 1 });
  }

  run(options: HeadlessRunOptions = {}): HeadlessRunResult {
    if (this.state !== "running") {
      throw new Error(`Headless session is not running (${this.state}).`);
    }
    const maxInstructions = Math.max(1, options.maxInstructions ?? 1000);
    let stepsExecuted = 0;

    while (stepsExecuted < maxInstructions) {
      const stopPc = options.stopPc !== undefined && this.cpu.pc === (options.stopPc & 0xffff);
      if (stopPc) {
        return { reason: "stop_pc", stepsExecuted, currentPc: this.cpu.pc, lastTrap: this.lastTrap };
      }
      const breakpoint = this.breakpoints.get(this.cpu.pc);
      if (breakpoint) {
        if (breakpoint.temporary) {
          this.breakpoints.delete(this.cpu.pc);
        }
        return { reason: "breakpoint", stepsExecuted, currentPc: this.cpu.pc, lastTrap: this.lastTrap };
      }
      try {
        if (this.handleKernalTrap()) {
          stepsExecuted += 1;
          continue;
        }
        this.executeInstruction();
        stepsExecuted += 1;
      } catch (error) {
        this.state = "error";
        this.lastError = error instanceof Error ? error.message : String(error);
        this.stoppedAt = nowIso();
        return { reason: "trap_error", stepsExecuted, currentPc: this.cpu.pc, lastTrap: this.lastTrap };
      }
    }

    return { reason: "step_limit", stepsExecuted, currentPc: this.cpu.pc, lastTrap: this.lastTrap };
  }

  stop(reason?: string): HeadlessSessionRecord {
    this.state = "stopped";
    this.stoppedAt = nowIso();
    if (reason) {
      this.lastTrap = reason;
    }
    return this.getRecord();
  }

  private executeInstruction(): void {
    const before = this.cpu.getState();
    const bytes = this.cpu.peekInstructionBytes();
    const opcode = bytes[0] ?? 0;
    this.cpu.step();
    const after = this.cpu.getState();
    this.pushTrace({
      index: this.traceIndex++,
      pc: before.pc,
      opcode,
      bytes,
      before,
      after,
    });
  }

  private handleKernalTrap(): boolean {
    switch (this.cpu.pc) {
      case KERNAL_SETLFS:
        this.handleSetlfsTrap();
        return true;
      case KERNAL_SETNAM:
        this.handleSetnamTrap();
        return true;
      case KERNAL_LOAD:
        this.handleLoadTrap();
        return true;
      case KERNAL_SAVE:
        this.handleSaveTrap();
        return true;
      default:
        return false;
    }
  }

  private handleSetlfsTrap(): void {
    this.loaderState.logicalFile = this.cpu.a;
    this.loaderState.device = this.cpu.x;
    this.loaderState.secondaryAddress = this.cpu.y;
    const before = this.cpu.getState();
    this.cpu.setCarry(false);
    this.cpu.returnFromSubroutine();
    const after = this.cpu.getState();
    this.lastTrap = `SETLFS lfn=${this.loaderState.logicalFile} device=${this.loaderState.device} sa=${this.loaderState.secondaryAddress}`;
    this.pushTrap(before, after, this.lastTrap);
  }

  private handleSetnamTrap(): void {
    const length = this.cpu.a & 0xff;
    const pointer = this.cpu.x | (this.cpu.y << 8);
    const bytes: number[] = [];
    for (let index = 0; index < length; index++) {
      bytes.push(this.bus.read((pointer + index) & 0xffff));
    }
    const name = String.fromCharCode(...bytes).replace(/\u00A0/g, " ");
    this.loaderState.fileName = name;
    this.loaderState.fileNameBytes = bytes;
    const before = this.cpu.getState();
    this.cpu.setCarry(false);
    this.cpu.returnFromSubroutine();
    const after = this.cpu.getState();
    this.lastTrap = `SETNAM "${name}" @ ${formatHexWord(pointer)}`;
    this.pushTrap(before, after, this.lastTrap);
  }

  private handleLoadTrap(): void {
    const before = this.cpu.getState();
    const fileName = this.loaderState.fileName.trim();
    const device = this.loaderState.device ?? 8;
    const secondaryAddress = this.loaderState.secondaryAddress ?? 1;
    if (!fileName) {
      throw new Error("KERNAL LOAD requested without prior SETNAM.");
    }
    if (!this.diskProvider) {
      throw new Error(`KERNAL LOAD "${fileName}" requested without attached disk image.`);
    }
    const match = this.diskProvider.findFile(fileName);
    if (!match) {
      throw new Error(`KERNAL LOAD could not find "${fileName}" on ${this.diskProvider.imagePath}.`);
    }
    const bytes = match.bytes;
    const fileLoadAddress = bytes.length >= 2 ? (bytes[0]! | (bytes[1]! << 8)) : 0x0000;
    const targetAddress = secondaryAddress === 0 ? (this.cpu.x | (this.cpu.y << 8)) : fileLoadAddress;
    const payload = bytes.length >= 2 ? bytes.slice(2) : bytes;
    this.bus.loadBytes(targetAddress, payload);
    const endAddress = (targetAddress + payload.length) & 0xffff;
    this.cpu.a = 0x00;
    this.cpu.x = endAddress & 0xff;
    this.cpu.y = (endAddress >> 8) & 0xff;
    this.cpu.setCarry(false);
    this.cpu.returnFromSubroutine();
    const after = this.cpu.getState();
    const event: HeadlessLoadEvent = {
      name: match.entry.name,
      device,
      secondaryAddress,
      startAddress: targetAddress,
      endAddress,
      source: this.diskProvider.imagePath,
      createdAt: nowIso(),
    };
    this.loadEvents.push(event);
    this.lastTrap = `LOAD "${match.entry.name}" -> ${formatHexWord(targetAddress)}-${formatHexWord((endAddress - 1) & 0xffff)}`;
    this.pushTrap(before, after, this.lastTrap);
  }

  private handleSaveTrap(): void {
    const before = this.cpu.getState();
    const fileName = this.loaderState.fileName.trim() || `SAVE_${this.savedFiles.length + 1}`;
    const startPointer = this.cpu.a & 0xff;
    const startAddress = this.bus.read(startPointer) | (this.bus.read((startPointer + 1) & 0xff) << 8);
    const endAddress = this.cpu.x | (this.cpu.y << 8);
    const bytes = new Uint8Array(2 + Math.max(0, endAddress - startAddress));
    bytes[0] = startAddress & 0xff;
    bytes[1] = (startAddress >> 8) & 0xff;
    bytes.set(this.bus.readRange(startAddress, Math.max(startAddress, endAddress - 1)), 2);
    this.savedFiles.push({
      name: fileName,
      bytes,
      startAddress,
      endAddress,
      createdAt: nowIso(),
    });
    this.cpu.a = 0x00;
    this.cpu.setCarry(false);
    this.cpu.returnFromSubroutine();
    const after = this.cpu.getState();
    this.lastTrap = `SAVE "${fileName}" <- ${formatHexWord(startAddress)}-${formatHexWord((endAddress - 1) & 0xffff)}`;
    this.pushTrap(before, after, this.lastTrap);
  }

  private pushTrap(before: HeadlessCpuState, after: HeadlessCpuState, trap: string): void {
    this.pushTrace({
      index: this.traceIndex++,
      pc: before.pc,
      opcode: this.bus.read(before.pc),
      bytes: [this.bus.read(before.pc)],
      before,
      after,
      trap,
      note: trap,
    });
  }

  private pushTrace(event: HeadlessTraceEvent): void {
    this.recentTrace.push(event);
    while (this.recentTrace.length > TRACE_LIMIT) {
      this.recentTrace.shift();
    }
  }

  private seedVectors(): void {
    this.bus.ram[0xfffc] = 0x00;
    this.bus.ram[0xfffd] = 0x00;
    this.bus.ram[0xfffe] = 0x00;
    this.bus.ram[0xffff] = 0x00;
  }
}

export class HeadlessSessionManager {
  private currentSession?: HeadlessSession;

  constructor(private readonly projectDir: string) {}

  getProjectDir(): string {
    return this.projectDir;
  }

  startSession(options: HeadlessSessionStartOptions = {}): HeadlessSessionRecord {
    this.currentSession = new HeadlessSession(this.projectDir);
    return this.currentSession.start(options);
  }

  getStatus(): HeadlessSessionRecord | null {
    return this.currentSession?.getRecord() ?? null;
  }

  stopSession(reason?: string): HeadlessSessionRecord | null {
    if (!this.currentSession) {
      return null;
    }
    return this.currentSession.stop(reason);
  }

  stepSession(): HeadlessRunResult {
    return this.requireSession().step();
  }

  runSession(options: HeadlessRunOptions = {}): HeadlessRunResult {
    return this.requireSession().run(options);
  }

  readMemory(start: number, endInclusive: number): Uint8Array {
    return this.requireSession().readMemory(start, endInclusive);
  }

  getRegisters(): HeadlessCpuState {
    return this.requireSession().getRegisters();
  }

  addBreakpoint(address: number, temporary = false): void {
    this.requireSession().addBreakpoint(address, temporary);
  }

  clearBreakpoints(): void {
    this.requireSession().clearBreakpoints();
  }

  private requireSession(): HeadlessSession {
    if (!this.currentSession) {
      throw new Error("No active headless runtime session.");
    }
    return this.currentSession;
  }
}
