// Spec 268 — Selected snapshot branch detail panel.

import React, { useState } from "react";
import type { SnapshotBranch } from "./SnapshotTreeView.js";

export interface SnapshotDetailProps {
  branch: SnapshotBranch | null;
  branchId: string | null;
  rootBranchId: string;
  allBranchIds: string[];
  sessionId: string;
  onRestore: (branchId: string) => void;
  onPromote: (branchId: string) => void;
  onPin: (branchId: string) => void;
  onDiff: (branchId: string, vsId: string) => void;
}

export function SnapshotDetail(props: SnapshotDetailProps): React.JSX.Element {
  const {
    branch, branchId, rootBranchId, allBranchIds,
    onRestore, onPromote, onPin, onDiff,
  } = props;

  const [diffTarget, setDiffTarget] = useState<string>(rootBranchId);

  if (!branch || !branchId) {
    return (
      <div style={{ padding: 16, color: "#888", fontSize: 13 }}>
        Select a branch node to see details.
      </div>
    );
  }

  const shortId = branchId.slice(0, 8);
  const patchCount = branch.patches.length;
  const childCount = branch.children.length;

  return (
    <div style={{ padding: 12, fontSize: 13, color: "#ccc" }}>
      <div style={{ marginBottom: 8, fontWeight: 600, color: "#fff" }}>
        Snapshot: {shortId}
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}>
        <tbody>
          <tr>
            <td style={{ color: "#888", paddingRight: 12, paddingBottom: 4 }}>Cycle</td>
            <td style={{ fontFamily: "monospace" }}>{branch.atCycle.toLocaleString()}</td>
          </tr>
          {branch.endCycle !== undefined && (
            <tr>
              <td style={{ color: "#888", paddingRight: 12, paddingBottom: 4 }}>End cycle</td>
              <td style={{ fontFamily: "monospace" }}>{branch.endCycle.toLocaleString()}</td>
            </tr>
          )}
          <tr>
            <td style={{ color: "#888", paddingRight: 12, paddingBottom: 4 }}>Children</td>
            <td>{childCount}</td>
          </tr>
          <tr>
            <td style={{ color: "#888", paddingRight: 12, paddingBottom: 4 }}>Patches</td>
            <td>{patchCount}</td>
          </tr>
          {branch.resultHash && (
            <tr>
              <td style={{ color: "#888", paddingRight: 12, paddingBottom: 4 }}>Hash</td>
              <td style={{ fontFamily: "monospace", fontSize: 11 }}>{branch.resultHash.slice(0, 16)}</td>
            </tr>
          )}
        </tbody>
      </table>

      {patchCount > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: "#888", marginBottom: 4 }}>Patches</div>
          {branch.patches.map((p, i) => (
            <div key={i} style={{
              fontFamily: "monospace",
              fontSize: 11,
              background: "rgba(255,255,255,0.04)",
              borderRadius: 3,
              padding: "2px 6px",
              marginBottom: 2,
            }}>
              {p.kind}: {p.addr !== undefined ? `$${p.addr.toString(16).padStart(4, "0")}` : ""}
              {p.value !== undefined ? ` = $${p.value.toString(16).padStart(2, "0")}` : ""}
              {p.reg ? `${p.reg} = $${(p.value ?? 0).toString(16).padStart(2, "0")}` : ""}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button
          style={btnStyle("#2a6")}
          onClick={() => onRestore(branchId)}
          title="Restore session to this snapshot"
        >
          Restore
        </button>
        <button
          style={btnStyle("#a62")}
          onClick={() => onPromote(branchId)}
          title="Promote this branch to a persistent scenario"
        >
          Promote
        </button>
        <button
          style={btnStyle("#268")}
          onClick={() => onPin(branchId)}
          title="Pin this snapshot to prevent ring eviction"
        >
          Pin
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#888" }}>Diff vs</span>
        <select
          value={diffTarget}
          onChange={e => setDiffTarget(e.target.value)}
          style={{
            background: "#222",
            color: "#ccc",
            border: "1px solid #444",
            borderRadius: 3,
            padding: "2px 4px",
            fontSize: 12,
            flex: 1,
          }}
        >
          {allBranchIds.map(id => (
            <option key={id} value={id}>{id.slice(0, 8)}{id === rootBranchId ? " (root)" : ""}</option>
          ))}
        </select>
        <button
          style={btnStyle("#555")}
          onClick={() => onDiff(branchId, diffTarget)}
        >
          Diff
        </button>
      </div>
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 12,
  };
}
