import { Socket } from "node:net";

const STX = 0x02;
const API_VERSION = 0x02;
const EVENT_REQUEST_ID = 0xffffffff;

const RESPONSE_CHECKPOINT = 0x11;
const RESPONSE_CHECKPOINT_LIST = 0x14;
const RESPONSE_REGISTERS = 0x31;
const RESPONSE_JAM = 0x61;
const RESPONSE_STOPPED = 0x62;
const RESPONSE_RESUMED = 0x63;

const CMD_MEMORY_GET = 0x01;
const CMD_MEMORY_SET = 0x02;
const CMD_CHECKPOINT_DELETE = 0x13;
const CMD_CHECKPOINT_LIST = 0x14;
const CMD_CHECKPOINT_SET = 0x12;
const CMD_REGISTERS_GET = 0x31;
const CMD_REGISTERS_SET = 0x32;
const CMD_DISPLAY_GET = 0x84;
const CMD_DUMP = 0x41;
const CMD_ADVANCE = 0x71;
const CMD_KEYBOARD_FEED = 0x72;
const CMD_EXECUTE_UNTIL_RETURN = 0x73;
const CMD_PING = 0x81;
const CMD_BANKS_AVAILABLE = 0x82;
const CMD_REGISTERS_AVAILABLE = 0x83;
const CMD_CPU_HISTORY = 0x86;
const CMD_EXIT = 0xaa;
const CMD_QUIT = 0xbb;
const CMD_RESET = 0xcc;
const CMD_AUTOSTART = 0xdd;

const MAIN_MEMSPACE = 0x00;

export type ViceMemspace = 0x00 | 0x01 | 0x02 | 0x03 | 0x04;

interface ViceResponseFrame {
  apiVersion: number;
  responseType: number;
  errorCode: number;
  requestId: number;
  body: Buffer;
}

export interface ViceRegisterDescriptor {
  id: number;
  bits: number;
  name: string;
}

export interface ViceRegisterValue {
  id: number;
  value: number;
}

export interface ViceBankDescriptor {
  id: number;
  name: string;
}

export interface ViceCheckpointInfo {
  checkpointNumber: number;
  currentlyHit: boolean;
  startAddress: number;
  endAddress: number;
  stopWhenHit: boolean;
  enabled: boolean;
  operation: number;
  temporary: boolean;
  hitCount: number;
  ignoreCount: number;
  hasCondition: boolean;
  memspace: number;
}

export interface ViceDisplayBuffer {
  debugWidth: number;
  debugHeight: number;
  xOffset: number;
  yOffset: number;
  innerWidth: number;
  innerHeight: number;
  bitsPerPixel: number;
  pixels: Buffer;
}

export interface ViceSetCheckpointOptions {
  startAddress: number;
  endAddress: number;
  stopWhenHit?: boolean;
  enabled?: boolean;
  operation?: number;
  temporary?: boolean;
  memspace?: ViceMemspace;
}

export interface ViceCpuHistoryItem {
  clock: string;
  registers: ViceRegisterValue[];
  instructionBytes: number[];
}

export type ViceMonitorEvent =
  | { sequence: number; kind: "checkpoint"; requestId: number; checkpoint: ViceCheckpointInfo }
  | { sequence: number; kind: "registers"; requestId: number; registers: ViceRegisterValue[] }
  | { sequence: number; kind: "stopped"; requestId: number; pc: number }
  | { sequence: number; kind: "resumed"; requestId: number; pc: number }
  | { sequence: number; kind: "jam"; requestId: number; pc: number };

interface WaitForEventOptions {
  afterSequence?: number;
  timeoutMs?: number;
}

interface ViceMonitorClientOptions {
  host: string;
  port: number;
  onTraceEvent?: (type: string, payload: object) => void;
}

