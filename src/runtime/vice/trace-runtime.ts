import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface ViceTraceInstructionEvent {
  kind: "instruction";
  sampleIndex: number;
  clock: string;
  pc?: number;
  instructionBytes: number[];
  registers: Record<string, number>;
}

export interface ViceTraceSampleEvent {
  kind: "sample";
  sampleIndex: number;
  capturedAt: string;
  currentPc?: number;
  items: number;
}

// Spec 095 (M0.2): EOF sample event for the VICE-side EOF trace harness.
// Backwards-compatible: existing parsers ignore unknown `kind` values.
export interface ViceTraceEofChannels {
  drivePc?: number;
  iec?: { atn: 0 | 1; clk: 0 | 1; data: 0 | 1 };
  zp?: Record<string, number>; // keyed by lowercase hex byte e.g. "90", "a5"
}

export interface ViceTraceEofSampleEvent {
  kind: "eof-sample";
  sampleIndex: number;
  clock: string;            // VICE clock string (matches instruction.clock)
  c64Cyc: number;
  driveCyc: number;
  c64Pc: number;
  channels: ViceTraceEofChannels;
}

export interface ViceTraceEofMomentEvent {
  kind: "eof-moment";
  name:
    | "first_a5_ge1"
    | "first_eoi"
    | "last_talk_pc"
    | "untalk_send"
    | "drive_idle_return";
  c64Cyc: number;
  driveCyc: number;
  c64Pc: number;
  drivePc: number;
}

export interface ViceTraceEofHeaderEvent {
  kind: "eof-header";
  source: "headless" | "vice";
  schemaVersion: 1;
  diskPath?: string;
  loadName?: string;
  // Implementations may add additional optional fields; consumers must
  // tolerate unknown keys.
  [extra: string]: unknown;
}

export type ViceTraceEvent =
  | ViceTraceInstructionEvent
  | ViceTraceSampleEvent
  | ViceTraceEofSampleEvent
  | ViceTraceEofMomentEvent
  | ViceTraceEofHeaderEvent;

export async function* readRuntimeTrace(path: string): AsyncGenerator<ViceTraceEvent> {
  for await (const line of readJsonlLines(path)) {
    try {
      const event = JSON.parse(line) as ViceTraceEvent;
      if (
        event.kind === "sample"
        || event.kind === "instruction"
        || event.kind === "eof-sample"
        || event.kind === "eof-moment"
        || event.kind === "eof-header"
      ) {
        yield event;
      }
    } catch {
      // ignore malformed runtime trace rows
    }
  }
}

export async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      yield line;
    }
  } finally {
    reader.close();
    input.destroy();
  }
}
