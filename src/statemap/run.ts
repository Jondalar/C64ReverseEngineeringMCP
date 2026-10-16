// One function for a state map: `runtime_state_map` and `c64re state map` both call `runStateMap`.

import { existsSync } from "node:fs";
import { anchorFile, anchorFileExists, anchorFileRel, ensureAnchorsDir, removeAnchorFile } from "../anchors/file.js";
import { projectHoldsGraph, readAnchor } from "../anchors/graph.js";
import { describeSearch, Refusal, type StateMapInput } from "./describe.js";
import { forgetMap, inputsHash, loadMap, saveMap, type SavedAnchor } from "./memory.js";
import type { MapAnswer } from "./render.js";
import { runSearch } from "./search.js";

export interface RunOptions {
  /** The project the anchor, the map and the anchors it writes belong to. */
  readonly projectDir: string;
  /** Checkpoints kept in the machine's ring before the rest go to files (a test seam). */
  readonly ringStates?: number;
}

/** Another anchor already has the name this map would write to: the map's own are replaced, a person's are not. */
function foreignAnchor(projectDir: string, anchor: string, map: string): boolean {
  return anchorFileExists(projectDir, anchor) && readAnchor(projectDir, anchor)?.fromMap !== map;
}

export async function runStateMap(input: StateMapInput, opts: RunOptions): Promise<MapAnswer> {
  const spec = describeSearch(input);
  const proj = opts.projectDir;
  if (!projectHoldsGraph(proj)) throw new Refusal("project_dir", `${proj} is not an initialised project (no knowledge/project.json): the map is kept in its graph`);
  if (!anchorFileExists(proj, spec.anchor)) {
    throw new Refusal("anchor", `no anchor file for "${spec.anchor}" (${anchorFileRel(spec.anchor)} is not in ${proj}). Set one at the loop where the game waits for input: runtime_anchor_set, or \`And I set the anchor "${spec.anchor}"\` in a feature file`);
  }
  if (spec.goal && foreignAnchor(proj, `${spec.name}.goal`, spec.name)) {
    throw new Refusal("name", `the anchor "${spec.name}.goal" already exists and is not this map's; give the map another name`);
  }

  const hash = inputsHash(spec, anchorFile(proj, spec.anchor));
  const kept = loadMap(proj, spec.name);
  if (kept && kept.hash === hash && !(kept.result.outcome.kind === "stopped" && kept.result.outcome.cap === "budget") && kept.anchors.every((a) => existsSync(anchorFile(proj, a.name)))) {
    return {
      name: spec.name, spec: { ...kept.spec, edges: spec.edges }, result: kept.result, anchors: kept.anchors,
      fromGraph: kept.mappedAt, notes: mapNotes(kept.result),
    };
  }

  const written: SavedAnchor[] = [];
  const result = await (async () => {
    try {
      ensureAnchorsDir(proj);
      return await runSearch(spec, {
        anchorFile: anchorFile(proj, spec.anchor),
        ...(opts.ringStates === undefined ? {} : { ringStates: opts.ringStates }),
        anchorPath: (suffix) => {
          const name = `${spec.name}.${suffix}`;
          if (foreignAnchor(proj, name, spec.name)) throw new Refusal("name", `the anchor "${name}" already exists and is not this map's; give the map another name`);
          removeAnchorFile(proj, name);
          return anchorFile(proj, name);
        },
        onWritten: (suffix, _path, cycle, pc) => { written.push({ name: `${spec.name}.${suffix}`, file: anchorFileRel(`${spec.name}.${suffix}`), cycle, pc }); },
      });
    } catch (e) {
      for (const a of written) removeAnchorFile(proj, a.name);
      throw e;
    }
  })();

  // A map of this name from an earlier call is replaced; its anchors that this one did not write go with it.
  if (kept) for (const a of kept.anchors) if (!written.some((w) => w.name === a.name)) removeAnchorFile(proj, a.name);
  forgetMap(proj, spec.name);
  saveMap(proj, spec, hash, result, written);
  return { name: spec.name, spec, result, anchors: written, notes: mapNotes(result) };
}

function mapNotes(r: { staleJams: number; spilled: number; runtimeVersion?: string }): string[] {
  const out: string[] = [];
  if (r.staleJams > 0) {
    out.push(`Note: the runtime${r.runtimeVersion ? ` (${r.runtimeVersion})` : ""} reported a jam ${r.staleJams} time${r.staleJams === 1 ? "" : "s"} at a PC that holds no JAM opcode, after a checkpoint restore. Those were not taken for crashes. A runtime that restores the jam state with the checkpoint does not report them.`);
  }
  if (r.spilled > 0) out.push(`Note: ${r.spilled} state${r.spilled === 1 ? "" : "s"} did not fit the machine's checkpoint ring and ${r.spilled === 1 ? "was" : "were"} kept as files.`);
  return out;
}
