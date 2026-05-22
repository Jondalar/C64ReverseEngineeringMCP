// Spec 237 — Agent query API (KernelClient extension).
//
// Stable surface aggregating all V2.x modules into one class.
// Consumed by Spec 238 V2 MCP tools and direct agent calls.
//
// Each method delegates to the underlying V2 module. Heavy
// resources (BreakpointManager, RewindManager, MonitorAPI) are
// lazy-initialised on first use.

import type { IntegratedSession } from "../integrated-session.js";
import type { ScenarioMode, Scenario, ReplayResult } from "./scenario.js";
import { runScenario } from "./scenario.js";
import type { EventRow } from "./trace-events.js";
import type { EventQuery, QueryEventsBackend } from "./query-events.js";
import { queryEvents } from "./query-events.js";
import type { PathQuery, PathChain } from "./follow-path.js";
import { followPath } from "./follow-path.js";
import type { SwimlaneQuery, SwimlaneSlice } from "./swimlane.js";
import { swimlaneSlice } from "./swimlane.js";
import type { ResolvedPc } from "./resolve-pc.js";
import { resolvePc, resolvePcs } from "./resolve-pc.js";
import type { TaintQuery, TaintGraph } from "./taint.js";
import { traceTaint } from "./taint.js";
import type { LoaderProfile } from "./loader-profile.js";
import { profileLoader } from "./loader-profile.js";
import type { SnapshotDiff } from "./snapshot-diff.js";
import { diffSnapshots, formatDiff } from "./snapshot-diff.js";
import type {
  FingerprintMatch, ScanOptions, FingerprintEntry,
} from "./fingerprint.js";
import { scanFingerprints, addFingerprintToLibrary } from "./fingerprint.js";
import type {
  BreakpointSpec, BreakpointHit, BreakpointAction,
} from "./breakpoints.js";
import { BreakpointManager } from "./breakpoints.js";
import type { TraceBookmark, BookmarkBackend } from "./bookmarks.js";
import {
  addBookmark, listBookmarks, removeBookmark,
} from "./bookmarks.js";
import type { PokePatch, SnapshotId, BranchId } from "./rewind.js";
import { RewindManager } from "./rewind.js";
import type {
  MonitorRegisters, DisasmLine, FindResult,
  StepOverResult, StepOutResult, UntilResult,
} from "./monitor.js";
import { MonitorAPI } from "./monitor.js";
import type { DivergenceRecord, DiffQuery } from "./vice-diff.js";
import { diffAgainstVice } from "./vice-diff.js";
import {
  regressionCompare, regressionCaptureBaseline, regressionReport,
  type RegressionResult,
} from "./regression.js";
import { saveSessionVsf, loadSessionVsf } from "../vsf/session-vsf.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface AgentApiOptions {
  session: IntegratedSession;
  /** DuckDB-backed query backend; required for trace-store ops. */
  traceBackend?: QueryEventsBackend;
  /** Bookmark backend (DuckDB; same conn as traceBackend typically). */
  bookmarkBackend?: BookmarkBackend;
  /** scenarioId for ops that require it (regression, rewind). */
  scenarioId?: string;
  /** Disk path for rewind/scenario reconstruction. */
  diskPath?: string;
  /** Session mode for rewind/scenario. */
  mode?: ScenarioMode;
  /** Scenario registry for regression ops. */
  scenarioRegistry?: Map<string, unknown>;
}

/** Spec 237 — V2 agent query API stable surface. */
export class AgentQueryApi {
  private session: IntegratedSession;
  private traceBackend?: QueryEventsBackend;
  private bookmarkBackend?: BookmarkBackend;
  private scenarioId?: string;
  private diskPath?: string;
  private mode?: ScenarioMode;
  private scenarioRegistry?: Map<string, unknown>;
  private _bp?: BreakpointManager;
  private _monitor?: MonitorAPI;
  private _rewind?: RewindManager;

  constructor(opts: AgentApiOptions) {
    this.session = opts.session;
    this.traceBackend = opts.traceBackend;
    this.bookmarkBackend = opts.bookmarkBackend;
    this.scenarioId = opts.scenarioId;
    this.diskPath = opts.diskPath;
    this.mode = opts.mode;
    this.scenarioRegistry = opts.scenarioRegistry;
  }

