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
}

export class KernelTraceControllerImpl implements KernelTraceController {
  private busAccessProducer: BusAccessTraceProducer | undefined;

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

  closeAll(): void {
    this.registry.closeAll();
  }

  getBusAccessProducer(): BusAccessTraceProducer | undefined {
    return this.busAccessProducer;
  }

  setBusAccessProducer(producer: BusAccessTraceProducer | undefined): void {
    this.busAccessProducer = producer;
  }
}
