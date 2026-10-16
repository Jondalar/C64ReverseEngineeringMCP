// A map is knowledge: it is kept in the project's graph, so it outlives the sandbox, is found by name, and
// answers a second identical call without a machine.
//
//   state_map   one node: the description (as given), the outcome, the counts, the caps
//   game_state  one node per state: key values, depth, how it was first reached, crash / goal / dead
//   MOVES_TO    one edge per move that changed the state (the move is the edge's key, so two moves between
//               the same pair are two edges)
//   CONTAINS    state_map -> game_state
//   STARTS_FROM state_map -> the anchor it started from
//   SAVED_AS    game_state -> the anchor file written for it

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveSubsystemId } from "../knowledge-graph/ids.js";
import { withStore } from "../knowledge-graph/migrate/human.js";
import { DOOR_PRODUCER } from "../knowledge-graph/migrate/schema-822.js";
import { canonicalJson } from "../knowledge-graph/json.js";
import { GraphStore, readProjectSlug } from "../knowledge-graph/store.js";
import { anchorNodeId, projectHoldsGraph, recordAnchor } from "../anchors/graph.js";
import { describeSearch, type StateMapInput, type StateMapSpec } from "./describe.js";
import type { MapEdge, MapState, Outcome, SearchResult } from "./search.js";

const fit = (raw: string): string => raw.trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "x";

export function mapNodeId(slug: string, name: string): string {
  return deriveSubsystemId(slug, `statemap.${fit(name)}-${createHash("sha1").update(name).digest("hex").slice(0, 6)}`);
}
function stateNodeId(mapId: string, index: number): string {
  return `${mapId}.s${index}`;
}

/** What a call asked for, as stored and as hashed: the description, not the optional ways of showing it. */
export function normalizedInput(spec: StateMapSpec): Record<string, unknown> {
  return {
    anchor: spec.anchor, key: spec.key.map((k) => k.text), actions: spec.moves.map((m) => m.label), port: spec.port,
    frames: spec.frames, release_frames: spec.releaseFrames, dead: spec.dead.map((d) => d.text),
    ...(spec.goal ? { goal: spec.goal.text } : {}), continue_after_goal: spec.continueAfterGoal,
    max_states: spec.maxStates, max_depth: spec.maxDepth, max_runs: spec.maxRuns, budget_minutes: spec.budgetMinutes,
    save_states: spec.saveStates, name: spec.name,
  };
}

/** The same description over the same anchor file gives the same hash. The name and the way of showing it are not in it. */
export function inputsHash(spec: StateMapSpec, anchorFile: string): string {
  const { name: _name, ...rest } = normalizedInput(spec);
  const file = createHash("sha256").update(readFileSync(anchorFile)).digest("hex");
  return createHash("sha256").update(canonicalJson({ ...rest, anchor_sha: file })).digest("hex").slice(0, 32);
}

export interface SavedAnchor { readonly name: string; readonly file: string; readonly cycle: number; readonly pc: number }

export interface StoredMap {
  readonly nodeId: string;
  readonly input: Record<string, unknown>;
  readonly spec: StateMapSpec;
  readonly hash: string;
  readonly mappedAt: string;
  readonly result: SearchResult;
  readonly anchors: readonly SavedAnchor[];
}

export function saveMap(projectDir: string, spec: StateMapSpec, hash: string, result: SearchResult, anchors: readonly SavedAnchor[]): string {
  const slug = readProjectSlug(projectDir);
  const mapId = mapNodeId(slug, spec.name);
  const anchorId = anchorNodeId(slug, spec.anchor);
  forgetMap(projectDir, spec.name);
  for (const a of anchors) {
    recordAnchor(projectDir, { name: a.name, cycle: a.cycle, why: `state of the map "${spec.name}"`, setAt: new Date().toISOString(), file: a.file, fromMap: spec.name });
  }
  withStore(projectDir, (st) => {
    const have = st.db.prepare("SELECT 1 FROM nodes WHERE id = ? AND layer = 'human'").get(anchorId);
    if (!have) recordAnchor(projectDir, { name: spec.anchor });
    const attrs = {
      map_name: spec.name, anchor: spec.anchor, input: normalizedInput(spec), inputs_hash: hash,
      outcome: result.outcome, runs: result.runs, states: result.states.length,
      crashes: result.states.filter((s) => s.crash).length, goal_state: result.goalState ?? null,
      frames_per_move: result.framesPerMove, machine: result.machine, elapsed_ms: result.elapsedMs,
      spilled: result.spilled, stale_jams: result.staleJams, runtime_version: result.runtimeVersion ?? null,
      mapped_at: new Date().toISOString(), anchors,
    };
    st.upsertHuman({ id: mapId, kind: "state_map", name: spec.name, attrs, origin: "runtime", confidence: "observed" }, DOOR_PRODUCER);
    const edge = st.db.prepare(
      `INSERT INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, ?, ?, 'human', ?, 'runtime', 'observed', ?, NULL, ?)
       ON CONFLICT(from_id, type, to_id, layer, evidence_key) DO UPDATE SET evidence = excluded.evidence, producer = excluded.producer`,
    );
    const link = (from: string, type: string, to: string, key: string, evidence: Record<string, unknown>): void => {
      edge.run(from, type, to, key, DOOR_PRODUCER, canonicalJson({ kind: type.toLowerCase().replace(/_/gu, "-"), ...evidence }));
    };
    link(mapId, "STARTS_FROM", anchorId, "", { title: `${spec.name} starts from anchor ${spec.anchor}` });
    for (const s of result.states) {
      const id = stateNodeId(mapId, s.index);
      st.upsertHuman({
        id, kind: "game_state", name: `${spec.name}/s${s.index}`,
        attrs: {
          map: spec.name, index: s.index, key: s.key, depth: s.depth, path: s.path, crash_pc: s.crash?.pc ?? null,
          crash: !!s.crash, goal: s.goal, dead: s.dead, stays: s.stays, expanded: s.expanded, anchor_name: s.anchorName ? `${spec.name}.${s.anchorName}` : null,
        },
        origin: "runtime", confidence: "observed",
      }, DOOR_PRODUCER);
      link(mapId, "CONTAINS", id, "", { title: `${spec.name} has state s${s.index}` });
      if (s.anchorName) link(id, "SAVED_AS", anchorNodeId(slug, `${spec.name}.${s.anchorName}`), "", { title: `s${s.index} is the anchor ${spec.name}.${s.anchorName}` });
    }
    for (const e of result.edges) {
      link(stateNodeId(mapId, e.from), "MOVES_TO", stateNodeId(mapId, e.to), e.move, { move: e.move, frames: result.framesPerMove, title: `s${e.from} -${e.move}-> s${e.to}` });
    }
  });
  return mapId;
}

