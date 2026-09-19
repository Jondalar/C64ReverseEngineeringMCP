// Spec 740.3 D3 — "is this render stale", answered in one place.
//
// render_docs stamps what it rendered FROM onto the file (847 D4: `generated: {at,
// counts}`). Two readers compare that stamp with the graph: the critic's `stale-render`
// check, and the project search, which ranks a drifted render below the live records it
// copies. They used to be one reader and a gap — the search served the old copy at the
// rank of a curated document. Two implementations of the comparison would drift exactly
// the way the renders do, so both call this.

/** The graph as a render sees it. Keys are the ones render_docs stamps. */
export type RenderCounts = Record<string, number>;

export interface RenderDrift {
  key: string;
  rendered: number;
  now: number;
}

/** The live counts, keyed the way `ProjectKnowledgeService.renderDocs` stamps them. */
export function liveRenderCounts(findings: number, entities: number, questions: number): RenderCounts {
  return { findings, entities, questions };
}

/**
 * Every stamped count that no longer matches the graph. A key the graph does not count
 * is not drift — it is a stamp from a renderer that counted something else.
 */
export function renderDrift(generated: { counts: Record<string, number> }, live: RenderCounts): RenderDrift[] {
  const out: RenderDrift[] = [];
  for (const [key, rendered] of Object.entries(generated.counts)) {
    const now = live[key];
    if (now !== undefined && now !== rendered) out.push({ key, rendered, now });
  }
  return out;
}

/** `findings: rendered 19, now 1 (rendered 2026-09-09)` — both numbers, always. */
export function formatRenderDrift(drift: RenderDrift[], at: string): string {
  const body = drift.map((d) => `${d.key}: rendered ${d.rendered}, now ${d.now}`).join("; ");
  return at ? `${body} (rendered ${at.slice(0, 10)})` : body;
}
