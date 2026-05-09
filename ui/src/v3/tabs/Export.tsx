// Spec 269 — Export tab: PNG / MP4 / WAV export for a scenario.

import React, { useState, useEffect, useCallback } from "react";
import type { TabProps } from "./Live.types.js";
import { getClient } from "../ws-client.js";

interface ScenarioSummary {
  id: string;
  diskPath: string;
  mode: string;
  cycleBudget: number;
  inputCount: number;
  savedAt: string;
  filePath: string;
  source: "samples" | "project";
}

type ExportFormat = "png" | "mp4" | "wav";

interface ExportState {
  scenarioId: string;
  format: ExportFormat;
  outPath: string;
  duration: string;   // number as string for input binding
  scale: 1 | 2 | 4;
  atCycle: string;    // for PNG; empty = full budget
}

type JobState = "idle" | "running" | "done" | "error";

interface ExportJobResult {
  out_path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  frames?: number;
  duration_sec?: number;
  sample_rate?: number;
  samples?: number;
}

export function ExportTab({ sessionId }: TabProps): JSX.Element {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [loadingScenarios, setLoadingScenarios] = useState(false);
  const [form, setForm] = useState<ExportState>({
    scenarioId: "",
    format: "png",
    outPath: "/tmp/c64re-export/frame.png",
    duration: "5",
    scale: 1,
    atCycle: "",
  });
  const [jobState, setJobState] = useState<JobState>("idle");
  const [result, setResult] = useState<ExportJobResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const client = getClient();

  // Load scenario list on mount.
  useEffect(() => {
    setLoadingScenarios(true);
    client
      .call<ScenarioSummary[]>("runtime/scenario_list")
      .then((list) => {
        setScenarios(list);
        if (list.length > 0 && !form.scenarioId) {
          setForm((f) => ({ ...f, scenarioId: list[0]!.id }));
        }
      })
      .catch(() => {
        // Ignore if no server.
      })
      .finally(() => setLoadingScenarios(false));
  }, []);

  // Update out_path extension when format changes.
  const handleFormatChange = useCallback((fmt: ExportFormat) => {
    const ext = fmt === "png" ? ".png" : fmt === "mp4" ? ".mp4" : ".wav";
    const base = form.outPath.replace(/\.(png|mp4|wav)$/, "");
    setForm((f) => ({ ...f, format: fmt, outPath: base + ext }));
  }, [form.outPath]);

  const handleStart = useCallback(async () => {
    if (!form.scenarioId) { setErrorMsg("Select a scenario first."); return; }
    if (!form.outPath.trim()) { setErrorMsg("Enter an output path."); return; }
    setJobState("running");
    setResult(null);
    setErrorMsg("");
    try {
      let res: ExportJobResult;
      if (form.format === "png") {
        res = await client.call<ExportJobResult>("runtime/export_screenshot", {
          scenario_id: form.scenarioId,
          out_path: form.outPath.trim(),
          scale: form.scale,
          at_cycle: form.atCycle ? parseInt(form.atCycle, 10) : undefined,
        });
      } else if (form.format === "mp4") {
        res = await client.call<ExportJobResult>("runtime/export_video", {
          scenario_id: form.scenarioId,
          out_path: form.outPath.trim(),
          duration: parseFloat(form.duration) || 5,
          scale: form.scale,
        });
      } else {
        res = await client.call<ExportJobResult>("runtime/export_audio", {
          scenario_id: form.scenarioId,
          out_path: form.outPath.trim(),
          duration: parseFloat(form.duration) || 5,
          format: "wav",
        });
      }
      setResult(res);
      setJobState("done");
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setJobState("error");
    }
  }, [form, client]);

  const isRunning = jobState === "running";

  return (
    <div style={{ padding: "16px", maxWidth: 640, fontFamily: "monospace" }}>
      <h2 style={{ margin: "0 0 16px" }}>Export</h2>

      {/* Scenario picker */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", marginBottom: 4 }}>Scenario</label>
        <select
          disabled={isRunning}
          value={form.scenarioId}
          onChange={(e) => setForm((f) => ({ ...f, scenarioId: e.target.value }))}
          style={{ width: "100%", padding: "4px 8px" }}
        >
          {loadingScenarios && <option value="">Loading…</option>}
          {!loadingScenarios && scenarios.length === 0 && <option value="">No scenarios found</option>}
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} ({s.mode}, {(s.cycleBudget / 985248).toFixed(1)}s) [{s.source}]
            </option>
          ))}
        </select>
      </div>

      {/* Format selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", marginBottom: 4 }}>Format</label>
        <div style={{ display: "flex", gap: 12 }}>
          {(["png", "mp4", "wav"] as ExportFormat[]).map((fmt) => (
            <label key={fmt} style={{ cursor: "pointer" }}>
              <input
                type="radio"
                name="format"
                value={fmt}
                checked={form.format === fmt}
                disabled={isRunning}
                onChange={() => handleFormatChange(fmt)}
              />{" "}
              {fmt.toUpperCase()}
            </label>
          ))}
        </div>
      </div>

      {/* Duration (video/audio only) */}
      {form.format !== "png" && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", marginBottom: 4 }}>Duration (seconds)</label>
          <input
            type="number"
            min={1}
            max={300}
            step={1}
            disabled={isRunning}
            value={form.duration}
            onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
            style={{ width: 100, padding: "4px 8px" }}
          />
        </div>
      )}

      {/* Scale slider (PNG / video only) */}
      {form.format !== "wav" && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", marginBottom: 4 }}>Scale: {form.scale}x</label>
          <input
            type="range"
            min={0}
            max={2}
            step={1}
            disabled={isRunning}
            value={form.scale === 1 ? 0 : form.scale === 2 ? 1 : 2}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              const s = v === 0 ? 1 : v === 1 ? 2 : 4;
              setForm((f) => ({ ...f, scale: s as 1 | 2 | 4 }));
            }}
          />
          <span style={{ marginLeft: 8 }}>1x / 2x / 4x</span>
        </div>
      )}

      {/* At-cycle (PNG only) */}
      {form.format === "png" && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", marginBottom: 4 }}>At cycle (optional — empty = run full budget)</label>
          <input
            type="number"
            min={0}
            disabled={isRunning}
            value={form.atCycle}
            onChange={(e) => setForm((f) => ({ ...f, atCycle: e.target.value }))}
            placeholder="e.g. 985248"
            style={{ width: 160, padding: "4px 8px" }}
          />
        </div>
      )}

      {/* Output path */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 4 }}>Output path</label>
        <input
          type="text"
          disabled={isRunning}
          value={form.outPath}
          onChange={(e) => setForm((f) => ({ ...f, outPath: e.target.value }))}
          style={{ width: "100%", padding: "4px 8px", boxSizing: "border-box" }}
        />
      </div>

      {/* Start button */}
      <button
        onClick={handleStart}
        disabled={isRunning || !form.scenarioId}
        style={{
          padding: "8px 24px",
          background: isRunning ? "#555" : "#336",
          color: "#fff",
          border: "none",
          cursor: isRunning ? "wait" : "pointer",
          fontFamily: "monospace",
        }}
      >
        {isRunning ? "Exporting…" : `Export ${form.format.toUpperCase()}`}
      </button>

      {/* Status / result */}
      {jobState === "running" && (
        <div style={{ marginTop: 12, color: "#aaa" }}>Running…</div>
      )}
      {jobState === "done" && result && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#1a2a1a",
            border: "1px solid #3a6a3a",
            borderRadius: 4,
          }}
        >
          <div style={{ color: "#7f7", marginBottom: 6 }}>Export complete</div>
          <div>Path: <strong>{result.out_path}</strong></div>
          {result.bytes !== undefined && (
            <div>Size: {(result.bytes / 1024).toFixed(1)} KB</div>
          )}
          {result.width !== undefined && result.height !== undefined && (
            <div>Dimensions: {result.width}×{result.height}</div>
          )}
          {result.frames !== undefined && (
            <div>Frames: {result.frames} ({result.duration_sec?.toFixed(1)}s)</div>
          )}
          {result.samples !== undefined && (
            <div>Samples: {result.samples?.toLocaleString()} @ {result.sample_rate} Hz</div>
          )}
        </div>
      )}
      {jobState === "error" && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#2a1a1a",
            border: "1px solid #6a3a3a",
            borderRadius: 4,
            color: "#f77",
          }}
        >
          {errorMsg}
        </div>
      )}
    </div>
  );
}
