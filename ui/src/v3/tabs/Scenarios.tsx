// Spec 268 + 271 — Scenario editor tab + parallel batch runner.
//
// Left: scenario list with filter + sort.
// Right: selected scenario detail + input timeline editor.
// Top-right: "Batch run" button → modal.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TabProps } from "./Live.types.js";
import { getClient } from "../ws-client.js";
import { ScenarioList, type ScenarioSummary } from "../components/ScenarioList.js";
import { ScenarioInputTimeline, type ScenarioInputEvent } from "../components/ScenarioInputTimeline.js";

// ---------------------------------------------------------------------------
// Batch run types (Spec 271)
// ---------------------------------------------------------------------------

interface BatchStatus {
  batchId: string;
  status: "running" | "done" | "error";
  completed: number;
  total: number;
  workerCount: number;
  startedAt: string;
  finishedAt?: string;
  lastError?: string;
}

interface BatchResultEntry {
  error?: string;
  endSnapshotHash?: string;
  ramHash?: string;
  screenshotHash?: string;
  traceHash?: string;
  cyclesRan?: number;
}

// ---------------------------------------------------------------------------
// BatchRunModal
// ---------------------------------------------------------------------------

interface BatchRunModalProps {
  scenarios: ScenarioSummary[];
  onClose: () => void;
}

