// Spec 217 — typed-array column buffers for hot-path trace ingest.
// Hot path appends to TypedArray columns. No JSON.stringify, no SQL,
// no fs writes per event. Flushing happens in the sink, not here.

export type TraceSource = "vice" | "headless";
export type TraceCpu = "c64" | "drive8";

export interface ChunkHeader {
  source: TraceSource;
  cpu: TraceCpu;
  capacity: number;
  count: number;
}

export interface InstructionChunk extends ChunkHeader {
  seq: BigUint64Array;
  clock: BigUint64Array;
  masterClock: BigUint64Array;
  pc: Uint16Array;
  opcode: Uint8Array;
  b1: Uint8Array;
  b2: Uint8Array;
  a: Uint8Array;
  x: Uint8Array;
  y: Uint8Array;
  sp: Uint8Array;
  p: Uint8Array;
  // null-marker bitsets (1 = NULL).
  // master_clock and operand bytes can be unknown/absent.
  masterClockNull: Uint8Array;
  b1Null: Uint8Array;
  b2Null: Uint8Array;
}

export interface BusEventChunk extends ChunkHeader {
  seq: BigUint64Array;
  clock: BigUint64Array;
  masterClock: BigUint64Array;
  pc: Uint16Array;
  // kind stored as small int code; resolver maps to text on flush.
  kindCode: Uint8Array;
  addr: Uint16Array;
  value: Uint8Array;
  oldValue: Uint8Array;
  // line-state booleans encoded as 0/1/0xFF (0xFF = NULL)
  lineAtn: Uint8Array;
  lineClk: Uint8Array;
  lineData: Uint8Array;
  // null bitsets
  masterClockNull: Uint8Array;
  pcNull: Uint8Array;
  addrNull: Uint8Array;
  valueNull: Uint8Array;
  oldValueNull: Uint8Array;
}

export interface ChipEventChunk extends ChunkHeader {
  seq: BigUint64Array;
  clock: BigUint64Array;
  masterClock: BigUint64Array;
  pc: Uint16Array;
  chipCode: Uint8Array;
  kindCode: Uint8Array;
  unit: Uint8Array;
  value: Uint8Array;
  oldValue: Uint8Array;
  masterClockNull: Uint8Array;
  pcNull: Uint8Array;
  valueNull: Uint8Array;
  oldValueNull: Uint8Array;
}

// Code tables — small ints in chunks, resolved on sink flush.

export const BUS_EVENT_KINDS = [
  "read", "write", "line_change",
  "irq_assert", "irq_clear", "irq_service",
  "gcr_byte_ready", "gcr_sync", "motor", "density", "head_step",
] as const;
export type BusEventKind = typeof BUS_EVENT_KINDS[number];
const BUS_EVENT_KIND_INDEX = new Map<string, number>(
  BUS_EVENT_KINDS.map((k, i) => [k, i]),
);
export function busEventKindCode(kind: BusEventKind): number {
  const code = BUS_EVENT_KIND_INDEX.get(kind);
  if (code === undefined) throw new Error(`unknown bus_event kind: ${kind}`);
  return code;
}
export function busEventKindFromCode(code: number): BusEventKind {
  const k = BUS_EVENT_KINDS[code];
  if (!k) throw new Error(`bus_event kind code out of range: ${code}`);
  return k;
}

export const CHIP_EVENT_CHIPS = [
  "cia1", "cia2", "via1", "via2", "vic", "gcr",
] as const;
export type ChipEventChip = typeof CHIP_EVENT_CHIPS[number];
const CHIP_EVENT_CHIP_INDEX = new Map<string, number>(
  CHIP_EVENT_CHIPS.map((k, i) => [k, i]),
);
export function chipEventChipCode(chip: ChipEventChip): number {
  const code = CHIP_EVENT_CHIP_INDEX.get(chip);
  if (code === undefined) throw new Error(`unknown chip_event chip: ${chip}`);
  return code;
}
export function chipEventChipFromCode(code: number): ChipEventChip {
  const k = CHIP_EVENT_CHIPS[code];
  if (!k) throw new Error(`chip_event chip code out of range: ${code}`);
  return k;
}