export class ViceMonitorClient {
  private socket?: Socket;
  private receiveBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pending = new Map<number, {
    resolve: (frame: ViceResponseFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly checkpointListPending = new Map<number, {
    checkpoints: ViceCheckpointInfo[];
    resolve: (value: { checkpoints: ViceCheckpointInfo[]; count: number }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly eventHistory: ViceMonitorEvent[] = [];
  private readonly eventWaiters = new Set<{
    predicate: (event: ViceMonitorEvent) => boolean;
    afterSequence: number;
    resolve: (event: ViceMonitorEvent) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }>();
  private eventSequence = 0;
  private commandChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ViceMonitorClientOptions) {}

  get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  get currentEventSequence(): number {
    return this.eventSequence;
  }

  async connect(timeoutMs = 3_000): Promise<void> {
    if (this.isConnected) {
      return;
    }

    const socket = new Socket();
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("data", (chunk) => {
      this.handleData(chunk);
    });
    socket.on("close", () => {
      this.handleDisconnect(new Error("VICE monitor socket closed."));
    });
    socket.on("error", (error) => {
      this.handleDisconnect(error instanceof Error ? error : new Error(String(error)));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to VICE monitor on ${this.options.host}:${this.options.port}.`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.trace("monitor_connected", {
          host: this.options.host,
          port: this.options.port,
        });
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      socket.connect(this.options.port, this.options.host);
    });
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = undefined;
  }

  async ping(): Promise<void> {
    await this.sendCommand(CMD_PING, Buffer.alloc(0), () => undefined);
  }

  async quitVice(): Promise<void> {
    await this.sendCommand(CMD_QUIT, Buffer.alloc(0), () => undefined);
  }

  async resetSystem(powerCycle = false): Promise<void> {
    const body = Buffer.from([powerCycle ? 0x01 : 0x00]);
    await this.sendCommand(CMD_RESET, body, () => undefined);
  }

  async resume(): Promise<void> {
    await this.sendCommand(CMD_EXIT, Buffer.alloc(0), () => undefined);
  }

  async executeUntilReturn(): Promise<void> {
    await this.sendCommand(CMD_EXECUTE_UNTIL_RETURN, Buffer.alloc(0), () => undefined);
  }

  async advanceInstructions(count: number, stepOverSubroutines: boolean): Promise<void> {
    const body = Buffer.alloc(3);
    body.writeUInt8(stepOverSubroutines ? 1 : 0, 0);
    body.writeUInt16LE(count, 1);
    await this.sendCommand(CMD_ADVANCE, body, () => undefined);
  }

  async getRegistersAvailable(memspace = MAIN_MEMSPACE): Promise<ViceRegisterDescriptor[]> {
    const body = Buffer.from([memspace]);
    return this.sendCommand(CMD_REGISTERS_AVAILABLE, body, (frame) => parseRegistersAvailable(frame.body));
  }

  async getRegisters(memspace = MAIN_MEMSPACE): Promise<ViceRegisterValue[]> {
    const body = Buffer.from([memspace]);
    return this.sendCommand(CMD_REGISTERS_GET, body, (frame) => parseRegisterValues(frame.body));
  }

  async getBanksAvailable(): Promise<ViceBankDescriptor[]> {
    return this.sendCommand(CMD_BANKS_AVAILABLE, Buffer.alloc(0), (frame) => parseBanksAvailable(frame.body));
  }

  async dumpSnapshot(filename: string, saveRoms = true, saveDisks = true): Promise<void> {
    const filenameBytes = Buffer.from(filename, "utf8");
    if (filenameBytes.length > 255) {
      throw new Error("Snapshot filename must fit into 255 bytes.");
    }
    const body = Buffer.alloc(3 + filenameBytes.length);
    body.writeUInt8(saveRoms ? 1 : 0, 0);
    body.writeUInt8(saveDisks ? 1 : 0, 1);
    body.writeUInt8(filenameBytes.length, 2);
    filenameBytes.copy(body, 3);
    await this.sendCommand(CMD_DUMP, body, () => undefined);
  }

  async getCpuHistory(count: number, memspace = MAIN_MEMSPACE): Promise<ViceCpuHistoryItem[]> {
    const body = Buffer.alloc(5);
    body.writeUInt8(memspace, 0);
    body.writeUInt32LE(count, 1);
    return this.sendCommand(CMD_CPU_HISTORY, body, (frame) => parseCpuHistory(frame.body));
  }

  async readMemory(startAddress: number, endAddress: number, bankId = 0, memspace: ViceMemspace = MAIN_MEMSPACE): Promise<Buffer> {
    const body = Buffer.alloc(8);
    body.writeUInt8(0, 0);
    body.writeUInt16LE(startAddress, 1);
    body.writeUInt16LE(endAddress, 3);
    body.writeUInt8(memspace, 5);
    body.writeUInt16LE(bankId, 6);
    return this.sendCommand(CMD_MEMORY_GET, body, (frame) => parseMemoryGet(frame.body));
  }

  async writeMemory(startAddress: number, data: Buffer, bankId = 0, memspace: ViceMemspace = MAIN_MEMSPACE, sideEffects = false): Promise<void> {
    if (data.length === 0) {
      return;
    }
    const endAddress = startAddress + data.length - 1;
    const body = Buffer.alloc(8 + data.length);
    body.writeUInt8(sideEffects ? 1 : 0, 0);
    body.writeUInt16LE(startAddress, 1);
    body.writeUInt16LE(endAddress, 3);
    body.writeUInt8(memspace, 5);
    body.writeUInt16LE(bankId, 6);
    data.copy(body, 8);
    await this.sendCommand(CMD_MEMORY_SET, body, () => undefined);
  }

  async setCheckpoint(options: ViceSetCheckpointOptions): Promise<ViceCheckpointInfo> {
    const includeMemspace = options.memspace !== undefined;
    const body = Buffer.alloc(includeMemspace ? 9 : 8);
    body.writeUInt16LE(options.startAddress, 0);
    body.writeUInt16LE(options.endAddress, 2);
    body.writeUInt8(options.stopWhenHit ?? true ? 1 : 0, 4);
    body.writeUInt8(options.enabled ?? true ? 1 : 0, 5);
    body.writeUInt8(options.operation ?? 0x04, 6);
    body.writeUInt8(options.temporary ?? false ? 1 : 0, 7);
    if (includeMemspace) {
      body.writeUInt8(options.memspace ?? MAIN_MEMSPACE, 8);
    }
    return this.sendCommand(CMD_CHECKPOINT_SET, body, (frame) => parseCheckpoint(frame.body));
  }

  async setExecCheckpoint(address: number, temporary = false, stopWhenHit = true): Promise<ViceCheckpointInfo> {
    return this.setCheckpoint({
      startAddress: address,
      endAddress: address,
      stopWhenHit,
      enabled: true,
      operation: 0x04,
      temporary,
      memspace: MAIN_MEMSPACE,
    });
  }

  async listCheckpoints(): Promise<{ checkpoints: ViceCheckpointInfo[]; count: number }> {
    return this.sendCheckpointListCommand(5_000);
  }

  async deleteCheckpoint(checkpointNumber: number): Promise<void> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(checkpointNumber, 0);
    await this.sendCommand(CMD_CHECKPOINT_DELETE, body, () => undefined);
  }

  async setRegisters(registerValues: ViceRegisterValue[], memspace: ViceMemspace = MAIN_MEMSPACE): Promise<void> {
    const body = Buffer.alloc(3 + registerValues.length * 4);
    body.writeUInt8(memspace, 0);
    body.writeUInt16LE(registerValues.length, 1);
    let offset = 3;
    for (const registerValue of registerValues) {
      body.writeUInt8(3, offset);
      body.writeUInt8(registerValue.id, offset + 1);
      body.writeUInt16LE(registerValue.value, offset + 2);
      offset += 4;
    }
    await this.sendCommand(CMD_REGISTERS_SET, body, () => undefined);
  }

  async keyboardFeed(text: Buffer): Promise<void> {
    if (text.length > 0xff) {
      throw new Error("Keyboard feed text must fit into 255 bytes.");
    }
    const body = Buffer.alloc(1 + text.length);
    body.writeUInt8(text.length, 0);
    text.copy(body, 1);
    await this.sendCommand(CMD_KEYBOARD_FEED, body, () => undefined);
  }

  async autostart(filename: string, runAfterLoading = true, fileIndex = 0): Promise<void> {
    const filenameBytes = Buffer.from(filename, "utf8");
    if (filenameBytes.length > 0xff) {
      throw new Error("Autostart filename must fit into 255 bytes.");
    }
    const body = Buffer.alloc(4 + filenameBytes.length);
    body.writeUInt8(runAfterLoading ? 1 : 0, 0);
    body.writeUInt16LE(fileIndex, 1);
    body.writeUInt8(filenameBytes.length, 3);
    filenameBytes.copy(body, 4);
    await this.sendCommand(CMD_AUTOSTART, body, () => undefined);
  }

  async getDisplay(useVicII = true, format = 0): Promise<ViceDisplayBuffer> {
    const body = Buffer.from([useVicII ? 1 : 0, format]);
    return this.sendCommand(CMD_DISPLAY_GET, body, (frame) => parseDisplayGet(frame.body));
  }

  async reset(resetCode: number): Promise<void> {
    const body = Buffer.from([resetCode & 0xff]);
    await this.sendCommand(CMD_RESET, body, () => undefined);
  }

  async waitForEvent(
    predicate: (event: ViceMonitorEvent) => boolean,
    options: WaitForEventOptions = {},
  ): Promise<ViceMonitorEvent> {
    const afterSequence = options.afterSequence ?? this.eventSequence;
    for (const event of this.eventHistory) {
      if (event.sequence > afterSequence && predicate(event)) {
        return event;
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        afterSequence,
        resolve,
        reject,
        timer: options.timeoutMs
          ? setTimeout(() => {
            this.eventWaiters.delete(waiter);
            reject(new Error(`Timed out waiting for VICE monitor event after sequence ${afterSequence}.`));
          }, options.timeoutMs)
          : undefined,
      };
      this.eventWaiters.add(waiter);
    });
  }

  async waitForResume(afterSequence: number, timeoutMs = 2_000): Promise<{ pc: number }> {
    const event = await this.waitForEvent((candidate) => candidate.kind === "resumed", { afterSequence, timeoutMs }) as Extract<ViceMonitorEvent, { kind: "resumed" }>;
    return { pc: event.pc };
  }

  async waitForStop(afterSequence: number, timeoutMs = 2_000): Promise<{ pc: number }> {
    const event = await this.waitForEvent((candidate) => candidate.kind === "stopped", { afterSequence, timeoutMs }) as Extract<ViceMonitorEvent, { kind: "stopped" }>;
    return { pc: event.pc };
  }

  async waitForCheckpointOrStop(afterSequence: number, timeoutMs: number): Promise<ViceMonitorEvent> {
    return this.waitForEvent(
      (candidate) => candidate.kind === "checkpoint" || candidate.kind === "stopped" || candidate.kind === "jam",
      { afterSequence, timeoutMs },
    );
  }

  private async sendCommand<T>(
    commandType: number,
    body: Buffer,
    parser: (frame: ViceResponseFrame) => T,
    timeoutMs = 5_000,
  ): Promise<T> {
    return this.serialize(async () => {
      await this.connect();
      const socket = this.socket;
      if (!socket) {
        throw new Error("VICE monitor socket is not available.");
      }

      const requestId = this.nextRequestId++;
      const frame = buildCommandFrame(requestId, commandType, body);
      this.trace("monitor_command", {
        requestId,
        commandType,
        bodyLength: body.length,
      });

      const responsePromise = new Promise<ViceResponseFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Timed out waiting for VICE monitor response ${commandType.toString(16)}.`));
        }, timeoutMs);

        this.pending.set(requestId, { resolve, reject, timer });
      });

