// Spec 265 — Media selector tab.
//
// Layout:
//   left pane  — path tree (roots + folders, expand/collapse)
//   right pane — file list with type badge + mount button
//   bottom bar — recent files quick-pick
//   drive slots — shows mounted path + Eject + Swap

import React, { useEffect, useState, useCallback } from "react";
import { getClient } from "../ws-client.js";
import type { TabProps } from "./Live.types.js";

// ---- types mirroring server-side ----

interface FsRoot {
  label: string;
  path: string;
  exists: boolean;
}

interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "d64" | "g64" | "crt" | "prg" | "vsf" | "t64" | "tap";
  deferred: boolean;
  sizeBytes?: number;
}

interface RecentEntry {
  path: string;
  type: string;
  mountedAt: string;
}

interface MountResult {
  slot?: number;
  mountedPath: string;
  type: string;
  mapperType?: string;
  sectors?: number;
  errors?: string[];
}

// ---- helpers ----

const TYPE_BADGE: Record<string, string> = {
  d64: "D64",
  g64: "G64",
  crt: "CRT",
  prg: "PRG",
  vsf: "VSF",
  t64: "T64",
  tap: "TAP",
};

const TYPE_COLOR: Record<string, string> = {
  d64: "#4a90d9",
  g64: "#4a90d9",
  crt: "#d47f00",
  prg: "#6a9f2f",
  vsf: "#8e59c9",
  t64: "#888",
  tap: "#888",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

// ---- sub-components ----

function TypeBadge({ type, deferred }: { type: string; deferred: boolean }): JSX.Element {
  const label = TYPE_BADGE[type] ?? type.toUpperCase();
  const color = deferred ? "#888" : (TYPE_COLOR[type] ?? "#999");
  return (
    <span style={{
      display: "inline-block",
      padding: "0 4px",
      fontSize: "10px",
      fontWeight: "bold",
      borderRadius: "3px",
      backgroundColor: color,
      color: "#fff",
      opacity: deferred ? 0.55 : 1,
      marginRight: "6px",
    }}>
      {label}
      {deferred ? " *" : ""}
    </span>
  );
}

function DriveSlot({
  slot, mountedPath, mountedType, mapperType,
  onEject, onSwap,
}: {
  slot: 8 | 9;
  mountedPath?: string;
  mountedType?: string;
  mapperType?: string;
  onEject: () => void;
  onSwap: (p: string) => void;
}): JSX.Element {
  const [swapInput, setSwapInput] = useState("");
  return (
    <div style={{
      border: "1px solid #444",
      borderRadius: "5px",
      padding: "8px 12px",
      marginBottom: "8px",
      background: "#1c1c1c",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <strong style={{ color: "#aaa", minWidth: "70px" }}>Drive {slot}:</strong>
        {mountedPath ? (
          <>
            {mountedType && <TypeBadge type={mountedType} deferred={false} />}
            <span style={{ color: "#ddd", flex: 1, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={mountedPath}>
              {basename(mountedPath)}
            </span>
            {mapperType && (
              <span style={{ color: "#d47f00", fontSize: "11px" }}>[{mapperType}]</span>
            )}
            <button onClick={onEject} style={{ fontSize: "11px", padding: "2px 6px" }}>Eject</button>
          </>
        ) : (
          <span style={{ color: "#555", fontStyle: "italic", flex: 1 }}>empty</span>
        )}
      </div>
      {mountedPath && (
        <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
          <input
            placeholder="Swap to path..."
            value={swapInput}
            onChange={(e) => setSwapInput(e.target.value)}
            style={{ flex: 1, fontSize: "11px", padding: "2px 6px", background: "#111", color: "#ccc", border: "1px solid #333", borderRadius: "3px" }}
          />
          <button
            onClick={() => { if (swapInput) { onSwap(swapInput); setSwapInput(""); } }}
            disabled={!swapInput}
            style={{ fontSize: "11px", padding: "2px 8px" }}
          >
            Swap
          </button>
        </div>
      )}
    </div>
  );
}

// ---- main component ----

export function MediaTab({ sessionId }: TabProps): JSX.Element {
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, FsEntry[]>>(new Map());
  const [selectedDir, setSelectedDir] = useState<string>("");
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [drive8, setDrive8] = useState<{ path?: string; type?: string; mapperType?: string }>({});
  const [drive9, setDrive9] = useState<{ path?: string; type?: string; mapperType?: string }>({});
  const [status, setStatus] = useState<string>("");
  const client = getClient();

  // Load roots on mount.
  useEffect(() => {
    client.call<FsRoot[]>("media/list_paths").then(setRoots).catch(() => {});
    client.call<RecentEntry[]>("media/recent").then(setRecent).catch(() => {});
  }, []);

  const browseDir = useCallback(async (path: string) => {
    setSelectedDir(path);
    if (dirContents.has(path)) return;
    try {
      const result = await client.call<{ path: string; entries: FsEntry[] }>("media/browse", { path });
      setDirContents((prev) => new Map(prev).set(path, result.entries));
    } catch (e) {
      setStatus(`Browse error: ${(e as Error).message}`);
    }
  }, [dirContents, client]);

  const toggleDir = useCallback(async (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    await browseDir(path);
  }, [browseDir]);

  const mountFile = useCallback(async (entry: FsEntry, slot: 8 | 9 = 8) => {
    if (entry.deferred) {
      setStatus(`${entry.name}: tape media deferred to V3.1`);
      return;
    }
    if (!sessionId) {
      setStatus("No active session — start a session first");
      return;
    }
    try {
      setStatus(`Mounting ${entry.name}...`);
      const result = await client.call<MountResult>("media/mount", {
        session_id: sessionId,
        slot,
        path: entry.path,
      });
      const setter = slot === 8 ? setDrive8 : setDrive9;
      setter({ path: result.mountedPath, type: result.type, mapperType: result.mapperType });
      // Refresh recent.
      client.call<RecentEntry[]>("media/recent").then(setRecent).catch(() => {});
      const errMsg = result.errors?.join("; ");
      setStatus(errMsg ? `Mounted with warnings: ${errMsg}` : `Mounted ${entry.name} to drive ${slot}`);
    } catch (e) {
      setStatus(`Mount error: ${(e as Error).message}`);
    }
  }, [sessionId, client]);

  const ejectSlot = useCallback(async (slot: 8 | 9) => {
    if (!sessionId) return;
    try {
      await client.call("media/unmount", { session_id: sessionId, slot });
      const setter = slot === 8 ? setDrive8 : setDrive9;
      setter({});
      setStatus(`Drive ${slot} ejected`);
    } catch (e) {
      setStatus(`Eject error: ${(e as Error).message}`);
    }
  }, [sessionId, client]);

  const swapSlot = useCallback(async (slot: 8 | 9, newPath: string) => {
    if (!sessionId) return;
    try {
      setStatus(`Swapping drive ${slot} to ${basename(newPath)}...`);
      const result = await client.call<MountResult>("media/swap", { session_id: sessionId, slot, path: newPath });
      const setter = slot === 8 ? setDrive8 : setDrive9;
      setter({ path: result.mountedPath, type: result.type, mapperType: result.mapperType });
      client.call<RecentEntry[]>("media/recent").then(setRecent).catch(() => {});
      setStatus(`Drive ${slot} swapped to ${basename(newPath)}`);
    } catch (e) {
      setStatus(`Swap error: ${(e as Error).message}`);
    }
  }, [sessionId, client]);

  const mountRecent = useCallback(async (entry: RecentEntry) => {
    const fakeEntry: FsEntry = { name: basename(entry.path), path: entry.path, type: entry.type as FsEntry["type"], deferred: entry.type === "t64" || entry.type === "tap" };
    await mountFile(fakeEntry, 8);
  }, [mountFile]);

  // Current dir entries for file list.
  const currentEntries = dirContents.get(selectedDir) ?? [];
  const fileEntries = currentEntries.filter((e) => e.type !== "dir");

  // Render path tree (roots + subdirs if expanded).
  function renderTree(): JSX.Element {
    return (
      <div style={{ overflow: "auto", flex: 1 }}>
        {roots.map((root) => (
          <div key={root.path}>
            <div
              onClick={() => toggleDir(root.path)}
              style={{
                cursor: root.exists ? "pointer" : "default",
                padding: "4px 8px",
                color: root.exists ? (selectedDir === root.path ? "#4a90d9" : "#ccc") : "#555",
                fontWeight: "bold",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>{expandedPaths.has(root.path) ? "▾" : "▸"}</span>
              <span>{root.label}</span>
              {!root.exists && <span style={{ color: "#555", fontSize: "10px" }}>(missing)</span>}
            </div>
            {expandedPaths.has(root.path) && renderSubDirs(root.path, 1)}
          </div>
        ))}
      </div>
    );
  }

  function renderSubDirs(parentPath: string, depth: number): JSX.Element {
    const entries = dirContents.get(parentPath) ?? [];
    const subdirs = entries.filter((e) => e.type === "dir");
    return (
      <div style={{ paddingLeft: `${depth * 12}px` }}>
        {/* Show file count in this folder as a row */}
        <div
          onClick={() => setSelectedDir(parentPath)}
          style={{
            cursor: "pointer",
            padding: "3px 8px",
            color: selectedDir === parentPath ? "#4a90d9" : "#888",
            fontSize: "11px",
          }}
        >
          {entries.filter((e) => e.type !== "dir").length} files
        </div>
        {subdirs.map((dir) => (
          <div key={dir.path}>
            <div
              onClick={() => toggleDir(dir.path)}
              style={{
                cursor: "pointer",
                padding: "3px 8px",
                color: selectedDir === dir.path ? "#4a90d9" : "#bbb",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>{expandedPaths.has(dir.path) ? "▾" : "▸"}</span>
              <span>{dir.name}/</span>
            </div>
            {expandedPaths.has(dir.path) && renderSubDirs(dir.path, depth + 1)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "8px", padding: "8px", color: "#ccc", fontSize: "13px" }}>
      {/* Drive slots */}
      <div style={{ background: "#161616", borderRadius: "5px", padding: "8px" }}>
        <div style={{ fontWeight: "bold", color: "#888", marginBottom: "6px", fontSize: "11px", textTransform: "uppercase" }}>Drive Slots</div>
        <DriveSlot
          slot={8}
          mountedPath={drive8.path}
          mountedType={drive8.type}
          mapperType={drive8.mapperType}
          onEject={() => ejectSlot(8)}
          onSwap={(p) => swapSlot(8, p)}
        />
        <DriveSlot
          slot={9}
          mountedPath={drive9.path}
          mountedType={drive9.type}
          mapperType={drive9.mapperType}
          onEject={() => ejectSlot(9)}
          onSwap={(p) => swapSlot(9, p)}
        />
      </div>

      {/* Main browser area */}
      <div style={{ display: "flex", flex: 1, gap: "8px", minHeight: 0 }}>
        {/* Left — path tree */}
        <div style={{ width: "200px", background: "#161616", borderRadius: "5px", padding: "6px", overflowY: "auto" }}>
          <div style={{ fontWeight: "bold", color: "#888", marginBottom: "6px", fontSize: "11px", textTransform: "uppercase" }}>Paths</div>
          {renderTree()}
        </div>

        {/* Right — file list */}
        <div style={{ flex: 1, background: "#161616", borderRadius: "5px", padding: "6px", overflowY: "auto" }}>
          <div style={{ fontWeight: "bold", color: "#888", marginBottom: "6px", fontSize: "11px", textTransform: "uppercase" }}>
            {selectedDir ? `Files — ${basename(selectedDir)}` : "Select a folder"}
          </div>
          {fileEntries.length === 0 && selectedDir && (
            <div style={{ color: "#555", padding: "8px", fontStyle: "italic" }}>No media files</div>
          )}
          {fileEntries.map((entry) => (
            <div key={entry.path} style={{
              display: "flex",
              alignItems: "center",
              padding: "4px 6px",
              borderRadius: "3px",
              opacity: entry.deferred ? 0.5 : 1,
            }}>
              <TypeBadge type={entry.type} deferred={entry.deferred} />
              <span
                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", color: entry.deferred ? "#666" : "#ddd" }}
                title={entry.path}
              >
                {entry.name}
              </span>
              {entry.sizeBytes !== undefined && (
                <span style={{ color: "#555", fontSize: "10px", marginRight: "8px" }}>{formatBytes(entry.sizeBytes)}</span>
              )}
              {!entry.deferred && (
                <>
                  <button
                    onClick={() => mountFile(entry, 8)}
                    style={{ fontSize: "10px", padding: "1px 5px", marginLeft: "4px" }}
                    title="Mount to drive 8"
                  >
                    Mnt8
                  </button>
                  <button
                    onClick={() => mountFile(entry, 9)}
                    style={{ fontSize: "10px", padding: "1px 5px", marginLeft: "2px" }}
                    title="Mount to drive 9"
                  >
                    Mnt9
                  </button>
                </>
              )}
              {entry.deferred && (
                <span style={{ fontSize: "10px", color: "#555" }}>V3.1</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Recent files */}
      {recent.length > 0 && (
        <div style={{ background: "#161616", borderRadius: "5px", padding: "8px" }}>
          <div style={{ fontWeight: "bold", color: "#888", marginBottom: "6px", fontSize: "11px", textTransform: "uppercase" }}>Recent</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {recent.map((r) => (
              <button
                key={r.path}
                onClick={() => mountRecent(r)}
                title={r.path}
                style={{ fontSize: "11px", padding: "2px 8px", background: "#222", border: "1px solid #444", borderRadius: "4px", color: "#ccc", cursor: "pointer" }}
              >
                <TypeBadge type={r.type} deferred={false} />
                {basename(r.path)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Status bar */}
      {status && (
        <div style={{ background: "#111", borderRadius: "3px", padding: "4px 8px", fontSize: "11px", color: "#aaa" }}>
          {status}
        </div>
      )}
    </div>
  );
}
