import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Cpu6510 } from "./cpu6510.js";
import { loadCartridgeMapper, type HeadlessCartridgeMapper } from "./cartridge.js";
import { HeadlessMemoryBus } from "./memory-bus.js";
import { DiskProvider, readPrgFile, type PrgFile } from "./providers.js";
import type {
  HeadlessBreakpoint,
  HeadlessCpuState,
  HeadlessCartridgeMapperType,
  HeadlessIrqState,
  HeadlessIoInterruptState,
  HeadlessLoadEvent,
  HeadlessLoaderState,
  HeadlessMemoryAccess,
  HeadlessRunResult,
  HeadlessSavedFile,
  HeadlessSessionRecord,
  HeadlessTraceEvent,
  HeadlessWatchHit,
  HeadlessWatchRange,
} from "./types.js";

const KERNAL_SETLFS = 0xffba;
const KERNAL_SETNAM = 0xffbd;
const KERNAL_LOAD = 0xffd5;
const KERNAL_SAVE = 0xffd8;
const VECTOR_NMI = 0xfffa;
const VECTOR_IRQ = 0xfffe;

const TRACE_LIMIT = 256;

export interface HeadlessSessionStartOptions {
  prgPath?: string;
  diskPath?: string;
  crtPath?: string;
  mapperType?: HeadlessCartridgeMapperType;
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
    beforeStack: { ...event.beforeStack, bytes: [...event.beforeStack.bytes] },
    afterStack: { ...event.afterStack, bytes: [...event.afterStack.bytes] },
    bankInfo: { ...event.bankInfo },
    irqState: { ...event.irqState },
    accesses: event.accesses.map((access) => ({ ...access })),
    watchHits: event.watchHits.map((hit) => ({
      ...hit,
      touchedBy: [...hit.touchedBy],
      bytes: hit.bytes ? [...hit.bytes] : undefined,
    })),
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
  public readonly accessBreakpoints = new Map<string, HeadlessBreakpoint>();
  public readonly watchRanges = new Map<string, HeadlessWatchRange>();
  public readonly irqState: HeadlessIrqState = {
    irqPending: false,
    nmiPending: false,
    irqCount: 0,
    nmiCount: 0,
  };
  public readonly ioInterrupts: HeadlessIoInterruptState = {
    vicIrqStatus: 0,
    vicIrqMask: 0,
    cia1Status: 0,
    cia1Mask: 0,
    cia2Status: 0,
    cia2Mask: 0,
  };
  public state: HeadlessSessionRecord["state"] = "idle";
  public startedAt?: string;
  public stoppedAt?: string;
  public lastTrap?: string;
  public lastError?: string;
  public prgPath?: string;
  public diskPath?: string;
  public crtPath?: string;
  public entryPoint?: number;
  public inferredBasicSys?: number;
  private prgFile?: PrgFile;
  private diskProvider?: DiskProvider;
  private cartridge?: HeadlessCartridgeMapper;
  private traceIndex = 0;

  constructor(public readonly projectDir: string) {
    this.bus.reset();
    this.seedVectors();
    this.installIoHandlers();
  }

  start(options: HeadlessSessionStartOptions): HeadlessSessionRecord {
    this.state = "running";
    this.startedAt = nowIso();
    this.stoppedAt = undefined;
    this.lastTrap = undefined;
    this.lastError = undefined;
    this.prgPath = options.prgPath ? resolve(options.prgPath) : undefined;
    this.diskPath = options.diskPath ? resolve(options.diskPath) : undefined;
    this.crtPath = options.crtPath ? resolve(options.crtPath) : undefined;
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
    this.installIoHandlers();
    this.diskProvider = this.diskPath ? DiskProvider.fromImagePath(this.diskPath) : undefined;
    this.cartridge = this.crtPath ? loadCartridgeMapper(this.crtPath, options.mapperType) : undefined;
    this.bus.attachCartridge(this.cartridge);
    this.ioInterrupts.vicIrqStatus = 0;
    this.ioInterrupts.vicIrqMask = 0;
    this.ioInterrupts.cia1Status = 0;
    this.ioInterrupts.cia1Mask = 0;
    this.ioInterrupts.cia2Status = 0;
    this.ioInterrupts.cia2Mask = 0;

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
      crtPath: this.crtPath,
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
      breakpoints: [
        ...Array.from(this.breakpoints.values(), (entry) => ({ ...entry })),
        ...Array.from(this.accessBreakpoints.values(), (entry) => ({ ...entry })),
      ],
      watchRanges: Array.from(this.watchRanges.values(), (entry) => ({ ...entry })),
      irqState: { ...this.irqState },
      ioInterrupts: { ...this.ioInterrupts },
      cartridge: this.cartridge?.getState(),
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
    const normalized = address & 0xffff;
    this.breakpoints.set(normalized, { id: `exec:${normalized.toString(16)}`, kind: "exec", start: normalized, end: normalized, temporary });
  }