      await new Promise<void>((resolve, reject) => {
        socket.write(frame, (error) => {
          if (error) {
            const pending = this.pending.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(requestId);
            }
            reject(error);
            return;
          }
          resolve();
        });
      });

      const response = await responsePromise;
      if (response.errorCode !== 0) {
        throw new Error(`VICE monitor command 0x${commandType.toString(16)} failed with error 0x${response.errorCode.toString(16)}.`);
      }

      const parsed = parser(response);
      this.trace("monitor_response", {
        requestId,
        responseType: response.responseType,
        errorCode: response.errorCode,
      });
      return parsed;
    });
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.commandChain.then(action);
    this.commandChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private handleData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    while (this.receiveBuffer.length >= 12) {
      if (this.receiveBuffer.readUInt8(0) !== STX) {
        this.handleDisconnect(new Error("VICE monitor stream lost synchronization."));
        return;
      }

      const bodyLength = this.receiveBuffer.readUInt32LE(2);
      const totalLength = 12 + bodyLength;
      if (this.receiveBuffer.length < totalLength) {
        return;
      }

      const frameBuffer = this.receiveBuffer.subarray(0, totalLength);
      this.receiveBuffer = this.receiveBuffer.subarray(totalLength);
      this.handleFrame({
        apiVersion: frameBuffer.readUInt8(1),
        responseType: frameBuffer.readUInt8(6),
        errorCode: frameBuffer.readUInt8(7),
        requestId: frameBuffer.readUInt32LE(8),
        body: frameBuffer.subarray(12),
      });
    }
  }

  private handleFrame(frame: ViceResponseFrame): void {
    if (frame.apiVersion !== API_VERSION) {
      this.handleDisconnect(new Error(`Unsupported VICE monitor API version ${frame.apiVersion}.`));
      return;
    }

    if (frame.requestId === EVENT_REQUEST_ID) {
      const event = parseMonitorEvent(++this.eventSequence, frame);
      if (!event) {
        return;
      }
      this.eventHistory.push(event);
      if (this.eventHistory.length > 200) {
        this.eventHistory.splice(0, this.eventHistory.length - 200);
      }
      this.trace("monitor_event", eventToTracePayload(event));
      for (const waiter of [...this.eventWaiters]) {
        if (event.sequence > waiter.afterSequence && waiter.predicate(event)) {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.eventWaiters.delete(waiter);
          waiter.resolve(event);
        }
      }
      return;
    }

    const pending = this.pending.get(frame.requestId);
    const checkpointListPending = this.checkpointListPending.get(frame.requestId);
    if (checkpointListPending) {
      if (frame.responseType === RESPONSE_CHECKPOINT) {
        checkpointListPending.checkpoints.push(parseCheckpoint(frame.body));
        return;
      }
      if (frame.responseType === RESPONSE_CHECKPOINT_LIST) {
        clearTimeout(checkpointListPending.timer);
        this.checkpointListPending.delete(frame.requestId);
        checkpointListPending.resolve({
          checkpoints: checkpointListPending.checkpoints,
          count: frame.body.readUInt32LE(0),
        });
        return;
      }
    }
    if (!pending) {
      this.trace("monitor_unmatched_response", {
        requestId: frame.requestId,
        responseType: frame.responseType,
      });
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(frame.requestId);
    pending.resolve(frame);
  }

  private handleDisconnect(error: Error): void {
    this.trace("monitor_disconnected", { error: error.message });
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`VICE monitor request ${requestId} aborted: ${error.message}`));
    }
    this.pending.clear();
    for (const [requestId, pending] of this.checkpointListPending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`VICE monitor request ${requestId} aborted: ${error.message}`));
    }
    this.checkpointListPending.clear();
    for (const waiter of this.eventWaiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.eventWaiters.clear();
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = undefined;
  }

  private trace(type: string, payload: object): void {
    this.options.onTraceEvent?.(type, payload);
  }

  private async sendCheckpointListCommand(timeoutMs: number): Promise<{ checkpoints: ViceCheckpointInfo[]; count: number }> {
    return this.serialize(async () => {
      await this.connect();
      const socket = this.socket;
      if (!socket) {
        throw new Error("VICE monitor socket is not available.");
      }

      const requestId = this.nextRequestId++;
      const frame = buildCommandFrame(requestId, CMD_CHECKPOINT_LIST, Buffer.alloc(0));
      this.trace("monitor_command", {
        requestId,
        commandType: CMD_CHECKPOINT_LIST,
        bodyLength: 0,
      });

      const responsePromise = new Promise<{ checkpoints: ViceCheckpointInfo[]; count: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.checkpointListPending.delete(requestId);
          reject(new Error("Timed out waiting for VICE checkpoint list response."));
        }, timeoutMs);
        this.checkpointListPending.set(requestId, {
          checkpoints: [],
          resolve,
          reject,
          timer,
        });
      });

      await new Promise<void>((resolve, reject) => {
        socket.write(frame, (error) => {
          if (error) {
            const pending = this.checkpointListPending.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.checkpointListPending.delete(requestId);
            }
            reject(error);
            return;
          }
          resolve();
        });
      });

      const response = await responsePromise;
      this.trace("monitor_response", {
        requestId,
        responseType: RESPONSE_CHECKPOINT_LIST,
        errorCode: 0,
        count: response.count,
      });
      return response;
    });
  }
}

