// Spec 268 — Scenario list panel with filter + sort.

import React, { useState, useMemo } from "react";

export interface ScenarioSummary {
  id: string;
  diskPath: string;
  mode: string;
  cycleBudget: number;
  inputCount: number;
  savedAt: string;
  filePath: string;
  source: "samples" | "project";
}

export interface ScenarioListProps {
  scenarios: ScenarioSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  loading: boolean;
}

export function ScenarioList(props: ScenarioListProps): React.JSX.Element {
  const { scenarios, selectedId, onSelect, onRefresh, loading } = props;
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<"date" | "name">("date");

  const filtered = useMemo(() => {
    let list = scenarios;
    if (filter.trim()) {
      const q = filter.toLowerCase();
      list = list.filter(s => s.id.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (sortKey === "date") return b.savedAt.localeCompare(a.savedAt);
      return a.id.localeCompare(b.id);
    });
  }, [scenarios, filter, sortKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 8px 4px", display: "flex", gap: 6, alignItems: "center" }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          style={{
            flex: 1,
            background: "#1a1a1a",
            color: "#ccc",
            border: "1px solid #444",
            borderRadius: 3,
            padding: "3px 6px",
            fontSize: 12,
          }}
        />
        <select
          value={sortKey}
          onChange={e => setSortKey(e.target.value as "date" | "name")}
          style={{
            background: "#1a1a1a",
            color: "#ccc",
            border: "1px solid #444",
            borderRadius: 3,
            padding: "3px 4px",
            fontSize: 12,
          }}
        >
          <option value="date">By date</option>
          <option value="name">By name</option>
        </select>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            background: "#333",
            color: "#ccc",
            border: "1px solid #555",
            borderRadius: 3,
            padding: "3px 7px",
            fontSize: 12,
            cursor: "pointer",
          }}
          title="Refresh scenario list"
        >
          {loading ? "…" : "⟳"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {filtered.length === 0 && (
          <div style={{ padding: 12, color: "#555", fontSize: 12 }}>
            {loading ? "Loading…" : scenarios.length === 0 ? "No scenarios found." : "No matches."}
          </div>
        )}
        {filtered.map(s => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              padding: "6px 10px",
              cursor: "pointer",
              background: selectedId === s.id ? "rgba(255,255,255,0.08)" : "transparent",
              borderBottom: "1px solid #1e1e1e",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                fontSize: 10,
                color: s.source === "project" ? "#4caf50" : "#888",
                fontFamily: "monospace",
              }}>
                {s.source === "project" ? "P" : "S"}
              </span>
              <span style={{
                fontSize: 13,
                color: selectedId === s.id ? "#fff" : "#ccc",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {s.id}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
              {s.mode} · {s.cycleBudget.toLocaleString()}cy · {s.inputCount} inputs
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
