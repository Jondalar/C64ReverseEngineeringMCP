import type { WorkspaceUiSnapshot } from "../types";

// Renders boot-trace FlowRecords (kind === "boot-trace") that are linked
// to the given medium artifact via artifactIds. The boot-trace concept is
// medium-agnostic: each step is a node with optional artifactId/entityId
// the UI can resolve to a hex view or selection. Flows are produced by
// the LLM (or future analyzer) via the existing save_flow MCP tool.

interface BootTracePanelProps {
  snapshot: WorkspaceUiSnapshot;
  mediumArtifactId: string;
  onSelectArtifact?: (artifactId: string) => void;
  onSelectEntity?: (entityId: string) => void;
}

export function BootTracePanel({ snapshot, mediumArtifactId, onSelectArtifact, onSelectEntity }: BootTracePanelProps) {
  const flows = snapshot.flows.filter(
    (flow) => flow.kind === "boot-trace" && flow.artifactIds.includes(mediumArtifactId),
  );
  if (flows.length === 0) return null;

  return (
    <div className="boot-trace-panel">
      {flows.map((flow) => {
        const stepCount = flow.nodes.length;
        return (
          <div key={flow.id} className="boot-trace-card">
            <div className="boot-trace-headline">
              <strong>Boot trace</strong>
              <span>{flow.title}</span>
              <span className="boot-trace-count">{stepCount} steps</span>
            </div>
            {flow.summary ? <p className="boot-trace-summary">{flow.summary}</p> : null}
            <ol className="boot-trace-steps">
              {flow.nodes.map((node, index) => (
                <li key={node.id}>
                  <span className="boot-trace-index">{index + 1}.</span>
                  <span className="boot-trace-step-title">{node.title}</span>
                  {node.addressRange ? (
                    <span className="boot-trace-step-addr">
                      ${node.addressRange.start.toString(16).toUpperCase().padStart(4, "0")}
                      {node.addressRange.bank !== undefined ? ` · bank ${node.addressRange.bank}` : ""}
                    </span>
                  ) : null}
                  {node.artifactId && onSelectArtifact ? (
                    <button
                      type="button"
                      className="mon-icon-button boot-trace-jump"
                      onClick={() => onSelectArtifact(node.artifactId!)}
                      title="Open artifact"
                    >
                      open
                    </button>
                  ) : node.entityId && onSelectEntity ? (
                    <button
                      type="button"
                      className="mon-icon-button boot-trace-jump"
                      onClick={() => onSelectEntity(node.entityId!)}
                      title="Select entity"
                    >
                      select
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