/** Remove a map's nodes and edges (the anchors it wrote stay: they are files, and the caller decides). */
export function forgetMap(projectDir: string, name: string): boolean {
  if (!projectHoldsGraph(projectDir)) return false;
  const slug = readProjectSlug(projectDir);
  const mapId = mapNodeId(slug, name);
  let had = false;
  withStore(projectDir, (st) => {
    const ids = (st.db.prepare("SELECT id FROM nodes WHERE layer = 'human' AND kind = 'game_state' AND id LIKE ?").all(`${mapId}.s%`) as Array<{ id: string }>).map((r) => r.id);
    const all = [mapId, ...ids];
    had = !!st.db.prepare("SELECT 1 FROM nodes WHERE id = ? AND layer = 'human'").get(mapId);
    for (const id of all) {
      st.db.prepare("DELETE FROM edges WHERE layer = 'human' AND (from_id = ? OR to_id = ?)").run(id, id);
      st.db.prepare("DELETE FROM nodes WHERE layer = 'human' AND id = ?").run(id);
    }
  });
  return had;
}

/** The map of that name as the graph holds it, or undefined. */
export function loadMap(projectDir: string, name: string): StoredMap | undefined {
  if (!projectHoldsGraph(projectDir)) return undefined;
  let store: GraphStore | undefined;
  try {
    const slug = readProjectSlug(projectDir);
    const mapId = mapNodeId(slug, name);
    store = GraphStore.open(projectDir, { readOnly: true });
    const row = store.db.prepare("SELECT attrs FROM nodes WHERE id = ? AND layer = 'human' AND kind = 'state_map'").get(mapId) as { attrs: string } | undefined;
    if (!row) return undefined;
    const a = JSON.parse(row.attrs) as Record<string, unknown>;
    const input = a.input as Record<string, unknown>;
    const spec = describeSearch(input as StateMapInput);
    const stateRows = store.db.prepare("SELECT attrs FROM nodes WHERE layer = 'human' AND kind = 'game_state' AND id LIKE ?").all(`${mapId}.s%`) as Array<{ attrs: string }>;
    const states: MapState[] = stateRows.map((r) => {
      const s = JSON.parse(r.attrs) as Record<string, unknown>;
      const anchorName = typeof s.anchor_name === "string" ? s.anchor_name.slice(name.length + 1) : undefined;
      return {
        index: s.index as number, key: s.key as number[], depth: s.depth as number, path: s.path as string[],
        ...(s.crash ? { crash: { pc: s.crash_pc as number } } : {}),
        goal: s.goal === true, dead: s.dead === true, stays: (s.stays as string[]) ?? [], expanded: s.expanded === true,
        ...(anchorName ? { anchorName } : {}),
      };
    }).sort((x, y) => x.index - y.index);
    const edgeRows = store.db.prepare("SELECT from_id, to_id, evidence_key FROM edges WHERE layer = 'human' AND type = 'MOVES_TO' AND from_id LIKE ?").all(`${mapId}.s%`) as Array<{ from_id: string; to_id: string; evidence_key: string }>;
    const idx = (id: string): number => Number(id.slice(id.lastIndexOf(".s") + 2));
    const edges: MapEdge[] = edgeRows.map((e) => ({ from: idx(e.from_id), to: idx(e.to_id), move: e.evidence_key }));
    // Found order: by the state it leaves, then the order the moves were listed in the call.
    const order = new Map(spec.moves.map((m, i) => [m.label, i]));
    edges.sort((x, y) => x.from - y.from || (order.get(x.move) ?? 0) - (order.get(y.move) ?? 0));
    const result: SearchResult = {
      outcome: a.outcome as Outcome, states, edges, runs: a.runs as number,
      ...(typeof a.goal_state === "number" ? { goalState: a.goal_state } : {}),
      framesPerMove: a.frames_per_move as number, machine: a.machine as string, elapsedMs: a.elapsed_ms as number,
      spilled: (a.spilled as number) ?? 0, staleJams: (a.stale_jams as number) ?? 0,
      ...(typeof a.runtime_version === "string" ? { runtimeVersion: a.runtime_version } : {}),
    };
    return { nodeId: mapId, input, spec, hash: String(a.inputs_hash), mappedAt: String(a.mapped_at), result, anchors: (a.anchors as SavedAnchor[]) ?? [] };
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}
