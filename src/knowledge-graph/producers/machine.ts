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
import { resolvePlatform } from "../../project-knowledge/platform-default.js";
import { PLATFORM_TAGS, type PlatformTag } from "../../platform-kb/schema.js";
import { GraphStore } from "../store.js";

export type Machine = PlatformTag;
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
  if (artifact.platform === "vic20" || artifact.platform === "plus4") return { space: "ram", owner, platform: artifact.platform };
  return { space: "ram", owner };
}

/** The machine an artifact record names, when it is one of the tags the store knows (c128 / other are not). */
function artifactMachine(artifact: Pick<ArtifactRecord, "platform">): Machine | undefined {
  return (PLATFORM_TAGS as readonly string[]).includes(artifact.platform ?? "") ? artifact.platform as Machine : undefined;
}

function ctxForMachine(machine: Machine, owner: string): Ctx {
  if (machine === "c1541") return { space: "drv", owner };
  if (machine === "vic20" || machine === "plus4") return { space: "ram", owner, platform: machine };
  return { space: "ram", owner };
}

const MACHINE_META = (owner: string) => `machine.${owner}`;

export function declaredMachine(projectDir: string, owner: string): Machine | undefined {
  let store: GraphStore | undefined;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return undefined; }
  try {
    const v = store.getMeta(MACHINE_META(owner));
    return (PLATFORM_TAGS as readonly string[]).includes(v ?? "") ? v as Machine : undefined;
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
    const named = artifactMachine(artifact);
    if (ctx.space === "crt" || (named !== undefined && named !== "c64")) return { ctx, machine: named ?? "c64", source: "artifact" };
  }
  const declared = declaredMachine(projectDir, owner);
  if (declared) return { ctx: ctxForMachine(declared, owner), machine: declared, source: "declared" };
  const out: OwnerContext = { ctx: { space: "ram", owner }, machine: "c64", source: "default" };
  if (looksLikeDriveCode(owner, analysisPath)) {
    out.hint = `owner ${owner} looks like drive code (${analysisPath ?? owner}) but no machine is declared — if it runs on the 1541: c64re graph machine ${owner} c1541, then re-seed and re-import its annotations`;
  }
  return out;
}

/**
 * The machine an owner's code runs on, as the graph knows it (Spec 898 D7): the platform tag
 * its seeded USES_ZP / USES_HARDWARE edges point at (that is the machine it was SEEDED under,
 * whatever the artifact record or a declaration said at the time); else the declared machine;
 * else the project's default; else the C64. An ownerless boundary takes the project default.
 */
export function ownerPlatformTag(
  db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } },
  projectDir: string,
  owner: string | null,
): PlatformTag {
  if (owner) {
    const rows = db.prepare(
      "SELECT DISTINCT substr(to_id, 1, instr(to_id, ':') - 1) AS tag FROM edges WHERE owner = ? AND type IN ('USES_ZP','USES_HARDWARE')",
    ).all(owner) as Array<{ tag: string }>;
    const tags = rows.map((r) => r.tag).filter((t): t is PlatformTag => (PLATFORM_TAGS as readonly string[]).includes(t));
    if (tags.length === 1) return tags[0]!;
    const declared = declaredMachine(projectDir, owner);
    if (declared) return declared;
  } else {
    // An unowned boundary: the graph's own evidence first (what the hardware / zero-page edges
    // point at), then the machines declared for the owners — only when they name ONE tag.
    const rows = db.prepare(
      "SELECT DISTINCT substr(to_id, 1, instr(to_id, ':') - 1) AS tag FROM edges WHERE type IN ('USES_ZP','USES_HARDWARE')",
    ).all() as Array<{ tag: string }>;
    const tags = new Set(rows.map((r) => r.tag).filter((t): t is PlatformTag => (PLATFORM_TAGS as readonly string[]).includes(t)));
    if (tags.size === 1) return [...tags][0]!;
    if (tags.size === 0) {
      const decl = new Set(declaredMachines(projectDir).map((m) => m.machine as PlatformTag));
      if (decl.size === 1) return [...decl][0]!;
    }
  }
  return resolvePlatform({ projectDir }).platform;
}
