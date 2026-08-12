// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// Singleton holder for active IntegratedSession instances.

import { IntegratedSession, type IntegratedSessionOptions } from "./integrated-session.js";

const sessions = new Map<string, IntegratedSession>();
let nextId = 1;

export function startIntegratedSession(opts: IntegratedSessionOptions): { sessionId: string; session: IntegratedSession } {
  const session = new IntegratedSession(opts);
  const sessionId = `integrated-${nextId++}`;
  sessions.set(sessionId, session);
  return { sessionId, session };
}

export function getIntegratedSession(sessionId: string): IntegratedSession | undefined {
  return sessions.get(sessionId);
}

export function listIntegratedSessions(): Array<{ sessionId: string; session: IntegratedSession }> {
  return [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, session }));
}

export function stopIntegratedSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}