  // ---- Trace store (Spec 232/233/234/235/244/245) ----
  async queryEvents(query: EventQuery): Promise<EventRow[]> {
    if (!this.traceBackend) throw new Error("traceBackend not configured");
    return queryEvents(this.traceBackend, query);
  }
  async followPath(query: PathQuery): Promise<PathChain> {
    if (!this.traceBackend) throw new Error("traceBackend not configured");
    return followPath(this.traceBackend, query);
  }
  async swimlaneSlice(query: SwimlaneQuery): Promise<SwimlaneSlice> {
    if (!this.traceBackend) throw new Error("traceBackend not configured");
    return swimlaneSlice(this.traceBackend, query);
  }
  async traceTaint(query: TaintQuery): Promise<TaintGraph> {
    if (!this.traceBackend) throw new Error("traceBackend not configured");
    return traceTaint(this.traceBackend, query);
  }
  async profileLoader(scenarioId: string, range: [number, number]): Promise<LoaderProfile> {
    if (!this.traceBackend) throw new Error("traceBackend not configured");
    return profileLoader(this.traceBackend, scenarioId, range);
  }

  // ---- Disasm linkage (Spec 235) ----
  resolvePc(artifactId: string, pc: number): ResolvedPc {
    return resolvePc(artifactId, pc);
  }
  resolvePcs(artifactId: string, pcs: number[]): ResolvedPc[] {
    return resolvePcs(artifactId, pcs);
  }

  // ---- VICE diff (Spec 236, debug-tier) ----
  async compareRunAgainstVice(query: DiffQuery): Promise<DivergenceRecord | null> {
    if (!this.traceBackend) throw new Error("traceBackend not configured");
    return diffAgainstVice({
      headless: this.traceBackend,
      vice: this.traceBackend,
    } as any, query);
  }

  // ---- Replay & scenarios (Spec 231) ----
  runScenario(scenario: Scenario): ReplayResult {
    return runScenario(scenario);
  }

  // ---- Snapshot diff (Spec 246) ----
  diffSnapshots(a: Uint8Array, b: Uint8Array, opts?: { enrich?: boolean }): SnapshotDiff {
    return diffSnapshots(a, b, opts);
  }
  formatDiff(diff: SnapshotDiff): string {
    return formatDiff(diff);
  }

  // ---- Fingerprint (Spec 247) ----
  scanFingerprints(
    artifactId: string,
    artifactBytes: Uint8Array,
    baseAddr: number,
    opts?: ScanOptions,
  ): FingerprintMatch[] {
    return scanFingerprints(artifactId, artifactBytes, baseAddr, opts);
  }
  addFingerprintToLibrary(filePath: string, entry: FingerprintEntry): void {
    return addFingerprintToLibrary(filePath, entry);
  }

  // ---- Breakpoints (Spec 241) ----
  private bp(): BreakpointManager {
    if (!this._bp) this._bp = new BreakpointManager();
    return this._bp;
  }
  addBreakpoint(spec: BreakpointSpec): string {
    this.bp().add(spec);
    return spec.id;
  }
  addPcBreakpoint(id: string, pc: number | [number, number], action: BreakpointAction = "halt"): string {
    this.bp().addPc(id, pc, action);
    return id;
  }
  addTracepoint(id: string, pc: number): string {
    this.bp().addTracepoint(id, pc);
    return id;
  }
  listBreakpoints(): BreakpointSpec[] {
    return this.bp().list();
  }
  removeBreakpoint(id: string): boolean {
    return this.bp().remove(id);
  }
  enableBreakpoint(id: string, enabled: boolean): void {
    if (enabled) this.bp().enable(id);
    else this.bp().disable(id);
  }
  setBreakpointIgnoreCount(id: string, count: number): void {
    this.bp().setIgnoreCount(id, count);
  }
  breakpointAuditLog(): Array<{ id: string; reason: string; cycle: number }> {
    return this.bp().auditLog;
  }

  // ---- Bookmarks (Spec 242) ----
  async addBookmark(b: Omit<TraceBookmark, "id"> & { id?: string }): Promise<string> {
    if (!this.bookmarkBackend) throw new Error("bookmarkBackend not configured");
    return addBookmark(this.bookmarkBackend, b);
  }
  async listBookmarks(runId: string, range?: [number, number]): Promise<TraceBookmark[]> {
    if (!this.bookmarkBackend) throw new Error("bookmarkBackend not configured");
    return listBookmarks(this.bookmarkBackend, runId, range);
  }
  async removeBookmark(id: string): Promise<void> {
    if (!this.bookmarkBackend) throw new Error("bookmarkBackend not configured");
    return removeBookmark(this.bookmarkBackend, id);
  }

