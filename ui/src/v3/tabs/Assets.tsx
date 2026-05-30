// Spec 724B — Assets / Scrub tab (human workbench, migrated from v1).
//   - View graphics candidates + confirm/reject them (reclassify heuristic output).
//   - Free-form "scrub": pick a PRG/CRT, scroll the offset, render any slice as
//     sprite / charset / hires-bitmap / multicolor-bitmap, then SAVE the window
//     as a graphics segment annotation (picked up by the next disasm_prg).
// Reuses the shared C64GraphicsView decoder (../components) + the existing HTTP
// API (no second project logic, project path from the 724A resolver).
import React, { useEffect, useState, useCallback } from "react";
import { api, type WorkspaceSnapshot, type GraphicsItem, type ArtifactItem } from "../rest-client.js";
import { C64GraphicsView, type GraphicsRenderKind } from "../../components/C64GraphicsView.js";

const card: React.CSSProperties = { background: "#161616", borderRadius: 5, padding: 10, marginBottom: 10 };
const hdr: React.CSSProperties = { fontWeight: "bold", color: "#888", fontSize: 11, textTransform: "uppercase", marginBottom: 6 };
const hexW = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

type ScrubKind = "sprite" | "charset" | "bitmap";
const BLOCK_BYTES: Record<ScrubKind, number> = { sprite: 64, charset: 8, bitmap: 320 };