function buildCommandFrame(requestId: number, commandType: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(11 + body.length);
  frame.writeUInt8(STX, 0);
  frame.writeUInt8(API_VERSION, 1);
  frame.writeUInt32LE(body.length, 2);
  frame.writeUInt32LE(requestId, 6);
  frame.writeUInt8(commandType, 10);
  body.copy(frame, 11);
  return frame;
}

function parseMonitorEvent(sequence: number, frame: ViceResponseFrame): ViceMonitorEvent | undefined {
  switch (frame.responseType) {
    case RESPONSE_CHECKPOINT:
      return {
        sequence,
        kind: "checkpoint",
        requestId: frame.requestId,
        checkpoint: parseCheckpoint(frame.body),
      };
    case RESPONSE_REGISTERS:
      return {
        sequence,
        kind: "registers",
        requestId: frame.requestId,
        registers: parseRegisterValues(frame.body),
      };
    case RESPONSE_STOPPED:
      return {
        sequence,
        kind: "stopped",
        requestId: frame.requestId,
        pc: frame.body.readUInt16LE(0),
      };
    case RESPONSE_RESUMED:
      return {
        sequence,
        kind: "resumed",
        requestId: frame.requestId,
        pc: frame.body.readUInt16LE(0),
      };
    case RESPONSE_JAM:
      return {
        sequence,
        kind: "jam",
        requestId: frame.requestId,
        pc: frame.body.readUInt16LE(0),
      };
    default:
      return undefined;
  }
}

