// The answer: whether the map is complete, the states with their key values, the moves that change the state,
// the crashes, and the shortest way to the goal. Compact by default; every edge only when asked.

import { fmtKey, hex, type StateMapSpec } from "./describe.js";
import type { MapState, SearchResult } from "./search.js";
import type { SavedAnchor } from "./memory.js";

export interface MapAnswer {
  readonly name: string;
  readonly spec: StateMapSpec;
  readonly result: SearchResult;
  readonly anchors: readonly SavedAnchor[];
  /** Answered from the graph: the time it was mapped. */
  readonly fromGraph?: string;
  readonly notes: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function headline(a: MapAnswer): string {
  const r = a.result;
  const crashes = r.states.filter((s) => s.crash).length;
  const tail = `${plural(r.states.length, "state")}, ${plural(r.runs, "run")}, ${plural(crashes, "crash", "crashes")}`;
  switch (r.outcome.kind) {
    case "complete": return `complete: ${tail}`;
    case "goal": return `goal reached: ${tail}`;
    case "stopped": return `stopped: ${r.outcome.cap} ${r.outcome.limit}${r.outcome.cap === "budget" ? " min" : ""} — ${tail}; the map is not complete`;
  }
}

export const stateKey = (a: MapAnswer, s: MapState): string => fmtKey(a.spec.key, s.key);

const pathText = (path: readonly string[]): string => (path.length ? path.join(" ") : "(the anchor)");
export const framesOf = (a: MapAnswer, moves: number): number => moves * a.result.framesPerMove;

export function renderAnswer(a: MapAnswer): string {
  const r = a.result;
  const lines: string[] = [];
  lines.push(headline(a));
  if (a.fromGraph) lines.push(`(answered from the graph, mapped ${a.fromGraph}: same anchor, key, moves and caps, so no machine was started)`);
  lines.push("");
  for (const s of r.states) {
    const flags = [s.crash ? `JAM at ${hex(s.crash.pc, 4)}` : "", s.goal ? "GOAL" : "", s.dead ? "dead" : "", s.index === 0 ? "anchor" : ""].filter(Boolean);
    lines.push(`  s${s.index} ${s.crash ? `${stateKey(a, s)} (when it jammed)` : stateKey(a, s)}${flags.length ? `  (${flags.join(", ")})` : ""}${s.index === 0 ? "" : `  depth ${s.depth}  first reached by ${pathText(s.path)}`}${s.anchorName ? `  [anchor ${a.name}.${s.anchorName}]` : ""}`);
  }
  lines.push("");
  lines.push(a.spec.edges === "all" ? "Every move tried (-> a state, or = it stays):" : "Moves that change the state:");
  for (const s of r.states) {
    const out = r.edges.filter((e) => e.from === s.index);
    const stays = a.spec.edges === "all" ? s.stays : [];
    if (out.length === 0 && stays.length === 0) continue;
    lines.push(`  s${s.index}: ${[...out.map((e) => `${e.move}->s${e.to}`), ...(stays.length ? [`${stays.join(" ")} stay`] : [])].join("  ")}`);
  }
  const crashes = r.states.filter((s) => s.crash);
  if (crashes.length) {
    lines.push("");
    lines.push("Crashes:");
    for (const s of crashes) lines.push(`  s${s.index} JAM at ${hex(s.crash!.pc, 4)}, reached by ${pathText(s.path)} (${plural(s.path.length, "move")}, ${framesOf(a, s.path.length)} frames)`);
  }
  if (a.spec.goal) {
    lines.push("");
    const g = r.goalState === undefined ? undefined : r.states[r.goalState];
    lines.push(g
      ? `Shortest path to the goal (${a.spec.goal.text}): ${pathText(g.path)} (${plural(g.path.length, "move")}, ${framesOf(a, g.path.length)} frames) -> s${g.index}`
      : `The goal (${a.spec.goal.text}) was not reached${r.outcome.kind === "complete" ? " from this anchor with these moves" : " in what was searched"}.`);
  }
  lines.push("");
  lines.push(`Saved: map "${a.name}" in the graph (states, moves, STARTS_FROM anchor "${a.spec.anchor}")${a.anchors.length ? `; anchors ${a.anchors.map((x) => `${x.name} (${x.file})`).join(", ")}` : ""}.`);
  lines.push(`Search: ${plural(a.spec.moves.length, "move")} (${a.spec.moves.map((m) => m.label).join(" ")}), each ${a.spec.frames} frames held + ${a.spec.releaseFrames} released, on a machine of its own (${r.machine}), port ${a.spec.port}. Caps: max_states ${a.spec.maxStates}, max_runs ${a.spec.maxRuns}, max_depth ${a.spec.maxDepth}, budget ${a.spec.budgetMinutes} min.`);
  for (const n of a.notes) lines.push(n);
  return lines.join("\n");
}

export function answerJson(a: MapAnswer): Record<string, unknown> {
  const r = a.result;
  const g = r.goalState === undefined ? undefined : r.states[r.goalState];
  return {
    name: a.name,
    outcome: r.outcome.kind === "stopped" ? { kind: "stopped", cap: r.outcome.cap, limit: r.outcome.limit } : { kind: r.outcome.kind },
    complete: r.outcome.kind === "complete",
    fromGraph: a.fromGraph ?? null,
    runs: r.runs,
    states: r.states.map((s) => ({
      id: `s${s.index}`, key: fmtKey(a.spec.key, s.key), values: s.key, depth: s.depth, path: s.path,
      ...(s.crash ? { crash: { pc: s.crash.pc } } : {}), goal: s.goal, dead: s.dead, stays: s.stays,
      ...(s.anchorName ? { anchor: `${a.name}.${s.anchorName}` } : {}),
    })),
    edges: r.edges.map((e) => ({ from: `s${e.from}`, to: `s${e.to}`, move: e.move })),
    crashes: r.states.filter((s) => s.crash).map((s) => ({ state: `s${s.index}`, pc: s.crash!.pc, path: s.path })),
    goal: g ? { state: `s${g.index}`, path: g.path, moves: g.path.length, frames: framesOf(a, g.path.length) } : null,
    framesPerMove: r.framesPerMove,
    anchors: a.anchors,
    spilled: r.spilled,
    staleJamReports: r.staleJams,
    runtimeVersion: r.runtimeVersion ?? null,
    notes: a.notes,
  };
}
