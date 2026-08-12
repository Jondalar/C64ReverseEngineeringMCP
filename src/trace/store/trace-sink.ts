// Spec 217 — TraceSink interface + Null/DuckDb impls.

import type { BusEventChunk, ChipEventChunk, InstructionChunk } from "./chunk-buffer.js";

export interface TraceSinkSummary {
  instructionsWritten: number;
  busEventsWritten: number;
  chipEventsWritten: number;
  durationMs: number;
  // backpressure / writer stats (Spec 217 v3+)
  stallTotalMs: number;
  stallEventCount: number;
  chunksDropped: number;
  // path-specific extras
  details?: Record<string, unknown>;
}

export interface TraceSink {
  writeInstructionChunk(chunk: InstructionChunk): Promise<void>;
  writeBusEventChunk(chunk: BusEventChunk): Promise<void>;
  writeChipEventChunk(chunk: ChipEventChunk): Promise<void>;
  close(): Promise<TraceSinkSummary>;
}

// Counts-only baseline. Establishes hot-path-throughput floor.
export class NullTraceSink implements TraceSink {
  private instructions = 0;
  private busEvents = 0;
  private chipEvents = 0;
  private startedAt = Date.now();

  async writeInstructionChunk(chunk: InstructionChunk): Promise<void> {
    this.instructions += chunk.count;
  }
  async writeBusEventChunk(chunk: BusEventChunk): Promise<void> {
    this.busEvents += chunk.count;
  }
  async writeChipEventChunk(chunk: ChipEventChunk): Promise<void> {
    this.chipEvents += chunk.count;
  }
  async close(): Promise<TraceSinkSummary> {
    return {
      instructionsWritten: this.instructions,
      busEventsWritten: this.busEvents,
      chipEventsWritten: this.chipEvents,
      durationMs: Date.now() - this.startedAt,
      stallTotalMs: 0,
      stallEventCount: 0,
      chunksDropped: 0,
    };
  }
}
