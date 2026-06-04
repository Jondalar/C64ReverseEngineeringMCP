// Spec 268 — Recursive snapshot branch tree.
//
// Renders a SnapshotBranch tree as indented HTML/CSS nodes.
// Colors: leaf=green, internal=gray, current=yellow.

import React from "react";

export interface SnapshotBranch {
  id: string;
  parentId?: string;
  rootId?: string;
  atCycle: number;
  patches: Array<{ kind: string; addr?: number; value?: number; reg?: string; bytes?: number[] }>;
  startSnapshotId: string;
  endCycle?: number;
  endSnapshotId?: string;
  resultHash?: string;
  children: string[];
}

export interface SnapshotTreeViewProps {
  branches: Record<string, SnapshotBranch>;
  rootBranchId: string;
  selectedBranchId: string | null;
  currentBranchId?: string;
  onSelect: (id: string) => void;
  depth?: number;
}

function patchLabel(patch: SnapshotBranch["patches"][number]): string {
  switch (patch.kind) {
    case "mem_byte": return `mem $${(patch.addr ?? 0).toString(16).toUpperCase().padStart(4, "0")}=$${(patch.value ?? 0).toString(16).padStart(2, "0")}`;
    case "mem_range": return `mem_range $${(patch.addr ?? 0).toString(16).toUpperCase().padStart(4, "0")}+${(patch.bytes?.length ?? 0)}B`;
    case "register": return `${patch.reg}=$${(patch.value ?? 0).toString(16).padStart(2, "0")}`;
    case "io_register": return `io $${(patch.addr ?? 0).toString(16).toUpperCase().padStart(4, "0")}=$${(patch.value ?? 0).toString(16).padStart(2, "0")}`;
    default: return patch.kind;
  }
}

function nodeLabel(branch: SnapshotBranch, isRoot: boolean): string {
  if (isRoot) return "root";
  if (branch.patches.length > 0) {
    return branch.patches.map(patchLabel).join(", ");
  }
  const cycles = branch.endCycle !== undefined && branch.atCycle !== undefined
    ? branch.endCycle - branch.atCycle : 0;
  return `run ${cycles.toLocaleString()}cy`;
}

export function SnapshotTreeView(props: SnapshotTreeViewProps): React.JSX.Element {
  const { branches, rootBranchId, selectedBranchId, currentBranchId, onSelect, depth = 0 } = props;
  const branch = branches[rootBranchId];
  if (!branch) return <></>;

  const isLeaf = branch.children.length === 0;
  const isCurrent = currentBranchId === rootBranchId;
  const isSelected = selectedBranchId === rootBranchId;
  const isRoot = depth === 0;

  let nodeColor = "#888"; // internal = gray
  if (isLeaf) nodeColor = "#4caf50"; // leaf = green
  if (isCurrent) nodeColor = "#f5c400"; // current = yellow

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          padding: "2px 6px",
          borderRadius: 4,
          backgroundColor: isSelected ? "rgba(255,255,255,0.08)" : "transparent",
          marginBottom: 2,
        }}
        onClick={() => onSelect(rootBranchId)}
        title={`Branch ${rootBranchId.slice(0, 8)} — cycle ${branch.atCycle}`}
      >
        <span style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: "50%",
          backgroundColor: nodeColor,
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 12,
          color: isSelected ? "#fff" : "#ccc",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 200,
        }}>
          {nodeLabel(branch, isRoot)}
        </span>
        {!isLeaf && (
          <span style={{ fontSize: 11, color: "#666", marginLeft: "auto", flexShrink: 0 }}>
            {branch.children.length}
          </span>
        )}
      </div>
      {branch.children.map(childId => (
        <SnapshotTreeView
          key={childId}
          branches={branches}
          rootBranchId={childId}
          selectedBranchId={selectedBranchId}
          currentBranchId={currentBranchId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
