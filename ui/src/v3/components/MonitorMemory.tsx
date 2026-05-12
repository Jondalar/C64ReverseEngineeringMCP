// Spec 266 — MonitorMemory: hex dump view with configurable range.

import React, { useState } from "react";

interface Props {
  /** Raw bytes array */
  bytes: number[];
  /** Base address of the first byte */
  baseAddr: number;
  /** Called when user edits: addr + new byte value */
  onEdit?: (addr: number, value: number) => void;
}

function hex4(v: number): string {
  return v.toString(16).padStart(4, "0").toUpperCase();
}
function hex2(v: number): string {
  return v.toString(16).padStart(2, "0").toUpperCase();
}

const BYTES_PER_ROW = 16;

export function MonitorMemory({ bytes, baseAddr, onEdit }: Props): JSX.Element {
  const [editAddr, setEditAddr] = useState<number | null>(null);
  const [editVal, setEditVal] = useState<string>("");

  if (bytes.length === 0) {
    return <div className="mon-mem mon-mem-empty">(no memory data)</div>;
  }

  const rows: JSX.Element[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
    const rowAddr = baseAddr + offset;
    const rowBytes = bytes.slice(offset, offset + BYTES_PER_ROW);
    const ascii = rowBytes
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");

    rows.push(
      <div key={rowAddr} className="mon-mem-row">
        <span className="mon-mem-addr">${hex4(rowAddr)}</span>
        <span className="mon-mem-bytes">
          {rowBytes.map((b, i) => {
            const addr = rowAddr + i;
            const isEditing = editAddr === addr;
            if (isEditing) {
              return (
                <input
                  key={i}
                  className="mon-mem-edit"
                  value={editVal}
                  autoFocus
                  maxLength={2}
                  style={{ width: "2.4ch" }}
                  onChange={(e) => setEditVal(e.target.value)}
                  onBlur={() => {
                    const parsed = parseInt(editVal, 16);
                    if (!isNaN(parsed) && onEdit) {
                      onEdit(addr, parsed & 0xff);
                    }
                    setEditAddr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const parsed = parseInt(editVal, 16);
                      if (!isNaN(parsed) && onEdit) {
                        onEdit(addr, parsed & 0xff);
                      }
                      setEditAddr(null);
                    } else if (e.key === "Escape") {
                      setEditAddr(null);
                    }
                  }}
                />
              );
            }
            return (
              <span
                key={i}
                className="mon-mem-byte"
                title={`$${hex4(addr)}`}
                onClick={() => {
                  if (onEdit) {
                    setEditAddr(addr);
                    setEditVal(hex2(b));
                  }
                }}
              >
                {hex2(b)}
              </span>
            );
          })}
        </span>
        <span className="mon-mem-ascii">{ascii}</span>
      </div>
    );
  }

  return <div className="mon-mem">{rows}</div>;
}
