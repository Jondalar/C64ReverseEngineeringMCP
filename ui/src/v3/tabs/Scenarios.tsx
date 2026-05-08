// Spec 268 — Scenario editor tab.
//
// Left: scenario list with filter + sort.
// Right: selected scenario detail + input timeline editor.

import React, { useState, useEffect, useCallback } from "react";
import type { TabProps } from "./Live.js";
import { getClient } from "../ws-client.js";
import { ScenarioList, type ScenarioSummary } from "../components/ScenarioList.js";
import { ScenarioInputTimeline, type ScenarioInputEvent } from "../components/ScenarioInputTimeline.js";

interface FullScenario {
  id: string;
  diskPath: string;
  mode: "fast-trap" | "real-kernal" | "true-drive";
  cycleBudget: number;
  inputs: ScenarioInputEvent[];
  startSnapshot?: string;
  savedAt?: string;
}

export function ScenariosTab({ sessionId }: TabProps): JSX.Element {
  const [summaries, setSummaries] = useState<ScenarioSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<FullScenario | null>(null);
  const [edited, setEdited] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const client = getClient();

  const loadList = useCallback(async () => {
    setLoading(true);
    setStatusMsg(null);
    try {
      const list = await client.call<ScenarioSummary[]>("runtime/scenario_list");
      setSummaries(list);
    } catch (e: any) {
      setStatusMsg({ type: "err", text: e?.message ?? String(e) });
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { loadList(); }, []);

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id);
    setEdited(false);
    setStatusMsg(null);
    try {
      const data = await client.call<FullScenario>("runtime/call", {
        session_id: sessionId || "__none__",
        op: "status",
        args: [],
      }).catch(() => null); // ignore if no session
      // Load scenario via direct WS call (not runtime/call which needs session).
      // We call runtime/scenario_list to find the filePath then re-use it via load.
      // Actually use the runtime/call-based scenario load from the server-side.
      // Since the WS server exposes scenario_list (not scenario_load directly), we
      // need to add runtime/scenario_load or use the MCP tool indirectly.
      // For now, reconstruct from summaries + full load via a custom call.
      // The server registers "runtime/call" → op mapping, which uses AgentQueryApi.
      // Instead, call MCP tool "runtime_scenario_load" via ws doesn't apply here.
      // Use the list result to show detail from summaries, and load full via a
      // workaround: client.call("runtime/scenario_load_ws", {id}) if we add it.
      // Simplest: re-expose scenario load via "runtime/scenario_load" WS handler.
      // We'll add that below via a direct client.call with the method we added.
      const full = await client.call<FullScenario>("runtime/scenario_load", { id });
      setScenario(full);
    } catch (e: any) {
      setStatusMsg({ type: "err", text: `Load error: ${e?.message}` });
    }
  }, [client, sessionId]);

  // Keep edited scenario in sync when user changes inputs.
  const handleInputsChange = useCallback((inputs: ScenarioInputEvent[]) => {
    setScenario(prev => prev ? { ...prev, inputs } : prev);
    setEdited(true);
  }, []);

  const handleFieldChange = useCallback(<K extends keyof FullScenario>(key: K, value: FullScenario[K]) => {
    setScenario(prev => prev ? { ...prev, [key]: value } : prev);
    setEdited(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!scenario) return;
    try {
      await client.call("runtime/scenario_save", { scenario });
      setEdited(false);
      setStatusMsg({ type: "ok", text: "Saved." });
      await loadList();
    } catch (e: any) {
      setStatusMsg({ type: "err", text: `Save failed: ${e?.message}` });
    }
  }, [scenario, client, loadList]);

  const handleReplay = useCallback(async () => {
    if (!scenario) return;
    setStatusMsg({ type: "ok", text: "Replaying…" });
    try {
      const result = await client.call("runtime/scenario_run", { id: scenario.id });
      setStatusMsg({ type: "ok", text: `Replay done: ramHash=${(result as any)?.ramHash?.slice(0, 12) ?? "?"}` });
    } catch (e: any) {
      setStatusMsg({ type: "err", text: `Replay failed: ${e?.message}` });
    }
  }, [scenario, client]);

  const handleFork = useCallback(async () => {
    if (!scenario) return;
    const newId = `${scenario.id}-fork-${Date.now().toString(36)}`;
    const forked: FullScenario = { ...scenario, id: newId };
    try {
      await client.call("runtime/scenario_save", { scenario: forked });
      setStatusMsg({ type: "ok", text: `Forked as ${newId}` });
      await loadList();
      handleSelect(newId);
    } catch (e: any) {
      setStatusMsg({ type: "err", text: `Fork failed: ${e?.message}` });
    }
  }, [scenario, client, loadList, handleSelect]);

  const handleDelete = useCallback(async () => {
    if (!scenario) return;
    if (!confirm(`Delete scenario "${scenario.id}"?`)) return;
    try {
      await client.call("runtime/scenario_delete", { id: scenario.id });
      setScenario(null);
      setSelectedId(null);
      setStatusMsg({ type: "ok", text: "Deleted." });
      await loadList();
    } catch (e: any) {
      setStatusMsg({ type: "err", text: `Delete failed: ${e?.message}` });
    }
  }, [scenario, client, loadList]);

  const handleCompare = useCallback(() => {
    // V3.1: compare-two-scenarios visual diff placeholder.
    alert("Compare-two-scenarios visual diff is a V3.1 feature.");
  }, []);

  return (
    <div style={{ display: "flex", height: "100%", fontFamily: "monospace" }}>
      {/* Left: scenario list ~30% */}
      <div style={{ width: "30%", minWidth: 200, borderRight: "1px solid #2a2a2a" }}>
        <ScenarioList
          scenarios={summaries}
          selectedId={selectedId}
          onSelect={handleSelect}
          onRefresh={loadList}
          loading={loading}
        />
      </div>

      {/* Right: scenario detail ~70% */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        {!scenario && (
          <div style={{ padding: 16, color: "#555", fontSize: 13 }}>
            {loading ? "Loading…" : "Select a scenario to edit."}
          </div>
        )}

        {statusMsg && (
          <div style={{
            padding: "6px 12px",
            background: statusMsg.type === "ok" ? "rgba(76,175,80,0.15)" : "rgba(244,67,54,0.15)",
            color: statusMsg.type === "ok" ? "#4caf50" : "#f44336",
            fontSize: 12,
            borderBottom: "1px solid #2a2a2a",
            display: "flex",
            justifyContent: "space-between",
          }}>
            <span>{statusMsg.text}</span>
            <button
              onClick={() => setStatusMsg(null)}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 12 }}
            >
              ×
            </button>
          </div>
        )}

        {scenario && (
          <div style={{ padding: 14, flex: 1 }}>
            <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{scenario.id}</span>
              {edited && (
                <span style={{ fontSize: 11, color: "#f5c400" }}>● unsaved</span>
              )}
              {scenario.savedAt && (
                <span style={{ fontSize: 11, color: "#555", marginLeft: "auto" }}>
                  {scenario.savedAt.slice(0, 10)}
                </span>
              )}
            </div>

            {/* Meta fields */}
            <table style={{ borderCollapse: "collapse", marginBottom: 14, fontSize: 12, width: "100%" }}>
              <tbody>
                <MetaRow label="diskPath">
                  <input
                    value={scenario.diskPath}
                    onChange={e => handleFieldChange("diskPath", e.target.value)}
                    style={inputStyle("100%")}
                  />
                </MetaRow>
                <MetaRow label="mode">
                  <select
                    value={scenario.mode}
                    onChange={e => handleFieldChange("mode", e.target.value as any)}
                    style={inputStyle(140)}
                  >
                    <option value="fast-trap">fast-trap</option>
                    <option value="real-kernal">real-kernal</option>
                    <option value="true-drive">true-drive</option>
                  </select>
                </MetaRow>
                <MetaRow label="cycleBudget">
                  <input
                    value={scenario.cycleBudget}
                    type="number"
                    min={0}
                    onChange={e => handleFieldChange("cycleBudget", parseInt(e.target.value, 10) || 0)}
                    style={inputStyle(120)}
                  />
                </MetaRow>
              </tbody>
            </table>

            {/* Input timeline */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>
                Inputs ({scenario.inputs.length})
              </div>
              <ScenarioInputTimeline
                inputs={scenario.inputs}
                onChange={handleInputsChange}
              />
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 8, borderTop: "1px solid #2a2a2a" }}>
              {edited && (
                <button style={actionBtn("#2a6")} onClick={handleSave}>
                  Save
                </button>
              )}
              <button style={actionBtn("#555")} onClick={handleReplay}>
                Replay
              </button>
              <button style={actionBtn("#555")} onClick={handleFork}>
                Fork
              </button>
              <button style={actionBtn("#555")} onClick={handleCompare}>
                Compare to…
              </button>
              <button style={actionBtn("#a33")} onClick={handleDelete}>
                Delete scenario
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <tr>
      <td style={{ color: "#888", paddingRight: 12, paddingBottom: 6, verticalAlign: "middle", whiteSpace: "nowrap" }}>
        {label}
      </td>
      <td style={{ paddingBottom: 6 }}>{children}</td>
    </tr>
  );
}

function inputStyle(width: number | string): React.CSSProperties {
  return {
    background: "#1a1a1a",
    color: "#ccc",
    border: "1px solid #444",
    borderRadius: 3,
    padding: "3px 5px",
    fontSize: 12,
    width: typeof width === "number" ? width : width,
  };
}

function actionBtn(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: 12,
  };
}
