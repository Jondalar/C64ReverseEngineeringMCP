// Spec 217 — TraceStoreProducer
//
// Parallel observer (Spec 217 option B): registers as observer on the
// kernel TraceRegistry, translates channel events into chunk-buffer
// rows, flushes via TraceSink. No JSON.stringify, no SQL in hot path.

import {
  allocateBusEventChunk,
  allocateChipEventChunk,
  allocateInstructionChunk,
  appendBusEvent,
  appendChipEvent,
  appendInstruction,
  chunkIsFull,
} from "./chunk-buffer.js";
import type {
  BusEventChunk,
  BusEventKind,
  ChipEventChip,
  ChipEventChunk,
  ChipEventKind,
  InstructionChunk,
  TraceCpu,
  TraceSource,
} from "./chunk-buffer.js";
import type { TraceSink, TraceSinkSummary } from "./trace-sink.js";

export interface TraceStoreProducerOptions {
  source: TraceSource;
  sink: TraceSink;
  // Producer-side master_clock mapper. Receives the channel ts (= source
  // clock as emitted by the kernel) and returns the master_clock for
  // it. Caller wires this based on captured zero-points + drive offset.
  masterClockMapper?: (cpu: TraceCpu, sourceClock: number) => bigint | undefined;
  // Chunk capacity (rows per buffer). Default 64Ki.
  capacity?: number;
}

interface PublishedEvent {
  ts: number;
  channel: string;
  data: Record<string, unknown>;
}

export class TraceStoreProducer {
  private cpuChunks: Record<TraceCpu, InstructionChunk | undefined> = { c64: undefined, drive8: undefined };
  private busChunks: Record<TraceCpu, BusEventChunk | undefined> = { c64: undefined, drive8: undefined };
  private chipChunks: Record<TraceCpu, ChipEventChunk | undefined> = { c64: undefined, drive8: undefined };
  private cpuSeq = { c64: 0n, drive8: 0n };
  private busSeq = { c64: 0n, drive8: 0n };
  private chipSeq = { c64: 0n, drive8: 0n };
  private droppedEvents = 0;
  private flushPromise: Promise<void> = Promise.resolve();

  constructor(private opts: TraceStoreProducerOptions) {}

  // Bind to a TraceRegistry. Returns dispose function.
  attach(registerObserver: (observer: (event: PublishedEvent) => void) => () => void): () => void {
    const handler = (ev: PublishedEvent) => {
      try {
        this.dispatch(ev);
      } catch {
        this.droppedEvents++;
      }
    };
    return registerObserver(handler);
  }

  // -------------------------------------------------------------------------
  // Direct publish API — used by non-channel producers (e.g. VICE binmon
  // poll loop). Channel handlers (onCpu/onIec/...) route through these.
  // -------------------------------------------------------------------------

  publishInstruction(
    side: TraceCpu,
    pc: number,
    opcode: number,
    a: number, x: number, y: number, sp: number, p: number,
    clk: number | bigint,
    b1?: number,
    b2?: number,
  ): void {
    const clkN = typeof clk === "bigint" ? clk : BigInt(clk);
    const mc = this.opts.masterClockMapper?.(side, Number(clkN));
    const chunk = this.ensureCpuChunk(side);
    appendInstruction(chunk, {
      seq: this.cpuSeq[side]++,
      clock: clkN,
      masterClock: mc,
      pc: pc & 0xffff,
      opcode: opcode & 0xff,
      b1: b1 !== undefined ? b1 & 0xff : undefined,
      b2: b2 !== undefined ? b2 & 0xff : undefined,
      a: a & 0xff, x: x & 0xff, y: y & 0xff, sp: sp & 0xff, p: p & 0xff,
    });
    if (chunkIsFull(chunk)) this.flushInstruction(side);
  }

