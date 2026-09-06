// Spec 826.0 T7 — an artifact needs a machine.
//
// WL1's third finding: 1541 drivecode seeded as C64 RAM — `jsr $FDF5` resolved
// to a C64 table, 173 zero-page edges wore KERNAL names. 818's grammar had
// `drv/<owner>` and platform c1541 from the start; nothing SET it, because
// neither the analysis report nor the artifact record says which machine
// (`platform` is null on every Wasteland record). The machine is a fact the
// human declares once per owner — `c64re graph machine <owner> c1541` — kept
// in the graph's meta; an artifact record that says `platform: c1541`
// (Spec 020, `analyze_prg platform=`) counts the same. Default is the C64, and
// the seed SAYS which of the three it used, with a hint when the path smells
// of the drive (`drivecode/`, `1541`) and nothing was declared — a nudge, not
// a guess.
//
// This module has no producer imports so every producer can read it.

import type { ArtifactRecord } from "../../project-knowledge/types.js";
import type { Ctx } from "../ids.js";
import { GraphStore } from "../store.js";

export type Machine = "c64" | "c1541";
export type MachineSource = "artifact" | "declared" | "default";

export interface OwnerContext {
  ctx: Ctx;
  machine: Machine;
  source: MachineSource;
  /** set when the machine defaulted and the path looks like drive code */
  hint?: string;
}

/** Spec 819 D7 — the ctx from what the artifact record already says: `platform` and `loadContexts[].bank`. */
export function contextForArtifact(artifact: Pick<ArtifactRecord, "platform" | "loadContexts">, owner: string): Ctx {
  const bank = artifact.loadContexts?.find((c) => typeof c.bank === "number")?.bank;
  if (bank !== undefined) return { space: "crt", bank };
  if (artifact.platform === "c1541") return { space: "drv", owner };
  return { space: "ram", owner };
}

const MACHINE_META = (owner: string) => `machine.${owner}`;

export function declaredMachine(projectDir: string, owner: string): Machine | undefined {
  let store: GraphStore | undefined;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return undefined; }
  try {
    const v = store.getMeta(MACHINE_META(owner));
    return v === "c1541" || v === "c64" ? v : undefined;
  } finally { store.close(); }
}

export function declareMachine(projectDir: string, owner: string, machine: Machine): void {
  const store = GraphStore.open(projectDir);
  try { store.setMeta(MACHINE_META(owner), machine); } finally { store.close(); }
}

export function declaredMachines(projectDir: string): Array<{ owner: string; machine: Machine }> {
  let store: GraphStore | undefined;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return []; }
  try {
    const rows = store.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'machine.%' ORDER BY key").all() as Array<{ key: string; value: string }>;
    return rows.map((r) => ({ owner: r.key.slice("machine.".length), machine: r.value as Machine }));
  } finally { store.close(); }
}

export function looksLikeDriveCode(owner: string, analysisPath?: string): boolean {
  const p = (analysisPath ?? "").toLowerCase();
  return /drivecode|drive[-_ ]?code|1541/u.test(p) || /^t\d+s\d+/u.test(owner);
}

/** The ctx an owner is seeded under: the artifact record's banks / platform, else the declared machine, else the C64 — and which. */
export function contextForOwner(projectDir: string, owner: string, artifact?: Pick<ArtifactRecord, "platform" | "loadContexts"> | undefined, analysisPath?: string): OwnerContext {
  if (artifact) {
    const ctx = contextForArtifact(artifact, owner);
    if (ctx.space === "crt" || artifact.platform === "c1541") return { ctx, machine: artifact.platform === "c1541" ? "c1541" : "c64", source: "artifact" };
  }
  const declared = declaredMachine(projectDir, owner);
  if (declared === "c1541") return { ctx: { space: "drv", owner }, machine: "c1541", source: "declared" };
  if (declared === "c64") return { ctx: { space: "ram", owner }, machine: "c64", source: "declared" };
  const out: OwnerContext = { ctx: { space: "ram", owner }, machine: "c64", source: "default" };
  if (looksLikeDriveCode(owner, analysisPath)) {
    out.hint = `owner ${owner} looks like drive code (${analysisPath ?? owner}) but no machine is declared — if it runs on the 1541: c64re graph machine ${owner} c1541, then re-seed and re-import its annotations`;
  }
  return out;
}