  addAccessBreakpoint(kind: "read" | "write" | "access", start: number, end: number, temporary = false, label?: string): string {
    const normalizedStart = start & 0xffff;
    const normalizedEnd = end & 0xffff;
    const id = `${kind}:${normalizedStart.toString(16)}-${normalizedEnd.toString(16)}:${label ?? ""}`;
    this.accessBreakpoints.set(id, {
      id,
      kind,
      start: normalizedStart,
      end: normalizedEnd,
      temporary,
      label,
    });
    return id;
  }

  addWatchRange(name: string, start: number, end: number, includeBytes = true): string {
    const normalizedStart = start & 0xffff;
    const normalizedEnd = end & 0xffff;
    const id = `${name}:${normalizedStart.toString(16)}-${normalizedEnd.toString(16)}`;
    this.watchRanges.set(id, {
      id,
      name,
      start: normalizedStart,
      end: normalizedEnd,
      includeBytes,
    });
    return id;
  }

  clearBreakpoints(): void {
    this.breakpoints.clear();
    this.accessBreakpoints.clear();
  }

  clearWatchRanges(): void {
    this.watchRanges.clear();
  }

  requestInterrupt(kind: "irq" | "nmi"): void {
    if (kind === "irq") {
      this.irqState.irqPending = true;
      return;
    }
    this.irqState.nmiPending = true;
  }

  clearInterrupt(kind?: "irq" | "nmi"): void {
    if (!kind || kind === "irq") {
      this.irqState.irqPending = false;
    }
    if (!kind || kind === "nmi") {
      this.irqState.nmiPending = false;
    }
  }

