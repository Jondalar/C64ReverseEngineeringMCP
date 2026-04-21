import { startTransition, useDeferredValue, useEffect, useState, type ReactNode } from "react";
import { HexView } from "./components/HexView.js";
import { CartridgeMemoryGrid } from "./components/CartridgeMemoryGrid.js";
import type {
  ArtifactRecord,
  EntityRecord,
  FindingRecord,
  FlowGraphView,
  LoadSequenceView,
  MemoryMapView,
  RelationRecord,
  WorkspaceUiSnapshot,
} from "./types";

type TabId = "dashboard" | "docs" | "memory" | "cartridge" | "disk" | "load" | "flow" | "listing" | "activity";

interface UiConfig {
  defaultProjectDir: string;
}

interface UiDocument {
  id: string;
  title: string;
  relativePath: string;
  updatedAt: string;
  role?: string;
}

interface DocGroup {
  id: string;
  title: string;
  docs: UiDocument[];
}

const allTabs: Array<{ id: TabId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "docs", label: "Docs" },
  { id: "memory", label: "Memory Map" },
  { id: "cartridge", label: "Cartridge" },
  { id: "disk", label: "Disk" },
  { id: "load", label: "Load Sequence" },
  { id: "flow", label: "Flow Graph" },
  { id: "listing", label: "Annotated Listing" },
  { id: "activity", label: "Recent Activity" },
];

// Files we want to open in the (mon) hex viewer. Anything else (.json,
// .md, .asm, .tass, .sym, etc.) is text the listing/docs panes already
// handle, so we hide the icon to avoid noise.
const C64_BINARY_EXTENSIONS = new Set([".prg", ".bin", ".crt", ".d64", ".g64", ".sid", ".raw"]);

function isC64BinaryArtifact(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return C64_BINARY_EXTENSIONS.has(lower.slice(dot));
}

