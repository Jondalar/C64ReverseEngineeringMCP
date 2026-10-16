// The search itself: breadth-first from an anchor, on one private machine.
//
// A state is reached by restoring its checkpoint, never by replay from boot. A move is: restore, put the
// input down, run `frames`, let go, run `release_frames`, read the key. A key never seen before is a new
// state and its machine is captured on the spot. A JAM ends the branch as a crash state (named by its PC).
//
// The machine is a sandbox of this call's own (`SandboxSession`): it has its own port, a budget, and it is
// ended before the answer goes out. Nothing here can reach the shared session.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxSession } from "../reel/sandbox-session.js";
import { assertNotShared } from "../reel/run-sandbox.js";
import { machineIdentity, describeMachine, type MachineIdentity } from "../runtime/machine-model.js";
import { joinChunks } from "../project-knowledge/region.js";
import { holds, readPlan, Refusal, type Move, type StateMapSpec } from "./describe.js";

/** The opcodes that stop a 6502 for good. */
export const JAM_OPCODES: ReadonlySet<number> = new Set([0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]);

export type Cap = "max_states" | "max_runs" | "max_depth" | "budget";
export type Outcome =
  | { readonly kind: "complete" }
  | { readonly kind: "goal" }
  | { readonly kind: "stopped"; readonly cap: Cap; readonly limit: number };

export interface MapState {
  readonly index: number;
  readonly key: readonly number[];
  readonly depth: number;
  /** The moves from the anchor along the first way found. */
  readonly path: readonly string[];
  readonly crash?: { readonly pc: number };
  goal: boolean;
  dead: boolean;
  /** Moves from here that led back to this very state. */
  readonly stays: string[];
  /** Whether its moves were all tried. */
  expanded: boolean;
  /** The anchor file written for it, when one was. */
  anchorName?: string;
}

export interface MapEdge { readonly from: number; readonly to: number; readonly move: string }

export interface SearchResult {
  readonly outcome: Outcome;
  readonly states: readonly MapState[];
  /** Moves that changed the state (a crash counts), in the order they were found. */
  readonly edges: readonly MapEdge[];
  readonly runs: number;
  readonly goalState?: number;
  readonly framesPerMove: number;
  readonly machine: string;
  readonly elapsedMs: number;
  /** Checkpoints that did not fit the ring and went to a file. */
  readonly spilled: number;
  /** Jam reports at a PC that holds no JAM opcode, which were not taken for crashes. */
  readonly staleJams: number;
  readonly runtimeVersion?: string;
  /** Every move from every expanded state led to the one same successor: the key follows time, not the moves. */
  readonly keyFollowsTime?: boolean;
}

export interface SearchContext {
  /** The anchor's file in the project. */
  readonly anchorFile: string;
  /** Where an anchor file of this map goes (`<name>.goal`, `<name>.s3`); absent: none are written. */
  readonly anchorPath?: (suffix: string) => string;
  /** Checkpoints kept in the machine's ring before the rest go to files (a test seam; default: whatever the ring takes). */
  readonly ringStates?: number;
  readonly onWritten?: (suffix: string, path: string, cycle: number, pc: number) => void;
}

type Held = { readonly cp: string } | { readonly file: string };

interface MemoryChunks { chunks: { addr: number; len: number; lens: string; bytes: string }[] }

