// The Trace tab's anchor list — the named instants of the ring (they replace the old bookmark
// panel, whose backing call no daemon ever had). Click a name to see where it sits in the trace;
// the "go" button moves the shared machine there, so it says so.

import React from "react";
import type { Anchor } from "../anchors.js";

interface Props {
  anchors: Anchor[];
  onShow: (cycle: number) => void;
  onGo: (name: string) => void;
}

export function AnchorList({ anchors, onShow, onGo }: Props): React.JSX.Element {
  if (anchors.length === 0) return <div className="anchor-list anchor-list-empty">No anchors yet — name an instant from the filmstrip, or let the assistant set one.</div>;
  return (
    <div className="anchor-list">
      {anchors.map((a) => (
        <div key={a.anchorId} className="bookmark-marker" title={`cycle ${a.cycle}, frame ${a.frame ?? "?"}`}>
          <span className="bookmark-icon" onClick={() => onShow(a.cycle)}>⚓</span>
          <span className="bookmark-label">"{a.name}" @cycle={a.cycle.toLocaleString()}</span>
          <button className="trace-btn" onClick={() => onGo(a.name)} title="Moves the shared machine to this anchor and pauses it there">go</button>
        </div>
      ))}
    </div>
  );
}
