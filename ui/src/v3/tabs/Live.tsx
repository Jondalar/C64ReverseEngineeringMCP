import React from "react";
export interface TabProps { sessionId: string; setSessionId: (id: string) => void; }
export function LiveTab(_p: TabProps): JSX.Element {
  return (
    <div className="v3-tab-stub">
      <h2>Live</h2>
      <p>VIC frame stream + audio playback (Spec 262 + 263)</p>
      <p>Stub — implementation arrives in Sprint 136 + 137.</p>
    </div>
  );
}
