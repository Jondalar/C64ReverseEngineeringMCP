// Spec 845 D1/D3 — asserting a boundary, and reading the boundaries back.
//
// A model node is an ordinary graph node with kind `container`, on the human layer. That
// is deliberate and not laziness: edges, evidence, layers, the id grammar and every
// existing query already work on it, and a second table would have meant a second set of
// all of them, drifting.
//
// D3 is enforced HERE rather than in the tool, because the reason is structural: a
// boundary without a citation is the claim the NEXT session inherits and cannot check.
// Ultima VI's own graph has evidence on 94 % of its edges and on none of its 11 161
// nodes — so this is the gap, and a door that allows it would just widen it.
//
// The id is the SUBSYSTEM form (`slug:sub:model.<name>`), not the project form. The first
// cut derived it from the start address and the test caught it immediately: a component
// at $2000-$20FF inside a container at $2000-$3FFF produced the same id and silently
// overwrote its own parent. A boundary is identified by what it IS, not by where it
// begins — two of them may legitimately start at the same byte. The range therefore lives
// in attrs, and containment reads it from there.

import type { ModelLevel, ModelNode } from "./types.js";
import { MODEL_LEVELS } from "./types.js";

export interface AssertBoundaryInput {
  name: string;
  level: ModelLevel;
  start: number;
  end: number;
  description: string;
  evidence: string[];
  space?: "ram" | "crt" | "drv";
  owner?: string;
  bank?: number;
  /** Set when the boundary arrived through slot_record (D7). */
  slot?: string;
}

export class ModelBoundaryError extends Error {}

export async function assertBoundary(projectDir: string, input: AssertBoundaryInput): Promise<ModelNode> {
  if (!MODEL_LEVELS.includes(input.level)) {
    throw new ModelBoundaryError(`level must be one of ${MODEL_LEVELS.join(" | ")}`);
  }
  if (input.end < input.start) {
    throw new ModelBoundaryError(`end $${hex(input.end)} is below start $${hex(input.start)}`);
  }
  const evidence = (input.evidence ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
  if (evidence.length === 0) {
    throw new ModelBoundaryError(
      "a boundary without a citation is the claim the next session inherits and cannot check (Spec 845 D3)",
    );
  }

  const { GraphStore, readProjectSlug } = await import("../knowledge-graph/store.js");
  const { deriveSubsystemId } = await import("../knowledge-graph/ids.js");
  const store = GraphStore.open(projectDir);
  try {
    const slug = readProjectSlug(projectDir);
    const space = input.space ?? "ram";
    const id = deriveSubsystemId(slug, `model.${slugify(input.name)}`);
    store.upsertHuman({
      id,
      kind: "container",
      name: input.name,
      attrs: {
        level: input.level,
        description: input.description,
        start: input.start,
        end: input.end,
        space,
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.bank !== undefined ? { bank: input.bank } : {}),
        ...(input.slot ? { slot: input.slot } : {}),
      },
      origin: "user",
      confidence: "user_asserted",
      evidence,
    }, "845");
    return {
      id, name: input.name, level: input.level,
      space, owner: input.owner ?? null, bank: input.bank ?? null,
      start: input.start, end: input.end,
      description: input.description, evidence,
      ...(input.slot ? { slot: input.slot } : {}),
    };
  } finally {
    store.close();
  }
}

export async function listBoundaries(projectDir: string): Promise<ModelNode[]> {
  const { GraphStore } = await import("../knowledge-graph/store.js");
  let store;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return []; }
  try {
    const rows = store.db.prepare(
      "SELECT id, name, attrs, evidence FROM nodes WHERE kind = 'container' ORDER BY id",
    ).all() as Array<{ id: string; name: string | null; attrs: string; evidence: string }>;
    return rows.map((r) => {
      const a = safeJson<Record<string, unknown>>(r.attrs, {});
      const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
      return {
        id: r.id,
        name: r.name ?? r.id,
        level: (typeof a.level === "string" ? a.level : "container") as ModelLevel,
        space: typeof a.space === "string" ? a.space : "ram",
        owner: typeof a.owner === "string" ? a.owner : null,
        bank: typeof a.bank === "number" ? a.bank : null,
        start: num(a.start, 0),
        end: num(a.end, num(a.start, 0)),
        description: typeof a.description === "string" ? a.description : "",
        evidence: safeJson<string[]>(r.evidence, []),
        ...(typeof a.slot === "string" ? { slot: a.slot } : {}),
      };
    }).sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
  } finally {
    store.close();
  }
}

export async function removeBoundary(projectDir: string, id: string): Promise<boolean> {
  const { GraphStore } = await import("../knowledge-graph/store.js");
  const store = GraphStore.open(projectDir);
  try {
    const r = store.db.prepare("DELETE FROM nodes WHERE id = ? AND kind = 'container' AND layer = 'human'").run(id);
    return Number(r.changes) > 0;
  } finally {
    store.close();
  }
}

/** "stage 2 loader" -> "stage-2-loader". The id grammar allows [a-z0-9_.-] only. */
function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (s.length === 0) throw new ModelBoundaryError(`"${name}" has no usable characters for an id`);
  return s;
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