export function AssetsTab(): React.JSX.Element {
  const [snap, setSnap] = useState<WorkspaceSnapshot | null>(null);
  const [candidates, setCandidates] = useState<GraphicsItem[]>([]);
  const [projectDir, setProjectDir] = useState("");
  const [err, setErr] = useState("");

  // scrub state
  const [selectedPath, setSelectedPath] = useState("");
  const [offsetText, setOffsetText] = useState("0000");
  const [windowText, setWindowText] = useState("0400");
  const [kind, setKind] = useState<ScrubKind>("charset");
  const [multicolor, setMulticolor] = useState(false);
  const [columns, setColumns] = useState(32);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loadAddr, setLoadAddr] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [comment, setComment] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  const parseHex = (v: string) => { const c = v.trim().replace(/^\$/, "").replace(/^0x/i, ""); return /^[0-9a-fA-F]+$/.test(c) ? parseInt(c, 16) : 0; };

  const reload = useCallback(() => {
    api.config().then((c) => setProjectDir(c.defaultProjectDir)).catch(() => {});
    api.workspace().then((s) => { setSnap(s); setErr(""); }).catch((e) => setErr(String(e.message ?? e)));
    api.graphics().then((r) => setCandidates(r.items ?? [])).catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  const scrubArtifacts: ArtifactItem[] = (snap?.artifacts ?? [])
    .filter((a) => ["prg", "crt", "raw"].includes(a.kind) && a.role !== "rebuild-check")
    .map((a) => ({ ...a, relativePath: a.relativePath ?? a.path ?? "" }));

  const selected = scrubArtifacts.find((a) => (a.relativePath ?? a.path) === selectedPath);

  // load the slice + the 2-byte PRG load address.
  useEffect(() => {
    if (!selectedPath || !projectDir) { setBytes(null); return; }
    let cancelled = false;
    setLoading(true);
    const off = parseHex(offsetText), len = Math.max(1, parseHex(windowText));
    api.artifactRaw(projectDir, selectedPath, off, len)
      .then((b) => { if (!cancelled) setBytes(b); })
      .catch((e) => { if (!cancelled) { setErr(String((e as Error).message)); setBytes(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedPath, offsetText, windowText, projectDir]);

  useEffect(() => {
    if (!selectedPath || !projectDir) { setLoadAddr(null); return; }
    let cancelled = false;
    api.artifactRaw(projectDir, selectedPath, 0, 2).then((b) => { if (!cancelled && b.length >= 2) setLoadAddr(b[0]! | (b[1]! << 8)); }).catch(() => { if (!cancelled) setLoadAddr(null); });
    return () => { cancelled = true; };
  }, [selectedPath, projectDir]);

  const step = (delta: number) => setOffsetText(hexW(Math.max(0, parseHex(offsetText) + delta)));
  const renderKind: GraphicsRenderKind = kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : (kind as GraphicsRenderKind);

  const saveSegment = useCallback(async () => {
    if (!selected || selected.kind !== "prg") { setSaveStatus("Annotations require a PRG artifact."); return; }
    try {
      setSaveStatus("Saving…");
      const fileOffset = parseHex(offsetText), win = Math.max(1, parseHex(windowText));
      const start = (loadAddr ?? 0) + Math.max(0, fileOffset - 2);
      const end = start + win - 1;
      const segKind = kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind;
      const r = await api.annotateSegment({
        projectDir, prgPath: selectedPath, start: hexW(start), end: hexW(end),
        kind: segKind, label: label.trim() || undefined, comment: comment.trim() || undefined,
      });
      setSaveStatus(`Saved → ${r.annotationsPath} (${r.totalSegments} segments). Picked up by the next disasm_prg.`);
    } catch (e) { setSaveStatus(`Save failed: ${(e as Error).message}`); }
  }, [selected, selectedPath, offsetText, windowText, kind, multicolor, loadAddr, label, comment, projectDir]);

  const confirmCandidate = useCallback(async (it: GraphicsItem, reject: boolean) => {
    const artifactId = (it.prgArtifactId as string) ?? (it.analysisArtifactId as string);
    if (!artifactId || typeof it.start !== "number" || typeof it.end !== "number") { setSaveStatus("candidate missing artifact/address"); return; }
    try {
      const length = it.end - it.start + 1;
      if (reject) await api.rejectSegment({ projectDir, artifactId, address: it.start, length, kind: String(it.kind ?? "graphics"), reason: "rejected from v3 Assets" });
      else await api.confirmSegment({ projectDir, artifactId, address: it.start, length, kind: String(it.kind ?? "graphics") });
      setSaveStatus(`${reject ? "Rejected" : "Confirmed"} ${it.label ?? it.kind} ${hexW(it.start)}–${hexW(it.end)}`);
      reload();
    } catch (e) { setSaveStatus(`segment update failed: ${(e as Error).message}`); }
  }, [projectDir, reload]);

  const hexN = (n: unknown) => typeof n === "number" ? "$" + n.toString(16) : "?";

  return (
    <div style={{ padding: 8, color: "#ccc", fontSize: 13, overflowY: "auto", height: "100%" }}>
      {err && <div style={{ color: "#d66", marginBottom: 8 }}>{err}</div>}

      {/* Candidate list + confirm/reject (reclassify heuristic output) */}
      <div style={card}>
        <div style={hdr}>Graphics candidates ({candidates.length}) — confirm / reject</div>
        {candidates.length === 0 && <div style={{ color: "#555", fontStyle: "italic" }}>No candidates — run scan_graphics_candidates.</div>}
        {candidates.map((it, i) => (
          <div key={(it.id as string) ?? i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px solid #222", fontSize: 12 }}>
            <span style={{ color: "#d47f00", fontSize: 10 }}>[{String(it.kind ?? "?")}]</span>
            <strong>{String(it.label ?? it.title ?? `asset ${i}`)}</strong>
            <span style={{ color: "#888" }}>{hexN(it.start)}–{hexN(it.end)}</span>
            {it.confirmed ? <span style={{ color: "#6a9f2f", fontSize: 10 }}>confirmed</span> : null}
            {it.rejected ? <span style={{ color: "#d66", fontSize: 10 }}>rejected</span> : null}
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button onClick={() => confirmCandidate(it, false)} style={{ fontSize: 10, padding: "1px 6px" }}>Confirm</button>
              <button onClick={() => confirmCandidate(it, true)} style={{ fontSize: 10, padding: "1px 6px" }}>Reject</button>
            </span>
          </div>
        ))}
      </div>

      {/* Scrub: free-form memory browser + render + save segment */}
      <div style={{ ...card, display: "flex", gap: 12 }}>
        <div style={{ minWidth: 250, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={hdr}>Scrub — render any slice</div>
          <label style={{ fontSize: 12 }}>File
            <select value={selectedPath} onChange={(e) => setSelectedPath(e.target.value)} style={{ width: "100%", marginTop: 2 }}>
              <option value="">(select PRG/CRT/raw)</option>
              {scrubArtifacts.map((a) => <option key={a.id} value={a.relativePath ?? a.path}>{a.title} ({a.kind})</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Offset (hex) <input value={offsetText} onChange={(e) => setOffsetText(e.target.value)} style={{ width: 80, fontFamily: "monospace" }} /></label>
          <label style={{ fontSize: 12 }}>Window (hex) <input value={windowText} onChange={(e) => setWindowText(e.target.value)} style={{ width: 80, fontFamily: "monospace" }} /></label>
          <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
            <button onClick={() => step(-BLOCK_BYTES[kind])}>−blk</button>
            <button onClick={() => step(BLOCK_BYTES[kind])}>+blk</button>
            <button onClick={() => step(-parseHex(windowText))}>−win</button>
            <button onClick={() => step(parseHex(windowText))}>+win</button>
          </div>
          <label style={{ fontSize: 12 }}>Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as ScrubKind)} style={{ marginLeft: 4 }}>
              <option value="sprite">sprite</option>
              <option value="charset">charset</option>
              <option value="bitmap">bitmap (320×200)</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={multicolor} onChange={(e) => setMulticolor(e.target.checked)} /> Multicolor</label>
          {kind !== "bitmap" && (
            <label style={{ fontSize: 12 }}>Columns <input type="number" min={1} max={128} value={columns} onChange={(e) => setColumns(Math.max(1, Math.min(128, parseInt(e.target.value, 10) || 1)))} style={{ width: 60 }} /></label>
          )}
          <div style={{ fontSize: 11, color: "#9aa" }}>Block: {BLOCK_BYTES[kind]} B{loadAddr !== null ? ` · load $${hexW(loadAddr)}` : ""}</div>

          {selected?.kind === "prg" && (
            <div style={{ borderTop: "1px solid #30363d", paddingTop: 8, marginTop: 4, display: "flex", flexDirection: "column", gap: 6 }}>
              <strong style={{ fontSize: 12 }}>Save window as segment</strong>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (e.g. title_charset)" style={{ fontSize: 12 }} />
              <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="why this slice is graphics" style={{ fontSize: 12 }} />
              <button onClick={saveSegment} style={{ fontSize: 12 }}>Save segment ({renderKind})</button>
            </div>
          )}
          {saveStatus && <div style={{ fontSize: 11, color: "#9ab" }}>{saveStatus}</div>}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{selectedPath || "No file"} — offset ${offsetText.toUpperCase()} window ${windowText.toUpperCase()} {renderKind}</div>
          {selectedPath ? (
            <C64GraphicsView
              bytes={bytes}
              loading={loading}
              kind={renderKind}
              multicolor={kind !== "bitmap" ? multicolor : undefined}
              columns={kind !== "bitmap" ? columns : undefined}
              showColourPicker={true}
            />
          ) : <div style={{ color: "#555", fontStyle: "italic", padding: 12 }}>Select a file to scrub.</div>}
        </div>
      </div>
    </div>
  );
}
