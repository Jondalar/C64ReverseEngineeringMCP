// Spec 804 §4.3 — names on the runtime's STRUCTURED answers.
//
// `monitorDisasm` lines and trace rows already carry their addresses as numbers
// (`addr`, `target`, `operandAddr`, `pc`). Naming them is the same generic step as the
// monitor's spans: every listed field that holds a number is resolved, and the row gains
// a sibling `<field>Name` — the numbers stay exactly as the runtime sent them.

import { formatName, type SymbolResolver } from "./resolver.js";
import type { ByteSource, MachineState, ResolvedName, RuntimeSpace } from "./types.js";

export interface AddressField {
  key: string;
  role: "pc" | "target" | "operand" | "memory";
}

export type NamedRow<T> = T & Record<string, unknown>;

export interface RowNaming<T> {
  resolver: SymbolResolver;
  spaceOf: (row: T) => RuntimeSpace;
  /** the bytes a row is compared against — the live machine, or a trace frozen at the row's cycle */
  bytesFor: (row: T) => ByteSource;
  machine?: MachineState;
}

export function nameText(n: ResolvedName): string {
  return formatName(n);
}

export async function nameRows<T extends Record<string, unknown>>(rows: T[], fields: AddressField[], how: RowNaming<T>): Promise<Array<NamedRow<T>>> {
  const out: Array<NamedRow<T>> = rows.map((r) => ({ ...r }));
  if (how.resolver.size === 0) return out;
  // Rows that share a byte source are resolved in one batch (one memory read).
  const groups = new Map<ByteSource, number[]>();
  rows.forEach((r, i) => {
    const b = how.bytesFor(r);
    const list = groups.get(b) ?? [];
    list.push(i);
    groups.set(b, list);
  });
  for (const [bytes, idxs] of groups) {
    const reqs: Array<{ row: number; key: string; space: RuntimeSpace; addr: number }> = [];
    for (const i of idxs) {
      for (const f of fields) {
        const v = rows[i]![f.key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffff) continue;
        reqs.push({ row: i, key: f.key, space: how.spaceOf(rows[i]!), addr: v });
      }
    }
    if (reqs.length === 0) continue;
    const res = await how.resolver.resolve(reqs.map((q) => ({ space: q.space, addr: q.addr })), { bytes, machine: how.machine });
    res.forEach((r, k) => {
      const q = reqs[k]!;
      if (r.name) (out[q.row] as Record<string, unknown>)[`${q.key}Name`] = { text: formatName(r.name), ...r.name };
      else if (r.ambiguous) (out[q.row] as Record<string, unknown>)[`${q.key}Ambiguous`] = r.ambiguous;
    });
  }
  return out;
}
