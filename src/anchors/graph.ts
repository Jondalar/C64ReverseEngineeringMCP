// What an anchor MEANT, kept in the project. The ring holds the machine state and dies with the
// daemon; the human-layer node written here (name, cycle, frame, why) does not. A candidate links
// to it with a STARTS_FROM edge. Both are subsystem-form ids (`<slug>:sub:<name>`), which carry no
// address, so they are not mistaken for something in the machine's memory.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deriveSubsystemId } from "../knowledge-graph/ids.js";
import { upsertLink, withStore } from "../knowledge-graph/migrate/human.js";
import { DOOR_PRODUCER } from "../knowledge-graph/migrate/schema-822.js";
import { GraphStore, readProjectSlug } from "../knowledge-graph/store.js";

export interface AnchorFacts {
  name: string;
  anchorId?: string;
  cycle?: number;
  frame?: number;
  why?: string;
  setAt?: string;
  droppedAt?: string;
  /** The anchor's file, relative to the project (knowledge/anchors/<name>.c64re), when it has one. */
  file?: string;
  /** The state map that wrote this anchor (its name), when one did. */
  fromMap?: string;
}

/** `<slug>:sub:anchor.<name>` — the name made to fit the id grammar, with a hash when it had to change. */
export function anchorNodeId(slug: string, name: string): string {
  return deriveSubsystemId(slug, `anchor.${fitName(name)}`);
}

export function candidateNodeId(slug: string, id: string): string {
  return deriveSubsystemId(slug, `candidate.${fitName(id)}`);
}

