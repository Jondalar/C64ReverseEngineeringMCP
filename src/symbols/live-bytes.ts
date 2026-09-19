// Spec 804 §4.2 — live memory for the residency check, read from the runtime.
//
// One `session/read_memory` per batch: the addresses are merged into short ranges, read
// through the lens the span came with (C64) or the drive's own address space
// (`space: "drive8"`). The runtime delivers bytes; deciding what they mean happens here.

import type { ByteSource, RuntimeSpace } from "./types.js";

export type RuntimeCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Merge sorted addresses into ranges, bridging gaps of up to `gap` bytes. */
export function toRanges(addrs: number[], gap = 16): Array<{ addr: number; len: number }> {
  const sorted = [...new Set(addrs.map((a) => a & 0xffff))].sort((a, b) => a - b);
  const out: Array<{ addr: number; len: number }> = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last.addr + last.len - 1 + gap) last.len = a - last.addr + 1;
    else out.push({ addr: a, len: 1 });
  }
  return out;
}

export function liveByteSource(call: RuntimeCall, sessionId: string | undefined): ByteSource {
  return {
    async read(space: RuntimeSpace, lens: string | undefined, addrs: number[]): Promise<Map<number, number>> {
      const out = new Map<number, number>();
      if (addrs.length === 0) return out;
      const ranges = toRanges(addrs).map((r) => ({
        addr: r.addr,
        len: r.len,
        ...(space === "drive8" ? { space: "drive8" } : { lens: lens ?? "cpu" }),
      }));
      let reply: { chunks?: Array<{ addr: number; bytes: string }> };
      try {
        reply = (await call("session/read_memory", { ...(sessionId ? { session_id: sessionId } : {}), ranges })) as typeof reply;
      } catch {
        return out; // unreadable → unknown → no name (never a guess)
      }
      for (const chunk of reply.chunks ?? []) {
        const bytes = Buffer.from(chunk.bytes, "base64");
        for (let i = 0; i < bytes.length; i++) out.set((chunk.addr + i) & 0xffff, bytes[i]!);
      }
      return out;
    },
  };
}