export const CHIP_EVENT_KINDS = [
  "timer_underflow", "timer_reload",
  "irq_assert", "irq_clear", "irq_service",
  "ifr_set", "ifr_clear", "ier_write",
  "raster_line", "frame_start",
  "motor", "density", "head_step",
  "byte_ready", "sync_edge",
] as const;
export type ChipEventKind = typeof CHIP_EVENT_KINDS[number];
const CHIP_EVENT_KIND_INDEX = new Map<string, number>(
  CHIP_EVENT_KINDS.map((k, i) => [k, i]),
);
export function chipEventKindCode(kind: ChipEventKind): number {
  const code = CHIP_EVENT_KIND_INDEX.get(kind);
  if (code === undefined) throw new Error(`unknown chip_event kind: ${kind}`);
  return code;
}
export function chipEventKindFromCode(code: number): ChipEventKind {
  const k = CHIP_EVENT_KINDS[code];
  if (!k) throw new Error(`chip_event kind code out of range: ${code}`);
  return k;
}

// Allocators

export function allocateInstructionChunk(
  source: TraceSource,
  cpu: TraceCpu,
  capacity: number,
): InstructionChunk {
  return {
    source, cpu, capacity, count: 0,
    seq:           new BigUint64Array(capacity),
    clock:         new BigUint64Array(capacity),
    masterClock:   new BigUint64Array(capacity),
    pc:            new Uint16Array(capacity),
    opcode:        new Uint8Array(capacity),
    b1:            new Uint8Array(capacity),
    b2:            new Uint8Array(capacity),
    a:             new Uint8Array(capacity),
    x:             new Uint8Array(capacity),
    y:             new Uint8Array(capacity),
    sp:            new Uint8Array(capacity),
    p:             new Uint8Array(capacity),
    masterClockNull: new Uint8Array(capacity),
    b1Null:          new Uint8Array(capacity),
    b2Null:          new Uint8Array(capacity),
  };
}

export function allocateBusEventChunk(
  source: TraceSource,
  cpu: TraceCpu,
  capacity: number,
): BusEventChunk {
  return {
    source, cpu, capacity, count: 0,
    seq:         new BigUint64Array(capacity),
    clock:       new BigUint64Array(capacity),
    masterClock: new BigUint64Array(capacity),
    pc:          new Uint16Array(capacity),
    kindCode:    new Uint8Array(capacity),
    addr:        new Uint16Array(capacity),
    value:       new Uint8Array(capacity),
    oldValue:    new Uint8Array(capacity),
    lineAtn:     new Uint8Array(capacity),
    lineClk:     new Uint8Array(capacity),
    lineData:    new Uint8Array(capacity),
    masterClockNull: new Uint8Array(capacity),
    pcNull:          new Uint8Array(capacity),
    addrNull:        new Uint8Array(capacity),
    valueNull:       new Uint8Array(capacity),
    oldValueNull:    new Uint8Array(capacity),
  };
}

export function allocateChipEventChunk(
  source: TraceSource,
  cpu: TraceCpu,
  capacity: number,
): ChipEventChunk {
  return {
    source, cpu, capacity, count: 0,
    seq:         new BigUint64Array(capacity),
    clock:       new BigUint64Array(capacity),
    masterClock: new BigUint64Array(capacity),
    pc:          new Uint16Array(capacity),
    chipCode:    new Uint8Array(capacity),
    kindCode:    new Uint8Array(capacity),
    unit:        new Uint8Array(capacity),
    value:       new Uint8Array(capacity),
    oldValue:    new Uint8Array(capacity),
    masterClockNull: new Uint8Array(capacity),
    pcNull:          new Uint8Array(capacity),
    valueNull:       new Uint8Array(capacity),
    oldValueNull:    new Uint8Array(capacity),
  };
}

export function chunkRoomLeft(chunk: ChunkHeader): number {
  return chunk.capacity - chunk.count;
}

export function chunkIsFull(chunk: ChunkHeader): boolean {
  return chunk.count >= chunk.capacity;
}

// Hot-path appenders. No allocation, no string conversion.

export interface InstructionRow {
  seq: bigint;
  clock: bigint;
  masterClock?: bigint;
  pc: number;
  opcode: number;
  b1?: number;
  b2?: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  p: number;
}

export function appendInstruction(chunk: InstructionChunk, row: InstructionRow): void {
  if (chunkIsFull(chunk)) throw new Error("instruction chunk is full; flush before append");
  const i = chunk.count;
  chunk.seq[i]   = row.seq;
  chunk.clock[i] = row.clock;
  if (row.masterClock !== undefined) {
    chunk.masterClock[i] = row.masterClock;
    chunk.masterClockNull[i] = 0;
  } else {
    chunk.masterClock[i] = 0n;
    chunk.masterClockNull[i] = 1;
  }
  chunk.pc[i]     = row.pc;
  chunk.opcode[i] = row.opcode;
  if (row.b1 !== undefined) { chunk.b1[i] = row.b1; chunk.b1Null[i] = 0; }
  else { chunk.b1[i] = 0; chunk.b1Null[i] = 1; }
  if (row.b2 !== undefined) { chunk.b2[i] = row.b2; chunk.b2Null[i] = 0; }
  else { chunk.b2[i] = 0; chunk.b2Null[i] = 1; }
  chunk.a[i]  = row.a;
  chunk.x[i]  = row.x;
  chunk.y[i]  = row.y;
  chunk.sp[i] = row.sp;
  chunk.p[i]  = row.p;
  chunk.count = i + 1;
}

