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