function hex(value: number, digits = 4): string {
  return `$${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}

function shortTime(value: string): string {
  return new Date(value).toLocaleString("de-DE", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.text();
}

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function docPriority(doc: UiDocument): number {
  const name = doc.title.toLowerCase();
  if (name.includes("first_analysis") || name.includes("handoff") || name.includes("overview") || name.includes("summary")) {
    return 0;
  }
  if (name.endsWith("_pointer_facts.md") || name.endsWith("_ram_facts.md")) {
    return 2;
  }
  return 1;
}

function docGroupId(doc: UiDocument): string {
  const name = doc.title.toLowerCase();
  if (docPriority(doc) === 0) return "main";
  if (name.endsWith("_pointer_facts.md") || name.endsWith("_ram_facts.md")) return "facts";
  return "notes";
}

function docGroupTitle(groupId: string): string {
  if (groupId === "main") return "Main Docs";
  if (groupId === "facts") return "Per-File Facts";
  return "Other Notes";
}

function buildDocs(artifacts: ArtifactRecord[]): UiDocument[] {
  return artifacts
    .filter((artifact) => artifact.relativePath.toLowerCase().startsWith("doc/") || artifact.relativePath.toLowerCase().endsWith(".md"))
    .map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      relativePath: artifact.relativePath,
      updatedAt: artifact.updatedAt,
      role: artifact.role,
    }))
    .sort((left, right) => {
      const priorityDelta = docPriority(left) - docPriority(right);
      if (priorityDelta !== 0) return priorityDelta;
      return left.relativePath.localeCompare(right.relativePath);
    });
}

function groupDocs(docs: UiDocument[]): DocGroup[] {
  const groups = new Map<string, UiDocument[]>();
  for (const doc of docs) {
    const groupId = docGroupId(doc);
    groups.set(groupId, [...(groups.get(groupId) ?? []), doc]);
  }
  return ["main", "notes", "facts"]
    .map((groupId) => ({
      id: groupId,
      title: docGroupTitle(groupId),
      docs: groups.get(groupId) ?? [],
    }))
    .filter((group) => group.docs.length > 0);
}

function renderInlineMarkdown(text: string): Array<string | ReactNode> {
  const result: Array<string | ReactNode> = [];
  let remaining = text;
  let key = 0;
  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (!codeMatch || codeMatch.index === undefined) {
      result.push(remaining);
      break;
    }
    if (codeMatch.index > 0) {
      result.push(remaining.slice(0, codeMatch.index));
    }
    result.push(<code key={`code-${key++}`}>{codeMatch[1]}</code>);
    remaining = remaining.slice(codeMatch.index + codeMatch[0].length);
  }
  return result;
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function ThinMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeBlock: string[] = [];
  let inCode = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    nodes.push(<p key={`p-${nodes.length}`}>{renderInlineMarkdown(text)}</p>);
    paragraph = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {listItems.map((item, index) => <li key={`li-${index}`}>{renderInlineMarkdown(item)}</li>)}
      </ul>,
    );
    listItems = [];
  }

  function flushCode() {
    if (codeBlock.length === 0) return;
    nodes.push(<pre key={`pre-${nodes.length}`}><code>{codeBlock.join("\n")}</code></pre>);
    codeBlock = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBlock.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const nextLine = lines[index + 1]?.trimEnd() ?? "";
    if (line.includes("|") && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      flushList();
      const header = splitMarkdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index].trimEnd();
        if (!rowLine.trim() || !rowLine.includes("|")) {
          index -= 1;
          break;
        }
        rows.push(splitMarkdownTableRow(rowLine));
        index += 1;
      }
      nodes.push(
        <div key={`table-wrap-${nodes.length}`} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {header.map((cell, cellIndex) => <th key={`h-${cellIndex}`}>{renderInlineMarkdown(cell)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {row.map((cell, cellIndex) => <td key={`c-${rowIndex}-${cellIndex}`}>{renderInlineMarkdown(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1) nodes.push(<h1 key={`h-${nodes.length}`}>{text}</h1>);
      else if (level === 2) nodes.push(<h2 key={`h-${nodes.length}`}>{text}</h2>);
      else nodes.push(<h3 key={`h-${nodes.length}`}>{text}</h3>);
      continue;
    }
    const listMatch = line.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      continue;
    }
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();

  return <div className="thin-markdown">{nodes}</div>;
}

function MetricTile({ title, value, tone }: { title: string; value: string; tone: string }) {
  return (
    <article className={`metric-tile metric-${tone}`}>
      <div className="metric-label">{title}</div>
      <div className="metric-value">{value}</div>
    </article>
  );
}

function RecordList({
  title,
  items,
  onSelectEntity,
}: {
  title: string;
  items: Array<{ id: string; title: string; summary?: string; status: string; confidence?: number; entityId?: string; updatedAt: string }>;
  onSelectEntity?: (entityId: string) => void;
}) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>{title}</h3>
      </div>
      <div className="record-stack">
        {items.length === 0 ? <div className="empty-state">No records.</div> : null}
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="record-card"
            onClick={() => item.entityId && onSelectEntity?.(item.entityId)}
            disabled={!item.entityId}
          >
            <div className="record-topline">
              <span>{item.title}</span>
              <span className="record-status">{item.status}</span>
            </div>
            {item.summary ? <p>{item.summary}</p> : null}
            <div className="record-meta">
              {item.confidence !== undefined ? <span>{pct(item.confidence)}</span> : null}
              <span>{shortTime(item.updatedAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function DashboardPanel({
  snapshot,
  onSelectEntity,
  onOpenDocument,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
  onOpenDocument: (path: string) => void;
}) {
  return (
    <div className="dashboard-shell">
      <section className="panel-card overview-panel">
        <div className="section-heading">
          <h3>Overall State</h3>
          <span>{snapshot.project.status}</span>
        </div>
        <div className="overview-grid">
          {snapshot.views.projectDashboard.overview.map((item) => (
            <article key={item.id} className="overview-card">
              <h4>{item.title}</h4>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>
      <div className="split-columns">
        <section className="panel-card">
          <div className="section-heading">
            <h3>Current Work</h3>
            <span>tasks and questions</span>
          </div>
          <div className="record-stack">
            {snapshot.views.projectDashboard.openTasks.slice(0, 4).map((task) => (
              <button
                key={task.id}
                type="button"
                className="record-card"
                onClick={() => {
                  const entityId = snapshot.tasks.find((candidate) => candidate.id === task.id)?.entityIds[0];
                  if (entityId) onSelectEntity(entityId);
                }}
              >
                <div className="record-topline">
                  <span>{task.title}</span>
                  <span className="record-status">{task.status}</span>
                </div>
                {task.summary ? <p>{task.summary}</p> : null}
              </button>
            ))}
            {snapshot.views.projectDashboard.openQuestions.slice(0, 3).map((question) => (
              <article key={question.id} className="record-card static-card">
                <div className="record-topline">
                  <span>{question.title}</span>
                  <span className="record-status">{question.status}</span>
                </div>
                {question.summary ? <p>{question.summary}</p> : null}
              </article>
            ))}
          </div>
        </section>
        <section className="panel-card">
          <div className="section-heading">
            <h3>Key Documents</h3>
            <span>{snapshot.views.projectDashboard.keyDocuments.length} docs</span>
          </div>
          <div className="record-stack">
            {snapshot.views.projectDashboard.keyDocuments.map((doc) => (
              <button
                key={doc.id}
                type="button"
                className="record-card"
                onClick={() => doc.summary && onOpenDocument(doc.summary)}
              >
                <div className="record-topline">
                  <span>{doc.title}</span>
                  <span className="record-status">doc</span>
                </div>
                {doc.summary ? <p>{doc.summary}</p> : null}
                <div className="record-meta">
                  <span>{shortTime(doc.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function DocsPanel({
  docs,
  selectedPath,
  onSelectPath,
  content,
  loading,
  error,
}: {
  docs: UiDocument[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  content: string;
  loading: boolean;
  error: string | null;
}) {
  const selectedDoc = docs.find((doc) => doc.relativePath === selectedPath) ?? docs[0];
  const groups = groupDocs(docs);

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Docs</h3>
        <span>{docs.length} markdown files</span>
      </div>
      <div className="docs-shell">
        <div className="docs-list">
          <div className="docs-list-stack">
            {groups.map((group) => (
              <section key={group.id} className="docs-group">
                <div className="docs-group-title">
                  <strong>{group.title}</strong>
                  <span>{group.docs.length}</span>
                </div>
                <div className={group.id === "facts" ? "record-stack docs-tree-stack" : "record-stack"}>
                  {group.docs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className={selectedDoc?.relativePath === doc.relativePath ? "record-card active-record" : "record-card"}
                      onClick={() => onSelectPath(doc.relativePath)}
                    >
                      <div className="record-topline">
                        <span>{doc.title}</span>
                        <span className="record-status">{doc.role ?? "doc"}</span>
                      </div>
                      <p>{doc.relativePath}</p>
                      <div className="record-meta">
                        <span>{shortTime(doc.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="docs-viewer">
          <div className="detail-title-row">
            <h4>{selectedDoc?.title ?? "No document selected"}</h4>
            <span>{selectedDoc?.relativePath ?? ""}</span>
          </div>
          {loading ? <div className="empty-state">Loading document...</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          {!loading && !error && content ? <ThinMarkdown content={content} /> : null}
          {!loading && !error && !content ? <div className="empty-state">No markdown content.</div> : null}
        </div>
      </div>
    </section>
  );
}

function MemoryMapPanel({
  snapshot,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
}) {
  const view = snapshot.views.memoryMap;
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [selectedStageKeys, setSelectedStageKeys] = useState<string[]>([]);
  const columnOffsets = Array.from({ length: 16 }, (_, index) => index * view.cellSize);
  const rowBases = Array.from({ length: 16 }, (_, index) => index * view.rowStride);
  const stageOptions = snapshot.views.loadSequence.items.map((item) => ({
    key: item.key,
    title: item.title,
    entityIds: item.entityIds,
    artifactIds: item.artifactIds,
  }));

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
  const selectedCell = visibleCells.find((cell) => cell.id === selectedCellId)
    ?? visibleCells.find((cell) => cell.category !== "free")
    ?? view.cells.find((cell) => cell.id === selectedCellId)
    ?? view.cells.find((cell) => cell.category !== "free")
    ?? view.cells[0];
  const selectedRegions = view.regions
    .filter((region) =>
      selectedCell?.regionIds.includes(region.id) &&
      (!hasStageFilter || (region.entityId !== undefined && focusedEntityIds.has(region.entityId)))
    )
    .sort((left, right) => left.start - right.start);
  const visibleHighlights = view.highlights.filter((item) => !hasStageFilter || (item.entityId !== undefined && focusedEntityIds.has(item.entityId)));

  useEffect(() => {
    if (!selectedCell) return;
    const preferredEntityId = selectedCell.dominantEntityId
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

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Address Space</h3>
        <span>{view.regions.length} mapped regions / {view.cells.length} heatmap cells</span>
      </div>
      <div className="memory-grid-panel">
        <div className="memory-legend">
          <div className="memory-legend-scale">
            <span><i className="legend-swatch legend-free" /> free</span>
            <span><i className="legend-swatch legend-code" /> code</span>
            <span><i className="legend-swatch legend-data" /> data</span>
            <span><i className="legend-swatch legend-system" /> system</span>
            <span><i className="legend-swatch legend-other" /> other</span>
          </div>
          <label className="memory-filter">
            <span>Payload focus</span>
            <select
              multiple
              value={selectedStageKeys}
              onChange={(event) => {
                const next = Array.from(event.target.selectedOptions).map((option) => option.value);
                setSelectedStageKeys(next);
              }}
            >
              {stageOptions.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.title}
                </option>
              ))}
            </select>
            <small>{hasStageFilter ? `${focusedStages.length} payloads focused` : "No filter. Showing full address space."}</small>
          </label>
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
                          onClick={() => setSelectedCellId(cell.id)}
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
                <tr key={item.id} onClick={() => item.entityId && onSelectEntity(item.entityId)}>
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
                    className="record-card"
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

function CartridgePanel({
  snapshot,
  onSelectEntity,
  onOpenHex,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number }) => void;
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
    <section className="panel-card">
      <div className="section-heading">
        <h3>Cartridge Layout</h3>
        <span>{snapshot.views.cartridgeLayout.cartridges.length} cartridges</span>
      </div>
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
              onSelectChip={(chip) => {
                const entity = findChipEntity(chip.bank, chip.loadAddress);
                if (entity) onSelectEntity(entity.id);
              }}
              onSelectBank={(bank) => {
                const entity = findBankEntity(bank.bank);
                if (entity) onSelectEntity(entity.id);
              }}
              onOpenChipHex={(chip, role) => {
                const path = chipArtifactPath(chip.file, manifestArtifact?.relativePath);
                if (!path) return;
                const baseAddress = role === "ROMH"
                  ? (cartridge.slotLayout?.isUltimax ? 0xe000 : 0xa000)
                  : 0x8000;
                onOpenHex(path, {
                  title: `${cartridge.cartridgeName ?? cartridge.title} · Bank ${String(chip.bank).padStart(2, "0")} ${role}`,
                  baseAddress,
                });
              }}
              onOpenEepromHex={() => {
                const eepromFile = cartridge.slotLayout?.eeprom?.file;
                const path = chipArtifactPath(eepromFile, manifestArtifact?.relativePath);
                if (path) {
                  onOpenHex(path, { title: `${cartridge.cartridgeName ?? cartridge.title} · EEPROM` });
                }
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function DiskPanel({
  snapshot,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
}) {
  const disks = snapshot.views.diskLayout.disks;
  const [activeDiskId, setActiveDiskId] = useState<string | null>(disks[0]?.artifactId ?? null);
  const activeDisk = disks.find((disk) => disk.artifactId === activeDiskId) ?? disks[0];
  const [selectedFileId, setSelectedFileId] = useState<string | null>(activeDisk?.files[0]?.id ?? null);

  useEffect(() => {
    if (!activeDisk) {
      setSelectedFileId(null);
      return;
    }
    if (!activeDisk.files.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(activeDisk.files[0]?.id ?? null);
    }
  }, [activeDisk, selectedFileId]);

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

  const selectedFile = activeDisk?.files.find((file) => file.id === selectedFileId) ?? activeDisk?.files[0];
  const freeBlocks = activeDisk?.sectors.filter((sector) => sector.category === "free").length ?? 0;
  const directoryLines = activeDisk
    ? [
        `0 "${(activeDisk.diskName ?? activeDisk.title).toUpperCase()}" ${(activeDisk.diskId ?? "--").toUpperCase()}`,
        ...activeDisk.files.map((file) =>
          `${String(file.sizeSectors ?? 0).padStart(3, " ")} "${(file.title ?? "").toUpperCase()}" ${file.type.toLowerCase()}`,
        ),
        `${String(freeBlocks).padStart(3, " ")} BLOCKS FREE.`,
      ]
    : [];

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Disk Layout</h3>
        <span>{disks.length} images</span>
      </div>
      {disks.length > 1 ? (
        <div className="disk-tab-strip">
          {disks.map((disk) => (
            <button
              key={disk.artifactId}
              type="button"
              className={activeDisk?.artifactId === disk.artifactId ? "tab-button active" : "tab-button"}
              onClick={() => {
                setActiveDiskId(disk.artifactId);
                setSelectedFileId(disk.files[0]?.id ?? null);
              }}
            >
              {disk.diskName ?? disk.title}
            </button>
          ))}
        </div>
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
                {activeDisk.files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className={selectedFile?.id === file.id ? "record-card active-record" : "record-card"}
                    onClick={() => {
                      setSelectedFileId(file.id);
                      if (file.entityId) {
                        onSelectEntity(file.entityId);
                      }
                    }}
                  >
                    <div className="record-topline">
                      <span>{file.relativePath ?? file.title}</span>
                      <span className="record-status">{file.loadType}</span>
                    </div>
                    <div className="record-meta">
                      <span>{file.sizeSectors ?? 0} blk</span>
                      {file.loadAddress !== undefined ? <span>{hex(file.loadAddress)}</span> : null}
                      {file.loaderSource ? <span>via {file.loaderSource}</span> : null}
                    </div>
                  </button>
                ))}
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
            <div className="disk-geometry-wrap">
              <svg viewBox="0 0 640 640" className="disk-geometry-svg" role="img" aria-label="Disk geometry">
                <circle cx="320" cy="320" r="58" className="disk-center-hole" />
                {activeDisk.sectors.map((sector) => {
                  const isSelected = selectedFile?.id !== undefined && sector.fileId === selectedFile.id;
                  const className = [
                    "disk-sector",
                    `disk-sector-${sector.category}`,
                    isSelected ? "selected" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <path
                      key={sector.id}
                      d={sectorPath(sector.track, sector.angleStart, sector.angleEnd)}
                      className={className}
                    />
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
        <span><i className="legend-swatch disk-legend-free" /> free/unknown</span>
      </div>
    </section>
  );
}

function LoadSequencePanel({
  view,
  onSelectEntity,
}: {
  view: LoadSequenceView;
  onSelectEntity: (entityId: string) => void;
}) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Load Sequence</h3>
        <span>{view.items.length} payloads / {view.edges.length} transitions</span>
      </div>
      <div className="sequence-strip">
        {view.items.map((item, index) => (
          <div key={item.id} className="sequence-step">
            <button
              type="button"
              className="sequence-card"
              onClick={() => item.primaryEntityId && onSelectEntity(item.primaryEntityId)}
              disabled={!item.primaryEntityId}
            >
              <div className="sequence-card-top">
                <span className="sequence-order">{String(index + 1).padStart(2, "0")}</span>
                <span className="sequence-role">{item.role}</span>
              </div>
              <h4>{item.title}</h4>
              <p>{item.purposeSummary ?? "No purpose summary available."}</p>
              <div className="record-meta">
                <span>{pct(item.confidence)}</span>
                {item.entryAddresses[0] !== undefined ? <span>entry {hex(item.entryAddresses[0])}</span> : null}
                {item.targetRanges[0] ? <span>target {hex(item.targetRanges[0].start)}-{hex(item.targetRanges[0].end)}</span> : null}
              </div>
            </button>
            {index < view.items.length - 1 ? <div className="sequence-arrow" aria-hidden="true">↓</div> : null}
          </div>
        ))}
      </div>
      <div className="split-columns">
        <div className="detail-card">
          <div className="detail-title-row">
            <h4>Transition Logic</h4>
            <span>payload-centric</span>
          </div>
          <div className="record-stack">
            {view.edges.map((edge) => (
              <article key={edge.id} className="record-card static-card">
                <div className="record-topline">
                  <span>{edge.title}</span>
                  <span className="record-status">{edge.kind}</span>
                </div>
                <div className="record-meta">
                  <span>{pct(edge.confidence)}</span>
                  {edge.summary ? <span>{edge.summary}</span> : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function FlowPanel({
  flowGraph,
  entities,
  relations,
  onSelectEntity,
}: {
  flowGraph: FlowGraphView;
  entities: EntityRecord[];
  relations: RelationRecord[];
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
                    className="flow-node-group"
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
                  className="record-card"
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

function ListingPanel({
  snapshot,
  query,
  setQuery,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  query: string;
  setQuery: (value: string) => void;
  onSelectEntity: (entityId: string) => void;
}) {
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const entries = snapshot.views.annotatedListing.entries.filter((entry) => {
    if (!deferredQuery) {
      return true;
    }
    return [entry.title, entry.kind, entry.comment ?? "", hex(entry.start), hex(entry.end)]
      .join(" ")
      .toLowerCase()
      .includes(deferredQuery);
  });

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Annotated Listing</h3>
        <span>{entries.length} visible entries</span>
      </div>
      <label className="project-input-wrap">
        <span>Filter segments</span>
        <input
          value={query}
          onChange={(event) => startTransition(() => setQuery(event.target.value))}
          placeholder="Search address, label, kind, or comment"
        />
      </label>
      <div className="listing-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Range</th>
              <th>Label</th>
              <th>Kind</th>
              <th>Comment</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} onClick={() => entry.entityId && onSelectEntity(entry.entityId)}>
                <td>{hex(entry.start)}-{hex(entry.end)}</td>
                <td>{entry.title}</td>
                <td>{entry.kind}</td>
                <td>{entry.comment ?? "-"}</td>
                <td>{pct(entry.confidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ActivityPanel({ snapshot }: { snapshot: WorkspaceUiSnapshot }) {
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Recent Activity</h3>
        <span>{snapshot.recentTimeline.length} events</span>
      </div>
      <div className="record-stack">
        {snapshot.recentTimeline.map((event) => (
          <article key={event.id} className="timeline-card">
            <strong>{event.title}</strong>
            {event.summary ? <p>{event.summary}</p> : null}
            <span>{shortTime(event.createdAt)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

type InspectorMode = "disk-file" | "memory" | "flow" | "payload" | "cartridge" | "generic";

function EntityInspector({
  snapshot,
  entity,
  onSelectEntity,
  onOpenDocument,
  onOpenTab,
  onOpenHex,
}: {
  snapshot: WorkspaceUiSnapshot;
  entity?: EntityRecord;
  onSelectEntity: (entityId: string) => void;
  onOpenDocument: (path: string) => void;
  onOpenTab: (tab: TabId) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number }) => void;
}) {
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

  const artifactsById = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const entitiesById = new Map(snapshot.entities.map((candidate) => [candidate.id, candidate]));
  const linkedFindings = snapshot.findings.filter((finding) => finding.entityIds.includes(entity.id));
  const linkedRelations = snapshot.relations.filter((relation) => relation.sourceEntityId === entity.id || relation.targetEntityId === entity.id);
  const linkedArtifacts = uniqueById(
    [...entity.artifactIds, ...linkedFindings.flatMap((finding) => finding.artifactIds)]
      .map((artifactId) => artifactsById.get(artifactId))
      .filter((artifact): artifact is ArtifactRecord => artifact !== undefined),
  );
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
    loadItems.length > 0 ? { id: "load", label: "Load Sequence", tab: "load" as TabId } : null,
    flowNodes.length > 0 ? { id: "flow", label: "Flow Graph", tab: "flow" as TabId } : null,
    listingEntries.length > 0 ? { id: "listing", label: "Annotated List", tab: "listing" as TabId } : null,
    docArtifacts.length > 0 ? { id: "docs", label: "Docs", tab: "docs" as TabId } : null,
  ].filter((item): item is { id: string; label: string; tab: TabId } => item !== null);

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
      onOpenTab("activity");
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
            <button key={item.id} type="button" className="record-card" onClick={() => onOpenTab("load")}>
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
      </div>
      {sectionOrder[inspectorMode].map((sectionId) => <div key={sectionId}>{sectionNodes[sectionId]}</div>)}
    </section>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceUiSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [listingQuery, setListingQuery] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [tabSelections, setTabSelections] = useState<Partial<Record<TabId, string>>>({});
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null);
  const [docContent, setDocContent] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [hexOverlay, setHexOverlay] = useState<{ path: string; title?: string; baseAddress?: number } | null>(null);

  function openHexOverlay(path: string, options?: { title?: string; baseAddress?: number }) {
    setHexOverlay({ path, title: options?.title, baseAddress: options?.baseAddress });
  }

  useEffect(() => {
    void (async () => {
      try {
        const loadedConfig = await fetchJson<UiConfig>("/api/config");
        await loadWorkspace(loadedConfig.defaultProjectDir);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setLoading(false);
      }
    })();
  }, []);

  async function loadWorkspace(nextProjectDir: string) {
    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(nextProjectDir);
      const nextSnapshot = await fetchJson<WorkspaceUiSnapshot>(`/api/workspace?projectDir=${encoded}`);
      setSnapshot(nextSnapshot);
      setSelectedEntityId(null);
      setTabSelections({});
      const nextDocs = buildDocs(nextSnapshot.artifacts);
      setSelectedDocPath(nextDocs[0]?.relativePath ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!snapshot || !selectedDocPath) {
      setDocContent("");
      setDocError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setDocLoading(true);
      setDocError(null);
      try {
        const encodedProject = encodeURIComponent(snapshot.project.rootPath);
        const encodedPath = encodeURIComponent(selectedDocPath);
        const nextContent = await fetchText(`/api/document?projectDir=${encodedProject}&path=${encodedPath}`);
        if (!cancelled) {
          setDocContent(nextContent);
        }
      } catch (loadError) {
        if (!cancelled) {
          setDocError(loadError instanceof Error ? loadError.message : String(loadError));
          setDocContent("");
        }
      } finally {
        if (!cancelled) {
          setDocLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, selectedDocPath]);

  const selectedEntity = snapshot?.entities.find((entity) => entity.id === selectedEntityId);
  const docs = snapshot ? buildDocs(snapshot.artifacts) : [];
  const visibleTabs = snapshot
    ? allTabs.filter((tab) => {
        if (tab.id === "dashboard") return true;
        if (tab.id === "docs") return docs.length > 0;
        if (tab.id === "memory") return snapshot.views.memoryMap.cells.length > 0;
        if (tab.id === "cartridge") return snapshot.views.cartridgeLayout.cartridges.length > 0;
        if (tab.id === "disk") return snapshot.views.diskLayout.disks.length > 0;
        if (tab.id === "load") return snapshot.views.loadSequence.items.length > 0;
        if (tab.id === "flow") return snapshot.views.flowGraph.nodes.length > 0;
        if (tab.id === "listing") return snapshot.views.annotatedListing.entries.length > 0;
        if (tab.id === "activity") return snapshot.recentTimeline.length > 0;
        return true;
      })
    : allTabs;

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [activeTab, visibleTabs]);

  useEffect(() => {
    if (activeTab === "docs") {
      return;
    }
    const nextSelectedEntityId = tabSelections[activeTab];
    setSelectedEntityId(nextSelectedEntityId ?? null);
  }, [activeTab, tabSelections]);

  function handleSelectEntity(entityId: string, tabId: TabId = activeTab) {
    setSelectedEntityId(entityId);
    setTabSelections((current) => ({ ...current, [tabId]: entityId }));
  }

  return (
    <div className="app-root">
      <header className="hero-shell">
        <div className="hero-copy panel-card">
          <div className="eyebrow">C64 Reverse Engineering Workspace</div>
          <h1>{snapshot?.project.name ?? "Project"}</h1>
          {snapshot ? (
            <div className="hero-metrics">
              {snapshot.views.projectDashboard.metrics.map((metric) => (
                <MetricTile key={metric.id} title={metric.title} value={metric.value} tone={metric.emphasis} />
              ))}
            </div>
          ) : null}
          {snapshot ? (
            <div className="hero-meta-line">
              <span>{snapshot.project.status}</span>
              <span>updated {shortTime(snapshot.generatedAt)}</span>
            </div>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!snapshot ? (
        <main className="loading-shell">
          <div className="panel-card empty-state">{loading ? "Loading workspace snapshot..." : "No snapshot loaded."}</div>
        </main>
      ) : (
        <main className={activeTab === "docs" ? "app-main-grid docs-mode" : "app-main-grid"}>
          <nav className="tab-strip" aria-label="Workspace views">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "tab-button active" : "tab-button"}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <section className="workspace-main">
            {activeTab === "dashboard" ? (
              <DashboardPanel
                snapshot={snapshot}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "dashboard")}
                onOpenDocument={(path) => {
                  setSelectedDocPath(path);
                  setActiveTab("docs");
                }}
              />
            ) : null}

            {activeTab === "docs" ? (
              <DocsPanel
                docs={docs}
                selectedPath={selectedDocPath}
                onSelectPath={setSelectedDocPath}
                content={docContent}
                loading={docLoading}
                error={docError}
              />
            ) : null}
            {activeTab === "memory" ? <MemoryMapPanel snapshot={snapshot} onSelectEntity={(entityId) => handleSelectEntity(entityId, "memory")} /> : null}
            {activeTab === "cartridge" ? (
              <CartridgePanel
                snapshot={snapshot}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "cartridge")}
                onOpenHex={openHexOverlay}
              />
            ) : null}
            {activeTab === "disk" ? <DiskPanel snapshot={snapshot} onSelectEntity={(entityId) => handleSelectEntity(entityId, "disk")} /> : null}
            {activeTab === "load" ? (
              <LoadSequencePanel
                view={snapshot.views.loadSequence}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "load")}
              />
            ) : null}
            {activeTab === "flow" ? (
              <FlowPanel
                flowGraph={snapshot.views.flowGraph}
                entities={snapshot.entities}
                relations={snapshot.relations}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "flow")}
              />
            ) : null}
            {activeTab === "listing" ? (
              <ListingPanel
                snapshot={snapshot}
                query={listingQuery}
                setQuery={setListingQuery}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "listing")}
              />
            ) : null}
            {activeTab === "activity" ? <ActivityPanel snapshot={snapshot} /> : null}
          </section>

          {activeTab !== "docs" ? (
            <aside className="workspace-side">
              <EntityInspector
                snapshot={snapshot}
                entity={selectedEntity}
                onSelectEntity={handleSelectEntity}
                onOpenDocument={(path) => {
                  setSelectedDocPath(path);
                  setActiveTab("docs");
                }}
                onOpenTab={setActiveTab}
                onOpenHex={openHexOverlay}
              />
            </aside>
          ) : null}
        </main>
      )}
      {hexOverlay ? (
        <HexView
          path={hexOverlay.path}
          projectDir={snapshot?.project.rootPath}
          title={hexOverlay.title}
          baseAddress={hexOverlay.baseAddress}
          onClose={() => setHexOverlay(null)}
        />
      ) : null}
    </div>
  );
}
