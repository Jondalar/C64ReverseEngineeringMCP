// Spec 266 — BreakpointList: list breakpoints with enable/disable/remove.

import React from "react";

export interface BpSpec {
  id: string;
  enabled: boolean;
  hitCount?: number;
  label?: string;
  predicate?: { kind: string; pc?: number; addr?: number | [number, number] };
  action?: string;
}

function hex4(v: number): string {
  return v.toString(16).padStart(4, "0").toUpperCase();
}

function descPredicate(pred?: BpSpec["predicate"]): string {
  if (!pred) return "(unknown)";
  switch (pred.kind) {
    case "pc": {
      const pc = pred.pc;
      if (pc === undefined) return "PC=(?)";
      return `PC=$${hex4(pc)}`;
    }
    case "mem_read": {
      const a = pred.addr;
      if (a === undefined) return "mem_read=(?)";
      const as = Array.isArray(a) ? `$${hex4(a[0])}-$${hex4(a[1])}` : `$${hex4(a)}`;
      return `mem_read @ ${as}`;
    }
    case "mem_write": {
      const a = pred.addr;
      if (a === undefined) return "mem_write=(?)";
      const as = Array.isArray(a) ? `$${hex4(a[0])}-$${hex4(a[1])}` : `$${hex4(a)}`;
      return `mem_write @ ${as}`;
    }
    default:
      return pred.kind;
  }
}

interface Props {
  breakpoints: BpSpec[];
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}

export function BreakpointList({ breakpoints, onToggle, onRemove }: Props): JSX.Element {
  if (breakpoints.length === 0) {
    return <div className="mon-bplist mon-bplist-empty">(no breakpoints)</div>;
  }
  return (
    <div className="mon-bplist">
      {breakpoints.map((bp) => (
        <div key={bp.id} className={`mon-bp-row${bp.enabled ? "" : " mon-bp-disabled"}`}>
          <input
            type="checkbox"
            checked={bp.enabled}
            onChange={(e) => onToggle(bp.id, e.target.checked)}
            title={bp.enabled ? "Disable" : "Enable"}
          />
          <span className="mon-bp-id">{bp.id}</span>
          <span className="mon-bp-pred">{descPredicate(bp.predicate)}</span>
          {bp.action && <span className="mon-bp-action">[{bp.action}]</span>}
          {bp.hitCount !== undefined && <span className="mon-bp-hits">hits={bp.hitCount}</span>}
          {bp.label && <span className="mon-bp-label">{bp.label}</span>}
          <button
            className="mon-bp-remove"
            onClick={() => onRemove(bp.id)}
            title="Remove breakpoint"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