export interface BusEventRow {
  seq: bigint;
  clock: bigint;
  masterClock?: bigint;
  pc?: number;
  kind: BusEventKind;
  addr?: number;
  value?: number;
  oldValue?: number;
  lineAtn?: boolean;
  lineClk?: boolean;
  lineData?: boolean;
}

const BOOL_NULL = 0xff;
const BOOL_TRUE = 1;
const BOOL_FALSE = 0;
function encodeBool(v: boolean | undefined): number {
  if (v === undefined) return BOOL_NULL;
  return v ? BOOL_TRUE : BOOL_FALSE;
}

export function appendBusEvent(chunk: BusEventChunk, row: BusEventRow): void {
  if (chunkIsFull(chunk)) throw new Error("bus_event chunk is full; flush before append");
  const i = chunk.count;
  chunk.seq[i] = row.seq;
  chunk.clock[i] = row.clock;
  if (row.masterClock !== undefined) {
    chunk.masterClock[i] = row.masterClock;
    chunk.masterClockNull[i] = 0;
  } else {
    chunk.masterClock[i] = 0n;
    chunk.masterClockNull[i] = 1;
  }
  if (row.pc !== undefined) { chunk.pc[i] = row.pc; chunk.pcNull[i] = 0; }
  else { chunk.pc[i] = 0; chunk.pcNull[i] = 1; }
  chunk.kindCode[i] = busEventKindCode(row.kind);
  if (row.addr !== undefined) { chunk.addr[i] = row.addr; chunk.addrNull[i] = 0; }
  else { chunk.addr[i] = 0; chunk.addrNull[i] = 1; }
  if (row.value !== undefined) { chunk.value[i] = row.value; chunk.valueNull[i] = 0; }
  else { chunk.value[i] = 0; chunk.valueNull[i] = 1; }
  if (row.oldValue !== undefined) { chunk.oldValue[i] = row.oldValue; chunk.oldValueNull[i] = 0; }
  else { chunk.oldValue[i] = 0; chunk.oldValueNull[i] = 1; }
  chunk.lineAtn[i]  = encodeBool(row.lineAtn);
  chunk.lineClk[i]  = encodeBool(row.lineClk);
  chunk.lineData[i] = encodeBool(row.lineData);
  chunk.count = i + 1;
}

export interface ChipEventRow {
  seq: bigint;
  clock: bigint;
  masterClock?: bigint;
  pc?: number;
  chip: ChipEventChip;
  kind: ChipEventKind;
  unit: number;
  value?: number;
  oldValue?: number;
}

export function appendChipEvent(chunk: ChipEventChunk, row: ChipEventRow): void {
  if (chunkIsFull(chunk)) throw new Error("chip_event chunk is full; flush before append");
  const i = chunk.count;
  chunk.seq[i]   = row.seq;
  chunk.clock[i] = row.clock;
  if (row.masterClock !== undefined) {
    chunk.masterClock[i] = row.masterClock;
    chunk.masterClockNull[i] = 0;
  } else {
    chunk.masterClock[i] = 0n;
    chunk.masterClockNull[i] = 1;
  }
  if (row.pc !== undefined) { chunk.pc[i] = row.pc; chunk.pcNull[i] = 0; }
  else { chunk.pc[i] = 0; chunk.pcNull[i] = 1; }
  chunk.chipCode[i] = chipEventChipCode(row.chip);
  chunk.kindCode[i] = chipEventKindCode(row.kind);
  chunk.unit[i] = row.unit;
  if (row.value !== undefined) { chunk.value[i] = row.value; chunk.valueNull[i] = 0; }
  else { chunk.value[i] = 0; chunk.valueNull[i] = 1; }
  if (row.oldValue !== undefined) { chunk.oldValue[i] = row.oldValue; chunk.oldValueNull[i] = 0; }
  else { chunk.oldValue[i] = 0; chunk.oldValueNull[i] = 1; }
  chunk.count = i + 1;
}

export function decodeBool(v: number): boolean | null {
  if (v === BOOL_NULL) return null;
  return v === BOOL_TRUE;
}
