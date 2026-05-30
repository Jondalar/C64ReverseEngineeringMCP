// Spec 268 — Scenario input timeline editor.
//
// Shows input events in cycle order. Add/delete supported.
// Drag-to-retime is V3.1 (placeholder noted).

import React, { useState } from "react";

export interface ScenarioInputEvent {
  atCycle: number;
  kind: "keyboard" | "joystick1" | "joystick2";
  payload: unknown;
}

export interface ScenarioInputTimelineProps {
  inputs: ScenarioInputEvent[];
  onChange: (inputs: ScenarioInputEvent[]) => void;
  readonly?: boolean;
}

const KIND_LABELS: Record<string, string> = {
  keyboard: "KBD",
  joystick1: "JOY1",
  joystick2: "JOY2",
};

export function ScenarioInputTimeline(props: ScenarioInputTimelineProps): React.JSX.Element {
  const { inputs, onChange, readonly } = props;
  const [addKind, setAddKind] = useState<"keyboard" | "joystick1" | "joystick2">("keyboard");
  const [addCycle, setAddCycle] = useState("");
  const [addPayload, setAddPayload] = useState("");

  const sorted = [...inputs].sort((a, b) => a.atCycle - b.atCycle);

  function handleDelete(idx: number): void {
    const updated = [...inputs];
    updated.splice(idx, 1);
    onChange(updated);
  }

  function handleAdd(): void {
    const cycle = parseInt(addCycle, 10);
    if (!Number.isFinite(cycle) || cycle < 0) return;
    let payload: unknown = addPayload;
    if (addKind.startsWith("joystick")) {
      try { payload = JSON.parse(addPayload); } catch { payload = {}; }
    }
    const updated = [...inputs, { atCycle: cycle, kind: addKind, payload }];
    onChange(updated);
    setAddCycle("");
    setAddPayload("");
  }

  return (
    <div style={{ fontSize: 12 }}>
      {sorted.length === 0 && (
        <div style={{ color: "#555", padding: "4px 0", marginBottom: 8 }}>
          No inputs defined.
        </div>
      )}

      {sorted.map((ev, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "3px 0",
            borderBottom: "1px solid #1e1e1e",
          }}
        >
          <span style={{
            width: 3,
            height: 18,
            background: ev.kind === "keyboard" ? "#4caf50" : ev.kind === "joystick1" ? "#2196f3" : "#ff9800",
            borderRadius: 2,
            flexShrink: 0,
          }} />
          <span style={{ fontFamily: "monospace", color: "#888", width: 80, flexShrink: 0 }}>
            @{ev.atCycle.toLocaleString()}
          </span>
          <span style={{ color: "#aaa", width: 36, flexShrink: 0 }}>
            {KIND_LABELS[ev.kind] ?? ev.kind}
          </span>
          <span style={{
            fontFamily: "monospace",
            color: "#ccc",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload)}
          </span>
          {!readonly && (
            <button
              onClick={() => handleDelete(i)}
              style={{
                background: "transparent",
                border: "none",
                color: "#f44",
                cursor: "pointer",
                fontSize: 13,
                padding: "0 4px",
              }}
              title="Delete input"
            >
              ×
            </button>
          )}
        </div>
      ))}

      {!readonly && (
        <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={addKind}
            onChange={e => setAddKind(e.target.value as any)}
            style={inputStyle()}
          >
            <option value="keyboard">keyboard</option>
            <option value="joystick1">joystick1</option>
            <option value="joystick2">joystick2</option>
          </select>
          <input
            value={addCycle}
            onChange={e => setAddCycle(e.target.value)}
            placeholder="@cycle"
            style={{ ...inputStyle(), width: 90 }}
            type="number"
            min={0}
          />
          <input
            value={addPayload}
            onChange={e => setAddPayload(e.target.value)}
            placeholder={addKind === "keyboard" ? "text to type" : '{"fire":true}'}
            style={{ ...inputStyle(), flex: 1, minWidth: 100 }}
          />
          <button
            onClick={handleAdd}
            disabled={!addCycle}
            style={{
              background: "#2a6",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Add
          </button>
          <span style={{ color: "#555", fontSize: 11 }}>
            (drag-to-retime: V3.1)
          </span>
        </div>
      )}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    background: "#1a1a1a",
    color: "#ccc",
    border: "1px solid #444",
    borderRadius: 3,
    padding: "3px 5px",
    fontSize: 12,
  };
}
