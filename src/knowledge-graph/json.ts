// Spec 822.2 — one canonical JSON serialiser for every graph column that holds
// JSON (`nodes.attrs`, `edges.evidence`, the 822 tables' `attrs`).
//
// The earlier `JSON.stringify(v, Object.keys(v).sort())` sorted the TOP-level
// keys — and, because a replacer ARRAY applies at every depth, silently dropped
// every nested key that was not also a top-level name: a payload's
// `{ format, content_hash }` came out as `{}`, a medium span as `[{}]`. Keys are
// sorted recursively here; nothing is dropped.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
