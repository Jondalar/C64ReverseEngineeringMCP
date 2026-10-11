// Spec 267 — Trace viewer tab.
//
// Swimlane (Spec 234) + the ring's anchors + filter UI.
// Backend calls via WS runtime/call, falling back to stubs when
// the session is unavailable.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TabProps } from "./Live.types.js";
import { getClient } from "../ws-client.js";
import {
  TraceFilters,
  defaultFilterState,
  type TraceFilterState,
} from "../components/TraceFilters.js";
import { SwimlaneTable, type SwimlaneRow } from "../components/SwimlaneTable.js";
import { AnchorList } from "../components/AnchorList.js";
import { gotoAnchor, listAnchors, setAnchor, type Anchor } from "../anchors.js";
import { TraceSearch, type SearchResult } from "../components/TraceSearch.js";

// ── Markdown swimlane parser (no external deps) ───────────────────────────────

/**
 * Parse a Markdown swimlane table produced by renderMarkdown() (Spec 234).
 *
 * Returns parsed rows and the total row count claimed by the truncation note
 * (falls back to parsed count if note is absent).
 */
export function parseMarkdownSwimlane(md: string): {
  rows: SwimlaneRow[];
  totalRows: number;
} {
  const lines = md.split("\n");

  // Find header separator line (starts with |---).
  const sepIdx = lines.findIndex((l) => /^\|[-:| ]+\|/.test(l));
  if (sepIdx < 0) return { rows: [], totalRows: 0 };

  const dataLines = lines.slice(sepIdx + 1).filter((l) => l.startsWith("|"));
  const rows: SwimlaneRow[] = [];

  for (const line of dataLines) {
    // Split on | and trim — first and last cells are empty (leading/trailing |).
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] = "" (before first |), cells[1..8] = data, cells[9] = "" (after last |)
    if (cells.length < 9) continue;
    const cycle = parseInt(cells[1]!, 10);
    if (isNaN(cycle)) continue;
    rows.push({
      cycle,
      c64Pc: cells[2] ?? "",
      c64Op: cells[3] ?? "",
      c64Io: cells[4] ?? "",
      bus:   cells[5] ?? "",
      drvPc: cells[6] ?? "",
      drvOp: cells[7] ?? "",
      drvIo: cells[8] ?? "",
    });
  }

  // Try to read truncation note: "_Truncated: showing N of M rows._"
  const truncLine = lines.find((l) => l.includes("Truncated:"));
  let totalRows = rows.length;
  if (truncLine) {
    const m = truncLine.match(/of (\d+) rows/);
    if (m) totalRows = parseInt(m[1]!, 10);
  }

  return { rows, totalRows };
}

// ── JSONL export helper ───────────────────────────────────────────────────────

/**
 * Serialise swimlane rows to JSONL with a header object.
 * Pure function — no DOM, no external deps.
 */
export function rowsToJsonl(
  rows: SwimlaneRow[],
  meta: { startCycle: number; endCycle: number },
): string {
  const header = JSON.stringify({
    _type: "swimlane_header",
    startCycle: meta.startCycle,
    endCycle: meta.endCycle,
    rowCount: rows.length,
  });
  const rowLines = rows.map((r) => JSON.stringify(r));
  return [header, ...rowLines].join("\n");
}

/**
 * Trigger a browser file download of the given content.
 */