function fitName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const fitted = lower.replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (fitted === raw && fitted.length > 0) return fitted;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${fitted.slice(0, 48) || "x"}-${hash}`;
}

/** A project that can hold a graph: it has been initialised. */
export function projectHoldsGraph(projectDir: string): boolean {
  return existsSync(join(projectDir, "knowledge", "project.json"));
}

export function recordAnchor(projectDir: string, a: AnchorFacts): string {
  const slug = readProjectSlug(projectDir);
  const id = anchorNodeId(slug, a.name);
  withStore(projectDir, (st) => {
    const prev = st.db.prepare("SELECT attrs FROM nodes WHERE id = ? AND layer = 'human'").get(id) as { attrs: string } | undefined;
    const before = prev ? (JSON.parse(prev.attrs) as Record<string, unknown>) : {};
    const attrs: Record<string, unknown> = {
      ...before,
      anchor_name: a.name,
      anchor_id: a.anchorId ?? before.anchor_id,
      cycle: a.cycle ?? before.cycle,
      frame: a.frame ?? before.frame,
      why: a.why ?? before.why,
      set_at: a.setAt ?? before.set_at,
      file: a.file === "" ? undefined : (a.file ?? before.file),
      from_map: a.fromMap ?? before.from_map,
    };
    if (a.setAt) delete attrs.dropped_at; // set again after a drop
    if (a.droppedAt) attrs.dropped_at = a.droppedAt;
    for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];
    st.upsertHuman({ id, kind: "anchor", name: a.name, attrs, origin: "runtime", confidence: "observed" }, DOOR_PRODUCER);
  });
  return id;
}

export function readAnchor(projectDir: string, name: string): (AnchorFacts & { nodeId: string }) | undefined {
  if (!projectHoldsGraph(projectDir)) return undefined;
  let store: GraphStore | undefined;
  try {
    const slug = readProjectSlug(projectDir);
    const id = anchorNodeId(slug, name);
    store = GraphStore.open(projectDir, { readOnly: true });
    const row = store.db.prepare("SELECT attrs FROM nodes WHERE id = ? AND layer = 'human'").get(id) as { attrs: string } | undefined;
    if (!row) return undefined;
    return { ...factsFromAttrs(JSON.parse(row.attrs) as Record<string, unknown>, name), nodeId: id };
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}

export function listRecordedAnchors(projectDir: string): AnchorFacts[] {
  if (!projectHoldsGraph(projectDir)) return [];
  let store: GraphStore | undefined;
  try {
    store = GraphStore.open(projectDir, { readOnly: true });
    const rows = store.db.prepare("SELECT name, attrs FROM nodes WHERE kind = 'anchor' AND layer = 'human' ORDER BY name").all() as Array<{ name: string; attrs: string }>;
    return rows.map((r) => factsFromAttrs(JSON.parse(r.attrs) as Record<string, unknown>, r.name));
  } catch {
    return [];
  } finally {
    store?.close();
  }
}

function factsFromAttrs(attrs: Record<string, unknown>, fallbackName: string): AnchorFacts {
  return {
    name: typeof attrs.anchor_name === "string" ? attrs.anchor_name : fallbackName,
    anchorId: typeof attrs.anchor_id === "string" ? attrs.anchor_id : undefined,
    cycle: typeof attrs.cycle === "number" ? attrs.cycle : undefined,
    frame: typeof attrs.frame === "number" ? attrs.frame : undefined,
    why: typeof attrs.why === "string" ? attrs.why : undefined,
    setAt: typeof attrs.set_at === "string" ? attrs.set_at : undefined,
    file: typeof attrs.file === "string" ? attrs.file : undefined,
    droppedAt: typeof attrs.dropped_at === "string" ? attrs.dropped_at : undefined,
    fromMap: typeof attrs.from_map === "string" ? attrs.from_map : undefined,
  };
}

/** `<slug>:sub:feature.<path>` — the feature file a candidate was run from. */
export function featureNodeId(slug: string, path: string): string {
  return deriveSubsystemId(slug, `feature.${fitName(path)}`);
}

/**
 * The candidate node, its STARTS_FROM edge to the anchor (the anchor node is made from `facts` when absent) and,
 * for a candidate that is the record of a feature run, the link to the feature file.
 */
export function recordCandidate(
  projectDir: string,
  c: { id: string; title?: string; anchor: string; chosen?: string; deltaArtifactIds?: string[]; variants: number; feature?: { path: string; scenario: string; line: number } },
  facts?: AnchorFacts,
): string {
  const slug = readProjectSlug(projectDir);
  const cid = candidateNodeId(slug, c.id);
  const aid = c.anchor ? anchorNodeId(slug, c.anchor) : undefined;
  const fid = c.feature ? featureNodeId(slug, c.feature.path) : undefined;
  withStore(projectDir, (st) => {
    if (aid) {
      const have = st.db.prepare("SELECT 1 FROM nodes WHERE id = ? AND layer = 'human'").get(aid);
      if (!have) recordAnchor(projectDir, facts ?? { name: c.anchor });
    }
    if (fid && c.feature) {
      st.upsertHuman({ id: fid, kind: "feature", name: c.feature.path, attrs: { path: c.feature.path }, origin: "runtime", confidence: "observed" }, DOOR_PRODUCER);
    }
    const attrs: Record<string, unknown> = { candidate_id: c.id, variants: c.variants, file: `knowledge/candidates/${c.id}.json` };
    if (c.anchor) attrs.anchor = c.anchor;
    if (c.feature) { attrs.feature = c.feature.path; attrs.scenario = c.feature.scenario; attrs.scenario_line = c.feature.line; }
    if (c.chosen) attrs.chosen = c.chosen;
    if (c.deltaArtifactIds?.length) attrs.delta_artifact_ids = c.deltaArtifactIds;
    st.upsertHuman({ id: cid, kind: "candidate", name: c.title ?? c.id, attrs, origin: "runtime", confidence: "observed" }, DOOR_PRODUCER);
  });
  if (aid) upsertLink(projectDir, { from: cid, type: "STARTS_FROM", to: aid, title: `${c.id} starts from anchor ${c.anchor}` });
  if (fid && c.feature) upsertLink(projectDir, { from: cid, type: "FROM_FEATURE", to: fid, title: `${c.id} is the record of ${c.feature.path} (${c.feature.scenario})` });
  return cid;
}

export function forgetCandidateNode(projectDir: string, id: string): void {
  if (!projectHoldsGraph(projectDir)) return;
  try {
    const slug = readProjectSlug(projectDir);
    const cid = candidateNodeId(slug, id);
    withStore(projectDir, (st) => {
      st.db.prepare("DELETE FROM edges WHERE from_id = ? AND layer = 'human'").run(cid);
      st.db.prepare("DELETE FROM nodes WHERE id = ? AND layer = 'human'").run(cid);
    });
  } catch { /* a graph that cannot be written costs the record of the link, never the delete */ }
}
