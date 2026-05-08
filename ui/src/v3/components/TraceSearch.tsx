// Spec 267 — TraceSearch: search result display + jump-to-match.

import React from "react";

export interface SearchResult {
  cycle: number;
  matchedField: string;
  snippet: string;
}

interface Props {
  results: SearchResult[];
  onJump: (cycle: number) => void;
  loading: boolean;
}

export function TraceSearch({ results, onJump, loading }: Props): JSX.Element {
  if (loading) {
    return <div className="trace-search-status">Searching…</div>;
  }
  if (results.length === 0) {
    return <></>;
  }
  return (
    <div className="trace-search-results">
      <span className="trace-search-count">{results.length} match{results.length !== 1 ? "es" : ""}:</span>
      {results.slice(0, 20).map((r, i) => (
        <button key={i} className="trace-search-hit" onClick={() => onJump(r.cycle)}>
          @{r.cycle.toLocaleString()} [{r.matchedField}] {r.snippet}
        </button>
      ))}
      {results.length > 20 && (
        <span className="trace-search-more">…+{results.length - 20} more</span>
      )}
    </div>
  );
}
