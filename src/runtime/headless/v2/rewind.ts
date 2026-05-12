// Spec 243 — Rewind + interactive patch/poke + scenario tree.
//
// Time-travel debugging primitive. Capture snapshots at branch points,
// apply patches between instructions, run forward, compare branches.
//
// Resolved decisions (2026-05-08):
//   A2: ring fixed 32 default + per-session override
//   A3: tree branches (multiple children per parent, recursive)
//   A4: transient by default; opt-in promoteBranch → new Scenario
//   A5: strict between-instructions; mid-cycle patches deferred to V3+

import { randomUUID } from "node:crypto";
import { saveSessionVsf, loadSessionVsf } from "../vsf/session-vsf.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IntegratedSession } from "../integrated-session.js";
import { startIntegratedSession } from "../integrated-session-manager.js";
import { diffSnapshots, type SnapshotDiff } from "./snapshot-diff.js";
import type { Scenario, ScenarioMode } from "./scenario.js";

// ---- Types ----

export type SnapshotId = string;
export type BranchId = string;

export interface PokePatch {
  kind: "mem_byte" | "mem_range" | "register" | "io_register";
  /** mem_byte / mem_range / io_register addr */
  addr?: number;
  /** mem_range / io_register payload */
  bytes?: number[];
  /** register kind */
  reg?: "a" | "x" | "y" | "sp" | "pc" | "flags";
  /** register / mem_byte single value */
  value?: number;
}

export interface SnapshotBranch {
  id: BranchId;
  parentId?: BranchId;
  rootId?: BranchId;
  atCycle: number;
  patches: PokePatch[];
  startSnapshotId: SnapshotId;
  endCycle?: number;
  endSnapshotId?: SnapshotId;
  resultHash?: string;
  /** child branch ids (tree). */
  children: BranchId[];
}

export interface RewindHandleOpts {
  ringSize?: number;
}

export interface RewindHandle {
  scenarioId: string;
  rootSnapshotId: SnapshotId;
  rootBranchId: BranchId;
  branches: Map<BranchId, SnapshotBranch>;
  ringSize: number;
}

// ---- Manager ----

const DEFAULT_RING_SIZE = 32;

interface SnapshotEntry {
  id: SnapshotId;
  bytes: Uint8Array;
  /** Most recent access — for LRU eviction. */
  lastAccess: number;
  /** True if any active branch references this snapshot. */
  pinned: boolean;
}

export class RewindManager {
  private session: IntegratedSession;
  private scenarioId: string;
  private ringSize: number;
  private snapshots: Map<SnapshotId, SnapshotEntry> = new Map();
  private rootSnapshotId: SnapshotId;
  private rootBranchId: BranchId;
  private branches: Map<BranchId, SnapshotBranch> = new Map();
  private accessCounter = 0;
  private diskPath: string;
  private mode: ScenarioMode;

  constructor(session: IntegratedSession, scenarioId: string, diskPath: string, mode: ScenarioMode, opts: RewindHandleOpts = {}) {
    this.session = session;
    this.scenarioId = scenarioId;
    this.ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
    this.diskPath = diskPath;
    this.mode = mode;
    // Capture root snapshot.
    const rootBytes = this.captureSnapshot(this.session);
    this.rootSnapshotId = this.storeSnapshot(rootBytes, true);
    this.rootBranchId = randomUUID();
    const rootBranch: SnapshotBranch = {
      id: this.rootBranchId,
      atCycle: this.session.c64Cpu.cycles,
      patches: [],
      startSnapshotId: this.rootSnapshotId,
      endCycle: this.session.c64Cpu.cycles,
      endSnapshotId: this.rootSnapshotId,
      children: [],
    };
    rootBranch.rootId = this.rootBranchId;
    this.branches.set(this.rootBranchId, rootBranch);
  }

  handle(): RewindHandle {
    return {
      scenarioId: this.scenarioId,
      rootSnapshotId: this.rootSnapshotId,
      rootBranchId: this.rootBranchId,
      branches: this.branches,
      ringSize: this.ringSize,
    };
  }

  /**
   * Restore from closest existing snapshot ≤ cycle, then run forward
   * to exact cycle. Captures snapshot at the target cycle and returns
   * its id.
   */
  rewindTo(cycle: number): SnapshotId {
    // Find best snapshot to restore from: highest endCycle ≤ cycle.
    let bestEntry: SnapshotEntry | undefined;
    let bestCycle = -1;
    for (const branch of this.branches.values()) {
      if (branch.endCycle === undefined) continue;
      if (branch.endCycle > cycle) continue;
      if (branch.endCycle <= bestCycle) continue;
      if (!branch.endSnapshotId) continue;
      const entry = this.snapshots.get(branch.endSnapshotId);
      if (!entry) continue;
      bestEntry = entry;
      bestCycle = branch.endCycle;
    }
    if (!bestEntry) {
      throw new Error(`rewindTo: no snapshot found ≤ cycle ${cycle}`);
    }
    this.restoreSession(bestEntry.bytes);
    bestEntry.lastAccess = ++this.accessCounter;
    // Run forward to exact target.
    const remaining = cycle - this.session.c64Cpu.cycles;
    if (remaining > 0) {
      this.session.runFor(remaining + 50_000, { cycleBudget: remaining });
    }
    const newBytes = this.captureSnapshot(this.session);
    return this.storeSnapshot(newBytes, false);
  }

