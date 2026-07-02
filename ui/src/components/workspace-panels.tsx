// Spec 724B / BUG-011/012 — shared workspace visualization panels.
//
// These are the REAL v1 visualizations (heatmap grid, SVG cylindrical disk,
// bank/chip grid, SVG flow graph), extracted verbatim from the monolithic
// ui/src/App.tsx so BOTH the v1 entry and the v3 One-UI shell render the same
// product UI (no JSON dump). Pure view-model consumers: they take the workspace
// snapshot (or a sub-view) + selection callbacks. v3 passes no-op callbacks for
// the cross-panel inspector navigation; panel-internal selection/detail stays
// fully functional. No runtime/backend/VICE coupling.
//
// Spec 757 — co-locate the panel CSS with the component that uses it, so the ONE
// UI bundle is self-sufficient. (It used to reach the bundle only via the deleted
// standalone v3 style.css @import; the product never imported it directly, leaving
// panel classes like `wb-embedded` unstyled.)
import "./workspace-panels.css";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ArtifactRecord, CartridgeLutChunk } from "../types.js";
import type {
  EntityRecord,
  FlowGraphView,
  MemoryMapView,
  RelationRecord,
  WorkspaceUiSnapshot,
} from "../types.js";
import { MediumPanelShell, type MediumOriginPillSpec } from "./MediumPanelShell.js";
import { BootTracePanel } from "./BootTracePanel.js";
import { CartridgeMemoryGrid } from "./CartridgeMemoryGrid.js";
import { latestArtifactsByLineage, lineageVersionCount } from "../lib/lineage.js";
import { isInternalArtifact, isInternalEntity } from "../lib/internal.js";

// Inspector/visibility infra (extracted from App.tsx; defaults work with NO
// Provider — e.g. in the v3 shell). v1 still wraps these contexts with its
// header toggles; v3 just uses the defaults.
export type TabId = "dashboard" | "questions" | "docs" | "memory" | "graphics" | "scrub" | "cartridge" | "disk" | "payloads" | "flow" | "listing";
const C64_BINARY_EXTENSIONS = new Set([".prg", ".bin", ".crt", ".d64", ".g64", ".sid", ".raw"]);
export function isC64BinaryArtifact(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return C64_BINARY_EXTENSIONS.has(lower.slice(dot));
}
export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) { if (!seen.has(item.id)) { seen.add(item.id); out.push(item); } }
  return out;
}
export const LineageVisibilityContext = createContext<{ showAllVersions: boolean; latest: <T extends ArtifactRecord>(items: T[]) => T[]; }>(
  { showAllVersions: false, latest: (items) => latestArtifactsByLineage(items) });
export function useLineageVisibility() { return useContext(LineageVisibilityContext); }
export const InternalVisibilityContext = createContext<{
  showInternal: boolean;
  visibleArtifacts: <T extends ArtifactRecord>(items: T[]) => T[];
  visibleEntities: <T extends EntityRecord>(items: T[], artifactsById: Map<string, ArtifactRecord>) => T[];
}>({
  showInternal: false,
  visibleArtifacts: (items) => items.filter((a) => !isInternalArtifact(a)),
  visibleEntities: (items, byId) => items.filter((e) => !isInternalEntity(e, byId)),
});
export function useInternalVisibility() { return useContext(InternalVisibilityContext); }

export interface LlmTodoActions {
  onCreateTask: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
  onCreateQuestion: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
}
export type InspectorMode = "disk-file" | "memory" | "flow" | "payload" | "cartridge" | "generic";

// Two-column workbench layout shared by every visualization view: a primary
// visual area on the left + the Inspector side panel on the right. Restores the
// v1 app-main-grid arrangement (BUG-014) instead of a vertical stack.
export function Workbench({ main, side }: { main: ReactNode; side: ReactNode }): React.JSX.Element {
  return (
    <div className="app-main-grid wb-embedded">
      <section className="workspace-main">{main}</section>
      <aside className="workspace-side">{side}</aside>
    </div>
  );
}

// ---- shared pure helpers (extracted from App.tsx) ----