  publishBusEvent(
    side: TraceCpu,
    kind: BusEventKind,
    clk: number | bigint,
    extras: { pc?: number; addr?: number; value?: number; oldValue?: number; lineAtn?: boolean; lineClk?: boolean; lineData?: boolean } = {},
  ): void {
    const clkN = typeof clk === "bigint" ? clk : BigInt(clk);
    const chunk = this.ensureBusChunk(side);
    appendBusEvent(chunk, {
      seq: this.busSeq[side]++,
      clock: clkN,
      masterClock: this.opts.masterClockMapper?.(side, Number(clkN)),
      pc: extras.pc,
      kind,
      addr: extras.addr,
      value: extras.value,
      oldValue: extras.oldValue,
      lineAtn: extras.lineAtn,
      lineClk: extras.lineClk,
      lineData: extras.lineData,
    });
    if (chunkIsFull(chunk)) this.flushBus(side);
  }

  publishChipEvent(
    side: TraceCpu,
    chip: ChipEventChip,
    kind: ChipEventKind,
    clk: number | bigint,
    extras: { pc?: number; unit?: number; value?: number; oldValue?: number } = {},
  ): void {
    const clkN = typeof clk === "bigint" ? clk : BigInt(clk);
    const chunk = this.ensureChipChunk(side);
    appendChipEvent(chunk, {
      seq: this.chipSeq[side]++,
      clock: clkN,
      masterClock: this.opts.masterClockMapper?.(side, Number(clkN)),
      pc: extras.pc,
      chip,
      kind,
      unit: extras.unit ?? 0,
      value: extras.value,
      oldValue: extras.oldValue,
    });
    if (chunkIsFull(chunk)) this.flushChip(side);
  }

  private dispatch(ev: PublishedEvent): void {
    switch (ev.channel) {
      case "cpu":         return this.onCpu(ev);
      case "bus_access":  return this.onBusAccess(ev);
      case "iec":         return this.onIec(ev);
      case "irq":         return this.onIrq(ev);
      case "cia":         return this.onCia(ev);
      case "vic":         return this.onVic(ev);
      case "gcr":         return this.onGcr(ev);
      // session/keyboard/joystick/sid/eof/io/drive_pc — ignored for now
      default: return;
    }
  }

  // -------------------------------------------------------------------------
  // Channel handlers
  // -------------------------------------------------------------------------

  private onCpu(ev: PublishedEvent): void {
    const side = ev.data.side === "drive" ? "drive8" as TraceCpu : "c64" as TraceCpu;
    const pc = (ev.data.pc as number) ?? 0;
    const clk = ev.ts;
    const mc = this.opts.masterClockMapper?.(side, clk);
    const chunk = this.ensureCpuChunk(side);
    // Spec 217: full register state + operand bytes from publishCpuInstruction.
    const opcode = (ev.data.opcode as number) ?? 0;
    const b1 = ev.data.b1 as number | undefined;
    const b2 = ev.data.b2 as number | undefined;
    const a = (ev.data.a as number) ?? 0;
    const x = (ev.data.x as number) ?? 0;
    const y = (ev.data.y as number) ?? 0;
    const sp = (ev.data.sp as number) ?? 0;
    const p = (ev.data.p as number) ?? 0;
    appendInstruction(chunk, {
      seq: this.cpuSeq[side]++,
      clock: BigInt(clk),
      masterClock: mc,
      pc: pc & 0xffff,
      opcode: opcode & 0xff,
      b1: b1 !== undefined ? b1 & 0xff : undefined,
      b2: b2 !== undefined ? b2 & 0xff : undefined,
      a: a & 0xff, x: x & 0xff, y: y & 0xff, sp: sp & 0xff, p: p & 0xff,
    });
    if (chunkIsFull(chunk)) this.flushInstruction(side);
  }

