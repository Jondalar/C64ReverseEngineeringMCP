export interface TabProps {
  sessionId: string;
  setSessionId: (id: string) => void;
  runState?: "running" | "paused" | "off";
  setRunState?: (s: "running" | "paused" | "off") => void;
}