function parseMemoryGet(body: Buffer): Buffer {
  const length = body.readUInt16LE(0);
  return body.subarray(2, 2 + length);
}

function parseRegistersAvailable(body: Buffer): ViceRegisterDescriptor[] {
  const count = body.readUInt16LE(0);
  const items: ViceRegisterDescriptor[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    const itemSize = body.readUInt8(offset);
    const id = body.readUInt8(offset + 1);
    const bits = body.readUInt8(offset + 2);
    const nameLength = body.readUInt8(offset + 3);
    const name = body.subarray(offset + 4, offset + 4 + nameLength).toString("ascii");
    items.push({ id, bits, name });
    offset += 1 + itemSize;
  }
  return items;
}

function parseRegisterValues(body: Buffer): ViceRegisterValue[] {
  const count = body.readUInt16LE(0);
  const items: ViceRegisterValue[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    const itemSize = body.readUInt8(offset);
    const id = body.readUInt8(offset + 1);
    const value = body.readUInt16LE(offset + 2);
    items.push({ id, value });
    offset += 1 + itemSize;
  }
  return items;
}

function parseBanksAvailable(body: Buffer): ViceBankDescriptor[] {
  const count = body.readUInt16LE(0);
  const items: ViceBankDescriptor[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    const itemSize = body.readUInt8(offset);
    const id = body.readUInt16LE(offset + 1);
    const nameLength = body.readUInt8(offset + 3);
    const name = body.subarray(offset + 4, offset + 4 + nameLength).toString("ascii");
    items.push({ id, name });
    offset += 1 + itemSize;
  }
  return items;
}