  private onBusAccess(ev: PublishedEvent): void {
    const side: TraceCpu = ev.data.side === "drive" ? "drive8" : "c64";
    const addr = (ev.data.addr as number) ?? undefined;
    const value = (ev.data.value as number) ?? undefined;
    // Spec 218: bus-access producer publishes `op`, not `access`.
    // Tolerate both field names for back-compat with any older event
    // shape that might still use `access`.
    const opField = (ev.data.op ?? ev.data.access) as string | undefined;
    const isWrite = opField === "write";
    const lineAtn = (ev.data.iec as { atn?: number } | undefined)?.atn === undefined
      ? undefined
      : ((ev.data.iec as { atn: number }).atn !== 0);
    const lineClk = (ev.data.iec as { clk?: number } | undefined)?.clk === undefined
      ? undefined
      : ((ev.data.iec as { clk: number }).clk !== 0);
    const lineData = (ev.data.iec as { data?: number } | undefined)?.data === undefined
      ? undefined
      : ((ev.data.iec as { data: number }).data !== 0);
    const chunk = this.ensureBusChunk(side);
    appendBusEvent(chunk, {
      seq: this.busSeq[side]++,
      clock: BigInt(ev.ts),
      masterClock: this.opts.masterClockMapper?.(side, ev.ts),
      pc: ev.data.pc as number | undefined,
      kind: (isWrite ? "write" : "read") as BusEventKind,
      addr: addr,
      value: value,
      lineAtn,
      lineClk,
      lineData,
    });
    if (chunkIsFull(chunk)) this.flushBus(side);
  }

  private onIec(ev: PublishedEvent): void {
    // IEC line edges. Stored in bus_events with kind=line_change.
    // Side derives from data.actor when available; default c64.
    const actor = ev.data.actor as string | undefined;
    const side: TraceCpu = actor === "drive" ? "drive8" : "c64";
    const chunk = this.ensureBusChunk(side);
    const lineAtn = ev.data.atn as boolean | undefined;
    const lineClk = ev.data.clk as boolean | undefined;
    const lineData = ev.data.data as boolean | undefined;
    appendBusEvent(chunk, {
      seq: this.busSeq[side]++,
      clock: BigInt(ev.ts),
      masterClock: this.opts.masterClockMapper?.(side, ev.ts),
      kind: "line_change",
      lineAtn, lineClk, lineData,
    });
    if (chunkIsFull(chunk)) this.flushBus(side);
  }

  private onIrq(ev: PublishedEvent): void {
    const target = ev.data.target as string | undefined;
    const side: TraceCpu = target === "drive" ? "drive8" : "c64";
    const asserted = ev.data.asserted as boolean | undefined;
    const kind: ChipEventKind = ev.data.serviced
      ? "irq_service"
      : asserted === false ? "irq_clear" : "irq_assert";
    const chip = this.deriveChipFromIrqSource(ev.data.source as string | undefined);
    const chunk = this.ensureChipChunk(side);
    appendChipEvent(chunk, {
      seq: this.chipSeq[side]++,
      clock: BigInt(ev.ts),
      masterClock: this.opts.masterClockMapper?.(side, ev.ts),
      chip,
      kind,
      unit: 0,
    });
    if (chunkIsFull(chunk)) this.flushChip(side);
  }

  private deriveChipFromIrqSource(source: string | undefined): ChipEventChip {
    if (!source) return "cia1";
    if (source.startsWith("cia1")) return "cia1";
    if (source.startsWith("cia2")) return "cia2";
    if (source.startsWith("via1")) return "via1";
    if (source.startsWith("via2")) return "via2";
    if (source.startsWith("vic")) return "vic";
    if (source.includes("gcr")) return "gcr";
    return "cia1";
  }

  private onCia(ev: PublishedEvent): void {
    const chip: ChipEventChip = ev.data.chip === "cia2" ? "cia2" : "cia1";
    const side: TraceCpu = "c64";
    const chunk = this.ensureChipChunk(side);
    appendChipEvent(chunk, {
      seq: this.chipSeq[side]++,
      clock: BigInt(ev.ts),
      masterClock: this.opts.masterClockMapper?.(side, ev.ts),
      chip,
      kind: "ifr_set",
      unit: 0,
      value: ev.data.bits as number | undefined,
    });
    if (chunkIsFull(chunk)) this.flushChip(side);
  }

  private onVic(ev: PublishedEvent): void {
    const side: TraceCpu = "c64";
    const chunk = this.ensureChipChunk(side);
    const isFrame = ev.data.kind === "frame";
    appendChipEvent(chunk, {
      seq: this.chipSeq[side]++,
      clock: BigInt(ev.ts),
      masterClock: this.opts.masterClockMapper?.(side, ev.ts),
      chip: "vic",
      kind: isFrame ? "frame_start" : "raster_line",
      unit: ((ev.data.raster as number) ?? 0) & 0xff,
    });
    if (chunkIsFull(chunk)) this.flushChip(side);
  }

