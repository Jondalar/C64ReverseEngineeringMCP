// Spec 122 (M5.1) v1 — trace channel registry.
//
// Per-subsystem ring-buffer producers. Each channel is a generic
// event sink with two modes:
//   - "ring":  in-memory ring buffer of capacity N (read via getRing)
//   - "jsonl": appends each event to a JSONL file
//
// Existing channels (already produced elsewhere in code, just gated
// here): iec (Spec 093), drive_pc (Spec 093), eof (Spec 094).
// New channels exposed for v1: cpu (instruction PC), io (memory bus
// IO writes), vic (raster IRQ + mode change), cia (timer underflow),
// keyboard (matrix change), joystick (stick change).

import { appendFileSync, openSync, closeSync } from "node:fs";

export type ChannelName =
  | "cpu" | "io" | "iec" | "drive_pc" | "gcr"
  | "vic" | "cia" | "sid" | "keyboard" | "joystick" | "eof"
  | "bus_access"  // Spec 142: $DD00 / $1800 access trace
  | "irq"         // Spec 205-A c3: KernelIrqEvent emit + serviced backfill
  | "session";    // Spec 205-A c10: media mount, reset, input events

export type ChannelMode = "off" | "ring" | "jsonl";

export interface ChannelConfig {
  mode: ChannelMode;
  capacity?: number;     // ring mode
  path?: string;         // jsonl mode
}

export interface TraceEvent {
  ts: number;     // C64 cycle
  channel: ChannelName;
  data: Record<string, unknown>;
}

class Channel {
  public mode: ChannelMode = "off";
  private ring: TraceEvent[] = [];
  private capacity = 1024;
  private fd: number | null = null;

  configure(cfg: ChannelConfig): void {
    this.close();
    this.mode = cfg.mode;
    if (cfg.mode === "ring") {
      this.capacity = Math.max(8, cfg.capacity ?? 1024);
      this.ring = [];
    } else if (cfg.mode === "jsonl") {
      if (!cfg.path) throw new Error(`channel jsonl mode requires path`);
      this.fd = openSync(cfg.path, "a");
    }
  }

  publish(ev: TraceEvent): void {
    if (this.mode === "off") return;
    if (this.mode === "ring") {
      this.ring.push(ev);
      if (this.ring.length > this.capacity) this.ring.shift();
      return;
    }
    if (this.mode === "jsonl" && this.fd !== null) {
      appendFileSync(this.fd, JSON.stringify(ev) + "\n");
    }
  }

  getRing(): TraceEvent[] { return this.ring.slice(); }

  close(): void {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    this.mode = "off";
    this.ring = [];
  }
}

// Spec 217 — observer callback (option B). A registered observer
// receives every published event (across all channels) regardless of
// per-channel mode. This lets a TraceStoreProducer attach without
// changing channel modes or per-channel publish sites.
export type TraceObserver = (event: TraceEvent) => void;

export class TraceRegistry {
  private channels = new Map<ChannelName, Channel>();
  private observers: TraceObserver[] = [];

  configure(name: ChannelName, cfg: ChannelConfig): void {
    let ch = this.channels.get(name);
    if (!ch) { ch = new Channel(); this.channels.set(name, ch); }
    ch.configure(cfg);
  }

  isEnabled(name: ChannelName): boolean {
    return (this.channels.get(name)?.mode ?? "off") !== "off";
  }

  publish(name: ChannelName, ts: number, data: Record<string, unknown>): void {
    const ch = this.channels.get(name);
    const event: TraceEvent = { ts, channel: name, data };
    if (this.observers.length > 0) {
      for (const obs of this.observers) obs(event);
    }
    if (!ch || ch.mode === "off") return;
    ch.publish(event);
  }

  // Spec 217: register/unregister parallel observers.
  registerObserver(observer: TraceObserver): () => void {
    this.observers.push(observer);
    return () => {
      const i = this.observers.indexOf(observer);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  getRing(name: ChannelName): TraceEvent[] {
    return this.channels.get(name)?.getRing() ?? [];
  }

  closeAll(): void {
    for (const ch of this.channels.values()) ch.close();
    this.observers = [];
  }
}
