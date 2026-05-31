// Spec 744.4 — RuntimeSessionService: the ONE runtime session authority shared by
// the MCP runtime_* tools AND the Live UI / WS backend.
//
// Before 744.4 each surface constructed its own session: the MCP tools called
// `startIntegratedSession` in server-tools/headless.ts and the UI bootstrap called
// it again in scripts/start-v3-server.mjs, so a human could not attach to an
// LLM session and the LLM could not control a UI session. The session-manager and
// the runtime-controller registry were ALREADY module singletons, but no single
// API owned the lifecycle and product callers reached past it.
//
// This service is that single owner. It wraps the two existing singletons
// (integrated-session-manager + the controller registry) into one authority:
//
//   start / get / list / attach / close   — session lifecycle
//   status                                — combined session + controller state
//   run / pause / resume                  — execution (delegates to the controller)
//   close                                 — finalize trace + dispose controller + drop session
//
// Both surfaces import this module, so within one process they operate on the SAME
// session ids and controllers — REAL shared state, not mirrored sessions. The
// controller registry re-wires its broadcast sink on `ensureRuntimeController`, so
// a UI that attaches to an MCP-created session id starts receiving that session's
// frames (and vice-versa).
//
// Idle contract (Spec 744.3 + 744.4): `start()` creates a PAUSED session and does
// NOT begin the autonomous run loop. Trace capture is passive — it does not start a
// loop. Only an explicit UI `run()` (Live mode) or a bounded MCP `run(...)` advances
// the machine; an MCP run is one-shot (caller `runFor`s synchronously) and leaves no
// scheduled tick behind.

import type { IntegratedSession, IntegratedSessionOptions } from "./integrated-session.js";
import {
  startIntegratedSession,
  getIntegratedSession,
  listIntegratedSessions,
  stopIntegratedSession,
} from "./integrated-session-manager.js";
import {
  ensureRuntimeController,
  getRuntimeController,
  disposeRuntimeController,
  type RuntimeController,
} from "./debug/runtime-controller.js";

export type BroadcastFn = (message: string, payload: unknown) => void;
const NO_BROADCAST: BroadcastFn = () => {};

export interface RuntimeSessionHandle {
  sessionId: string;
  session: IntegratedSession;
  controller: RuntimeController;
}

export interface RuntimeSessionSummary {
  sessionId: string;
  runState: string;
  cycles: number;
  pc: number;
}

class RuntimeSessionService {
  /**
   * Create a session + its controller and register both in the shared authority.
   * The session is PAUSED with no autonomous loop (idle-safe). `broadcast`/`present`
   * are optional — the MCP surface passes none; the UI passes its WS sink. Callers
   * still drive boot (`session.resetCold` / `runFor`) — start does not free-run.
   */
  start(
    opts: IntegratedSessionOptions,
    broadcast: BroadcastFn = NO_BROADCAST,
    presentFrame?: (frameNum: number) => void,
  ): RuntimeSessionHandle {
    const { sessionId, session } = startIntegratedSession(opts);
    const controller = ensureRuntimeController(sessionId, session, broadcast, presentFrame);
    return { sessionId, session, controller };
  }

  /** Resolve a session id to its handle (session + controller), or undefined. */
  get(sessionId: string): RuntimeSessionHandle | undefined {
    const session = getIntegratedSession(sessionId);
    if (!session) return undefined;
    // Controller may not exist yet if the session was created before this service
    // (legacy path); create it lazily with a no-op sink so both surfaces share one.
    const controller = ensureRuntimeController(sessionId, session, NO_BROADCAST);
    return { sessionId, session, controller };
  }

  /**
   * Attach a surface to an EXISTING session id, (re)wiring its broadcast/present
   * sink. This is how the UI observes/controls an MCP-created session (and how MCP
   * picks up a UI-created session). Returns undefined for an unknown id.
   */
  attach(
    sessionId: string,
    broadcast: BroadcastFn,
    presentFrame?: (frameNum: number) => void,
  ): RuntimeSessionHandle | undefined {
    const session = getIntegratedSession(sessionId);
    if (!session) return undefined;
    const controller = ensureRuntimeController(sessionId, session, broadcast, presentFrame);
    return { sessionId, session, controller };
  }

  /** All live sessions (visible to both surfaces). */
  list(): RuntimeSessionSummary[] {
    return listIntegratedSessions().map(({ sessionId, session }) => ({
      sessionId,
      runState: getRuntimeController(sessionId)?.runState ?? "paused",
      cycles: session.c64Cpu.cycles,
      pc: session.c64Cpu.pc,
    }));
  }

  /** Combined controller + session status for a session id. */
  status(sessionId: string): { runState: string; cycles: number; pc: number } | undefined {
    const session = getIntegratedSession(sessionId);
    if (!session) return undefined;
    return {
      runState: getRuntimeController(sessionId)?.runState ?? "paused",
      cycles: session.c64Cpu.cycles,
      pc: session.c64Cpu.pc,
    };
  }

  /** Start the continuous run loop (UI Live mode). */
  run(sessionId: string, pacing?: { mode?: string; ratio?: number }): void {
    getRuntimeController(sessionId)?.run(pacing as never);
  }

  /** Pause the run loop. */
  pause(sessionId: string): void {
    getRuntimeController(sessionId)?.pause();
  }

  /** Resume the run loop. */
  resume(sessionId: string): void {
    getRuntimeController(sessionId)?.continue();
  }

  /**
   * Close a session: finalize an active streaming trace, dispose the controller
   * (cancels the run loop so it stops pegging a core), and drop the session from
   * the registry. Idempotent. This is cleanup, NOT the idle-safety mechanism —
   * a correctly-bounded MCP session never had a loop to cancel.
   */
  async close(sessionId: string): Promise<{ existed: boolean; released: string[] }> {
    const existed = !!getIntegratedSession(sessionId);
    const released: string[] = [];
    const ctrl = getRuntimeController(sessionId);
    try {
      if (ctrl?.traceRun?.isActive()) { await ctrl.traceRun.stop(); released.push("trace"); }
    } catch { /* nothing to finalize */ }
    if (ctrl) { disposeRuntimeController(sessionId); released.push("controller"); }
    if (stopIntegratedSession(sessionId)) released.push("session");
    return { existed, released };
  }
}

/** The single process-wide runtime authority. Import this; do not call
 *  startIntegratedSession / ensureRuntimeController directly from product code. */
export const runtimeSessions = new RuntimeSessionService();