  /**
   * Apply patches between instructions on snapshotId, capture result,
   * return new snapshot id. Creates branch entry tracking the patch.
   */
  applyPatch(snapshotId: SnapshotId, patches: PokePatch[], parentBranchId?: BranchId): SnapshotId {
    const entry = this.snapshots.get(snapshotId);
    if (!entry) throw new Error(`applyPatch: snapshot ${snapshotId} not found`);
    this.restoreSession(entry.bytes);
    entry.lastAccess = ++this.accessCounter;
    // Patches apply BEFORE next instruction fetch (A5 strict between-instructions).
    for (const p of patches) {
      this.applyOnePatch(p);
    }
    const newBytes = this.captureSnapshot(this.session);
    const newSnapshotId = this.storeSnapshot(newBytes, false);
    // Track in branch.
    const branchId = randomUUID();
    const parent = parentBranchId ? this.branches.get(parentBranchId) : this.branches.get(this.rootBranchId);
    if (!parent) throw new Error(`applyPatch: parent branch ${parentBranchId} not found`);
    const branch: SnapshotBranch = {
      id: branchId,
      parentId: parent.id,
      rootId: parent.rootId ?? parent.id,
      atCycle: this.session.c64Cpu.cycles,
      patches,
      startSnapshotId: snapshotId,
      endSnapshotId: newSnapshotId,
      endCycle: this.session.c64Cpu.cycles,
      children: [],
    };
    this.branches.set(branchId, branch);
    parent.children.push(branchId);
    this.pinReferenced();
    return newSnapshotId;
  }

  /**
   * Restore + run for budgetCycles, capture end snapshot. Returns the
   * end snapshot id. Trace/result hash optional and cheaper than full
   * Spec 231 replay.
   */
  runForward(snapshotId: SnapshotId, budgetCycles: number, parentBranchId?: BranchId): {
    endSnapshotId: SnapshotId;
    cyclesRan: number;
    branchId: BranchId;
  } {
    const entry = this.snapshots.get(snapshotId);
    if (!entry) throw new Error(`runForward: snapshot ${snapshotId} not found`);
    this.restoreSession(entry.bytes);
    entry.lastAccess = ++this.accessCounter;
    const startCycle = this.session.c64Cpu.cycles;
    this.session.runFor(budgetCycles + 50_000, { cycleBudget: budgetCycles });
    const cyclesRan = this.session.c64Cpu.cycles - startCycle;
    const endBytes = this.captureSnapshot(this.session);
    const endSnapshotId = this.storeSnapshot(endBytes, false);

    const branchId = randomUUID();
    const parent = parentBranchId ? this.branches.get(parentBranchId) : this.branches.get(this.rootBranchId);
    if (!parent) throw new Error(`runForward: parent branch ${parentBranchId} not found`);
    const branch: SnapshotBranch = {
      id: branchId,
      parentId: parent.id,
      rootId: parent.rootId ?? parent.id,
      atCycle: startCycle,
      patches: [],
      startSnapshotId: snapshotId,
      endSnapshotId,
      endCycle: this.session.c64Cpu.cycles,
      children: [],
    };
    this.branches.set(branchId, branch);
    parent.children.push(branchId);
    this.pinReferenced();
    return { endSnapshotId, cyclesRan, branchId };
  }

  /** Use Spec 246 diff between two snapshots. */
  diffBranches(a: SnapshotId, b: SnapshotId): SnapshotDiff {
    const aEntry = this.snapshots.get(a);
    const bEntry = this.snapshots.get(b);
    if (!aEntry || !bEntry) throw new Error("diffBranches: snapshot id not found");
    return diffSnapshots(aEntry.bytes, bEntry.bytes);
  }

