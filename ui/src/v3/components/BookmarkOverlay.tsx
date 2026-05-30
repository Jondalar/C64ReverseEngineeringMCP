// Spec 267 — BookmarkOverlay: render ▶ markers for trace bookmarks.

import React from "react";

export interface Bookmark {
  id: string;
  cycle: number;
  label: string;
  note?: string;
}

interface Props {
  bookmarks: Bookmark[];
  visibleCycleStart: number;
  visibleCycleEnd: number;
  onJump: (cycle: number) => void;
}

export function BookmarkOverlay({ bookmarks, visibleCycleStart, visibleCycleEnd, onJump }: Props): React.JSX.Element {
  const visible = bookmarks.filter(
    (b) => b.cycle >= visibleCycleStart && b.cycle <= visibleCycleEnd,
  );

  if (visible.length === 0) return <></>;

  return (
    <div className="bookmark-overlay">
      {visible.map((bm) => (
        <div key={bm.id} className="bookmark-marker" title={bm.note ?? bm.label}>
          <span className="bookmark-icon" onClick={() => onJump(bm.cycle)}>▶</span>
          <span className="bookmark-label">
            "{bm.label}" @cycle={bm.cycle.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
