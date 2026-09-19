// Spec 804 §4.3 — `runtime_resolve_pc`, answered from the graph.
//
// It used to ask the runtime (`resolvePc`), which read the project's analysis and
// annotation files itself. TRX64 holds no symbols now; the answer comes from the same
// resolver every other surface uses, with the residency evidence that decided it.

import { formatName, type ResolveContext, type SymbolResolver } from "./resolver.js";
import { payloadLabel, type ResidencyEvidence, type RuntimeSpace } from "./types.js";

export interface PcExplanation {
  pc: number;
  space: RuntimeSpace;
  /** the one name shown at this address, with its origin tag */
  name?: string;
  origin?: string;
  payload?: string | null;
  offset?: number;
  ambiguous?: Array<{ name: string; origin: string; payload: string | null }>;
  /** every name at or around the address, and whether its payload is resident */
  candidates: Array<{ name: string; origin: string; kind: string; address: number; endAddress: number | null; payload: string | null; resident: boolean }>;
  residency: ResidencyEvidence[];
  note?: string;
}

export async function explainPc(
  resolver: SymbolResolver,
  q: { pc: number; space: RuntimeSpace; payload?: string },
  ctx: ResolveContext,
): Promise<PcExplanation> {
  const [r] = await resolver.resolve([{ space: q.space, addr: q.pc, containment: "all" }], ctx);
  const { exact, containing } = resolver.candidatesAt(q.space, q.pc);
  const all = [...exact, ...containing];
  const wanted = q.payload?.toLowerCase().replace(/\.[a-z0-9]+$/u, "").replace(/_analysis$/u, "");
  const residentPayloads = new Set(r!.evidence.filter((e) => e.resident).map((e) => e.payload));
  const candidates = all
    .filter((e) => !wanted || (payloadLabel(e.payload) ?? "") === wanted)
    .map((e) => ({
      name: e.name, origin: e.origin, kind: e.kind, address: e.address, endAddress: e.endAddress,
      payload: payloadLabel(e.payload),
      resident: e.payload === null || residentPayloads.has(payloadLabel(e.payload)!),
    }));
  const out: PcExplanation = { pc: q.pc, space: q.space, candidates, residency: r!.evidence };
  const shown = r!.name && (!wanted || r!.name.payload === wanted) ? r!.name : undefined;
  if (shown) {
    out.name = formatName(shown);
    out.origin = shown.origin;
    out.payload = shown.payload;
    out.offset = shown.offset;
  } else if (r!.ambiguous) {
    out.ambiguous = r!.ambiguous;
  }
  if (resolver.size === 0) out.note = "no names in this project yet (no graph, no build symbols)";
  else if (!shown && !r!.ambiguous) out.note = candidates.length === 0
    ? "no name at or around this address"
    : "names exist here, but none of their payloads is in memory now — no match, no name";
  return out;
}
