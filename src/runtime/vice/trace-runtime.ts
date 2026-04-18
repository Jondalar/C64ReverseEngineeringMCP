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

export type ViceTraceEvent = ViceTraceInstructionEvent | ViceTraceSampleEvent;

export async function* readRuntimeTrace(path: string): AsyncGenerator<ViceTraceEvent> {
  for await (const line of readJsonlLines(path)) {
    try {
      const event = JSON.parse(line) as ViceTraceEvent;
      if (event.kind === "sample" || event.kind === "instruction") {
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
