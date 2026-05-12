// Spec 268 — Snapshot tree tab.
//
// Left ~30%: branch tree visualization.
// Right ~70%: selected node detail.

import React, { useState, useEffect, useCallback } from "react";
import type { TabProps } from "./Live.types.js";
import { getClient } from "../ws-client.js";
import { SnapshotTreeView, type SnapshotBranch } from "../components/SnapshotTreeView.js";
import { SnapshotDetail } from "../components/SnapshotDetail.js";

interface SnapshotTreeData {
  scenarioId: string;
  rootBranchId: string;
  rootSnapshotId: string;
  ringSize: number;
  branches: Record<string, SnapshotBranch>;
}

export function SnapshotsTab({ sessionId }: TabProps): JSX.Element {
  const [treeData, setTreeData] = useState<SnapshotTreeData | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [diffResult, setDiffResult] = useState<string | null>(null);

  const client = getClient();

  const loadTree = useCallback(async () => {
    if (!sessionId) return;
    setStatus("loading");
    setErrorMsg("");
    try {
      const data = await client.call<SnapshotTreeData>("runtime/snapshot_tree", { session_id: sessionId });
      setTreeData(data);
      setStatus("idle");
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setStatus("error");
    }
  }, [sessionId, client]);

  useEffect(() => {
    if (sessionId) loadTree();
  }, [sessionId]);

  const handleRestore = useCallback(async (branchId: string) => {
    if (!sessionId) return;
    try {
      await client.call("runtime/call", {
        session_id: sessionId,
        op: "rewindTo",
        args: [treeData?.branches[branchId]?.atCycle ?? 0],
      });
      alert(`Restored to branch ${branchId.slice(0, 8)}`);
    } catch (e: any) {
      alert(`Restore failed: ${e?.message}`);
    }
  }, [sessionId, treeData, client]);

  const handlePromote = useCallback(async (branchId: string) => {
    if (!sessionId) return;
    try {
      const result = await client.call("runtime/promote_branch", {
        session_id: sessionId,
        branch_id: branchId,
      });
      alert(`Promoted to scenario: ${(result as any)?.scenarioId}`);
    } catch (e: any) {
      alert(`Promote failed: ${e?.message}`);
    }
  }, [sessionId, client]);

  const handlePin = useCallback((branchId: string) => {
    // Pin is a local visual hint — actual pinning managed server-side via ring eviction.
    alert(`Pin note: branch ${branchId.slice(0, 8)} marked (server-side pinning via ring eviction; reload tree to confirm)`);
  }, []);

  const handleDiff = useCallback(async (branchId: string, vsId: string) => {
    if (!sessionId) return;
    try {
      const aEndSnap = treeData?.branches[branchId]?.endSnapshotId;
      const bEndSnap = treeData?.branches[vsId]?.endSnapshotId;
      if (!aEndSnap || !bEndSnap) {
        setDiffResult("Cannot diff: one or both branches have no end snapshot.");
        return;
      }
      const result = await client.call("runtime/call", {
        session_id: sessionId,
        op: "diffBranches",
        args: [aEndSnap, bEndSnap],
      });
      const diff = result as any;
      const lines: string[] = [];
      if (diff?.ramChangedRanges?.length) {
        lines.push(`RAM diff: ${diff.ramChangedRanges.length} changed range(s)`);
        for (const r of diff.ramChangedRanges.slice(0, 10)) {
          lines.push(`  $${r.start.toString(16).padStart(4, "0")}-$${r.end.toString(16).padStart(4, "0")} (${r.end - r.start + 1} bytes)`);
        }
        if (diff.ramChangedRanges.length > 10) lines.push(`  … +${diff.ramChangedRanges.length - 10} more`);
      } else {
        lines.push("RAM: identical");
      }
      if (diff?.cpuDiff) lines.push(`CPU diff: ${JSON.stringify(diff.cpuDiff)}`);
      setDiffResult(lines.join("\n"));
    } catch (e: any) {
      setDiffResult(`Diff error: ${e?.message}`);
    }
  }, [sessionId, treeData, client]);

  const selectedBranch = treeData && selectedBranchId ? treeData.branches[selectedBranchId] ?? null : null;
  const allBranchIds = treeData ? Object.keys(treeData.branches) : [];

  return (
    <div style={{ display: "flex", height: "100%", fontFamily: "monospace" }}>
      {/* Left: tree ~30% */}
      <div style={{
        width: "30%",
        minWidth: 180,
        borderRight: "1px solid #2a2a2a",
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{
          padding: "8px 10px",
          borderBottom: "1px solid #2a2a2a",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ color: "#aaa", fontSize: 12, fontWeight: 600 }}>Snapshot Tree</span>
          <button
            onClick={loadTree}
            disabled={status === "loading"}
            style={{
              marginLeft: "auto",
              background: "#333",
              color: "#ccc",
              border: "1px solid #555",
              borderRadius: 3,
              padding: "2px 6px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {status === "loading" ? "…" : "⟳"}
          </button>
        </div>

        {!sessionId && (
          <div style={{ padding: 12, color: "#555", fontSize: 12 }}>
            No session active.
          </div>
        )}

        {status === "error" && (
          <div style={{ padding: 10, color: "#f44", fontSize: 11 }}>
            {errorMsg}
            <br />
            <span style={{ color: "#888" }}>Start a session to enable rewind tree.</span>
          </div>
        )}

        {treeData && (
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 6 }}>
              {allBranchIds.length} branch{allBranchIds.length !== 1 ? "es" : ""}
              {" · "}ring {treeData.ringSize}
            </div>
            <SnapshotTreeView
              branches={treeData.branches}
              rootBranchId={treeData.rootBranchId}
              selectedBranchId={selectedBranchId}
              onSelect={setSelectedBranchId}
            />
          </div>
        )}

        {!treeData && status === "idle" && sessionId && (
          <div style={{ padding: 12, color: "#555", fontSize: 12 }}>
            No tree loaded. Click ⟳ to fetch.
          </div>
        )}

        {/* Legend */}
        <div style={{ padding: "6px 10px", borderTop: "1px solid #2a2a2a", display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            { color: "#4caf50", label: "leaf" },
            { color: "#888", label: "internal" },
            { color: "#f5c400", label: "current" },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#666" }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color }} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Right: detail ~70% */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <SnapshotDetail
          branch={selectedBranch ?? null}
          branchId={selectedBranchId}
          rootBranchId={treeData?.rootBranchId ?? ""}
          allBranchIds={allBranchIds}
          sessionId={sessionId}
          onRestore={handleRestore}
          onPromote={handlePromote}
          onPin={handlePin}
          onDiff={handleDiff}
        />

        {diffResult && (
          <div style={{
            margin: "0 12px 12px",
            padding: 10,
            background: "rgba(255,255,255,0.04)",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            color: "#ccc",
          }}>
            <div style={{ color: "#888", marginBottom: 4 }}>Diff result</div>
            {diffResult}
            <button
              onClick={() => setDiffResult(null)}
              style={{
                display: "block",
                marginTop: 6,
                background: "transparent",
                border: "none",
                color: "#666",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