function parseCheckpoint(body: Buffer): ViceCheckpointInfo {
  return {
    checkpointNumber: body.readUInt32LE(0),
    currentlyHit: body.readUInt8(4) !== 0,
    startAddress: body.readUInt16LE(5),
    endAddress: body.readUInt16LE(7),
    stopWhenHit: body.readUInt8(9) !== 0,
    enabled: body.readUInt8(10) !== 0,
    operation: body.readUInt8(11),
    temporary: body.readUInt8(12) !== 0,
    hitCount: body.readUInt32LE(13),
    ignoreCount: body.readUInt32LE(17),
    hasCondition: body.readUInt8(21) !== 0,
    memspace: body.length > 22 ? body.readUInt8(22) : MAIN_MEMSPACE,
  };
}

function parseCpuHistory(body: Buffer): ViceCpuHistoryItem[] {
  const count = body.readUInt32LE(0);
  const items: ViceCpuHistoryItem[] = [];
  let offset = 4;

  for (let index = 0; index < count; index += 1) {
    const itemSize = body.readUInt8(offset);
    const itemStart = offset + 1;
    const itemEnd = itemStart + itemSize;

    const registerCount = body.readUInt16LE(itemStart);
    const registers: ViceRegisterValue[] = [];
    let cursor = itemStart + 2;

    for (let registerIndex = 0; registerIndex < registerCount; registerIndex += 1) {
      const registerItemSize = body.readUInt8(cursor);
      const id = body.readUInt8(cursor + 1);
      const value = body.readUInt16LE(cursor + 2);
      registers.push({ id, value });
      cursor += 1 + registerItemSize;
    }

    const clock = body.readBigUInt64LE(cursor).toString();
    cursor += 8;
    const instructionLength = body.readUInt8(cursor);
    cursor += 1;
    const instructionBytes = [...body.subarray(cursor, cursor + instructionLength)];

    items.push({
      clock,
      registers,
      instructionBytes,
    });

    offset = itemEnd;
  }

  return items;
}

