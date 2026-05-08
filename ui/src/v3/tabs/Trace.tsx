// Spec 267 — Trace viewer tab.
//
// Swimlane (Spec 234) + bookmarks (Spec 242) + filter UI.
// Backend calls via WS runtime/call, falling back to stubs when
// the session is unavailable.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TabProps } from "./Live.js";
import { getClient } from "../ws-client.js";
import {
  TraceFilters,
  defaultFilterState,
  type TraceFilterState,
} from "../components/TraceFilters.js";
import { SwimlaneTable, type SwimlaneRow } from "../components/SwimlaneTable.js";
import { BookmarkOverlay, type Bookmark } from "../components/BookmarkOverlay.js";
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

export function TraceTab({ sessionId }: TabProps): JSX.Element {
  const [filters, setFilters] = useState<TraceFilterState>(defaultFilterState());
  const [rows, setRows] = useState<SwimlaneRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
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
      // Call AgentQueryApi swimlaneSlice via WS runtime/call.
      // Op: "swimlaneSlice", args: [SwimlaneQuery]
      const result = await client.runtime<{ markdown?: string; rows?: unknown[] }>(
        sessionId,
        "swimlaneSlice",
        {
          runId,
          cycleRange: [filters.cycleStart, filters.cycleEnd] as [number, number],
          compact: true,
          filterC64PcRange:
            filters.pcStart !== 0x0000 || filters.pcEnd !== 0xffff
              ? ([filters.pcStart, filters.pcEnd] as [number, number])
              : undefined,
        },
      );

      // Backend may return rendered markdown or raw rows.
      if (result && typeof (result as any).markdown === "string") {
        const { rows: parsed, totalRows: total } = parseMarkdownSwimlane(
          (result as any).markdown as string,
        );
        setRows(parsed);
        setTotalRows(total);
      } else {
        // Fallback stub — no trace available yet.
        setRows([]);
        setTotalRows(0);
        setError("Backend returned no swimlane data. Run a session with trace capture enabled.");
      }
    } catch (e: any) {
      setError(`Swimlane fetch failed: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId, runId, filters.cycleStart, filters.cycleEnd, filters.pcStart, filters.pcEnd]);

  // ── Fetch bookmarks ─────────────────────────────────────────────────────────

  const fetchBookmarks = useCallback(async () => {
    if (!sessionId) { setBookmarks([]); return; }
    try {
      const client = getClient();
      // TODO: wire to runtime_bookmark_list when backend exposes it via WS runtime/call.
      // For now, call listBookmarks op and handle gracefully if not available.
      const result = await client.runtime<Bookmark[]>(sessionId, "listBookmarks", runId).catch(
        () => [] as Bookmark[],
      );
      setBookmarks(Array.isArray(result) ? result : []);
    } catch {
      setBookmarks([]); // stub — backend wiring later
    }
  }, [sessionId, runId]);

  // ── Auto-fetch on filter change ─────────────────────────────────────────────

  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      fetchSwimlane();
      fetchBookmarks();
    }, 300);
    return () => {
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    };
  }, [fetchSwimlane, fetchBookmarks]);

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

  // ── Add bookmark (stub — placeholder button) ────────────────────────────────

  const handleAddBookmark = useCallback(async () => {
    if (selectedCycle === null) {
      alert("Select a row first.");
      return;
    }
    // TODO: wire to runtime addBookmark op when backend exposes it via WS.
    alert(`Add bookmark at cycle ${selectedCycle} — backend wiring coming in a later sprint.`);
  }, [selectedCycle]);

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

      {/* Bookmark overlay */}
      <section className="trace-section">
        <BookmarkOverlay
          bookmarks={bookmarks}
          visibleCycleStart={filters.cycleStart}
          visibleCycleEnd={filters.cycleEnd}
          onJump={handleJump}
        />
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
        <button
          className="trace-btn"
          onClick={handleAddBookmark}
          disabled={selectedCycle === null}
          title={selectedCycle !== null ? `Add bookmark at cycle ${selectedCycle}` : "Select a row first"}
        >
          Add bookmark @ selected
        </button>
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