  private onGcr(ev: PublishedEvent): void {
    const side: TraceCpu = "drive8";
    const kindRaw = ev.data.kind as string;
    let kind: ChipEventKind;
    let unit = 0;
    let value: number | undefined;
    switch (kindRaw) {
      case "motor":     kind = "motor";       value = ev.data.on ? 1 : 0; break;
      case "density":   kind = "density";     value = ev.data.zone as number | undefined; break;
      case "head_step": kind = "head_step";   unit = (ev.data.halfTrack as number ?? 0) & 0xff; break;
      case "byte_ready":kind = "byte_ready";  value = ev.data.byte as number | undefined; break;
      case "sync_edge":
      case "sync":      kind = "sync_edge";   value = ev.data.active ? 1 : 0; break;
      default: return;  // unknown subtype, skip
    }
    const chunk = this.ensureChipChunk(side);
    appendChipEvent(chunk, {
      seq: this.chipSeq[side]++,
      clock: BigInt(ev.ts),
      masterClock: this.opts.masterClockMapper?.(side, ev.ts),
      chip: "gcr",
      kind,
      unit,
      value,
    });
    if (chunkIsFull(chunk)) this.flushChip(side);
  }

  // -------------------------------------------------------------------------
  // Chunk allocation + flush
  // -------------------------------------------------------------------------

  private ensureCpuChunk(cpu: TraceCpu): InstructionChunk {
    let c = this.cpuChunks[cpu];
    if (!c) {
      c = allocateInstructionChunk(this.opts.source, cpu, this.opts.capacity ?? 65536);
      this.cpuChunks[cpu] = c;
    }
    return c;
  }
  private ensureBusChunk(cpu: TraceCpu): BusEventChunk {
    let c = this.busChunks[cpu];
    if (!c) {
      c = allocateBusEventChunk(this.opts.source, cpu, this.opts.capacity ?? 65536);
      this.busChunks[cpu] = c;
    }
    return c;
  }
  private ensureChipChunk(cpu: TraceCpu): ChipEventChunk {
    let c = this.chipChunks[cpu];
    if (!c) {
      c = allocateChipEventChunk(this.opts.source, cpu, this.opts.capacity ?? 65536);
      this.chipChunks[cpu] = c;
    }
    return c;
  }

  // Flush calls are synchronous from the producer's perspective; we
  // serialize them via flushPromise so the caller can await `close()`
  // after all dispatches have been queued. Sink writes still happen
  // off-event-loop via the await chain.
  private flushInstruction(cpu: TraceCpu): void {
    const chunk = this.cpuChunks[cpu];
    if (!chunk || chunk.count === 0) return;
    this.cpuChunks[cpu] = undefined;
    this.flushPromise = this.flushPromise.then(() => this.opts.sink.writeInstructionChunk(chunk));
  }
  private flushBus(cpu: TraceCpu): void {
    const chunk = this.busChunks[cpu];
    if (!chunk || chunk.count === 0) return;
    this.busChunks[cpu] = undefined;
    this.flushPromise = this.flushPromise.then(() => this.opts.sink.writeBusEventChunk(chunk));
  }
  private flushChip(cpu: TraceCpu): void {
    const chunk = this.chipChunks[cpu];
    if (!chunk || chunk.count === 0) return;
    this.chipChunks[cpu] = undefined;
    this.flushPromise = this.flushPromise.then(() => this.opts.sink.writeChipEventChunk(chunk));
  }

  async close(): Promise<TraceSinkSummary & { droppedEvents: number }> {
    for (const cpu of ["c64", "drive8"] as TraceCpu[]) {
      this.flushInstruction(cpu);
      this.flushBus(cpu);
      this.flushChip(cpu);
    }
    await this.flushPromise;
    const sinkSum = await this.opts.sink.close();
    return { ...sinkSum, droppedEvents: this.droppedEvents };
  }
}