function parseDisplayGet(body: Buffer): ViceDisplayBuffer {
  const fieldLength = body.readUInt32LE(0);
  const debugWidth = body.readUInt16LE(4);
  const debugHeight = body.readUInt16LE(6);
  const xOffset = body.readUInt16LE(8);
  const yOffset = body.readUInt16LE(10);
  const innerWidth = body.readUInt16LE(12);
  const innerHeight = body.readUInt16LE(14);
  const bitsPerPixel = body.readUInt8(16);
  const bufferLength = body.readUInt32LE(17);
  const pixelsStart = fieldLength;
  return {
    debugWidth,
    debugHeight,
    xOffset,
    yOffset,
    innerWidth,
    innerHeight,
    bitsPerPixel,
    pixels: body.subarray(pixelsStart, pixelsStart + bufferLength),
  };
}

function eventToTracePayload(event: ViceMonitorEvent): object {
  switch (event.kind) {
    case "checkpoint":
      return {
        sequence: event.sequence,
        kind: event.kind,
        checkpointNumber: event.checkpoint.checkpointNumber,
        startAddress: event.checkpoint.startAddress,
        endAddress: event.checkpoint.endAddress,
        hitCount: event.checkpoint.hitCount,
      };
    case "registers":
      return {
        sequence: event.sequence,
        kind: event.kind,
        registerCount: event.registers.length,
      };
    case "stopped":
    case "resumed":
    case "jam":
      return {
        sequence: event.sequence,
        kind: event.kind,
        pc: event.pc,
      };
  }
}