export function hex(value: number, digits = 4): string {
  return `$${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}

export function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function artifactMediaClass(kind: string | undefined): "disk" | "cartridge" | "other" {
  if (!kind) return "other";
  const k = kind.toLowerCase();
  if (k.includes("d64") || k.includes("g64") || k.includes("disk")) return "disk";
  if (k.includes("crt") || k.includes("cart") || k.includes("chip")) return "cartridge";
  return "other";
}

function d64SectorOffset(track: number, sector: number): number {
  let offset = 0;
  for (let t = 1; t < track; t += 1) {
    const perTrack = t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17;
    offset += perTrack * 256;
  }
  return offset + sector * 256;
}

function d64SectorsInTrack(track: number): number {
  return track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17;
}

function PhaseBadge({ phase, frozen }: { phase?: number; frozen?: boolean }) {
  const current = phase ?? 1;
  const cells = [1, 2, 3, 4, 5, 6, 7].map((p) => {
    if (frozen && p === current) return "🔒";
    if (p < current) return "✓";
    if (p === current) return "•";
    return "⨯";
  }).join("");
  const label = frozen ? `frozen at phase ${current}` : `phase ${current}/7`;
  return (
    <span className="phase-badge" title={label} aria-label={label}>
      {cells}
    </span>
  );
}

type MediaFilter = "all" | "disk" | "cartridge";
export type DiskFileSelection = { diskArtifactId: string; fileId: string };

export function MemoryMapPanel({
  snapshot,
  selectedEntityId,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  selectedEntityId?: string | null;
  onSelectEntity: (entityId: string) => void;
}) {
  const view = snapshot.views.memoryMap;
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [selectedStageKeys, setSelectedStageKeys] = useState<string[]>([]);
  const [showMediumOnly, setShowMediumOnly] = useState<boolean>(false);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const columnOffsets = Array.from({ length: 16 }, (_, index) => index * view.cellSize);
  const rowBases = Array.from({ length: 16 }, (_, index) => index * view.rowStride);
  const artifactKindById = useMemo(() => {
    const map = new Map<string, string>();
    for (const artifact of snapshot.artifacts) map.set(artifact.id, artifact.kind);
    return map;
  }, [snapshot.artifacts]);
  // Pre-compute the effective entity count per stage. A stage filter only
  // affects the heatmap when at least one entity resolves either via
  // stage.entityIds directly OR via an entity whose artifactIds back-
  // references one of stage.artifactIds. Without this hint, stages whose
  // analysis-run artifact has no back-linked entities (very common when
  // bulk CLI registers populate artifacts.json without corresponding
  // import_analysis_report runs) silently filter to nothing — option
  // turns blue, heatmap stays the same. Counting upfront lets the UI
  // disable / annotate empty stages.
  const entitiesByArtifactId = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const entity of snapshot.entities) {
      for (const artifactId of entity.artifactIds) {
        let set = map.get(artifactId);
        if (!set) { set = new Set(); map.set(artifactId, set); }
        set.add(entity.id);
      }
    }
    return map;
  }, [snapshot.entities]);

  // Only include stages that actually filter the heatmap. A stage is
  // "filterable" when it has at least one entity that lives somewhere in
  // the address space (directly via item.entityIds, or transitively via
  // an entity whose artifactIds back-references item.artifactIds).
  // Stages built from generated-source / rebuilt PRG / preview artifacts
  // never have entities and would render as no-op options. The banner
  // separately surfaces unimported-analysis artifacts so the user knows
  // why the dropdown looks short.
  const allStageOptions = snapshot.views.loadSequence.items
    .map((item) => {
      const effective = new Set<string>(item.entityIds);
      for (const artifactId of item.artifactIds) {
        const linked = entitiesByArtifactId.get(artifactId);
        if (linked) for (const id of linked) effective.add(id);
      }
      return {
        key: item.key,
        title: item.title,
        entityIds: item.entityIds,
        artifactIds: item.artifactIds,
        mediaKinds: new Set(item.artifactIds.map((id) => artifactMediaClass(artifactKindById.get(id)))),
        effectiveEntityCount: effective.size,
      };
    })
    .filter((item) => item.effectiveEntityCount > 0);
  const diskStageCount = allStageOptions.filter((stage) => stage.mediaKinds.has("disk")).length;
  const cartStageCount = allStageOptions.filter((stage) => stage.mediaKinds.has("cartridge")).length;
  const showMediaFilter = diskStageCount > 0 && cartStageCount > 0;
  const stageOptions = mediaFilter === "all"
    ? allStageOptions
    : allStageOptions.filter((stage) => stage.mediaKinds.has(mediaFilter));

  const focusedStages = stageOptions.filter((item) => selectedStageKeys.includes(item.key));
  const focusedArtifactIds = new Set(focusedStages.flatMap((item) => item.artifactIds));
  const focusedEntityIds = new Set<string>();
  for (const stage of focusedStages) {
    for (const entityId of stage.entityIds) {
      focusedEntityIds.add(entityId);
    }
  }
  for (const entity of snapshot.entities) {
    if (entity.artifactIds.some((artifactId) => focusedArtifactIds.has(artifactId))) {
      focusedEntityIds.add(entity.id);
    }
  }

  const hasStageFilter = focusedEntityIds.size > 0;
  const visibleCells = view.cells.filter((cell) => !hasStageFilter || cell.entityIds.some((entityId) => focusedEntityIds.has(entityId)));
  const cellByStart = new Map(view.cells.map((cell) => [cell.start, cell]));
  const selectedEntity = selectedEntityId ? snapshot.entities.find((entity) => entity.id === selectedEntityId) : undefined;
  const selectedEntityRegionIds = new Set(view.regions.filter((region) => region.entityId === selectedEntityId).map((region) => region.id));
  const selectedEntityCell = selectedEntityId
    ? visibleCells.find((cell) =>
      cell.entityIds.includes(selectedEntityId)
      || cell.dominantEntityId === selectedEntityId
      || cell.regionIds.some((regionId) => selectedEntityRegionIds.has(regionId))
      || (selectedEntity?.addressRange !== undefined && selectedEntity.addressRange.start >= cell.start && selectedEntity.addressRange.start <= cell.end)
    )
      ?? view.cells.find((cell) =>
        cell.entityIds.includes(selectedEntityId)
        || cell.dominantEntityId === selectedEntityId
        || cell.regionIds.some((regionId) => selectedEntityRegionIds.has(regionId))
        || (selectedEntity?.addressRange !== undefined && selectedEntity.addressRange.start >= cell.start && selectedEntity.addressRange.start <= cell.end)
      )
    : undefined;
  const selectedCell = selectedEntityCell
    ?? visibleCells.find((cell) => cell.id === selectedCellId)
    ?? visibleCells.find((cell) => cell.category !== "free")
    ?? view.cells.find((cell) => cell.id === selectedCellId)
    ?? view.cells.find((cell) => cell.category !== "free")
    ?? view.cells[0];
  const selectedRegions = view.regions
    .filter((region) =>
      selectedCell?.regionIds.includes(region.id) &&
      (showMediumOnly || !region.mediumOnly) &&
      (!hasStageFilter || (region.entityId !== undefined && focusedEntityIds.has(region.entityId)))
    )
    .sort((left, right) => left.start - right.start);
  const visibleHighlights = view.highlights.filter((item) => !hasStageFilter || (item.entityId !== undefined && focusedEntityIds.has(item.entityId)));

  useEffect(() => {
    if (!selectedEntityId) return;
    const matchingCell = view.cells.find((cell) => cell.entityIds.includes(selectedEntityId) || cell.dominantEntityId === selectedEntityId);
    if (matchingCell && matchingCell.id !== selectedCellId) {
      setSelectedCellId(matchingCell.id);
    }
  }, [selectedEntityId, selectedCellId, view.cells]);

  useEffect(() => {
    if (!selectedCell) return;
    const preferredEntityId = selectedEntityId && selectedRegions.some((region) => region.entityId === selectedEntityId)
      ? selectedEntityId
      : selectedCell.dominantEntityId
      ?? (selectedRegions.length === 1 ? selectedRegions[0].entityId : undefined)
      ?? selectedRegions.find((region) => region.entityId !== undefined)?.entityId
      ?? selectedCell.entityIds[0];
    if (preferredEntityId) {
      onSelectEntity(preferredEntityId);
    }
  }, [onSelectEntity, selectedCell, selectedRegions]);

  function labelHex(value: number, digits: number): string {
    return value.toString(16).toUpperCase().padStart(digits, "0");
  }

  function preferredEntityForCell(cell: MemoryMapView["cells"][number]): string | undefined {
    return cell.dominantEntityId ?? cell.entityIds[0];
  }

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Address Space</h3>
        <span>{view.regions.length} mapped regions / {view.cells.length} heatmap cells</span>
      </div>
      {showMediaFilter ? (
        <div className="cart-lut-filter">
          <span className="cart-lut-filter-title">Source</span>
          <button
            type="button"
            className={mediaFilter === "all" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => { setMediaFilter("all"); setSelectedStageKeys([]); }}
          >
            <span>all</span>
            <span className="cart-lut-pill-count">{allStageOptions.length}</span>
          </button>
          <button
            type="button"
            className={mediaFilter === "disk" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => { setMediaFilter("disk"); setSelectedStageKeys([]); }}
          >
            <span>disk</span>
            <span className="cart-lut-pill-count">{diskStageCount}</span>
          </button>
          <button
            type="button"
            className={mediaFilter === "cartridge" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => { setMediaFilter("cartridge"); setSelectedStageKeys([]); }}
          >
            <span>cartridge</span>
            <span className="cart-lut-pill-count">{cartStageCount}</span>
          </button>
        </div>
      ) : null}
      <div className="memory-grid-panel">
        <div className="memory-legend">
          <div className="memory-legend-scale">
            <span><i className="legend-swatch legend-free" /> free</span>
            <span><i className="legend-swatch legend-code" /> code</span>
            <span><i className="legend-swatch legend-data" /> data</span>
            <span><i className="legend-swatch legend-system" /> system</span>
            <span><i className="legend-swatch legend-other" /> other</span>
          </div>
          <div className="memory-filter">
            <label className="memory-medium-toggle">
              <input
                type="checkbox"
                checked={showMediumOnly}
                onChange={(e) => setShowMediumOnly(e.target.checked)}
              />
              <span>Show cart/disk-resident regions</span>
            </label>
            <div className="memory-filter-header">
              <span>Payload focus</span>
              {selectedStageKeys.length > 0 ? (
                <button type="button" className="memory-filter-clear" onClick={() => setSelectedStageKeys([])}>clear</button>
              ) : null}
            </div>
            <div className="memory-filter-list" role="listbox" aria-multiselectable="true">
              {stageOptions.map((item) => {
                const active = selectedStageKeys.includes(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={active ? "memory-filter-pill memory-filter-pill-active" : "memory-filter-pill"}
                    onClick={() => {
                      setSelectedStageKeys((current) =>
                        current.includes(item.key)
                          ? current.filter((k) => k !== item.key)
                          : [...current, item.key]
                      );
                    }}
                  >
                    <span className="memory-filter-pill-title">{item.title}</span>
                    <span className="memory-filter-pill-count">{item.effectiveEntityCount}</span>
                  </button>
                );
              })}
            </div>
            <small>
              {hasStageFilter
                ? `${focusedStages.length} payloads focused, ${focusedEntityIds.size} entities matched`
                : stageOptions.length === 0
                  ? "No filterable stages yet. Run bulk_import_analysis_reports to back-fill analysis JSON into entities."
                  : "No filter. Showing full address space."}
            </small>
          </div>
        </div>
        <div className="memory-grid-wrap">
          <table className="memory-grid-table">
            <thead>
              <tr>
                <th>addr</th>
                {columnOffsets.map((offset) => (
                  <th key={offset}>{labelHex(offset, 3)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowBases.map((rowBase) => (
                <tr key={rowBase}>
                  <th>{labelHex(rowBase, 4)}</th>
                  {columnOffsets.map((columnOffset) => {
                    const cell = cellByStart.get(rowBase + columnOffset);
                    if (!cell) {
                      return <td key={columnOffset} />;
                    }
                    const isFocused = !hasStageFilter || cell.entityIds.some((entityId) => focusedEntityIds.has(entityId));
                    return (
                      <td key={columnOffset}>
                        <button
                          type="button"
                          className={[
                            "memory-cell",
                            `category-${cell.category}`,
                            selectedCell?.id === cell.id ? "selected" : "",
                            !isFocused ? "dimmed" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() => {
                            setSelectedCellId(cell.id);
                            const entityId = preferredEntityForCell(cell);
                            if (entityId) onSelectEntity(entityId);
                          }}
                          title={`${labelHex(cell.start, 4)}-${labelHex(cell.end, 4)} ${cell.dominantTitle}`}
                          style={{ opacity: (0.28 + cell.occupancy * 0.72) * (isFocused ? 1 : 0.22) }}
                        >
                          <span className="sr-only">{cell.dominantTitle}</span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="split-columns">
        <div className="detail-card">
          <div className="detail-title-row">
            <h4>Memory Highlights</h4>
            <span>derived summary</span>
          </div>
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Range</th>
                <th>Size</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visibleHighlights.map((item) => (
                <tr key={item.id} className={item.entityId === selectedEntityId ? "active-row" : ""} onClick={() => item.entityId && onSelectEntity(item.entityId)}>
                  <td>{item.title}</td>
                  <td>{hex(item.start)}-{hex(item.end)}</td>
                  <td>{item.sizeBytes}</td>
                  <td>{item.summary ?? item.kind}</td>
                </tr>
              ))}
              {visibleHighlights.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-table-cell">No highlight matches the current payload focus.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="detail-card">
          <div className="detail-title-row">
            <h4>Selected Cell</h4>
            <span>{selectedCell ? `${hex(selectedCell.start)}-${hex(selectedCell.end)}` : "none"}</span>
          </div>
          {selectedCell ? (
            <>
              <div className="record-meta">
                <span>{selectedCell.dominantTitle}</span>
                <span>{selectedCell.dominantKind}</span>
                <span>{pct(selectedCell.occupancy)}</span>
              </div>
              <div className="record-stack compact">
                {selectedRegions.length === 0 ? <div className="empty-state">No mapped entities in this cell.</div> : null}
                {selectedRegions.map((region) => (
                  <button
                    key={region.id}
                    type="button"
                    className={region.entityId === selectedEntityId ? "record-card active-record" : "record-card"}
                    onClick={() => region.entityId && onSelectEntity(region.entityId)}
                    disabled={!region.entityId}
                  >
                    <div className="record-topline">
                      <span>{region.title}</span>
                      <span className="record-status">{region.kind}</span>
                    </div>
                    <p>{hex(region.start)}-{hex(region.end)}</p>
                    <div className="record-meta">
                      <span>{pct(region.confidence)}</span>
                      {region.bank !== undefined ? <span>bank {region.bank}</span> : null}
                    </div>
                    {region.summary ? <p>{region.summary}</p> : null}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-state">No cell selected.</div>
          )}
        </div>
      </div>
    </section>
  );
}

export function CartridgePanel({
  snapshot,
  onSelectEntity,
  onSelectChunk,
  onOpenHex,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
  onSelectChunk: (cartridgeArtifactId: string, chunk: CartridgeLutChunk) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number>; markers?: Array<{ offset: number; label: string }> }) => void;
}) {
  function findChipEntity(bank: number, loadAddress: number) {
    return snapshot.entities.find((entity) =>
      entity.kind === "chip" &&
      entity.addressRange?.bank === bank &&
      entity.addressRange?.start === loadAddress,
    );
  }
  function findBankEntity(bank: number) {
    return snapshot.entities.find((entity) => entity.name === `bank_${String(bank).padStart(2, "0")}`);
  }
  function chipArtifactPath(file: string | undefined, manifestPath: string | undefined) {
    if (!file) return undefined;
    if (!manifestPath) return file;
    const dir = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/")) : "";
    return dir ? `${dir}/${file}` : file;
  }
  return (
    <MediumPanelShell
      title="Cartridge Layout"
      countSummary={`${snapshot.views.cartridgeLayout.cartridges.length} cartridges`}
    >
      {snapshot.views.cartridgeLayout.cartridges.map((cartridge) => (
        <BootTracePanel
          key={`boot-${cartridge.artifactId}`}
          snapshot={snapshot}
          mediumArtifactId={cartridge.artifactId}
          onSelectEntity={onSelectEntity}
        />
      ))}
      <div className="cart-grid-list">
        {snapshot.views.cartridgeLayout.cartridges.map((cartridge) => {
          const manifestArtifact = snapshot.artifacts.find((artifact) => artifact.id === cartridge.artifactId);
          return (
            <CartridgeMemoryGrid
              key={cartridge.artifactId}
              cartridgeName={cartridge.cartridgeName ?? cartridge.title}
              hardwareType={cartridge.hardwareType}
              exrom={cartridge.exrom}
              game={cartridge.game}
              chips={cartridge.chips}
              banks={cartridge.banks}
              slotLayout={cartridge.slotLayout}
              lutChunks={cartridge.lutChunks}
              payloadChunks={cartridge.payloadChunks}
              emptyRegions={cartridge.emptyRegions}
              segments={cartridge.segments}
              startup={cartridge.startup}
              onSelectChip={(chip) => {
                const entity = findChipEntity(chip.bank, chip.loadAddress);
                if (entity) onSelectEntity(entity.id);
              }}
              onSelectBank={(bank) => {
                const entity = findBankEntity(bank.bank);
                if (entity) onSelectEntity(entity.id);
              }}
              onSelectLutChunk={(chunk) => onSelectChunk(cartridge.artifactId, chunk)}
              onSelectPayloadChunk={(chunk) => onSelectEntity(chunk.entityId)}
              onSelectSegment={(segment) => {
                // Synthesize a CartridgeLutChunk from the segment so the
                // existing CartChunkInspector renders for it. Segments do
                // not have LUT refs, so we use a synthetic "(segment)"
                // lut+index pair to drive the inspector header. The chip
                // file is resolved the same way as for chunks.
                const synthetic: CartridgeLutChunk = {
                  bank: segment.bank,
                  slot: segment.slot,
                  offsetInBank: segment.offsetInBank,
                  length: segment.length,
                  lut: "(segment)",
                  index: 0,
                  destAddress: segment.destAddress,
                  refs: [],
                  spans: [{ bank: segment.bank, offsetInBank: segment.offsetInBank, length: segment.length }],
                  label: segment.label ?? segment.kind,
                  notes: [`Resident segment classified as ${segment.kind}`],
                };
                onSelectChunk(cartridge.artifactId, synthetic);
              }}
              onOpenBankHex={(_bank, chip) => {
                if (!chip) return;
                const path = chipArtifactPath(chip.file, manifestArtifact?.relativePath);
                if (!path) return;
                const slotBase = chip.slot === "ROMH"
                  ? (cartridge.slotLayout?.isUltimax ? 0xe000 : 0xa000)
                  : (chip.slot === "ULTIMAX_ROMH" ? 0xe000 : 0x8000);
                onOpenHex(path, {
                  title: `${cartridge.cartridgeName ?? cartridge.title} · Bank ${String(chip.bank).padStart(2, "0")} ${chip.slot ?? "ROML"}`,
                  baseAddress: slotBase,
                });
              }}
            />
          );
        })}
      </div>
    </MediumPanelShell>
  );
}

type DiskOriginFilter = "all" | "kernal" | "custom-loader" | "unknown";

export function DiskPanel({
  snapshot,
  selectedDiskFile,
  onSelectEntity,
  onSelectDiskFile,
  onOpenHex,
}: {
  snapshot: WorkspaceUiSnapshot;
  selectedDiskFile?: DiskFileSelection | null;
  onSelectEntity: (entityId: string) => void;
  onSelectDiskFile: (diskArtifactId: string, fileId: string) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number>; markers?: Array<{ offset: number; label: string }> }) => void;
}) {
  const disks = snapshot.views.diskLayout.disks;
  const [activeDiskId, setActiveDiskId] = useState<string | null>(disks[0]?.artifactId ?? null);
  const activeDisk = disks.find((disk) => disk.artifactId === activeDiskId) ?? disks[0];
  const [selectedFileId, setSelectedFileId] = useState<string | null>(activeDisk?.files[0]?.id ?? null);
  const [originFilter, setOriginFilter] = useState<DiskOriginFilter>("all");
  // BUG-017 — raw track/sector navigation: which sector cell is selected for
  // direct inspection (independent of directory-file selection).
  const [selectedSector, setSelectedSector] = useState<{ track: number; sector: number } | null>(null);
  // BUG-017 (track grid) — which whole track is selected via the track strip.
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  // clear the raw-sector + track selection when the active disk changes
  useEffect(() => { setSelectedSector(null); setSelectedTrack(null); }, [activeDiskId]);

  // BUG-008 — sync the active disk to the GLOBAL selection (selectedDiskFile)
  // ONLY when that selection genuinely changes. The previous version kept
  // activeDiskId in the deps and unconditionally forced it back to the prop's
  // disk on every render, so clicking a different disk tab (which updates the
  // local activeDiskId before the global prop catches up) was immediately
  // reverted to the first/previous disk. Guarding on the last-synced selection
  // key lets local tab clicks win while still following external selections.
  const lastSyncedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedDiskFile) return;
    const key = `${selectedDiskFile.diskArtifactId}:${selectedDiskFile.fileId}`;
    if (lastSyncedSelectionRef.current === key) return; // already applied — don't fight local clicks
    const disk = disks.find((candidate) => candidate.artifactId === selectedDiskFile.diskArtifactId);
    if (!disk || !disk.files.some((file) => file.id === selectedDiskFile.fileId)) return;
    lastSyncedSelectionRef.current = key;
    setActiveDiskId(disk.artifactId);
    setSelectedFileId(selectedDiskFile.fileId);
  }, [disks, selectedDiskFile]);

  useEffect(() => {
    if (!activeDisk) {
      setSelectedFileId(null);
      return;
    }
    const hasSelection = activeDisk.files.some((file) => file.id === selectedFileId);
    if (!hasSelection) {
      const fallback = activeDisk.files[0];
      if (fallback) {
        setSelectedFileId(fallback.id);
        // Also route the selection into the global inspector pipeline
        // so the right-hand panel immediately shows the first file
        // instead of the empty "Select a memory region…" state.
        onSelectDiskFile(activeDisk.artifactId, fallback.id);
      } else {
        setSelectedFileId(null);
      }
    }
  }, [activeDisk, selectedFileId, onSelectDiskFile]);

  function polar(cx: number, cy: number, radius: number, angle: number) {
    return {
      x: cx + radius * Math.cos(angle - Math.PI / 2),
      y: cy + radius * Math.sin(angle - Math.PI / 2),
    };
  }

  function sectorPath(track: number, angleStart: number, angleEnd: number) {
    const cx = 320;
    const cy = 320;
    const outerRadius = 280;
    const innerRadius = 72;
    const ringWidth = (outerRadius - innerRadius) / Math.max(activeDisk?.trackCount ?? 35, 1);
    const outer = outerRadius - (track - 1) * ringWidth;
    const inner = outer - ringWidth + 1;
    const startOuter = polar(cx, cy, outer, angleStart);
    const endOuter = polar(cx, cy, outer, angleEnd);
    const startInner = polar(cx, cy, inner, angleStart);
    const endInner = polar(cx, cy, inner, angleEnd);
    const largeArc = angleEnd - angleStart > Math.PI ? 1 : 0;
    return [
      `M ${startOuter.x} ${startOuter.y}`,
      `A ${outer} ${outer} 0 ${largeArc} 1 ${endOuter.x} ${endOuter.y}`,
      `L ${endInner.x} ${endInner.y}`,
      `A ${inner} ${inner} 0 ${largeArc} 0 ${startInner.x} ${startInner.y}`,
      "Z",
    ].join(" ");
  }

  const originCounts = new Map<DiskOriginFilter, number>();
  originCounts.set("kernal", 0);
  originCounts.set("custom-loader", 0);
  originCounts.set("unknown", 0);
  for (const file of activeDisk?.files ?? []) {
    originCounts.set(file.loadType, (originCounts.get(file.loadType) ?? 0) + 1);
  }
  const visibleFiles = (activeDisk?.files ?? []).filter((file) => originFilter === "all" || file.loadType === originFilter);
  const visibleFileIds = new Set(visibleFiles.map((file) => file.id));

  const selectedFile = visibleFiles.find((file) => file.id === selectedFileId) ?? visibleFiles[0] ?? activeDisk?.files.find((file) => file.id === selectedFileId) ?? activeDisk?.files[0];
  const freeBlocks = activeDisk?.sectors.filter((sector) => sector.category === "free").length ?? 0;
  // BUG-017 — disk image path for raw sector reads (/api/disk/sector-bytes).
  const diskArtifactForPath = activeDisk ? snapshot.artifacts.find((art) => art.id === activeDisk.artifactId) : undefined;
  const diskImagePath = activeDisk?.imageRelativePath ?? diskArtifactForPath?.relativePath ?? "";
  const diskDisplayName = activeDisk ? (activeDisk.diskName ?? activeDisk.title) : "";
  // Open the raw 256-byte hex view of a sector + mark it (and its track) selected.
  function inspectSector(track: number, sector: number) {
    setSelectedSector({ track, sector });
    setSelectedTrack(track);
    if (!diskImagePath) return;
    const params = new URLSearchParams({
      projectDir: snapshot.project.rootPath,
      path: diskImagePath,
      track: String(track),
      sector: String(sector),
    });
    onOpenHex(diskImagePath, {
      title: `${diskDisplayName} · T${track}/S${sector}`,
      baseAddress: 0,
      length: 256,
      fetchUrl: `/api/disk/sector-bytes?${params.toString()}`,
    });
  }
  // Real track count = the highest track that actually has sectors (covers
  // extended/42-track G64 images, not just the nominal trackCount).
  const diskMaxTrack = Math.max(
    activeDisk?.trackCount ?? 0,
    ...(activeDisk?.sectors ?? []).map((s) => s.track),
    0,
  );
  // Sectors of the selected track, in order — drives the sector sub-strip.
  const sectorsOfSelectedTrack = selectedTrack === null
    ? []
    : (activeDisk?.sectors ?? [])
        .filter((s) => s.track === selectedTrack)
        .slice()
        .sort((a, b) => a.sector - b.sector);
  const isD64Image = diskImagePath.toLowerCase().endsWith(".d64");
  // Click a whole track in the strip → open the WHOLE track in the hex/monitor
  // overlay: every sector concatenated (256 B each), with a separator line
  // labelling each sector. Format-agnostic via /api/disk/track-bytes (D64 + G64).
  function showTrack(track: number) {
    setSelectedTrack(track);
    setSelectedSector(null);
    if (!diskImagePath) return;
    const sectorCount = d64SectorsInTrack(track); // 256-byte stride is fixed; count by speed zone
    const markers = Array.from({ length: sectorCount }, (_, i) => ({
      offset: i * 256,
      label: `Track ${track} · Sector ${i}`,
    }));
    const params = new URLSearchParams({
      projectDir: snapshot.project.rootPath,
      path: diskImagePath,
      track: String(track),
    });
    onOpenHex(diskImagePath, {
      title: `${diskDisplayName} · Track ${track} (${sectorCount} sectors)`,
      baseAddress: 0,
      fetchUrl: `/api/disk/track-bytes?${params.toString()}`,
      markers,
    });
  }
  const directoryLines = activeDisk
    ? [
        `0 "${(activeDisk.diskName ?? activeDisk.title).toUpperCase()}" ${(activeDisk.diskId ?? "--").toUpperCase()}`,
        ...activeDisk.files.map((file) =>
          `${String(file.sizeSectors ?? 0).padStart(3, " ")} "${(file.title ?? "").toUpperCase()}" ${file.type.toLowerCase()}`,
        ),
        `${String(freeBlocks).padStart(3, " ")} BLOCKS FREE.`,
      ]
    : [];

  const filterPills: MediumOriginPillSpec[] = activeDisk && activeDisk.files.length > 0
    ? [
        { key: "all", label: "all", count: activeDisk.files.length },
        ...(["kernal", "custom-loader", "unknown"] as const)
          .map((origin) => ({ key: origin, label: origin, count: originCounts.get(origin) ?? 0 }))
          .filter((pill) => pill.count > 0 || originFilter === pill.key),
      ]
    : [];

  const tabs = disks.length > 1 ? (
    <div className="disk-tab-strip">
      {disks.map((disk) => {
        const diskArtifact = snapshot.artifacts.find((artifact) => artifact.id === disk.artifactId);
        const path = diskArtifact?.relativePath ?? "";
        const label = disk.imageFileName
          ?? (disk.imageRelativePath ? disk.imageRelativePath.split("/").pop() : undefined)
          ?? disk.diskName
          ?? disk.title;
        return (
          <button
            key={disk.artifactId}
            type="button"
            className={activeDisk?.artifactId === disk.artifactId ? "tab-button active" : "tab-button"}
            onClick={() => {
              setActiveDiskId(disk.artifactId);
              const first = disk.files[0]?.id ?? null;
              setSelectedFileId(first);
              // Follow the disk switch in the inspector. The BUG-008 ref-guard
              // means this global update won't bounce activeDiskId back.
              if (first) onSelectDiskFile(disk.artifactId, first);
            }}
            title={path || disk.title}
          >
            {label}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <MediumPanelShell
      title="Disk Layout"
      countSummary={`${disks.length} images`}
      filterTitle={filterPills.length > 0 ? "Origin" : undefined}
      filterPills={filterPills}
      activeFilter={originFilter}
      onSelectFilter={(key) => setOriginFilter(key as DiskOriginFilter)}
      tabs={tabs}
    >
      {activeDisk ? (
        <BootTracePanel
          snapshot={snapshot}
          mediumArtifactId={activeDisk.artifactId}
          onSelectEntity={onSelectEntity}
        />
      ) : null}
      {!activeDisk ? (
        <div className="empty-state">No disk manifests available.</div>
      ) : (
        <div className="disk-layout-shell">
          <div className="disk-left-column">
            <div className="disk-file-list panel-card inner-panel">
              <div className="detail-title-row">
                <h4>{activeDisk.diskName ?? activeDisk.title}</h4>
                <span>{activeDisk.format.toUpperCase()} [{activeDisk.diskId ?? "--"}]</span>
              </div>
              <div className="record-stack disk-file-stack">
                {visibleFiles.map((file) => {
                  // Spec 050 Block D: phase badge per disk file via
                  // entity → payloadSourceArtifactId → artifact.phase.
                  const entity = file.entityId ? snapshot.entities.find((e) => e.id === file.entityId) : undefined;
                  const sourceArt = entity ? snapshot.artifacts.find((a) => a.id === (entity.payloadSourceArtifactId ?? entity.artifactIds[0])) : undefined;
                  return (
                    <button
                      key={file.id}
                      type="button"
                      className={selectedFile?.id === file.id ? "record-card active-record" : "record-card"}
                      onClick={() => {
                        setSelectedFileId(file.id);
                        onSelectDiskFile(activeDisk.artifactId, file.id);
                      }}
                    >
                      <div className="record-topline">
                        <span className="disk-file-row-title">
                          <span className="disk-file-color-dot" style={{ background: file.color ?? "#6e7681" }} />
                          <span>{file.relativePath ?? file.title}</span>
                        </span>
                        {sourceArt ? <PhaseBadge phase={sourceArt.phase} frozen={sourceArt.phaseFrozen} /> : null}
                        {/* Spec 750 — code-derived payload entries (origin=custom) read off the
                            disk by the custom loader; flag the ones not yet attributed to a
                            specific disk image (no mediumRef) so they read honestly. */}
                        {file.origin === "custom" ? <span className="record-status" title="registered payload (code-derived raw region)">custom</span> : null}
                        {file.unscoped ? <span className="record-status" style={{ opacity: 0.7 }} title="image not yet attributed (no mediumRef) — shown on all disks">unscoped</span> : null}
                        <span className="record-status">{file.loadType}</span>
                      </div>
                      <div className="record-meta">
                        <span>{file.sizeSectors ?? 0} blk</span>
                        {file.loadAddress !== undefined ? <span>{hex(file.loadAddress)}</span> : null}
                        {file.loaderSource ? <span>via {file.loaderSource}</span> : null}
                        {file.packer ? <span>{file.packer}</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="panel-card inner-panel">
              <div className="detail-title-row">
                <h4>Directory</h4>
                <span>track 18 / BAM</span>
              </div>
              <pre className="directory-listing">{directoryLines.join("\n")}</pre>
            </div>
          </div>
          <div className="panel-card inner-panel">
            <div className="detail-title-row">
              <h4>Disk Geometry</h4>
              <span>track/sector occupancy</span>
            </div>
            {/* BUG-017 (track grid) — compact clickable track strip between the
                header and the circular geometry. Works for every format. The track
                count comes from the REAL sectors present (so extended/42-track G64
                images show tracks 36-42, not just the nominal 35). Selecting a
                track reveals a sector sub-strip so every sector is reachable. */}
            <div className="disk-track-strip">
              <span className="disk-track-strip-label">Track</span>
              {Array.from({ length: diskMaxTrack }, (_, i) => i + 1).map((track) => (
                <button
                  key={track}
                  type="button"
                  className={selectedTrack === track ? "disk-track-mon active" : "disk-track-mon"}
                  title={isD64Image
                    ? `Show track ${track} (${d64SectorsInTrack(track)} sectors) in the hex view`
                    : `Select track ${track} — then pick a sector below`}
                  onClick={() => showTrack(track)}
                >
                  {track}
                </button>
              ))}
            </div>
            {selectedTrack !== null && sectorsOfSelectedTrack.length > 0 ? (
              <div className="disk-track-strip disk-sector-substrip">
                <span className="disk-track-strip-label">T{selectedTrack} · Sec</span>
                {sectorsOfSelectedTrack.map((s) => {
                  const isCur = selectedSector?.track === s.track && selectedSector?.sector === s.sector;
                  return (
                    <button
                      key={s.sector}
                      type="button"
                      className={isCur ? "disk-track-mon active" : "disk-track-mon"}
                      title={`Show track ${s.track} sector ${s.sector} (256 B)${s.category ? " · " + s.category : ""}`}
                      onClick={() => inspectSector(s.track, s.sector)}
                    >
                      {s.sector}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="disk-geometry-wrap">
              <svg viewBox="0 0 640 640" className="disk-geometry-svg" role="img" aria-label="Disk geometry">
                <circle cx="320" cy="320" r="58" className="disk-center-hole" />
                {activeDisk.sectors.map((sector) => {
                  const selectionActive = selectedFile?.id !== undefined;
                  const isSelected = selectionActive && sector.fileId === selectedFile!.id;
                  // BUG-017 — raw-sector selection (independent of file selection).
                  const isSectorSelected = selectedSector?.track === sector.track && selectedSector?.sector === sector.sector;
                  // BUG-017 (track grid) — whole-track highlight from the strip.
                  const isTrackSelected = selectedTrack === sector.track;
                  const filteredOut = sector.fileId !== undefined && !visibleFileIds.has(sector.fileId);
                  const dimmed = !isSelected && !isSectorSelected && !isTrackSelected && (filteredOut || selectionActive);
                  const className = [
                    "disk-sector",
                    "disk-sector-clickable",
                    `disk-sector-${sector.category}`,
                    isSelected ? "selected" : "",
                    isSectorSelected ? "sector-selected" : "",
                    isTrackSelected ? "track-selected" : "",
                    dimmed ? "disk-sector-dimmed" : "",
                    filteredOut ? "disk-sector-filtered-out" : "",
                  ].filter(Boolean).join(" ");
                  const useFileColor = sector.category === "file" && sector.color && !filteredOut;
                  // Spec 037 / Sprint 43 Block A: hint border overlay.
                  const hintColor = sector.hint === "drive-code" ? "#a855f7"
                    : sector.hint === "protected" ? "#ef4444"
                    : sector.hint === "raw-unanalyzed" ? "#3b82f6"
                    : sector.hint === "bad-crc" ? "#dc2626"
                    : sector.hint === "gap" ? "#facc15"
                    : undefined;
                  return (
                    <g key={sector.id}>
                      <path
                        d={sectorPath(sector.track, sector.angleStart, sector.angleEnd)}
                        className={className}
                        style={useFileColor ? { fill: sector.color } : undefined}
                        onClick={() => inspectSector(sector.track, sector.sector)}
                        role="button"
                        tabIndex={-1}
                        aria-label={`Track ${sector.track} sector ${sector.sector} (${sector.category})`}
                      >
                        <title>{`T${sector.track}/S${sector.sector} · ${sector.category}${sector.hint ? " · " + sector.hint : ""}${sector.fileTitle ? " · " + sector.fileTitle : ""} — click for hex`}</title>
                      </path>
                      {hintColor ? (
                        <path
                          d={sectorPath(sector.track, sector.angleStart, sector.angleEnd)}
                          fill="none"
                          stroke={hintColor}
                          strokeWidth={1.5}
                          strokeDasharray={sector.hint === "bad-crc" ? "2,2" : undefined}
                          pointerEvents="none"
                        />
                      ) : null}
                    </g>
                  );
                })}
                {[1, 18, 25, 31, activeDisk.trackCount].filter((value, index, array) => array.indexOf(value) === index).map((track) => {
                  const outerRadius = 280;
                  const innerRadius = 72;
                  const ringWidth = (outerRadius - innerRadius) / Math.max(activeDisk.trackCount, 1);
                  const radius = outerRadius - (track - 0.5) * ringWidth;
                  return (
                    <text key={track} x="320" y={320 - radius} className="disk-track-label" textAnchor="middle">
                      {track}
                    </text>
                  );
                })}
              </svg>
            </div>
            {/* BUG-017 — raw sector inspector: click any sector in the geometry
                (incl. occupied non-directory data: orphan/drive-code/raw) to see
                its track/sector + category/hint/file and open the 256-byte hex. */}
            {(() => {
              const sel = selectedSector
                ? activeDisk.sectors.find((s) => s.track === selectedSector.track && s.sector === selectedSector.sector)
                : undefined;
              if (!selectedSector) {
                return <p className="disk-sector-hint">Click any sector in the geometry to inspect its raw 256 bytes.</p>;
              }
              return (
                <div className="disk-sector-detail">
                  <div className="record-meta">
                    <span><strong>T{selectedSector.track}/S{selectedSector.sector}</strong></span>
                    <span>{sel?.category ?? "unknown"}</span>
                    {sel?.hint ? <span>hint: {sel.hint}</span> : null}
                    {sel?.fileTitle ? <span>file: {sel.fileTitle}</span> : <span>no directory file</span>}
                  </div>
                  <button
                    type="button"
                    className="ghost-button disk-sector-hex-btn"
                    onClick={() => inspectSector(selectedSector.track, selectedSector.sector)}
                  >
                    Open hex (256 B)
                  </button>
                </div>
              );
            })()}
            {selectedFile ? (
              <div className="disk-selected-meta">
                <div className="record-meta">
                  <span>{selectedFile.relativePath ?? selectedFile.title}</span>
                  <span>{selectedFile.sectorChain.length} sectors</span>
                  <span>{selectedFile.loadType}</span>
                  {selectedFile.loaderSource ? <span>via {selectedFile.loaderSource}</span> : null}
                </div>
                <table className="data-table compact-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Track/Sector</th>
                      <th>Next</th>
                      <th>Bytes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedFile.sectorChain.map((cell) => (
                      <tr key={`${cell.track}-${cell.sector}`}>
                        <td>{cell.index + 1}</td>
                        <td>{cell.track}/{cell.sector}</td>
                        <td>{cell.isLast ? "end" : `${cell.nextTrack}/${cell.nextSector}`}</td>
                        <td>{cell.bytesUsed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      )}
      <div className="disk-legend">
        <span><i className="legend-swatch disk-legend-file" /> file sectors</span>
        <span><i className="legend-swatch disk-legend-directory" /> directory</span>
        <span><i className="legend-swatch disk-legend-bam" /> BAM</span>
        <span><i className="legend-swatch disk-legend-free" /> free ($00)</span>
        <span><i className="legend-swatch disk-legend-free-data" /> free w/ data</span>
        <span><i className="legend-swatch disk-legend-orphan" /> allocated, no file</span>
      </div>
    </MediumPanelShell>
  );
}

export function FlowPanel({
  flowGraph,
  entities,
  relations,
  selectedEntityId,
  onSelectEntity,
}: {
  flowGraph: FlowGraphView;
  entities: EntityRecord[];
  relations: RelationRecord[];
  selectedEntityId?: string | null;
  onSelectEntity: (entityId: string) => void;
}) {
  type FlowModeId = "structure" | "load" | "runtime";

  const [flowModeId, setFlowModeId] = useState<FlowModeId>("structure");
  const availableModes = flowGraph.modes
    ? ([
        flowGraph.modes.structure,
        flowGraph.modes.load,
        flowGraph.modes.runtime,
      ].filter((mode) => mode.nodes.length > 0 || mode.edges.length > 0))
    : [{
        id: "structure" as const,
        title: "Structure",
        summary: "Entity- and relation-centric graph.",
        nodes: flowGraph.nodes,
        edges: flowGraph.edges,
      }];

  useEffect(() => {
    if (!availableModes.some((mode) => mode.id === flowModeId)) {
      setFlowModeId(availableModes[0]?.id ?? "structure");
    }
  }, [availableModes, flowModeId]);

  const activeMode = availableModes.find((mode) => mode.id === flowModeId) ?? availableModes[0];

  function modeLayout(modeId: FlowModeId) {
    if (modeId === "load") {
      const laneDefinitions = [
        { key: "bootstrap", title: "Bootstrap" },
        { key: "content", title: "Content Payloads" },
        { key: "late", title: "Late / Ending" },
        { key: "other", title: "Other" },
      ] as const;
      function laneForKind(kind: string): (typeof laneDefinitions)[number]["key"] {
        const normalized = kind.toLowerCase();
        if (normalized.includes("bootstrap")) return "bootstrap";
        if (normalized.includes("ending") || normalized.includes("late")) return "late";
        if (normalized.includes("payload") || normalized.includes("scene") || normalized.includes("presentation") || normalized.includes("visual") || normalized.includes("content")) return "content";
        return "other";
      }
      return { laneDefinitions, laneForKind };
    }
    if (modeId === "runtime") {
      const laneDefinitions = [
        { key: "session", title: "Sessions" },
        { key: "phase", title: "Phases" },
        { key: "hotspot", title: "Hotspots" },
        { key: "region", title: "Regions" },
        { key: "other", title: "Other" },
      ] as const;
      function laneForKind(kind: string): (typeof laneDefinitions)[number]["key"] {
        const normalized = kind.toLowerCase();
        if (normalized.includes("session")) return "session";
        if (normalized.includes("phase")) return "phase";
        if (normalized.includes("hotspot")) return "hotspot";
        if (normalized.includes("region")) return "region";
        return "other";
      }
      return { laneDefinitions, laneForKind };
    }
    const laneDefinitions = [
      { key: "entry", title: "Entry Points" },
      { key: "code", title: "Code / Routines" },
      { key: "data", title: "Data / State" },
      { key: "other", title: "Other" },
    ] as const;
    function laneForKind(kind: string): (typeof laneDefinitions)[number]["key"] {
      const normalized = kind.toLowerCase();
      if (normalized.includes("entry")) return "entry";
      if (normalized.includes("code") || normalized.includes("routine")) return "code";
      if (normalized.includes("table") || normalized.includes("state") || normalized.includes("memory") || normalized.includes("pointer") || normalized.includes("symbol")) return "data";
      return "other";
    }
    return { laneDefinitions, laneForKind };
  }

  const { laneDefinitions, laneForKind } = modeLayout(activeMode.id);
  const lanes = new Map(laneDefinitions.map((lane) => [lane.key, [] as typeof activeMode.nodes]));
  for (const node of [...activeMode.nodes].sort((left, right) => left.title.localeCompare(right.title))) {
    lanes.get(laneForKind(node.kind))?.push(node);
  }

  const laneWidth = 240;
  const laneGap = 60;
  const nodeWidth = 190;
  const nodeHeight = 54;
  const topPadding = 54;
  const rowGap = 24;
  const graphWidth = laneDefinitions.length * laneWidth + (laneDefinitions.length - 1) * laneGap;
  const graphHeight = Math.max(
    380,
    ...laneDefinitions.map((lane) => topPadding + (lanes.get(lane.key)?.length ?? 0) * (nodeHeight + rowGap) + 40),
  );

  const positionedNodes = new Map<string, { x: number; y: number; node: typeof activeMode.nodes[number] }>();
  laneDefinitions.forEach((lane, laneIndex) => {
    const laneNodes = lanes.get(lane.key) ?? [];
    laneNodes.forEach((node, rowIndex) => {
      positionedNodes.set(node.id, {
        node,
        x: laneIndex * (laneWidth + laneGap) + 20,
        y: topPadding + rowIndex * (nodeHeight + rowGap),
      });
    });
  });

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Flow Graph</h3>
        <span>{activeMode.nodes.length} nodes / {activeMode.edges.length} edges</span>
      </div>
      <div className="inspector-chip-row" style={{ marginBottom: "0.9rem" }}>
        {availableModes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={mode.id === activeMode.id ? "inspector-chip active" : "inspector-chip"}
            onClick={() => setFlowModeId(mode.id)}
          >
            {mode.title}
          </button>
        ))}
      </div>
      {activeMode.summary ? <p className="inspector-copy" style={{ marginTop: 0 }}>{activeMode.summary}</p> : null}
      <div className="split-columns">
        <div className="detail-card">
          <div className="detail-title-row">
            <h4>Rendered Graph</h4>
            <span>{activeMode.title}</span>
          </div>
          <div className="graph-canvas-wrap">
            <svg
              className="flow-svg"
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
              role="img"
              aria-label="Rendered flow graph"
            >
              <defs>
                <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(77, 181, 255, 0.65)" />
                </marker>
              </defs>
              {laneDefinitions.map((lane, laneIndex) => (
                <g key={lane.key}>
                  <text
                    x={laneIndex * (laneWidth + laneGap) + 20}
                    y={24}
                    className="flow-lane-title"
                  >
                    {lane.title}
                  </text>
                  <rect
                    x={laneIndex * (laneWidth + laneGap)}
                    y={36}
                    width={laneWidth}
                    height={graphHeight - 50}
                    rx={18}
                    className="flow-lane-bg"
                  />
                </g>
              ))}
              {activeMode.edges.map((edge) => {
                const from = positionedNodes.get(edge.from);
                const to = positionedNodes.get(edge.to);
                if (!from || !to) return null;
                return (
                  <g key={edge.id}>
                    <line
                      x1={from.x + nodeWidth}
                      y1={from.y + nodeHeight / 2}
                      x2={to.x}
                      y2={to.y + nodeHeight / 2}
                      className="flow-edge-line"
                      markerEnd="url(#flow-arrow)"
                    />
                  </g>
                );
              })}
              {[...positionedNodes.values()].map(({ node, x, y }) => {
                const entity = entities.find((candidate) => candidate.id === node.entityId);
                return (
                  <g
                    key={node.id}
                    transform={`translate(${x}, ${y})`}
                    className={node.entityId === selectedEntityId ? "flow-node-group active" : "flow-node-group"}
                    onClick={() => entity && onSelectEntity(entity.id)}
                  >
                    <rect width={nodeWidth} height={nodeHeight} rx={14} className="flow-node-rect" />
                    <text x={14} y={20} className="flow-node-kind">{node.kind}</text>
                    <text x={14} y={38} className="flow-node-title">{node.title}</text>
                    <text x={nodeWidth - 14} y={38} textAnchor="end" className="flow-node-confidence">{pct(node.confidence)}</text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
          <div className="detail-card">
            <h4>Edges</h4>
            <div className="record-stack">
              {activeMode.edges.map((edge) => {
                const relation = relations.find((candidate) => candidate.id === edge.relationId);
              return (
                <button
                  key={edge.id}
                  type="button"
                  className={relation && selectedEntityId && (relation.sourceEntityId === selectedEntityId || relation.targetEntityId === selectedEntityId) ? "record-card active-record" : "record-card"}
                  onClick={() => relation && onSelectEntity(relation.sourceEntityId)}
                >
                  <div className="record-topline">
                    <span>{edge.title}</span>
                    <span className="record-status">{edge.kind}</span>
                  </div>
                  <div className="record-meta">
                    <span>{pct(edge.confidence)}</span>
                    {edge.summary ? <span>{edge.summary}</span> : relation?.summary ? <span>{relation.summary}</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- shared Inspector (extracted from App.tsx) ----
export function EntityInspector({
  snapshot,
  entity,
  onSelectEntity,
  onOpenDocument,
  onOpenTab,
  onOpenHex,
  onCreateTask,
  onCreateQuestion,
}: {
  snapshot: WorkspaceUiSnapshot;
  entity?: EntityRecord;
  onSelectEntity: (entityId: string) => void;
  onOpenDocument: (path: string) => void;
  onOpenTab: (tab: TabId) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
} & LlmTodoActions) {
  if (!entity) {
    return (
      <section className="panel-card inspector-card">
        <div className="section-heading">
          <h3>Inspector</h3>
        </div>
        <div className="empty-state">
          Select a memory region, listing item, flow node, bank, chip, or disk file to inspect its linked knowledge.
        </div>
      </section>
    );
  }

  const lineageVisibility = useLineageVisibility();
  const internalVisibility = useInternalVisibility();
  const artifactsById = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const entitiesById = new Map(snapshot.entities.map((candidate) => [candidate.id, candidate]));
  const linkedFindings = snapshot.findings.filter((finding) => finding.entityIds.includes(entity.id));
  const linkedRelations = snapshot.relations.filter((relation) => relation.sourceEntityId === entity.id || relation.targetEntityId === entity.id);
  // Bug 24: filter linked artifacts to latest version per lineage. Bug 26:
  // also hide infrastructure files. The linked-by-id resolution stays
  // against the full artifactsById map so older / internal references
  // still resolve before the filters collapse them out.
  const linkedArtifacts = internalVisibility.visibleArtifacts(lineageVisibility.latest(uniqueById(
    [...entity.artifactIds, ...linkedFindings.flatMap((finding) => finding.artifactIds)]
      .map((artifactId) => artifactsById.get(artifactId))
      .filter((artifact): artifact is ArtifactRecord => artifact !== undefined),
  )));
  const relatedEntities = uniqueById(
    [
      ...entity.relatedEntityIds,
      ...linkedRelations.map((relation) => relation.sourceEntityId === entity.id ? relation.targetEntityId : relation.sourceEntityId),
    ]
      .map((entityId) => entitiesById.get(entityId))
      .filter((candidate): candidate is EntityRecord => candidate !== undefined),
  );
  const loadItems = snapshot.views.loadSequence.items.filter((item) => item.entityIds.includes(entity.id));
  const flowNodes = snapshot.views.flowGraph.nodes.filter((node) => node.entityId === entity.id);
  const memoryRegions = snapshot.views.memoryMap.regions.filter((region) => region.entityId === entity.id);
  const listingEntries = snapshot.views.annotatedListing.entries.filter((entry) => entry.entityId === entity.id);
  const diskFiles = snapshot.views.diskLayout.disks.flatMap((disk) =>
    disk.files
      .filter((file) => file.entityId === entity.id)
      .map((file) => ({ ...file, diskTitle: disk.diskName ?? disk.title })),
  );
  const docArtifacts = linkedArtifacts.filter((artifact) => artifact.relativePath.toLowerCase().endsWith(".md"));
  const primaryDiskFile = diskFiles[0];
  const primaryLoadItem = loadItems[0];
  const inspectorMode: InspectorMode = primaryDiskFile
    ? "disk-file"
    : entity.kind.includes("memory") || entity.kind.includes("segment") || memoryRegions.length > 0
      ? "memory"
      : flowNodes.length > 0 || entity.kind.includes("entry")
        ? "flow"
        : primaryLoadItem
          ? "payload"
          : entity.kind.includes("chip") || entity.kind.includes("bank")
            ? "cartridge"
            : "generic";

  const jumpTargets = [
    entity.addressRange || memoryRegions.length > 0 ? { id: "memory", label: "Memory Map", tab: "memory" as TabId } : null,
    diskFiles.length > 0 ? { id: "disk", label: "Disk", tab: "disk" as TabId } : null,
    loadItems.length > 0 ? { id: "flow-load", label: "Load Sequence", tab: "flow" as TabId } : null,
    flowNodes.length > 0 ? { id: "flow", label: "Flow Graph", tab: "flow" as TabId } : null,
    listingEntries.length > 0 ? { id: "listing", label: "Annotated List", tab: "listing" as TabId } : null,
    docArtifacts.length > 0 ? { id: "docs", label: "Docs", tab: "docs" as TabId } : null,
  ].filter((item): item is { id: string; label: string; tab: TabId } => item !== null);

  const linkedArtifactIds = linkedArtifacts.map((artifact) => artifact.id);

  function openArtifact(artifact: ArtifactRecord) {
    if (artifact.relativePath.toLowerCase().endsWith(".md")) {
      onOpenDocument(artifact.relativePath);
      return;
    }
    if (snapshot.views.diskLayout.disks.some((disk) => disk.artifactId === artifact.id)) {
      onOpenTab("disk");
      return;
    }
    if (snapshot.views.cartridgeLayout.cartridges.some((cartridge) => cartridge.artifactId === artifact.id)) {
      onOpenTab("cartridge");
      return;
    }
    if (artifact.kind.includes("listing")) {
      onOpenTab("listing");
      return;
    }
    if (artifact.kind.includes("trace")) {
      // Activity tab folded into Dashboard (Spec 059).
      onOpenTab("dashboard");
      return;
      }
    if (artifact.kind.includes("analysis")) {
      onOpenTab("flow");
    }
  }

  const sectionNodes = {
    details: (
      <div className="inspector-block">
        <h4>Details</h4>
        <div className="mini-card">
          {inspectorMode === "disk-file" && primaryDiskFile ? (
            <>
              <strong>{primaryDiskFile.relativePath ?? primaryDiskFile.title}</strong>
              <p>{primaryDiskFile.diskTitle}</p>
              <div className="record-meta">
                <span>{primaryDiskFile.type}</span>
                {primaryDiskFile.sizeBytes !== undefined ? <span>{primaryDiskFile.sizeBytes} bytes</span> : null}
                {primaryDiskFile.track !== undefined && primaryDiskFile.sector !== undefined ? <span>{primaryDiskFile.track}/{primaryDiskFile.sector}</span> : null}
                {primaryDiskFile.loadAddress !== undefined ? <span>{hex(primaryDiskFile.loadAddress)}</span> : null}
                <span>{primaryDiskFile.loadType}</span>
                {primaryDiskFile.loaderSource ? <span>via {primaryDiskFile.loaderSource}</span> : null}
              </div>
            </>
          ) : null}
          {inspectorMode === "memory" ? (
            <>
              <strong>{entity.name}</strong>
              <p>{entity.summary ?? "Memory-linked element."}</p>
              <div className="record-meta">
                {entity.addressRange ? <span>{hex(entity.addressRange.start)}-{hex(entity.addressRange.end)}</span> : null}
                {entity.addressRange?.bank !== undefined ? <span>bank {entity.addressRange.bank}</span> : null}
                <span>{memoryRegions.length} memory regions</span>
                <span>{listingEntries.length} listing refs</span>
              </div>
            </>
          ) : null}
          {inspectorMode === "flow" ? (
            <>
              <strong>{entity.name}</strong>
              <p>{entity.summary ?? "Flow-linked entity."}</p>
              <div className="record-meta">
                <span>{flowNodes.length} flow nodes</span>
                <span>{linkedRelations.length} relations</span>
                {entity.addressRange ? <span>{hex(entity.addressRange.start)}-{hex(entity.addressRange.end)}</span> : null}
              </div>
            </>
          ) : null}
          {inspectorMode === "payload" && primaryLoadItem ? (
            <>
              <strong>{primaryLoadItem.title}</strong>
              <p>{primaryLoadItem.purposeSummary ?? "Payload-linked stage."}</p>
              <div className="record-meta">
                <span>{primaryLoadItem.role}</span>
                {primaryLoadItem.entryAddresses[0] !== undefined ? <span>entry {hex(primaryLoadItem.entryAddresses[0])}</span> : null}
                {primaryLoadItem.targetRanges[0] ? <span>target {hex(primaryLoadItem.targetRanges[0].start)}-{hex(primaryLoadItem.targetRanges[0].end)}</span> : null}
              </div>
            </>
          ) : null}
          {inspectorMode === "cartridge" ? (
            <>
              <strong>{entity.name}</strong>
              <p>{entity.summary ?? "Cartridge-linked element."}</p>
              <div className="record-meta">
                {entity.addressRange ? <span>{hex(entity.addressRange.start)}-{hex(entity.addressRange.end)}</span> : null}
                {entity.addressRange?.bank !== undefined ? <span>bank {entity.addressRange.bank}</span> : null}
              </div>
            </>
          ) : null}
          {inspectorMode === "generic" ? (
            <>
              <strong>{entity.name}</strong>
              <p>{entity.summary ?? "Linked knowledge element."}</p>
              <div className="record-meta">
                <span>{entity.kind}</span>
                <span>{pct(entity.confidence)}</span>
              </div>
            </>
          ) : null}
        </div>
      </div>
    ),
    artifacts: (
      <div className="inspector-block">
        <h4>Linked Artifacts</h4>
        {linkedArtifacts.length === 0 ? <div className="empty-inline">No linked artifacts.</div> : null}
        <div className="record-stack compact">
          {linkedArtifacts.map((artifact) => {
            const showMon = isC64BinaryArtifact(artifact.relativePath);
            // Bug 24: surface lineage size so the user knows older versions
            // exist even though they are filtered out of the list.
            const versionCount = lineageVersionCount(artifact, snapshot.artifacts);
            return (
              <div key={artifact.id} className="record-card-row">
                <button type="button" className="record-card" onClick={() => openArtifact(artifact)}>
                  <div className="record-topline">
                    <span>{artifact.title}</span>
                    <span className="record-status">{artifact.kind}</span>
                  </div>
                  <p>{artifact.relativePath}</p>
                  <div className="record-meta">
                    <span>{artifact.role ?? artifact.scope}</span>
                    <span>{pct(artifact.confidence)}</span>
                    {versionCount > 1 ? (
                      <span title={`${versionCount} versions in this lineage. Toggle "Show all versions" in the header to expand.`}>
                        +{versionCount - 1} older
                      </span>
                    ) : null}
                  </div>
                </button>
                {showMon ? (
                  <button
                    type="button"
                    className="mon-icon-button"
                    title={`Open hex view for ${artifact.relativePath}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenHex(artifact.relativePath, { title: artifact.title });
                    }}
                  >
                    mon
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    ),
    views: (
      <div className="inspector-block">
        <h4>View Links</h4>
        {diskFiles.length === 0 && loadItems.length === 0 && flowNodes.length === 0 && memoryRegions.length === 0 && listingEntries.length === 0 ? (
          <div className="empty-inline">No direct view-linked records.</div>
        ) : null}
        <div className="record-stack compact">
          {diskFiles.map((file) => (
            <button key={`${file.diskTitle}-${file.id}`} type="button" className="record-card" onClick={() => onOpenTab("disk")}>
              <div className="record-topline">
                <span>{file.relativePath ?? file.title}</span>
                <span className="record-status">disk file</span>
              </div>
              <div className="record-meta">
                <span>{file.diskTitle}</span>
                {file.loadAddress !== undefined ? <span>{hex(file.loadAddress)}</span> : null}
                {file.track !== undefined && file.sector !== undefined ? <span>{file.track}/{file.sector}</span> : null}
              </div>
            </button>
          ))}
          {loadItems.map((item) => (
            <button key={item.id} type="button" className="record-card" onClick={() => onOpenTab("flow")}>
              <div className="record-topline">
                <span>{item.title}</span>
                <span className="record-status">{item.role}</span>
              </div>
              <p>{item.purposeSummary ?? "Payload-linked stage."}</p>
            </button>
          ))}
          {flowNodes.map((node) => (
            <button key={node.id} type="button" className="record-card" onClick={() => onOpenTab("flow")}>
              <div className="record-topline">
                <span>{node.title}</span>
                <span className="record-status">{node.kind}</span>
              </div>
              <div className="record-meta">
                <span>{pct(node.confidence)}</span>
              </div>
            </button>
          ))}
          {memoryRegions.map((region) => (
            <button key={region.id} type="button" className="record-card" onClick={() => onOpenTab("memory")}>
              <div className="record-topline">
                <span>{region.title}</span>
                <span className="record-status">{region.kind}</span>
              </div>
              <p>{hex(region.start)}-{hex(region.end)}</p>
            </button>
          ))}
          {listingEntries.slice(0, 6).map((entry) => (
            <button key={entry.id} type="button" className="record-card" onClick={() => onOpenTab("listing")}>
              <div className="record-topline">
                <span>{entry.title}</span>
                <span className="record-status">{entry.kind}</span>
              </div>
              <p>{hex(entry.start)}-{hex(entry.end)}</p>
            </button>
          ))}
        </div>
      </div>
    ),
    findings: (
      <div className="inspector-block">
        <h4>Findings</h4>
        {linkedFindings.length === 0 ? <div className="empty-inline">No linked findings.</div> : null}
        <div className="record-stack compact">
          {linkedFindings.map((finding) => (
            <article key={finding.id} className="mini-card">
              <strong>{finding.title}</strong>
              <p>{finding.summary ?? finding.kind}</p>
              <div className="record-meta">
                <span>{finding.status}</span>
                <span>{pct(finding.confidence)}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    ),
    elements: (
      <div className="inspector-block">
        <h4>Linked Elements</h4>
        {relatedEntities.length === 0 ? <div className="empty-inline">No linked elements.</div> : null}
        <div className="record-stack compact">
          {relatedEntities.map((related) => (
            <button key={related.id} type="button" className="record-card" onClick={() => onSelectEntity(related.id)}>
              <div className="record-topline">
                <span>{related.name}</span>
                <span className="record-status">{related.kind}</span>
              </div>
              {related.summary ? <p>{related.summary}</p> : null}
              <div className="record-meta">
                <span>{pct(related.confidence)}</span>
                {related.addressRange ? <span>{hex(related.addressRange.start)}-{hex(related.addressRange.end)}</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    ),
    relations: (
      <div className="inspector-block">
        <h4>Relations</h4>
        {linkedRelations.length === 0 ? <div className="empty-inline">No linked relations.</div> : null}
        <div className="record-stack compact">
          {linkedRelations.map((relation) => {
            const otherId = relation.sourceEntityId === entity.id ? relation.targetEntityId : relation.sourceEntityId;
            const otherEntity = entitiesById.get(otherId);
            return (
              <button key={relation.id} type="button" className="record-card" onClick={() => otherEntity && onSelectEntity(otherEntity.id)}>
                <div className="record-topline">
                  <span>{relation.title}</span>
                  <span className="record-status">{relation.kind}</span>
                </div>
                <p>{relation.summary ?? `${relation.sourceEntityId} → ${relation.targetEntityId}`}</p>
                <div className="record-meta">
                  <span>{pct(relation.confidence)}</span>
                  {otherEntity ? <span>{otherEntity.name}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    ),
  };

  const sectionOrder: Record<InspectorMode, Array<keyof typeof sectionNodes>> = {
    "disk-file": ["details", "views", "findings", "artifacts", "relations", "elements"],
    memory: ["details", "views", "findings", "elements", "relations", "artifacts"],
    flow: ["details", "relations", "views", "findings", "elements", "artifacts"],
    payload: ["details", "views", "artifacts", "findings", "relations", "elements"],
    cartridge: ["details", "artifacts", "views", "findings", "relations", "elements"],
    generic: ["details", "findings", "relations", "elements", "artifacts", "views"],
  };

  return (
    <section className="panel-card inspector-card">
      <div className="section-heading">
        <h3>Inspector</h3>
        <span>{entity.kind}</span>
      </div>
      <div className="inspector-head">
        <strong>{entity.name}</strong>
        <span>{pct(entity.confidence)}</span>
      </div>
      {entity.addressRange ? (
        <div className="record-meta">
          <span>{hex(entity.addressRange.start)}-{hex(entity.addressRange.end)}</span>
          {entity.addressRange.bank !== undefined ? <span>bank {entity.addressRange.bank}</span> : null}
        </div>
      ) : null}
      {entity.summary ? <p className="inspector-copy">{entity.summary}</p> : null}
      <div className="inspector-chip-row">
        {jumpTargets.map((target) => (
          <button key={target.id} type="button" className="inspector-chip" onClick={() => onOpenTab(target.tab)}>
            {target.label}
          </button>
        ))}
        <button
          type="button"
          className="inspector-chip"
          onClick={() => onCreateTask({
            title: `Investigate ${entity.name}`,
            description: entity.summary ? `${entity.summary}\n\nNext step:` : undefined,
            entityIds: [entity.id],
            artifactIds: linkedArtifactIds,
          })}
        >
          + LLM Task
        </button>
        <button
          type="button"
          className="inspector-chip"
          onClick={() => onCreateQuestion({
            title: `What is ${entity.name}?`,
            description: entity.summary ? `${entity.summary}\n\nQuestion:` : undefined,
            entityIds: [entity.id],
            artifactIds: linkedArtifactIds,
          })}
        >
          + Open Question
        </button>
      </div>
      {sectionOrder[inspectorMode].map((sectionId) => <div key={sectionId}>{sectionNodes[sectionId]}</div>)}
    </section>
  );
}
