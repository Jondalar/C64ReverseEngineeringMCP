// Spec 804 §4.2 — residency per TRACE ROW, not only at freeze.
//
// A payload change is a run of writes into its code range, and the trace records writes.
// So the value of a code byte X at cycle t is exact where the trace captured memory:
//   1. the value of the last write to X before t, else
//   2. the old value of the next write to X at or after t, else
//   3. X was never written in the trace — it held one value throughout, and any executed
//      instruction that covered X shows it (the CPU row carries opcode/b1/b2).
// Two different executed values for a never-written byte means the trace missed a write
// (no memory domain captured, a DMA): that byte is unknown, and unknown is never a name.
//
// The store is read through the runtime (Spec 802 — C64RE has no trace reader): two
// `safeQuery` calls over the store's `bus_events` and `instructions` views, restricted to
// the addresses the resolver will actually compare.

import { disasm6502 } from "../monitor/disasm6502.js";
import { toRanges } from "./live-bytes.js";
import type { ByteSource, RuntimeSpace } from "./types.js";

export type SafeQuery = (sql: string, limit: number) => Promise<unknown[][]>;

interface Write { clock: number; value: number; old: number | undefined }

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

export class TraceTimeline {
  private readonly writes = new Map<number, Write[]>();
  private readonly executed = new Map<number, Set<number>>();

  static async build(query: SafeQuery, cpu: RuntimeSpace, addrs: number[]): Promise<TraceTimeline> {
    const t = new TraceTimeline();
    if (addrs.length === 0) return t;
    const wanted = new Set(addrs);
    for (let i = 0; i < addrs.length; i += 400) {
      const chunk = addrs.slice(i, i + 400);
      const rows = await query(
        `SELECT addr, master_clock, value, old_value FROM bus_events WHERE cpu = '${cpu}' AND kind = 'write' AND addr IN (${chunk.join(",")}) ORDER BY addr, master_clock, seq`,
        1_000_000,
      );
      for (const r of rows) {
        const a = num(r[0]);
        const list = t.writes.get(a) ?? [];
        list.push({ clock: num(r[1]), value: num(r[2]), old: r[3] === null || r[3] === undefined ? undefined : num(r[3]) });
        t.writes.set(a, list);
      }
    }
    for (const range of toRanges(addrs, 64)) {
      const lo = Math.max(0, range.addr - 2);
      const hi = range.addr + range.len - 1;
      const rows = await query(
        `SELECT pc, opcode, b1, b2 FROM instructions WHERE cpu = '${cpu}' AND pc BETWEEN ${lo} AND ${hi} GROUP BY pc, opcode, b1, b2`,
        1_000_000,
      );
      for (const r of rows) {
        const pc = num(r[0]);
        const bytes = [num(r[1]), num(r[2]), num(r[3])];
        const size = disasm6502((a) => bytes[(a - pc) & 0xffff] ?? 0, pc).size;
        for (let k = 0; k < size; k++) {
          const a = (pc + k) & 0xffff;
          if (!wanted.has(a)) continue;
          const set = t.executed.get(a) ?? new Set<number>();
          set.add(bytes[k]!);
          t.executed.set(a, set);
        }
      }
    }
    return t;
  }

  /** The byte at `addr` at cycle `clock`, or undefined when the trace cannot say. */
  valueAt(addr: number, clock: number): number | undefined {
    const ws = this.writes.get(addr);
    if (ws && ws.length > 0) {
      let prev: Write | undefined;
      let next: Write | undefined;
      for (const w of ws) {
        if (w.clock < clock) prev = w;
        else { next = w; break; }
      }
      if (prev) return prev.value;
      return next?.old;
    }
    const seen = this.executed.get(addr);
    if (seen && seen.size === 1) return [...seen][0];
    return undefined;
  }

  /** A byte source frozen at one cycle — what the resolver compares a row against. */
  at(clock: number): ByteSource {
    return {
      read: async (_space, _lens, addrs) => {
        const out = new Map<number, number>();
        for (const a of addrs) {
          const v = this.valueAt(a, clock);
          if (v !== undefined) out.set(a, v);
        }
        return out;
      },
    };
  }
}