  /**
   * Materialize a transient branch as persistent Scenario record.
   * Returns a Scenario with startSnapshot = the branch's start
   * snapshot bytes + patches embedded as inputs (= no inputs, but
   * patch sequence preserved via separate Scenario field if needed).
   *
   * For V2.x first cut, we save startSnapshot bytes to a tmp VSF and
   * build a Scenario whose startSnapshot points to that path. Patches
   * are captured in the result for caller to persist alongside.
   */
  promoteBranch(branchId: BranchId): { scenarioId: string; scenario: Scenario; patches: PokePatch[] } {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`promoteBranch: branch ${branchId} not found`);
    const startEntry = this.snapshots.get(branch.startSnapshotId);
    if (!startEntry) throw new Error(`promoteBranch: start snapshot ${branch.startSnapshotId} not found`);
    const tmpDir = join(tmpdir(), "c64re-rewind-promote");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const newScenarioId = `${this.scenarioId}-branch-${branchId.slice(0, 8)}`;
    const path = join(tmpDir, `${newScenarioId}.vsf`);
    writeFileSync(path, startEntry.bytes);
    const scenario: Scenario = {
      id: newScenarioId,
      startSnapshot: path,
      inputs: [],
      cycleBudget: branch.endCycle ? branch.endCycle - branch.atCycle : 0,
      diskPath: this.diskPath,
      mode: this.mode,
    };
    return { scenarioId: newScenarioId, scenario, patches: [...branch.patches] };
  }

  /** Snapshot ring stats for tests + introspection. */
  ringStats(): { size: number; pinnedCount: number; entries: SnapshotId[] } {
    return {
      size: this.snapshots.size,
      pinnedCount: [...this.snapshots.values()].filter(e => e.pinned).length,
      entries: [...this.snapshots.keys()],
    };
  }

  // ---- internals ----

  private captureSnapshot(session: IntegratedSession): Uint8Array {
    const tmpDir = join(tmpdir(), "c64re-rewind-cache");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, `cap-${process.pid}-${++this.accessCounter}.vsf`);
    saveSessionVsf(session, path);
    const bytes = new Uint8Array(readFileSync(path));
    return bytes;
  }

  private restoreSession(bytes: Uint8Array): void {
    const tmpDir = join(tmpdir(), "c64re-rewind-cache");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, `restore-${process.pid}.vsf`);
    writeFileSync(path, bytes);
    loadSessionVsf(this.session, path);
  }

  private storeSnapshot(bytes: Uint8Array, pinned: boolean): SnapshotId {
    const id = randomUUID();
    this.snapshots.set(id, {
      id, bytes, lastAccess: ++this.accessCounter, pinned,
    });
    this.evictIfNeeded();
    return id;
  }

  private pinReferenced(): void {
    // Clear all pin flags then re-pin only LEAF branch endpoints
    // (= branches with no children). Intermediate branch endpoints
    // can be evicted; rewindTo can re-derive from the closest
    // remaining snapshot ≤ target cycle.
    for (const e of this.snapshots.values()) e.pinned = false;
    for (const b of this.branches.values()) {
      const isLeaf = b.children.length === 0;
      if (isLeaf) {
        const s1 = this.snapshots.get(b.startSnapshotId); if (s1) s1.pinned = true;
        if (b.endSnapshotId) {
          const s2 = this.snapshots.get(b.endSnapshotId); if (s2) s2.pinned = true;
        }
      }
    }
    // Always pin root snapshot.
    const root = this.snapshots.get(this.rootSnapshotId); if (root) root.pinned = true;
  }

  private evictIfNeeded(): void {
    if (this.snapshots.size <= this.ringSize) return;
    // Evict unpinned, oldest-access first.
    const candidates = [...this.snapshots.values()]
      .filter(e => !e.pinned)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    for (const c of candidates) {
      if (this.snapshots.size <= this.ringSize) break;
      this.snapshots.delete(c.id);
    }
    // If still over (= all pinned), accept overflow rather than break refs.
  }

  private applyOnePatch(p: PokePatch): void {
    switch (p.kind) {
      case "mem_byte": {
        if (p.addr === undefined || p.value === undefined) throw new Error("mem_byte requires addr+value");
        this.session.c64Bus.write(p.addr & 0xffff, p.value & 0xff);
        return;
      }
      case "mem_range": {
        if (p.addr === undefined || !p.bytes) throw new Error("mem_range requires addr+bytes");
        for (let i = 0; i < p.bytes.length; i++) {
          this.session.c64Bus.write((p.addr + i) & 0xffff, p.bytes[i]! & 0xff);
        }
        return;
      }
      case "register": {
        if (p.reg === undefined || p.value === undefined) throw new Error("register requires reg+value");
        switch (p.reg) {
          case "a": this.session.c64Cpu.a = p.value & 0xff; return;
          case "x": this.session.c64Cpu.x = p.value & 0xff; return;
          case "y": this.session.c64Cpu.y = p.value & 0xff; return;
          case "sp": this.session.c64Cpu.sp = p.value & 0xff; return;
          case "pc": this.session.c64Cpu.pc = p.value & 0xffff; return;
          case "flags": this.session.c64Cpu.flags = p.value & 0xff; return;
        }
        return;
      }
      case "io_register": {
        if (p.addr === undefined || p.value === undefined) throw new Error("io_register requires addr+value");
        // Write through bus to hit IO handler (CIA/VIC/SID).
        this.session.c64Bus.write(p.addr & 0xffff, p.value & 0xff);
        return;
      }
    }
  }
}

/** Convenience factory matching Spec 237 query API shape. */
export function beginRewindSession(
  session: IntegratedSession,
  scenarioId: string,
  diskPath: string,
  mode: ScenarioMode,
  opts: RewindHandleOpts = {},
): RewindManager {
  return new RewindManager(session, scenarioId, diskPath, mode, opts);
}