  triggerIoInterrupt(source: "vic" | "cia1" | "cia2", mask = 0x01): void {
    const bitMask = mask & 0x1f;
    switch (source) {
      case "vic":
        this.ioInterrupts.vicIrqStatus |= bitMask;
        if ((this.ioInterrupts.vicIrqMask & bitMask) !== 0) {
          this.requestInterrupt("irq");
        }
        return;
      case "cia1":
        this.ioInterrupts.cia1Status |= bitMask;
        if ((this.ioInterrupts.cia1Mask & bitMask) !== 0) {
          this.requestInterrupt("irq");
        }
        return;
      case "cia2":
        this.ioInterrupts.cia2Status |= bitMask;
        if ((this.ioInterrupts.cia2Mask & bitMask) !== 0) {
          this.requestInterrupt("nmi");
        }
        return;
    }
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
        return { reason: "breakpoint", stepsExecuted, currentPc: this.cpu.pc, lastTrap: this.lastTrap, breakpointId: breakpoint.id };
      }
      try {
        if (this.servicePendingInterrupts()) {
          stepsExecuted += 1;
          continue;
        }
        if (this.handleKernalTrap()) {
          stepsExecuted += 1;
          continue;
        }
        const watchpointId = this.executeInstruction();
        stepsExecuted += 1;
        if (watchpointId) {
          return { reason: "watchpoint", stepsExecuted, currentPc: this.cpu.pc, lastTrap: this.lastTrap, breakpointId: watchpointId };
        }
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

  private executeInstruction(): string | undefined {
    const before = this.cpu.getState();
    const beforeStack = this.captureStackSnapshot(before.sp);
    const bytes = this.cpu.peekInstructionBytes();
    const opcode = bytes[0] ?? 0;
    this.bus.beginInstructionTrace();
    this.cpu.step();
    const accesses = this.bus.endInstructionTrace();
    const after = this.cpu.getState();
    const watchHits = this.collectWatchHits(accesses);
    const watchpoint = this.matchAccessBreakpoint(accesses);
    this.pushTrace({
      index: this.traceIndex++,
      pc: before.pc,
      opcode,
      bytes,
      before,
      after,
      beforeStack,
      afterStack: this.captureStackSnapshot(after.sp),
      bankInfo: this.bus.getBankInfo(),
      irqState: { ...this.irqState },
      accesses,
      watchHits,
    });
    return watchpoint?.id;
  }

  private servicePendingInterrupts(): boolean {
    if (this.irqState.nmiPending) {
      this.irqState.nmiPending = false;
      this.irqState.nmiCount += 1;
      this.dispatchInterrupt("NMI", VECTOR_NMI);
      return true;
    }
    if (this.irqState.irqPending && !this.cpu.interruptsDisabled()) {
      this.irqState.irqPending = false;
      this.irqState.irqCount += 1;
      this.dispatchInterrupt("IRQ", VECTOR_IRQ);
      return true;
    }
    return false;
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
      beforeStack: this.captureStackSnapshot(before.sp),
      afterStack: this.captureStackSnapshot(after.sp),
      bankInfo: this.bus.getBankInfo(),
      irqState: { ...this.irqState },
      accesses: [],
      watchHits: [],
      trap,
      note: trap,
    });
  }

  private dispatchInterrupt(kind: "IRQ" | "NMI", vectorAddress: number): void {
    const before = this.cpu.getState();
    const beforeStack = this.captureStackSnapshot(before.sp);
    this.bus.beginInstructionTrace();
    const target = this.cpu.serviceInterrupt(vectorAddress, false);
    const accesses = this.bus.endInstructionTrace();
    const after = this.cpu.getState();
    this.lastTrap = `${kind} -> ${formatHexWord(target)} via vector ${formatHexWord(vectorAddress)}`;
    this.pushTrace({
      index: this.traceIndex++,
      pc: before.pc,
      opcode: 0,
      bytes: [],
      before,
      after,
      beforeStack,
      afterStack: this.captureStackSnapshot(after.sp),
      bankInfo: this.bus.getBankInfo(),
      irqState: { ...this.irqState },
      accesses,
      watchHits: this.collectWatchHits(accesses),
      trap: this.lastTrap,
      note: `${kind} dispatch`,
    });
  }

  private pushTrace(event: HeadlessTraceEvent): void {
    this.recentTrace.push(event);
    while (this.recentTrace.length > TRACE_LIMIT) {
      this.recentTrace.shift();
    }
  }

  private captureStackSnapshot(sp: number): { sp: number; bytes: number[] } {
    const bytes: number[] = [];
    for (let offset = 1; offset <= 8; offset += 1) {
      const stackAddress = 0x0100 + ((sp + offset) & 0xff);
      bytes.push(this.bus.read(stackAddress));
    }
    return { sp, bytes };
  }

  private collectWatchHits(accesses: HeadlessMemoryAccess[]): HeadlessWatchHit[] {
    if (this.watchRanges.size === 0 || accesses.length === 0) {
      return [];
    }
    const hits: HeadlessWatchHit[] = [];
    for (const watch of this.watchRanges.values()) {
      const touched = accesses.filter((access) => access.address >= watch.start && access.address <= watch.end);
      if (touched.length === 0) {
        continue;
      }
      const touchedBy = Array.from(new Set(touched.map((access) => access.kind)));
      hits.push({
        id: watch.id,
        name: watch.name,
        start: watch.start,
        end: watch.end,
        touchedBy,
        bytes: watch.includeBytes ? Array.from(this.bus.readRange(watch.start, watch.end)) : undefined,
      });
    }
    return hits;
  }

  private matchAccessBreakpoint(accesses: HeadlessMemoryAccess[]): HeadlessBreakpoint | undefined {
    if (this.accessBreakpoints.size === 0 || accesses.length === 0) {
      return undefined;
    }
    for (const breakpoint of this.accessBreakpoints.values()) {
      const hit = accesses.some((access) => {
        if (access.address < breakpoint.start || access.address > breakpoint.end) {
          return false;
        }
        if (breakpoint.kind === "access") {
          return true;
        }
        return access.kind === breakpoint.kind;
      });
      if (hit) {
        if (breakpoint.temporary) {
          this.accessBreakpoints.delete(breakpoint.id);
        }
        this.lastTrap = `watchpoint ${breakpoint.kind} ${formatHexWord(breakpoint.start)}-${formatHexWord(breakpoint.end)}${breakpoint.label ? ` (${breakpoint.label})` : ""}`;
        return breakpoint;
      }
    }
    return undefined;
  }

  private seedVectors(): void {
    this.bus.ram[0xfffc] = 0x00;
    this.bus.ram[0xfffd] = 0x00;
    this.bus.ram[0xfffe] = 0x00;
    this.bus.ram[0xffff] = 0x00;
  }

  private installIoHandlers(): void {
    this.bus.registerIoHandler(0xd019, {
      read: () => (this.ioInterrupts.vicIrqStatus & 0x0f) | (this.ioInterrupts.vicIrqStatus ? 0x80 : 0x00),
      write: (_address, value) => {
        this.ioInterrupts.vicIrqStatus &= ~(value & 0x0f);
        if (this.ioInterrupts.vicIrqStatus === 0) {
          this.irqState.irqPending = false;
        }
      },
    });
    this.bus.registerIoHandler(0xd01a, {
      read: () => this.ioInterrupts.vicIrqMask & 0x0f,
      write: (_address, value) => {
        this.ioInterrupts.vicIrqMask = value & 0x0f;
      },
    });
    this.bus.registerIoHandler(0xdc0d, {
      read: () => (this.ioInterrupts.cia1Status & 0x1f) | (this.ioInterrupts.cia1Status ? 0x80 : 0x00),
      write: (_address, value) => {
        if ((value & 0x80) !== 0) {
          this.ioInterrupts.cia1Mask |= value & 0x1f;
        } else {
          this.ioInterrupts.cia1Mask &= ~(value & 0x1f);
        }
      },
    });
    this.bus.registerIoHandler(0xdd0d, {
      read: () => (this.ioInterrupts.cia2Status & 0x1f) | (this.ioInterrupts.cia2Status ? 0x80 : 0x00),
      write: (_address, value) => {
        if ((value & 0x80) !== 0) {
          this.ioInterrupts.cia2Mask |= value & 0x1f;
        } else {
          this.ioInterrupts.cia2Mask &= ~(value & 0x1f);
        }
      },
    });
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

  addAccessBreakpoint(kind: "read" | "write" | "access", start: number, end: number, temporary = false, label?: string): string {
    return this.requireSession().addAccessBreakpoint(kind, start, end, temporary, label);
  }

  addWatchRange(name: string, start: number, end: number, includeBytes = true): string {
    return this.requireSession().addWatchRange(name, start, end, includeBytes);
  }

  clearBreakpoints(): void {
    this.requireSession().clearBreakpoints();
  }

  clearWatchRanges(): void {
    this.requireSession().clearWatchRanges();
  }

  requestInterrupt(kind: "irq" | "nmi"): void {
    this.requireSession().requestInterrupt(kind);
  }

  clearInterrupt(kind?: "irq" | "nmi"): void {
    this.requireSession().clearInterrupt(kind);
  }

  triggerIoInterrupt(source: "vic" | "cia1" | "cia2", mask = 0x01): void {
    this.requireSession().triggerIoInterrupt(source, mask);
  }

  private requireSession(): HeadlessSession {
    if (!this.currentSession) {
      throw new Error("No active headless runtime session.");
    }
    return this.currentSession;
  }
}
