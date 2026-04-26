import { useEffect, useMemo, useState } from "react";

interface HexViewProps {
  // Project-relative path used by /api/artifact/raw (ignored when
  // `fetchUrl` is set).
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
  // Optional override URL. When set, HexView fetches bytes from this URL
  // verbatim and ignores path / projectDir / offset / length. Used for
  // D64 whole-file assembly via /api/disk/file-bytes.
  fetchUrl?: string;
  // Optional pre-fetched bytes. When provided, HexView renders them
  // directly and skips all network calls. Used by callers that need to
  // POST a chain to /api/disk/assemble-chain before rendering.
  bytes?: Uint8Array;
  // Optional packer hint shown as a tag. Set by the caller only when the
  // manifest knows the stream format.
  packerHint?: string;
  // Optional context dict (e.g. { destHi: 0x40 } for byteboozer-lykia)
  // appended verbatim to the /api/depack query string.
  packerContext?: Record<string, string | number>;
  onClose: () => void;
}

const ROW_BYTES = 16;
const DEPACK_PACKER_ALIASES: Record<string, string> = {
  rle: "rle",
  byteboozer: "byteboozer",
  byteboozer2: "byteboozer",
  "byteboozer-lykia": "byteboozer-lykia",
  byteboozer_lykia: "byteboozer-lykia",
  exomizer_raw: "exomizer_raw",
  "exomizer-raw": "exomizer_raw",
  exomizer_sfx: "exomizer_sfx",
  "exomizer-sfx": "exomizer_sfx",
};

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

export function HexView({ path, projectDir, title, baseAddress = 0, offset, length, fetchUrl, bytes: presetBytes, packerHint, packerContext, onClose }: HexViewProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(presetBytes ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(!presetBytes);
  const [depackState, setDepackState] = useState<{ mode: "raw" | "depacked"; packer?: string; rawBytes?: Uint8Array; depackedBytes?: Uint8Array; busy: boolean; error?: string }>({ mode: "raw", busy: false });

  useEffect(() => {
    if (presetBytes) {
      setBytes(presetBytes);
      setPending(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setPending(true);
    setError(null);
    setBytes(null);
    let url = fetchUrl;
    if (!url) {
      const params = new URLSearchParams({ path });
      if (projectDir) params.set("projectDir", projectDir);
      if (offset !== undefined) params.set("offset", String(offset));
      if (length !== undefined) params.set("length", String(length));
      url = `/api/artifact/raw?${params.toString()}`;
    }
    fetch(url)
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
  }, [path, projectDir, offset, length, fetchUrl, presetBytes]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Whenever the underlying bytes change (new overlay, different
  // chunk, …), reset the depack state so the toggle reflects reality.
  useEffect(() => {
    setDepackState({ mode: "raw", busy: false, packer: undefined, rawBytes: undefined, depackedBytes: undefined, error: undefined });
  }, [presetBytes, fetchUrl, path, offset, length]);

  async function toggleDepackView() {
    if (!bytes) return;
    if (depackState.mode === "depacked" && depackState.rawBytes) {
      setBytes(depackState.rawBytes);
      setDepackState((prev) => ({ ...prev, mode: "raw" }));
      return;
    }
    if (depackState.depackedBytes) {
      setDepackState((prev) => ({ ...prev, mode: "depacked", rawBytes: prev.rawBytes ?? bytes }));
      setBytes(depackState.depackedBytes);
      return;
    }
    setDepackState((prev) => ({ ...prev, busy: true, error: undefined, rawBytes: prev.rawBytes ?? bytes }));
    try {
      const params = new URLSearchParams();
      if (depackPacker) params.set("packer", depackPacker);
      if (packerContext) {
        for (const [key, value] of Object.entries(packerContext)) {
          params.set(key, String(value));
        }
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`/api/depack${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Copy into a plain ArrayBuffer so TS stops worrying about
        // SharedArrayBuffer compatibility with BlobPart.
        body: new Blob([new Uint8Array(bytes).slice().buffer as ArrayBuffer]),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
      }
      const packer = response.headers.get("x-depacker") ?? packerHint ?? "unknown";
      const buffer = await response.arrayBuffer();
      const depackedBytes = new Uint8Array(buffer);
      setDepackState({ mode: "depacked", packer, rawBytes: bytes, depackedBytes, busy: false });
      setBytes(depackedBytes);
    } catch (err) {
      setDepackState((prev) => ({ ...prev, busy: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }

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

  const depackPacker = packerHint ? DEPACK_PACKER_ALIASES[packerHint.trim().toLowerCase()] : undefined;
  const canDepack = Boolean(depackPacker);
  const showDepackButton = canDepack || depackState.mode === "depacked";

  return (
    <div className="hex-overlay-backdrop" onClick={onClose}>
      <div className="hex-overlay" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="hex-overlay-header">
          <div>
            <h3>
              {title ?? path}
              {depackState.mode === "depacked" && depackState.packer ? (
                <span className="hex-overlay-tag" title={`Depacked via ${depackState.packer}`}>
                  {depackState.packer}
                </span>
              ) : packerHint ? (
                <span className="hex-overlay-tag hex-overlay-tag-hint" title={`Known packer: ${packerHint}`}>
                  {packerHint}
                </span>
              ) : null}
            </h3>
            <p>
              {path} · {bytes ? `${bytes.length} bytes` : pending ? "loading…" : "—"}
              {baseAddress ? ` · base $${formatHexAddress(baseAddress)}` : ""}
              {depackState.mode === "depacked" && depackState.rawBytes ? ` · packed ${depackState.rawBytes.length} B` : ""}
            </p>
            {depackState.error ? <p className="hex-overlay-inline-error">depack failed: {depackState.error}</p> : null}
          </div>
          <div className="hex-overlay-header-actions">
            {showDepackButton ? (
              <button
                type="button"
                className={depackState.mode === "depacked" ? "hex-overlay-depack hex-overlay-depack-active" : "hex-overlay-depack"}
                onClick={toggleDepackView}
                disabled={!bytes || depackState.busy}
                title={depackState.mode === "depacked" ? "Show the raw bytes again" : `Depack known ${packerHint} stream`}
              >
                {depackState.busy ? "depacking…" : depackState.mode === "depacked" ? "raw view" : "depack view"}
              </button>
            ) : null}
            <button type="button" className="hex-overlay-close" onClick={onClose} aria-label="Close hex view">×</button>
          </div>
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