function downloadText(content: string, filename: string): void {
  const blob = new Blob([content], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Search helper ─────────────────────────────────────────────────────────────

function searchRows(rows: SwimlaneRow[], query: string): SearchResult[] {
  if (!query) return [];
  const q = query.replace(/^\$/, "").toUpperCase();
  const results: SearchResult[] = [];
  for (const row of rows) {
    const fields: [string, string][] = [
      ["c64_pc", row.c64Pc],
      ["c64_op", row.c64Op],
      ["c64_io", row.c64Io],
      ["bus",    row.bus],
      ["drv_pc", row.drvPc],
      ["drv_op", row.drvOp],
      ["drv_io", row.drvIo],
    ];
    for (const [name, val] of fields) {
      if (val.toUpperCase().includes(q)) {
        results.push({ cycle: row.cycle, matchedField: name, snippet: val });
        break; // one hit per row
      }
    }
    if (results.length >= 200) break; // hard cap
  }
  return results;
}

// ── Main TraceTab ─────────────────────────────────────────────────────────────

export function TraceTab({ sessionId }: TabProps): React.JSX.Element {
  const [filters, setFilters] = useState<TraceFilterState>(defaultFilterState());
  const [rows, setRows] = useState<SwimlaneRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [anchorNote, setAnchorNote] = useState<string | null>(null);
  const [anchorName, setAnchorName] = useState("");
  const [selectedCycle, setSelectedCycle] = useState<number | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // RunId to use — derived from sessionId for now.
  // Backend convention: runId == sessionId when integrated session captures trace.
  const runId = sessionId;

  // ── Fetch swimlane from backend ─────────────────────────────────────────────

  const fetchSwimlane = useCallback(async () => {
    if (!sessionId) {
      setRows([]);
      setTotalRows(0);
      setError("No session — start an integrated session first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = getClient();
      // Spec 746.10 — resolve the session's current/last-finalized trace store, then
      // read the swimlane THROUGH THE DAEMON (trace/read) so a live-daemon lock never
      // blocks us (BUG-029). The store's runId is authoritative (not the sessionId).
      const cur = await client.call<{ path: string | null; runId?: string; active?: boolean }>("trace/current", { session_id: sessionId });
      if (!cur || !cur.path) {
        setRows([]); setTotalRows(0);
        setError("No trace yet — start a trace (⏺ Trace button or `trace on` in the Monitor), run the session, then refresh.");
        return;
      }
      if (cur.active) {
        // DuckDB index is built at stop(); a live run has no queryable store yet.
        setRows([]); setTotalRows(0);
        setError("Trace is still recording — stop it (⏺ Trace / `trace off`) to build the queryable index, then refresh.");
        return;
      }
      const slice = await client.call<{ rows?: SwimlaneRow[] }>("trace/read", {
        op: "swimlane",
        duckdb_path: cur.path,
        args: { run_id: cur.runId, cycle_start: filters.cycleStart, cycle_end: filters.cycleEnd, compact: true },
      });
      const parsed = (slice?.rows ?? []) as SwimlaneRow[];
      setRows(parsed);
      setTotalRows(parsed.length);
    } catch (e: any) {
      setError(`Swimlane fetch failed: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId, runId, filters.cycleStart, filters.cycleEnd, filters.pcStart, filters.pcEnd]);

  // ── Fetch anchors ───────────────────────────────────────────────────────────

  const fetchAnchors = useCallback(async () => {
    if (!sessionId) { setAnchors([]); return; }
    try {
      setAnchors((await listAnchors(getClient())).anchors);
    } catch {
      setAnchors([]); // no runtime yet — the list is empty, not an error
    }
  }, [sessionId]);

  // ── Auto-fetch on filter change ─────────────────────────────────────────────

  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      fetchSwimlane();
      fetchAnchors();
    }, 300);
    return () => {
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    };
  }, [fetchSwimlane, fetchAnchors]);

  // ── Search ──────────────────────────────────────────────────────────────────

  const handleSearch = useCallback(() => {
    setSearchLoading(true);
    // Search is pure / local — no WS round-trip needed for local rows.
    const results = searchRows(rows, filters.searchText);
    setSearchResults(results);
    setSearchLoading(false);
    if (results.length > 0 && results[0]) {
      setSelectedCycle(results[0].cycle);
    }
  }, [rows, filters.searchText]);

  // ── Jump to cycle ───────────────────────────────────────────────────────────

  const handleJump = useCallback((cycle: number) => {
    setSelectedCycle(cycle);
    // Expand cycle range to include the target if needed.
    setFilters((prev) => {
      if (cycle >= prev.cycleStart && cycle <= prev.cycleEnd) return prev;
      const half = Math.floor((prev.cycleEnd - prev.cycleStart) / 2);
      return {
        ...prev,
        cycleStart: Math.max(0, cycle - half),
        cycleEnd: Math.min(prev.maxCycle, cycle + half),
      };
    });
  }, []);

  // ── Set / go to an anchor ───────────────────────────────────────────────────

  const handleSetAnchor = useCallback(async () => {
    try {
      const a = await setAnchor(getClient(), sessionId, anchorName, {});
      setAnchorNote(`⚓ ${a.name} — cycle ${a.cycle}`);
      setAnchorName("");
      await fetchAnchors();
    } catch (e: any) {
      setAnchorNote(e?.message ?? String(e)); // the runtime's own refusal, as it came
    }
  }, [sessionId, anchorName, fetchAnchors]);

  const handleGoAnchor = useCallback(async (name: string) => {
    try {
      await gotoAnchor(getClient(), name);
      setAnchorNote(`the shared machine is at ${name}`);
    } catch (e: any) {
      setAnchorNote(e?.message ?? String(e));
    }
  }, []);

  // ── Export JSONL ────────────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const jsonl = rowsToJsonl(rows, {
      startCycle: filters.cycleStart,
      endCycle: filters.cycleEnd,
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(jsonl, `swimlane-${ts}.jsonl`);
  }, [rows, filters.cycleStart, filters.cycleEnd]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="trace-tab">
      {/* Filters section */}
      <section className="trace-section trace-filter-section">
        <TraceFilters state={filters} onChange={setFilters} onSearch={handleSearch} />
      </section>

      {/* Anchors — the ring's named instants */}
      <section className="trace-section">
        <AnchorList anchors={anchors} onShow={handleJump} onGo={handleGoAnchor} />
      </section>

      {/* Search results */}
      {(searchResults.length > 0 || searchLoading) && (
        <section className="trace-section trace-search-section">
          <TraceSearch results={searchResults} onJump={handleJump} loading={searchLoading} />
        </section>
      )}

      {/* Swimlane table */}
      <section className="trace-section trace-table-section">
        {loading && <div className="trace-loading">Loading swimlane…</div>}
        {error && !loading && <div className="trace-error">{error}</div>}
        {!loading && !error && (
          <SwimlaneTable
            rows={rows}
            totalRows={totalRows}
            selectedCycle={selectedCycle}
            onSelectRow={setSelectedCycle}
          />
        )}
      </section>

      {/* Footer actions */}
      <section className="trace-section trace-actions">
        <input
          className="trace-input"
          value={anchorName}
          placeholder="anchor name"
          onChange={(e) => setAnchorName(e.target.value)}
          title="Names the machine's present instant"
        />
        <button
          className="trace-btn"
          onClick={() => void handleSetAnchor()}
          disabled={anchorName.trim() === ""}
          title="Capture the shared machine as it is now and name it — the machine is not moved"
        >
          ⚓ Set anchor
        </button>
        {anchorNote && <span className="trace-selected-info">{anchorNote}</span>}
        <button className="trace-btn" onClick={handleExport} disabled={rows.length === 0}>
          Export JSONL
        </button>
        {selectedCycle !== null && (
          <span className="trace-selected-info">
            Selected: cycle {selectedCycle.toLocaleString()}
          </span>
        )}
      </section>
    </div>
  );
}
