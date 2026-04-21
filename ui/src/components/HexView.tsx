import { useEffect, useMemo, useState } from "react";

interface HexViewProps {
  // Project-relative path used by /api/artifact/raw.
  path: string;
  projectDir?: string;
  title?: string;
  // Optional logical base address; defaults to 0 so the addr column is the
  // file offset. Cart chips pass loadAddress here so the column shows the
  // C64-side address.
  baseAddress?: number;
  // Optional byte slice. Server returns only [offset, offset+length) when
  // either is set. Used to focus a hex view on a single LUT chunk inside
  // a larger chip dump.
  offset?: number;
  length?: number;
  onClose: () => void;
}

const ROW_BYTES = 16;

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function formatHexAddress(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function petsciiPreviewChar(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  if (byte >= 0xa0 && byte <= 0xfe) return String.fromCharCode(byte - 0x80);
  return ".";
}

export function HexView({ path, projectDir, title, baseAddress = 0, offset, length, onClose }: HexViewProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    setBytes(null);
    const params = new URLSearchParams({ path });
    if (projectDir) params.set("projectDir", projectDir);
    if (offset !== undefined) params.set("offset", String(offset));
    if (length !== undefined) params.set("length", String(length));
    fetch(`/api/artifact/raw?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          const message = await response.text().catch(() => response.statusText);
          throw new Error(`HTTP ${response.status}: ${message}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (!cancelled) setBytes(new Uint8Array(buffer));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectDir, offset, length]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const rows = useMemo(() => {
    if (!bytes) return [] as Array<{ offset: number; addr: number; cells: number[]; chars: string }>;
    const out: Array<{ offset: number; addr: number; cells: number[]; chars: string }> = [];
    for (let offset = 0; offset < bytes.length; offset += ROW_BYTES) {
      const slice = bytes.subarray(offset, Math.min(offset + ROW_BYTES, bytes.length));
      const cells = Array.from(slice);
      const chars = cells.map((b) => petsciiPreviewChar(b)).join("");
      out.push({ offset, addr: (baseAddress + offset) & 0xffff, cells, chars });
    }
    return out;
  }, [bytes, baseAddress]);

  return (
    <div className="hex-overlay-backdrop" onClick={onClose}>
      <div className="hex-overlay" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="hex-overlay-header">
          <div>
            <h3>{title ?? path}</h3>
            <p>{path} · {bytes ? `${bytes.length} bytes` : pending ? "loading…" : "—"}{baseAddress ? ` · base $${formatHexAddress(baseAddress)}` : ""}</p>
          </div>
          <button type="button" className="hex-overlay-close" onClick={onClose} aria-label="Close hex view">×</button>
        </header>
        <div className="hex-overlay-body">
          {error ? (
            <div className="hex-overlay-error">{error}</div>
          ) : pending ? (
            <div className="hex-overlay-empty">Fetching artifact…</div>
          ) : rows.length === 0 ? (
            <div className="hex-overlay-empty">Empty file.</div>
          ) : (
            <pre className="hex-overlay-grid">
              {rows.map((row) => (
                <div key={row.offset} className="hex-row">
                  <span className="hex-addr">${formatHexAddress(row.addr)}</span>
                  <span className="hex-cells">
                    {Array.from({ length: ROW_BYTES }).map((_, columnIndex) => {
                      const byte = row.cells[columnIndex];
                      return (
                        <span key={columnIndex} className={byte === undefined ? "hex-cell hex-cell-empty" : "hex-cell"}>
                          {byte === undefined ? "  " : formatHexByte(byte)}
                        </span>
                      );
                    })}
                  </span>
                  <span className="hex-ascii">{row.chars.padEnd(ROW_BYTES, " ")}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
