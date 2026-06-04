import type { ReactNode } from "react";

export interface TabProps {
  sessionId: string;
  setSessionId: (id: string) => void;
  runState?: "running" | "paused" | "off";
  setRunState?: (s: "running" | "paused" | "off") => void;
  // BUG-018 (relocation) — optional status content shown in the Live controls
  // bar (next to Audio). v1 product passes the runtime conn/session chip here.
  statusSlot?: ReactNode;
}