function BatchRunModal({ scenarios, onClose }: BatchRunModalProps): JSX.Element {
  const client = getClient();

  const maxWorkers = Math.max(1, navigator.hardwareConcurrency - 1 || 3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [workerCount, setWorkerCount] = useState(Math.min(maxWorkers, 3));
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [results, setResults] = useState<Record<string, BatchResultEntry> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for batch/progress notifications.
  useEffect(() => {
    const unsub = client.onNotification("batch/progress", (params: any) => {
      setBatchStatus(prev => {
        if (!prev || params.batchId !== prev.batchId) return prev;
        return { ...prev, completed: params.completed ?? prev.completed, status: params.status ?? prev.status };
      });
    });
    return unsub;
  }, [client]);

  // Poll when running (fallback if WS notifications unavailable).
  useEffect(() => {
    if (!batchStatus || batchStatus.status !== "running") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const s = await client.call<BatchStatus>("batch/status", { batchId: batchStatus.batchId });
        setBatchStatus(s);
        if (s.status !== "running") {
          clearInterval(pollRef.current!);
          if (s.status === "done") fetchResults(s.batchId);
        }
      } catch {}
    }, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [batchStatus?.status]);

  async function fetchResults(batchId: string): Promise<void> {
    try {
      const r = await client.call<{ batch: BatchStatus; results: Record<string, BatchResultEntry> }>(
        "batch/results", { batchId }
      );
      setResults(r.results);
      setBatchStatus(r.batch);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const toggleAll = (): void => {
    if (selected.size === scenarios.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(scenarios.map(s => s.id)));
    }
  };

  const toggle = (id: string): void => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleStart = async (): Promise<void> => {
    if (selected.size === 0) return;
    setErr(null);
    setResults(null);
    try {
      const status = await client.call<BatchStatus>("batch/start", {
        scenarioIds: [...selected],
        workerCount,
      });
      setBatchStatus(status);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const progress = batchStatus
    ? Math.round((batchStatus.completed / Math.max(1, batchStatus.total)) * 100)
    : 0;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: "#1a1a1a", border: "1px solid #444", borderRadius: 6,
        width: 560, maxHeight: "80vh", display: "flex", flexDirection: "column",
        padding: 20, fontFamily: "monospace", color: "#ccc",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>Batch run scenarios</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>

        {/* Scenario multi-select */}
        {!batchStatus && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <button
                onClick={toggleAll}
                style={{ background: "#333", border: "1px solid #555", color: "#ccc", borderRadius: 3, padding: "3px 8px", fontSize: 12, cursor: "pointer" }}
              >
                {selected.size === scenarios.length ? "Deselect all" : "Select all"}
              </button>
              <span style={{ fontSize: 12, color: "#666" }}>{selected.size}/{scenarios.length} selected</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", maxHeight: 200, border: "1px solid #2a2a2a", borderRadius: 3, marginBottom: 12 }}>
              {scenarios.map(s => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", cursor: "pointer", borderBottom: "1px solid #1e1e1e" }}>
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                  <span style={{ fontSize: 12 }}>{s.id}</span>
                  <span style={{ fontSize: 11, color: "#666", marginLeft: "auto" }}>{s.mode}</span>
                </label>
              ))}
            </div>

            {/* Worker count slider */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, fontSize: 12 }}>
              <span style={{ color: "#888", minWidth: 90 }}>Worker count:</span>
              <input
                type="range" min={1} max={maxWorkers} value={workerCount}
                onChange={e => setWorkerCount(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ minWidth: 20, textAlign: "right" }}>{workerCount}</span>
            </div>

            <button
              onClick={handleStart}
              disabled={selected.size === 0}
              style={{
                background: selected.size === 0 ? "#333" : "#2a6",
                color: "#fff", border: "none", borderRadius: 4,
                padding: "7px 16px", cursor: selected.size === 0 ? "not-allowed" : "pointer",
                fontSize: 13, alignSelf: "flex-start",
              }}
            >
              Start batch ({selected.size} scenarios)
            </button>
          </>
        )}

        {/* Progress bar */}
        {batchStatus && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>
              {batchStatus.status === "running" ? `Running… ${batchStatus.completed}/${batchStatus.total}` :
               batchStatus.status === "done" ? `Done — ${batchStatus.total} scenarios` :
               `Error: ${batchStatus.lastError}`}
            </div>
            <div style={{ height: 8, background: "#2a2a2a", borderRadius: 4, overflow: "hidden" }}>
              <div style={{
                width: `${progress}%`, height: "100%",
                background: batchStatus.status === "error" ? "#c33" : batchStatus.status === "done" ? "#4caf50" : "#2a6",
                transition: "width 0.3s",
              }} />
            </div>
          </div>
        )}

        {/* Results table */}
        {results && (
          <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#666", borderBottom: "1px solid #2a2a2a" }}>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>Scenario</th>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>Status</th>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>Cycles</th>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>ramHash</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(results).map(([id, r]) => (
                  <tr key={id} style={{ borderBottom: "1px solid #1e1e1e" }}>
                    <td style={{ padding: "3px 6px", color: "#ccc" }}>{id}</td>
                    <td style={{ padding: "3px 6px", color: r.error ? "#f44" : "#4caf50" }}>
                      {r.error ? "error" : "ok"}
                    </td>
                    <td style={{ padding: "3px 6px", color: "#888" }}>{r.cyclesRan?.toLocaleString() ?? "-"}</td>
                    <td style={{ padding: "3px 6px", color: "#666", fontFamily: "monospace" }}>
                      {r.error ? r.error.slice(0, 30) : (r.ramHash?.slice(0, 12) ?? "-")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {err && (
          <div style={{ color: "#f44", fontSize: 12, marginTop: 8 }}>{err}</div>
        )}
      </div>
    </div>
  );
}

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
  const [showBatch, setShowBatch] = useState(false);

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
    <div style={{ display: "flex", height: "100%", fontFamily: "monospace", flexDirection: "column" }}>
      {/* Batch run modal */}
      {showBatch && (
        <BatchRunModal scenarios={summaries} onClose={() => setShowBatch(false)} />
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Left: scenario list ~30% */}
      <div style={{ width: "30%", minWidth: 200, borderRight: "1px solid #2a2a2a", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a2a" }}>
          <button
            onClick={() => setShowBatch(true)}
            style={{
              background: "#1a4a8a", color: "#fff", border: "1px solid #2a6aaa",
              borderRadius: 3, padding: "3px 10px", fontSize: 12, cursor: "pointer", width: "100%",
            }}
            title="Run multiple scenarios in parallel"
          >
            Batch run…
          </button>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
        <ScenarioList
          scenarios={summaries}
          selectedId={selectedId}
          onSelect={handleSelect}
          onRefresh={loadList}
          loading={loading}
        />
        </div>
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
