// Spec 205-A — Kernel trace controller.
//
// Thin facade over the existing TraceRegistry + BusAccessTraceProducer.
// Spec 205 lands first-divergence diff tooling and the canonical event
// schema; this commit (205-A c1) wires the surface so producers can
// register through the kernel and consumers can read rings / configure
// JSONL artifacts without touching IntegratedSession internals.
//
// Subsequent commits expand the event families per ADR §5.

import type {
  ChannelConfig,
  ChannelName,
  TraceEvent,
  TraceObserver,
  TraceRegistry,
} from "../trace/channels.js";
import type { BusAccessTraceProducer } from "../trace/bus-access.js";

/** Spec 726.B — zero-alloc CPU firehose sink. When set, `publishCpuInstruction`
 *  routes the per-instruction state through this callback as PRIMITIVES (no event
 *  object, no publish wrapper, no observer loop) so a binary trace encodes the
 *  hottest channel without allocating. Owned exclusively by an active binary
 *  TraceRunController; null when no binary trace is capturing CPU.
 *
 *  Returns `consumed`: true means the sink fully handled the event and the
 *  normal publish path MUST be skipped; false means the sink did NOT take it
 *  (e.g. this side is not broadly captured) and the normal publish path must run
 *  so other observers / channels still see it (no silent drop). */
export type CpuBinarySink = (
  side: "c64" | "drive", pc: number, opcode: number, b1: number, b2: number,
  a: number, x: number, y: number, sp: number, p: number, clk: number,
) => boolean;

export interface KernelTraceController {
  /** Configure a single channel (off / ring / jsonl). */
  configureChannel(name: ChannelName, cfg: ChannelConfig): void;
  /** Direct event publish. Producers normally use their own emit API. */
  publish(name: ChannelName, ts: number, data: Record<string, unknown>): void;
  /** Read a channel's current ring buffer (only meaningful in ring mode). */
  getRing(name: ChannelName): TraceEvent[];
  /** Whether a channel is currently producing events (mode != "off"). */
  isEnabled(name: ChannelName): boolean;
  /**
   * Spec 708 — register a parallel observer that receives every published
   * event (across all channels) until the returned dispose is called. Used by
   * the declarative trace-run compiler to tap the EXISTING channels (no second
   * diagnostic path). Producers only publish on enabled channels, so enabling
   * just the needed channels bounds what the observer sees.
   */
  registerObserver(obs: TraceObserver): () => void;
  /** Whether any parallel observer is currently registered. Spec 708.8 — lets a
   *  trace-run teardown be verified (no leaked tap after stop). */
  hasObservers(): boolean;
  /** Close all channels (flushes JSONL fds, clears rings). */
  closeAll(): void;
  /**
   * Bus-access producer for $DD00 / $1800 events. May be undefined when
   * IntegratedSession was constructed without `enableBusAccessTrace`.
   * Spec 205-A c2+: kernel will own the producer directly.
   */
  getBusAccessProducer(): BusAccessTraceProducer | undefined;
  /** Set the producer reference (called by IntegratedSession during wiring). */
  setBusAccessProducer(producer: BusAccessTraceProducer | undefined): void;
  /** Spec 726.B — install/clear the zero-alloc CPU firehose sink. */
  setCpuBinarySink(sink: CpuBinarySink | null): void;
  getCpuBinarySink(): CpuBinarySink | null;
}

export class KernelTraceControllerImpl implements KernelTraceController {
  private busAccessProducer: BusAccessTraceProducer | undefined;
  private cpuBinarySink: CpuBinarySink | null = null;

  constructor(private readonly registry: TraceRegistry) {}

  configureChannel(name: ChannelName, cfg: ChannelConfig): void {
    this.registry.configure(name, cfg);
  }

  publish(name: ChannelName, ts: number, data: Record<string, unknown>): void {
    this.registry.publish(name, ts, data);
  }

  getRing(name: ChannelName): TraceEvent[] {
    return this.registry.getRing(name);
  }

  isEnabled(name: ChannelName): boolean {
    return this.registry.isEnabled(name);
  }

  registerObserver(obs: TraceObserver): () => void {
    return this.registry.registerObserver(obs);
  }

  hasObservers(): boolean {
    return this.registry.hasObservers();
  }

  closeAll(): void {
    this.registry.closeAll();
  }

  getBusAccessProducer(): BusAccessTraceProducer | undefined {
    return this.busAccessProducer;
  }

  setBusAccessProducer(producer: BusAccessTraceProducer | undefined): void {
    this.busAccessProducer = producer;
  }

  setCpuBinarySink(sink: CpuBinarySink | null): void {
    this.cpuBinarySink = sink;
  }

  getCpuBinarySink(): CpuBinarySink | null {
    return this.cpuBinarySink;
  }
}