  // ---- Monitor (Spec 248) ----
  private monitor(): MonitorAPI {
    if (!this._monitor) this._monitor = new MonitorAPI(this.session);
    return this._monitor;
  }
  monitorRegisters(memspace?: "c64" | "drive"): MonitorRegisters {
    return this.monitor().registers(memspace);
  }
  monitorMemory(start: number, end: number): Uint8Array {
    return this.monitor().memory(start, end);
  }
  monitorDisasm(addr: number, count = 10): DisasmLine[] {
    return this.monitor().disasm(addr, count);
  }
  goto(addr: number): void { this.monitor().goto(addr); }
  stepInto(): void { this.monitor().stepInto(); }
  stepOver(opts?: { budget?: number }): StepOverResult {
    return this.monitor().stepOver(opts);
  }
  stepOut(opts?: { budget?: number }): StepOutResult {
    return this.monitor().stepOut(opts);
  }
  until(addr: number, opts?: { budget?: number }): UntilResult {
    return this.monitor().until(addr, opts);
  }
  monitorFind(start: number, end: number, pattern: number[]): FindResult[] {
    return this.monitor().find(start, end, pattern);
  }

  // ---- Rewind (Spec 243) ----
  beginRewindSession(opts: { ringSize?: number } = {}): RewindManager {
    if (!this.scenarioId || !this.diskPath || !this.mode) {
      throw new Error("beginRewindSession requires scenarioId+diskPath+mode in AgentApiOptions");
    }
    if (!this._rewind) {
      this._rewind = new RewindManager(this.session, this.scenarioId, this.diskPath, this.mode, opts);
    }
    return this._rewind;
  }
  rewindTo(cycle: number): SnapshotId {
    return this.beginRewindSession().rewindTo(cycle);
  }
  applyPatch(snapshotId: SnapshotId, patches: PokePatch[], parentBranchId?: BranchId): SnapshotId {
    return this.beginRewindSession().applyPatch(snapshotId, patches, parentBranchId);
  }
  runForward(snapshotId: SnapshotId, budgetCycles: number, parentBranchId?: BranchId) {
    return this.beginRewindSession().runForward(snapshotId, budgetCycles, parentBranchId);
  }
  diffBranches(a: SnapshotId, b: SnapshotId): SnapshotDiff {
    return this.beginRewindSession().diffBranches(a, b);
  }
  promoteBranch(branchId: BranchId) {
    return this.beginRewindSession().promoteBranch(branchId);
  }

  // ---- Regression (Spec 250) ----
  async regressionCompare(scenarioId: string): Promise<RegressionResult> {
    if (!this.scenarioRegistry) throw new Error("scenarioRegistry not configured");
    return regressionCompare(scenarioId, this.scenarioRegistry);
  }
  async regressionCaptureBaseline(scenarioId: string) {
    if (!this.scenarioRegistry) throw new Error("scenarioRegistry not configured");
    return regressionCaptureBaseline(scenarioId, this.scenarioRegistry);
  }
  async regressionReport() {
    if (!this.scenarioRegistry) throw new Error("scenarioRegistry not configured");
    return regressionReport(this.scenarioRegistry);
  }

  // ---- VSF (Spec 251) ----
  saveVsf(): Uint8Array {
    const tmp = join(tmpdir(), "c64re-agent-api-vsf");
    if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
    const path = join(tmp, `save-${process.pid}-${Date.now()}.vsf`);
    saveSessionVsf(this.session, path);
    return new Uint8Array(readFileSync(path));
  }
  loadVsf(bytes: Uint8Array): void {
    const tmp = join(tmpdir(), "c64re-agent-api-vsf");
    if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
    const path = join(tmp, `load-${process.pid}-${Date.now()}.vsf`);
    writeFileSync(path, bytes);
    loadSessionVsf(this.session, path);
  }

  // ---- Status / introspection ----
  status() {
    return {
      c64Cycles: this.session.c64Cpu.cycles,
      driveCycles: this.session.driveDebug().drive_clk, // Spec 704 §11 R3 — vice drive clock
      mode: this.session.mode,
      scenarioId: this.scenarioId,
      hasTraceBackend: !!this.traceBackend,
      hasBookmarkBackend: !!this.bookmarkBackend,
      hasScenarioRegistry: !!this.scenarioRegistry,
    };
  }
}

/** Convenience factory. */
export function createAgentQueryApi(opts: AgentApiOptions): AgentQueryApi {
  return new AgentQueryApi(opts);
}
