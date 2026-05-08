// Spec 267 — SwimlaneTable: virtualized HTML table for swimlane rows.
//
// Renders ≤200 rows from a parsed Markdown swimlane table.
// Emits c64re:goto-cycle custom events when a row is clicked.

import React, { useCallback } from "react";

/** One parsed row from the swimlane Markdown table. */
export interface SwimlaneRow {
  cycle: number;
  c64Pc: string;
  c64Op: string;
  c64Io: string;
  bus: string;
  drvPc: string;
  drvOp: string;
  drvIo: string;
}

const MAX_VISIBLE = 200;

interface Props {
  rows: SwimlaneRow[];
  totalRows: number;
  selectedCycle: number | null;
  onSelectRow: (cycle: number) => void;
}

export function SwimlaneTable({ rows, totalRows, selectedCycle, onSelectRow }: Props): JSX.Element {
  const visible = rows.slice(0, MAX_VISIBLE);
  const truncated = totalRows > MAX_VISIBLE;

  const handleRowClick = useCallback(
    (cycle: number) => {
      onSelectRow(cycle);
      // Cross-tab event — Monitor tab can listen.
      window.dispatchEvent(new CustomEvent("c64re:goto-cycle", { detail: { cycle } }));
    },
    [onSelectRow],
  );

  if (visible.length === 0) {
    return <div className="swimlane-empty">No rows in selected range / filters.</div>;
  }

  return (
    <div className="swimlane-wrapper">
      {truncated && (
        <div className="swimlane-truncation-banner">
          Showing {MAX_VISIBLE} of {totalRows} rows — narrow cycle range or add filters.
        </div>
      )}
      <div className="swimlane-scroll">
        <table className="swimlane-table">
          <thead>
            <tr>
              <th>cycle</th>
              <th>c64_pc</th>
              <th>c64_op</th>
              <th>c64_io</th>
              <th>bus</th>
              <th>drv_pc</th>
              <th>drv_op</th>
              <th>drv_io</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, idx) => (
              <tr
                key={idx}
                className={`swimlane-row${row.cycle === selectedCycle ? " selected" : ""}`}
                onClick={() => handleRowClick(row.cycle)}
              >
                <td className="cycle-col">{row.cycle}</td>
                <td className="pc-col">{row.c64Pc}</td>
                <td className="op-col">{row.c64Op}</td>
                <td className="io-col">{row.c64Io}</td>
                <td className="bus-col">{row.bus}</td>
                <td className="pc-col">{row.drvPc}</td>
                <td className="op-col">{row.drvOp}</td>
                <td className="io-col">{row.drvIo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
