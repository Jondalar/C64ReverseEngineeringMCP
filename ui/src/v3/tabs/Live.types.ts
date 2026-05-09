export interface TabProps {
  sessionId: string;
  setSessionId: (id: string) => void;
  runState?: "running" | "paused";
  setRunState?: (s: "running" | "paused") => void;
}