export async function runSearch(spec: StateMapSpec, ctx: SearchContext): Promise<SearchResult> {
  const startedAt = Date.now();
  const budgetMs = spec.budgetMinutes * 60_000;
  const scratch = mkdtempSync(join(tmpdir(), "c64re-map-"));
  const box = await SandboxSession.start({ budgetMs });
  try {
    assertNotShared(box.port);
    return await drive(spec, ctx, box, scratch, startedAt);
  } finally {
    // The sandbox ends here, answer or error: the budget would end it, this is the common case.
    await box.close();
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function drive(spec: StateMapSpec, ctx: SearchContext, box: SandboxSession, scratch: string, startedAt: number): Promise<SearchResult> {
  const call = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => box.call<T>(method, params);
  const deadline = startedAt + spec.budgetMinutes * 60_000;

  let runtimeVersion: string | undefined;
  try { const p = await call<{ version?: string }>("ping"); runtimeVersion = typeof p?.version === "string" ? p.version : undefined; } catch { /* the version is a note, not a need */ }

  // The anchor opens from a copy: the runtime lays an anchor's embedded media out beside the file it opens.
  const copyDir = join(scratch, "anchor");
  mkdirSync(copyDir, { recursive: true });
  const anchorCopy = join(copyDir, "anchor.c64re");
  copyFileSync(ctx.anchorFile, anchorCopy);
  await call("debug/pause", { source: "sandbox" });
  await call("media/open", { path: anchorCopy });
  await call("debug/pause", { source: "sandbox" });
  const st0 = await call<Record<string, unknown>>("session/state");
  const machine: MachineIdentity = machineIdentity(st0);
  const F = machine.cyclesPerFrame;

  const plan = readPlan(spec);
  const keyBytes = spec.key.reduce((n, k) => n + k.len, 0);

  const read = async (): Promise<number[]> => {
    const r = await call<MemoryChunks>("session/read_memory", { ranges: plan });
    return [...joinChunks(r.chunks.map((c) => new Uint8Array(Buffer.from(c.bytes, "base64"))))];
  };
  const peek = async (addr: number): Promise<number> => {
    const r = await call<MemoryChunks>("session/read_memory", { ranges: [{ addr, len: 1, lens: "cpu" }] });
    return new Uint8Array(Buffer.from(r.chunks[0]!.bytes, "base64"))[0]!;
  };
  /** The extra bytes after the key, in the order the conditions are listed. */
  const condBytes = (all: readonly number[]): Map<object, number> => {
    const m = new Map<object, number>();
    let i = keyBytes;
    for (const c of [...spec.dead, ...(spec.goal ? [spec.goal] : [])]) m.set(c, all[i++]!);
    return m;
  };

  const states: MapState[] = [];
  const edges: MapEdge[] = [];
  const held = new Map<number, Held>();
  const byKey = new Map<string, number>();
  const crashByPc = new Map<number, number>();
  let runs = 0;
  let spilled = 0;
  let staleJams = 0;
  let pinned = 0;
  let goalState: number | undefined;
  let outcome: Outcome | undefined;
  let depthCut: number | undefined;

  const keyId = (bytes: readonly number[]): string => bytes.slice(0, keyBytes).join(",");

  const holdHere = async (index: number): Promise<void> => {
    const roomInRing = ctx.ringStates === undefined || pinned < ctx.ringStates;
    if (roomInRing) {
      try {
        const cap = await call<{ ref?: { id?: string } }>("checkpoint/capture");
        const id = cap?.ref?.id;
        if (id) {
          await call("checkpoint/pin", { id });
          pinned++;
          held.set(index, { cp: id });
          return;
        }
      } catch { /* the ring cannot take another: the machine goes to a file */ }
    }
    const file = join(scratch, "spill", `s${index}.c64re`);
    mkdirSync(join(scratch, "spill"), { recursive: true });
    await call("snapshot/dump", { path: file });
    spilled++;
    held.set(index, { file });
  };

  const writeAnchor = async (suffix: string): Promise<boolean> => {
    if (!ctx.anchorPath) return false;
    const path = ctx.anchorPath(suffix);
    const d = await call<{ cycle?: number; pc?: number }>("snapshot/dump", { path });
    ctx.onWritten?.(suffix, path, d?.cycle ?? 0, d?.pc ?? 0);
    return true;
  };

  const restore = async (index: number): Promise<void> => {
    const h = held.get(index)!;
    if ("cp" in h) await call("checkpoint/restore", { id: h.cp, then: "pause" });
    else {
      // A file is a machine to open, as the anchor was; the copy keeps the runtime's media folder out of the scratch's other files.
      const dir = join(scratch, "reopen", String(index));
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, "state.c64re");
      copyFileSync(h.file, copy);
      await call("media/open", { path: copy });
      await call("debug/pause", { source: "sandbox" });
    }
    await call("session/joystick_clear", {});
  };

  const run = async (cycles: number): Promise<{ jam?: number }> => {
    const r = await call<{ jam?: { pc?: number } }>("session/run", { cycles });
    return typeof r?.jam?.pc === "number" ? { jam: r.jam.pc } : {};
  };

  const press = async (mv: Move): Promise<void> => {
    if (mv.joystick) await call("session/joystick_set", { port: spec.port, source: "sandbox", ...mv.joystick });
    for (const k of mv.keys ?? []) await call("session/key_down", { key: k, source: "sandbox" });
  };
  const letGo = async (mv: Move): Promise<void> => {
    if (mv.joystick) await call("session/joystick_clear", { port: spec.port });
    for (const k of mv.keys ?? []) await call("session/key_up", { key: k, source: "sandbox" });
  };

  /** A JAM the CPU really stands on: the PC holds a JAM opcode. A restore from a jammed machine kept reporting one on runtimes before the fix. */
  const realJam = async (pc: number): Promise<boolean> => {
    if (JAM_OPCODES.has(await peek(pc))) return true;
    staleJams++;
    return false;
  };

  type MoveResult = { jam: number; key: number[] } | { jam?: undefined; bytes: number[] };
  const play = async (from: number, mv: Move): Promise<MoveResult> => {
    await restore(from);
    await press(mv);
    const hold = await run(spec.frames * F);
    if (hold.jam !== undefined && (await realJam(hold.jam))) return { jam: hold.jam, key: (await read()).slice(0, keyBytes) };
    await letGo(mv);
    if (spec.releaseFrames > 0) {
      const rel = await run(spec.releaseFrames * F);
      if (rel.jam !== undefined && (await realJam(rel.jam))) return { jam: rel.jam, key: (await read()).slice(0, keyBytes) };
    }
    return { bytes: await read() };
  };

  // ── the anchor itself is the first state
  const first = await read();
  const conds0 = condBytes(first);
  const s0: MapState = {
    index: 0, key: first.slice(0, keyBytes), depth: 0, path: [], goal: spec.goal ? holds(spec.goal, conds0.get(spec.goal)!) : false,
    dead: spec.dead.some((d) => holds(d, conds0.get(d)!)), stays: [], expanded: false,
  };
  states.push(s0);
  byKey.set(keyId(first), 0);
  await holdHere(0);
  if (s0.goal) {
    goalState = 0;
    if (await writeAnchor("goal")) s0.anchorName = "goal";
    if (!spec.continueAfterGoal) outcome = { kind: "goal" };
  }
  if (spec.saveStates && !s0.anchorName && (await writeAnchor("s0"))) s0.anchorName = "s0";

  const stop = (cap: Cap, limit: number): void => { outcome = { kind: "stopped", cap, limit }; };

  search: for (let q = 0; q < states.length && !outcome; q++) {
    const here = states[q]!;
    if (here.crash || here.dead) { here.expanded = true; continue; }
    if (here.depth >= spec.maxDepth) { depthCut = spec.maxDepth; continue; }
    for (const mv of spec.moves) {
      if (runs >= spec.maxRuns) { stop("max_runs", spec.maxRuns); break search; }
      if (Date.now() >= deadline - 2_000) { stop("budget", spec.budgetMinutes); break search; }
      runs++;
      const res = await play(here.index, mv);

      let target: number;
      if (res.jam !== undefined) {
        const known = crashByPc.get(res.jam);
        if (known !== undefined) target = known;
        else {
          if (states.length >= spec.maxStates) { stop("max_states", spec.maxStates); break search; }
          target = states.length;
          states.push({ index: target, key: res.key, depth: here.depth + 1, path: [...here.path, mv.label], crash: { pc: res.jam }, goal: false, dead: false, stays: [], expanded: true });
          crashByPc.set(res.jam, target);
          if (spec.saveStates && (await writeAnchor(`s${target}`))) states[target]!.anchorName = `s${target}`;
        }
      } else {
        const id = keyId(res.bytes);
        const known = byKey.get(id);
        if (known !== undefined) target = known;
        else {
          if (states.length >= spec.maxStates) { stop("max_states", spec.maxStates); break search; }
          target = states.length;
          const conds = condBytes(res.bytes);
          const s: MapState = {
            index: target, key: res.bytes.slice(0, keyBytes), depth: here.depth + 1, path: [...here.path, mv.label],
            goal: spec.goal ? holds(spec.goal, conds.get(spec.goal)!) : false,
            dead: spec.dead.some((d) => holds(d, conds.get(d)!)), stays: [], expanded: false,
          };
          states.push(s);
          byKey.set(id, target);
          await holdHere(target);
          if (s.goal && goalState === undefined) {
            goalState = target;
            if (await writeAnchor("goal")) s.anchorName = "goal";
          }
          if (spec.saveStates && !s.anchorName && (await writeAnchor(`s${target}`))) s.anchorName = `s${target}`;
          if (s.goal && !spec.continueAfterGoal) outcome = { kind: "goal" };
        }
      }
      // A key that changes with every run is a timer or a position, not a room (checked on the first runs).
      if (runs === 20 && states.length === 21) {
        throw new Refusal("key", "changes with every run: the first 20 runs found 20 new states, one each. A timer, a frame counter or a sprite position is in it — a key is the bytes the game's own code indexes rooms or levels with. Nothing was saved");
      }
      if (target === here.index) here.stays.push(mv.label);
      else edges.push({ from: here.index, to: target, move: mv.label });
      if (outcome) break search;
    }
    here.expanded = true;
  }

  if (!outcome) outcome = depthCut !== undefined && states.some((s) => !s.expanded && !s.crash && !s.dead) ? { kind: "stopped", cap: "max_depth", limit: depthCut } : { kind: "complete" };

  const expanded = states.filter((st) => st.expanded && !st.crash && !st.dead);
  const keyFollowsTime = expanded.length >= 2 && spec.moves.length >= 2 && expanded.every((st) => {
    const succ = new Set(edges.filter((e) => e.from === st.index).map((e) => e.to));
    if (st.stays.length > 0) succ.add(st.index);
    return succ.size === 1 && !succ.has(st.index);
  });
  return {
    outcome, states, edges, runs, ...(keyFollowsTime ? { keyFollowsTime } : {}), ...(goalState === undefined ? {} : { goalState }),
    framesPerMove: spec.frames + spec.releaseFrames,
    machine: describeMachine(machine),
    elapsedMs: Date.now() - startedAt, spilled, staleJams,
    ...(runtimeVersion ? { runtimeVersion } : {}),
  };
}
