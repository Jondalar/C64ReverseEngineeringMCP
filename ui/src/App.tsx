import { startTransition, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { HexView } from "./components/HexView.js";
import { AsmView, type AsmViewSource } from "./components/AsmView.js";
import { CartridgeMemoryGrid } from "./components/CartridgeMemoryGrid.js";
import { FileInspector, type FileInspectorActionButton, type FileInspectorHeadlineExtra, type FileInspectorMetaRow, type FileInspectorSpanRow } from "./components/FileInspector.js";
import { MediumPanelShell, type MediumOriginPillSpec } from "./components/MediumPanelShell.js";
import { BootTracePanel } from "./components/BootTracePanel.js";
import { C64GraphicsView, type GraphicsRenderKind } from "./components/C64GraphicsView.js";
import type { CartridgeLutChunk } from "./types.js";
import type {
  ArtifactRecord,
  AuditCachedResponse,
  EntityRecord,
  FindingRecord,
  FlowGraphView,
  LoadSequenceView,
  MemoryMapView,
  OpenQuestionRecord,
  ProjectAuditFinding,
  ProjectRepairOperation,
  ProjectRepairResponse,
  RelationRecord,
  WorkspaceUiSnapshot,
} from "./types";

type TabId = "dashboard" | "docs" | "memory" | "graphics" | "scrub" | "cartridge" | "disk" | "payloads" | "load" | "flow" | "listing" | "activity";

interface UiConfig {
  defaultProjectDir: string;
}

interface UiDocument {
  id: string;
  title: string;
  relativePath: string;
  updatedAt: string;
  role?: string;
  unregistered?: boolean;
}

interface DiscoveredMarkdownDoc {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  title?: string;
}

interface DocsApiResponse {
  projectDir: string;
  docs: DiscoveredMarkdownDoc[];
}

interface GraphicsItem {
  id: string;
  label: string;
  kind: string;
  start: number;
  end: number;
  length: number;
  prgArtifactId: string;
  prgRelativePath: string;
  prgLoadAddress: number;
  fileOffset: number;
  analysisArtifactId: string;
}

interface GraphicsApiResponse {
  projectDir: string;
  items: GraphicsItem[];
  warnings: string[];
}

interface DocGroup {
  id: string;
  title: string;
  docs: UiDocument[];
}

interface TodoComposerState {
  mode: "task" | "question";
  title: string;
  description: string;
  entityIds: string[];
  artifactIds: string[];
}

type DiskFileSelection = { diskArtifactId: string; fileId: string };
type CartChunkSelection = { cartridgeArtifactId: string; chunk: CartridgeLutChunk };

const allTabs: Array<{ id: TabId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "docs", label: "Docs" },
  { id: "memory", label: "Memory Map" },
  { id: "graphics", label: "Graphics" },
  { id: "scrub", label: "Scrub" },
  { id: "cartridge", label: "Cartridge" },
  { id: "disk", label: "Disk" },
  { id: "payloads", label: "Payloads" },
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

function asmDialectForPath(relativePath: string): AsmViewSource["dialect"] {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".tass")) return "64tass";
  if (lower.endsWith(".asm")) return "kickass";
  return "plain";
}

function asmArtifactPriority(artifact: ArtifactRecord): number {
  switch (artifact.role) {
    case "final-kickassembler-source":
    case "final-64tass-source":
      return 300;
    case "kickassembler-source":
    case "64tass-source":
      return 200;
    default:
      return 100;
  }
}

function bestAsmSourcesForArtifacts(artifacts: ArtifactRecord[]): AsmViewSource[] {
  const bestByDialect = new Map<AsmViewSource["dialect"], ArtifactRecord>();
  for (const artifact of artifacts) {
    const dialect = asmDialectForPath(artifact.relativePath);
    const current = bestByDialect.get(dialect);
    if (!current || asmArtifactPriority(artifact) > asmArtifactPriority(current)) {
      bestByDialect.set(dialect, artifact);
    }
  }
  const dialectOrder: Record<AsmViewSource["dialect"], number> = {
    kickass: 0,
    "64tass": 1,
    plain: 2,
  };
  return [...bestByDialect.entries()]
    .sort(([left], [right]) => dialectOrder[left] - dialectOrder[right])
    .map(([dialect, artifact]) => ({
      id: artifact.id,
      label: dialect === "kickass" ? "KickAss" : dialect === "64tass" ? "64tass" : artifact.relativePath,
      path: artifact.relativePath,
      dialect,
    }));
}

function binaryArtifactPriority(artifact: ArtifactRecord): number {
  switch (artifact.role) {
    case "rebuilt-prg":
      return 300;
    case "analysis-target":
      return 200;
    default:
      return 100;
  }
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
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
  if (doc.unregistered) return "discovered";
  const name = doc.title.toLowerCase();
  if (docPriority(doc) === 0) return "main";
  if (name.endsWith("_pointer_facts.md") || name.endsWith("_ram_facts.md")) return "facts";
  return "notes";
}

function docGroupTitle(groupId: string): string {
  if (groupId === "main") return "Main Docs";
  if (groupId === "facts") return "Per-File Facts";
  if (groupId === "discovered") return "Discovered (unregistered)";
  return "Other Notes";
}

function buildDocs(
  artifacts: ArtifactRecord[],
  discovered: DiscoveredMarkdownDoc[] = [],
): UiDocument[] {
  const registered = artifacts
    .filter((artifact) => artifact.relativePath.toLowerCase().startsWith("doc/") || artifact.relativePath.toLowerCase().endsWith(".md"))
    .map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      relativePath: artifact.relativePath,
      updatedAt: artifact.updatedAt,
      role: artifact.role,
    }));

  const registeredPaths = new Set(registered.map((doc) => doc.relativePath.toLowerCase()));
  const fallback: UiDocument[] = discovered
    .filter((entry) => !registeredPaths.has(entry.relativePath.toLowerCase()))
    .map((entry) => ({
      id: `discovered:${entry.relativePath}`,
      title: entry.title?.trim() || entry.relativePath.split("/").pop()?.replace(/\.md$/i, "") || entry.relativePath,
      relativePath: entry.relativePath,
      updatedAt: entry.modifiedAt,
      role: "discovered",
      unregistered: true,
    }));

  return [...registered, ...fallback].sort((left, right) => {
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
  return ["main", "notes", "facts", "discovered"]
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

const ALL_REPAIR_OPS: ProjectRepairOperation[] = [
  "merge-fragments",
  "register-artifacts",
  "import-analysis",
  "import-manifest",
  "build-views",
];

function AuditPanel({
  projectDir,
  onReloadWorkspace,
}: {
  projectDir: string;
  onReloadWorkspace: () => Promise<void>;
}) {
  const [audit, setAudit] = useState<AuditCachedResponse | null>(null);
  const [busy, setBusy] = useState<"audit" | "audit-fresh" | "repair-dry" | "repair-safe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRepair, setLastRepair] = useState<ProjectRepairResponse | null>(null);

  async function loadAudit(fresh: boolean) {
    setError(null);
    setBusy(fresh ? "audit-fresh" : "audit");
    try {
      const url = `/api/audit?projectDir=${encodeURIComponent(projectDir)}${fresh ? "&fresh=1" : ""}`;
      const data = await fetchJson<AuditCachedResponse>(url);
      setAudit(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(null);
    }
  }

  async function runRepair(mode: "dry-run" | "safe") {
    if (mode === "safe" && !window.confirm("Run safe repair? This will write to knowledge/ and views/. Source files are not deleted.")) {
      return;
    }
    setError(null);
    setBusy(mode === "safe" ? "repair-safe" : "repair-dry");
    try {
      const data = await postJson<ProjectRepairResponse>("/api/repair", {
        projectDir,
        mode,
        operations: ALL_REPAIR_OPS,
      });
      setLastRepair(data);
      await loadAudit(true);
      if (mode === "safe") await onReloadWorkspace();
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : String(repairError));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadAudit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  const findings: ProjectAuditFinding[] = audit?.audit.findings ?? [];
  const counts = audit?.audit.counts;

  return (
    <section className="panel-card audit-panel">
      <div className="section-heading">
        <h3>Project Audit</h3>
        <span>{audit ? `${audit.audit.severity} (${audit.cacheStatus})` : "loading..."}</span>
      </div>
      <div className="inspector-chip-row">
        <button type="button" className="inspector-chip" disabled={busy !== null} onClick={() => loadAudit(true)}>
          {busy === "audit-fresh" ? "Auditing..." : "Refresh audit"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busy !== null || !audit?.audit.safeRepairAvailable}
          onClick={() => runRepair("dry-run")}
        >
          {busy === "repair-dry" ? "Planning..." : "Dry-run repair"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busy !== null || !audit?.audit.safeRepairAvailable}
          onClick={() => runRepair("safe")}
        >
          {busy === "repair-safe" ? "Repairing..." : "Run safe repair"}
        </button>
      </div>
      {error ? <div className="inspector-error">{error}</div> : null}
      {counts ? (
        <div className="record-meta">
          <span>nested={counts.nestedKnowledgeStores}</span>
          <span>broken={counts.brokenArtifactPaths}</span>
          <span>missing={counts.missingArtifacts}</span>
          <span>unregistered={counts.unregisteredFiles}</span>
          <span>unimported={counts.unimportedAnalysisArtifacts + counts.unimportedManifestArtifacts}</span>
          <span>staleViews={counts.staleViews}</span>
        </div>
      ) : null}
      <div className="record-stack compact">
        {findings.length === 0 ? (
          <div className="empty-inline">No audit findings.</div>
        ) : (
          findings.slice(0, 5).map((finding) => (
            <article key={finding.id} className="mini-card">
              <div className="record-topline">
                <span>[{finding.severity}] {finding.title}</span>
              </div>
              <p>{finding.whyItMatters}</p>
              <p><strong>Fix:</strong> {finding.suggestedFix}</p>
              {finding.paths.length > 0 ? (
                <div className="record-meta">
                  <span>{finding.paths.length} affected path(s)</span>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      {lastRepair ? (
        <details className="audit-repair-result">
          <summary>{`Last repair (${lastRepair.mode}) — executed=${lastRepair.executed.length} skipped=${lastRepair.skipped.length}`}</summary>
          <div className="record-stack compact">
            {lastRepair.planned.length > 0 ? (
              <article className="mini-card">
                <strong>Planned</strong>
                <pre>{lastRepair.planned.slice(0, 20).join("\n")}</pre>
              </article>
            ) : null}
            {lastRepair.executed.length > 0 ? (
              <article className="mini-card">
                <strong>Executed</strong>
                <pre>{lastRepair.executed.slice(0, 20).join("\n")}</pre>
              </article>
            ) : null}
            {lastRepair.skipped.length > 0 ? (
              <article className="mini-card">
                <strong>Skipped</strong>
                <pre>{lastRepair.skipped.slice(0, 20).join("\n")}</pre>
              </article>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DashboardPanel({
  snapshot,
  onSelectEntity,
  onSelectQuestion,
  onOpenDocument,
  onReloadWorkspace,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
  onSelectQuestion: (questionId: string) => void;
  onOpenDocument: (path: string) => void;
  onReloadWorkspace: () => Promise<void>;
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
      <AuditPanel projectDir={snapshot.project.rootPath} onReloadWorkspace={onReloadWorkspace} />

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
              <button key={question.id} type="button" className="record-card" onClick={() => onSelectQuestion(question.id)}>
                <div className="record-topline">
                  <span>{question.title}</span>
                  <span className="record-status">{question.status}</span>
                </div>
                {question.summary ? <p>{question.summary}</p> : null}
              </button>
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
                        <span className="record-status">{doc.unregistered ? "unregistered" : (doc.role ?? "doc")}</span>
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

const GRAPHICS_GROUP_ORDER: Array<{ id: string; title: string; matches: (kind: string) => boolean }> = [
  { id: "sprites", title: "Sprites", matches: (kind) => kind === "sprite" },
  { id: "charsets", title: "Charsets", matches: (kind) => kind === "charset" || kind === "charset_source" },
  { id: "bitmaps", title: "Bitmaps", matches: (kind) => kind === "bitmap" || kind === "hires_bitmap" || kind === "multicolor_bitmap" || kind === "bitmap_source" },
  { id: "screens", title: "Screen / Color", matches: (kind) => kind === "screen_ram" || kind === "screen_source" || kind === "color_source" },
];

function groupGraphics(items: GraphicsItem[]): Array<{ id: string; title: string; items: GraphicsItem[] }> {
  return GRAPHICS_GROUP_ORDER
    .map((group) => ({ id: group.id, title: group.title, items: items.filter((item) => group.matches(item.kind)) }))
    .filter((group) => group.items.length > 0);
}

function formatHex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function formatBytes(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function GraphicsPanel({
  items,
  selectedId,
  onSelect,
  bytes,
  loading,
  error,
  charsetPairId,
  onSelectCharsetPair,
  charsetBytes,
  marks,
  onMark,
  hideRejected,
  onToggleHideRejected,
}: {
  items: GraphicsItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  bytes: Uint8Array | null;
  loading: boolean;
  error: string | null;
  charsetPairId: string | null;
  onSelectCharsetPair: (id: string | null) => void;
  charsetBytes: Uint8Array | null;
  marks: Record<string, { status: "rejected" | "confirmed"; note?: string }>;
  onMark: (itemId: string, status: "rejected" | "confirmed" | "clear") => void;
  hideRejected: boolean;
  onToggleHideRejected: (next: boolean) => void;
}) {
  const visibleItems = hideRejected ? items.filter((item) => marks[item.id]?.status !== "rejected") : items;
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const groups = groupGraphics(visibleItems);
  const renderKind = (selected?.kind ?? "sprite") as GraphicsRenderKind;
  const showColours = !!selected;
  const charsetCandidates = items.filter((item) => item.kind === "charset" || item.kind === "charset_source");
  const screenLikeKind = selected && (selected.kind === "screen_ram" || selected.kind === "screen_source" || selected.kind === "color_source");
  const rejectedCount = items.filter((item) => marks[item.id]?.status === "rejected").length;
  const confirmedCount = items.filter((item) => marks[item.id]?.status === "confirmed").length;
  const selectedMark = selected ? marks[selected.id] : undefined;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Graphics</h3>
        <span>{items.length} segments · {confirmedCount} confirmed · {rejectedCount} rejected</span>
        <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
          <input type="checkbox" checked={hideRejected} onChange={(e) => onToggleHideRejected(e.target.checked)} />
          Hide rejected
        </label>
      </div>
      <div className="docs-shell">
        <div className="docs-list">
          <div className="docs-list-stack">
            {groups.map((group) => (
              <section key={group.id} className="docs-group">
                <div className="docs-group-title">
                  <strong>{group.title}</strong>
                  <span>{group.items.length}</span>
                </div>
                <div className="record-stack">
                  {group.items.map((item) => {
                    const mark = marks[item.id];
                    const markBadge = mark?.status === "rejected" ? "rejected" : mark?.status === "confirmed" ? "confirmed" : item.kind;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={selected?.id === item.id ? "record-card active-record" : "record-card"}
                        onClick={() => onSelect(item.id)}
                        style={mark?.status === "rejected" ? { opacity: 0.55 } : undefined}
                      >
                        <div className="record-topline">
                          <span>{item.label}</span>
                          <span className="record-status">{markBadge}</span>
                        </div>
                        <p>${formatHex16(item.start)}–${formatHex16(item.end)} · {formatBytes(item.length)}</p>
                        <div className="record-meta">
                          <span>{item.prgRelativePath}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="docs-viewer">
          <div className="detail-title-row">
            <h4>{selected?.label ?? "No graphics segment selected"}</h4>
            <span>{selected ? `${selected.kind} · $${formatHex16(selected.start)}–$${formatHex16(selected.end)} · ${formatBytes(selected.length)}` : ""}</span>
          </div>
          {selected ? (
            <div className="c64-mark-row" style={{ display: "flex", gap: "8px", padding: "4px 0", fontSize: "12px" }}>
              <span style={{ color: "#9aa4b2" }}>Status: <strong>{selectedMark?.status ?? "unmarked"}</strong></span>
              <button type="button" disabled={selectedMark?.status === "confirmed"} onClick={() => onMark(selected.id, "confirmed")}>Confirm graphics</button>
              <button type="button" disabled={selectedMark?.status === "rejected"} onClick={() => onMark(selected.id, "rejected")}>Mark wrong</button>
              {selectedMark ? <button type="button" onClick={() => onMark(selected.id, "clear")}>Clear mark</button> : null}
            </div>
          ) : null}
          {screenLikeKind && charsetCandidates.length > 0 ? (
            <div className="c64-charmap-pairing">
              <label>
                Pair with charset:&nbsp;
                <select
                  value={charsetPairId ?? ""}
                  onChange={(event) => onSelectCharsetPair(event.target.value || null)}
                >
                  <option value="">(none — render bytes as charset grid)</option>
                  {charsetCandidates.map((charset) => (
                    <option key={charset.id} value={charset.id}>
                      {charset.label} (${formatHex16(charset.start)}–${formatHex16(charset.end)}, {formatBytes(charset.length)})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {selected ? (
            <C64GraphicsView
              bytes={bytes}
              loading={loading}
              error={error}
              kind={renderKind}
              showColourPicker={showColours}
              charsetBytes={screenLikeKind ? charsetBytes ?? undefined : undefined}
            />
          ) : (
            <div className="empty-state">Select a graphics segment to render it.</div>
          )}
        </div>
      </div>
    </section>
  );
}

type ScrubKind = "sprite" | "charset" | "bitmap";

const SCRUB_BLOCK_BYTES: Record<ScrubKind, number> = {
  sprite: 64,
  charset: 8,
  bitmap: 320, // 8 bytes per cell × 40 cells = one row of an 8000-byte hires bitmap
};

function ScrubPanel({
  artifacts,
  projectRoot,
  onOpenHex,
  onOpenAsm,
}: {
  artifacts: ArtifactRecord[];
  projectRoot: string;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
}) {
  const scrubArtifacts = artifacts.filter((artifact) =>
    artifact.kind === "prg" || artifact.kind === "crt" || artifact.kind === "raw"
  );
  const [selectedPath, setSelectedPath] = useState<string>(scrubArtifacts[0]?.relativePath ?? "");
  const [offsetText, setOffsetText] = useState<string>("0000");
  const [windowText, setWindowText] = useState<string>("1000");
  const [kind, setKind] = useState<ScrubKind>("charset");
  const [multicolor, setMulticolor] = useState<boolean>(false);
  const [columns, setColumns] = useState<number>(32);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [prgLoadAddress, setPrgLoadAddress] = useState<number | null>(null);

  function parseHex(value: string): number {
    const clean = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean)) return 0;
    return Number.parseInt(clean, 16);
  }

  function formatHex(value: number): string {
    return value.toString(16).toUpperCase().padStart(4, "0");
  }

  useEffect(() => {
    if (!selectedPath) {
      setBytes(null);
      setFileSize(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const offset = parseHex(offsetText);
        const length = Math.max(1, parseHex(windowText));
        const params = new URLSearchParams({
          projectDir: projectRoot,
          path: selectedPath,
          offset: String(offset),
          length: String(length),
        });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        setBytes(new Uint8Array(buffer));
        const total = response.headers.get("Content-Range");
        // Best-effort size via separate HEAD-style probe: /api/artifact/raw returns the
        // requested slice, so just fall back to size inference by re-querying length=1
        // at a far offset. For the spike we leave fileSize null when unknown.
        setFileSize(total ? Number.parseInt(total.split("/")[1] ?? "", 10) || null : null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
          setBytes(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPath, offsetText, windowText, projectRoot]);

  function step(deltaBytes: number) {
    const current = parseHex(offsetText);
    const next = Math.max(0, current + deltaBytes);
    setOffsetText(formatHex(next));
  }

  // Pull the 2-byte PRG load-address header so the annotation form can
  // map file offsets to C64 addresses automatically.
  useEffect(() => {
    if (!selectedPath) {
      setPrgLoadAddress(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ projectDir: projectRoot, path: selectedPath, offset: "0", length: "2" });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buf = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        if (buf.length >= 2) setPrgLoadAddress(buf[0]! | (buf[1]! << 8));
      } catch {
        if (!cancelled) setPrgLoadAddress(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPath, projectRoot]);

  async function saveAnnotation() {
    if (!selectedArtifact) return;
    if (selectedArtifact.kind !== "prg") {
      setAnnotateStatus("Annotations require a PRG artifact.");
      return;
    }
    setAnnotateBusy(true);
    setAnnotateStatus("");
    try {
      const fileOffset = parseHex(offsetText);
      const windowBytes = Math.max(1, parseHex(windowText));
      const start = (prgLoadAddress ?? 0) + Math.max(0, fileOffset - 2);
      const end = start + windowBytes - 1;
      const segmentKind = kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind;
      const response = await fetch("/api/scrub/annotate-segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDir: projectRoot,
          prgPath: selectedPath,
          start: start.toString(16).toUpperCase().padStart(4, "0"),
          end: end.toString(16).toUpperCase().padStart(4, "0"),
          kind: segmentKind,
          label: annotateLabel.trim() || undefined,
          comment: annotateComment.trim() || undefined,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { annotationsPath: string; totalSegments: number };
      setAnnotateStatus(`Saved → ${payload.annotationsPath} (${payload.totalSegments} segments).`);
    } catch (saveError) {
      setAnnotateStatus(`Save failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    } finally {
      setAnnotateBusy(false);
    }
  }

  const blockBytes = SCRUB_BLOCK_BYTES[kind];

  const [annotateLabel, setAnnotateLabel] = useState<string>("");
  const [annotateComment, setAnnotateComment] = useState<string>("");
  const [annotateStatus, setAnnotateStatus] = useState<string>("");
  const [annotateBusy, setAnnotateBusy] = useState<boolean>(false);

  const selectedArtifact = scrubArtifacts.find((artifact) => artifact.relativePath === selectedPath);
  const stem = selectedArtifact ? selectedArtifact.relativePath.replace(/\.[^.]+$/, "").replace(/^.*\//, "") : "";
  const pairedAsmSources = stem
    ? bestAsmSourcesForArtifacts(
        artifacts.filter((artifact) => {
          const lower = artifact.relativePath.toLowerCase();
          if (!lower.endsWith(".asm") && !lower.endsWith(".tass")) return false;
          return lower.includes(stem.toLowerCase());
        }),
      )
    : [];
  const showMon = selectedArtifact ? isC64BinaryArtifact(selectedArtifact.relativePath) : false;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Scrub</h3>
        <span>Free-form memory browser — pick a file, scroll the address, render any slice</span>
      </div>
      {selectedArtifact ? (
        <div className="scrub-inspector" style={{
          display: "flex", flexWrap: "wrap", gap: "16px", padding: "10px 12px",
          background: "rgba(255,255,255,0.04)", borderRadius: "6px", marginBottom: "8px",
          fontSize: "12px", alignItems: "center",
        }}>
          <div><strong>{selectedArtifact.title}</strong></div>
          <div style={{ color: "#9aa4b2" }}>kind: {selectedArtifact.kind}</div>
          <div style={{ color: "#9aa4b2" }}>role: {selectedArtifact.role ?? "—"}</div>
          <div style={{ color: "#9aa4b2" }}>status: {selectedArtifact.status}</div>
          <div style={{ color: "#9aa4b2" }}>{selectedArtifact.relativePath}</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: "6px" }}>
            {showMon ? (
              <button
                type="button"
                onClick={() => onOpenHex(selectedArtifact.relativePath, {
                  title: `${selectedArtifact.title} (hex)`,
                  baseAddress: 0,
                })}
              >
                (mon)
              </button>
            ) : null}
            {pairedAsmSources.length > 0 ? (
              <button
                type="button"
                onClick={() => onOpenAsm(`${selectedArtifact.title} disasm`, pairedAsmSources)}
              >
                .asm
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="docs-shell">
        <div className="docs-list" style={{ minWidth: "280px" }}>
          <div className="docs-list-stack" style={{ gap: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              File:
              <select value={selectedPath} onChange={(e) => setSelectedPath(e.target.value)}>
                {scrubArtifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.relativePath}>
                    {artifact.title} ({artifact.kind})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              Offset (hex):
              <input
                type="text"
                value={offsetText}
                onChange={(e) => setOffsetText(e.target.value)}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </label>
            <div style={{ display: "flex", gap: "4px", fontSize: "11px" }}>
              <button type="button" onClick={() => step(-blockBytes * 4)}>--row</button>
              <button type="button" onClick={() => step(-blockBytes)}>-blk</button>
              <button type="button" onClick={() => step(-1)}>-1</button>
              <button type="button" onClick={() => step(1)}>+1</button>
              <button type="button" onClick={() => step(blockBytes)}>+blk</button>
              <button type="button" onClick={() => step(blockBytes * 4)}>+row</button>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              Window (hex bytes):
              <input
                type="text"
                value={windowText}
                onChange={(e) => setWindowText(e.target.value)}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              Kind:
              <select value={kind} onChange={(e) => setKind(e.target.value as ScrubKind)}>
                <option value="charset">charset (8x8)</option>
                <option value="sprite">sprite (24x21)</option>
                <option value="bitmap">bitmap (320x200)</option>
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <input type="checkbox" checked={multicolor} onChange={(e) => setMulticolor(e.target.checked)} />
              Multicolor
            </label>
            {kind !== "bitmap" ? (
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                Columns per row ({kind === "sprite" ? `${columns}×24 = ${columns * 24}px wide` : `${columns}×8 = ${columns * 8}px wide`}):
                <input
                  type="number"
                  min={1}
                  max={128}
                  value={columns}
                  onChange={(e) => setColumns(Math.max(1, Math.min(128, Number.parseInt(e.target.value, 10) || 1)))}
                />
              </label>
            ) : null}
            <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>
              Block size: {blockBytes} bytes. Use <strong>+blk / -blk</strong> to jump exactly one block at a time.
            </p>
            {fileSize ? <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>File size: {fileSize} B</p> : null}
            {prgLoadAddress !== null ? (
              <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>Load address: ${prgLoadAddress.toString(16).toUpperCase().padStart(4, "0")}</p>
            ) : null}
            {selectedArtifact?.kind === "prg" ? (
              <div style={{ borderTop: "1px solid #30363d", paddingTop: "10px", marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}>
                <strong style={{ fontSize: "12px" }}>Save as segment</strong>
                <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>
                  Persists the current window into <code>{selectedArtifact?.relativePath.replace(/\.[^.]+$/, "")}_annotations.json</code> as a kind=
                  <code>{kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind}</code> segment. Picked up by the next <code>disasm_prg</code> run.
                </p>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                  Label (optional):
                  <input
                    type="text"
                    value={annotateLabel}
                    onChange={(e) => setAnnotateLabel(e.target.value)}
                    placeholder="e.g. title_screen_charset"
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                  Comment (optional):
                  <input
                    type="text"
                    value={annotateComment}
                    onChange={(e) => setAnnotateComment(e.target.value)}
                    placeholder="why this slice is graphics"
                  />
                </label>
                <button type="button" onClick={saveAnnotation} disabled={annotateBusy}>
                  {annotateBusy ? "Saving…" : "Save segment"}
                </button>
                {annotateStatus ? <p style={{ fontSize: "11px", color: "#9aa4b2", margin: 0 }}>{annotateStatus}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="docs-viewer">
          <div className="detail-title-row">
            <h4>{selectedPath || "No file"}</h4>
            <span>offset=${offsetText.toUpperCase()} window=${windowText.toUpperCase()} {kind}{multicolor ? "·mc" : ""}</span>
          </div>
          {selectedPath ? (
            <C64GraphicsView
              bytes={bytes}
              loading={loading}
              error={error}
              kind={(kind === "bitmap" ? (multicolor ? "multicolor_bitmap" : "hires_bitmap") : kind) as GraphicsRenderKind}
              multicolor={kind !== "bitmap" ? multicolor : undefined}
              columns={kind !== "bitmap" ? columns : undefined}
              showColourPicker={true}
            />
          ) : (
            <div className="empty-state">No artifact available to scrub.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function MemoryMapPanel({
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

function CartridgePanel({
  snapshot,
  onSelectEntity,
  onSelectChunk,
  onOpenHex,
}: {
  snapshot: WorkspaceUiSnapshot;
  onSelectEntity: (entityId: string) => void;
  onSelectChunk: (cartridgeArtifactId: string, chunk: CartridgeLutChunk) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
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

function DiskPanel({
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
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
}) {
  const disks = snapshot.views.diskLayout.disks;
  const [activeDiskId, setActiveDiskId] = useState<string | null>(disks[0]?.artifactId ?? null);
  const activeDisk = disks.find((disk) => disk.artifactId === activeDiskId) ?? disks[0];
  const [selectedFileId, setSelectedFileId] = useState<string | null>(activeDisk?.files[0]?.id ?? null);
  const [originFilter, setOriginFilter] = useState<DiskOriginFilter>("all");

  useEffect(() => {
    if (!selectedDiskFile) return;
    const disk = disks.find((candidate) => candidate.artifactId === selectedDiskFile.diskArtifactId);
    if (!disk || !disk.files.some((file) => file.id === selectedDiskFile.fileId)) return;
    if (activeDiskId !== disk.artifactId) setActiveDiskId(disk.artifactId);
    if (selectedFileId !== selectedDiskFile.fileId) setSelectedFileId(selectedDiskFile.fileId);
  }, [activeDiskId, disks, selectedDiskFile, selectedFileId]);

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
              setSelectedFileId(disk.files[0]?.id ?? null);
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
                {visibleFiles.map((file) => (
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
                      <span className="record-status">{file.loadType}</span>
                    </div>
                    <div className="record-meta">
                      <span>{file.sizeSectors ?? 0} blk</span>
                      {file.loadAddress !== undefined ? <span>{hex(file.loadAddress)}</span> : null}
                      {file.loaderSource ? <span>via {file.loaderSource}</span> : null}
                      {file.packer ? <span>{file.packer}</span> : null}
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
            {(() => {
              const diskArtifact = snapshot.artifacts.find((art) => art.id === activeDisk.artifactId);
              const diskPath = activeDisk.imageRelativePath ?? diskArtifact?.relativePath ?? "";
              const isD64 = diskPath.toLowerCase().endsWith(".d64");
              if (!isD64) return null;
              return (
                <div className="disk-track-strip">
                  <span className="disk-track-strip-label">Track</span>
                  {Array.from({ length: activeDisk.trackCount }, (_, i) => i + 1).map((track) => {
                    const sectors = d64SectorsInTrack(track);
                    const offset = d64SectorOffset(track, 0);
                    const length = sectors * 256;
                    return (
                      <button
                        key={track}
                        type="button"
                        className="disk-track-mon"
                        title={`Open hex view of track ${track} (${sectors} sectors = ${length} B)`}
                        onClick={() => onOpenHex(diskPath, {
                          title: `${activeDisk.diskName ?? activeDisk.title} · Track ${track}`,
                          baseAddress: 0,
                          offset,
                          length,
                        })}
                      >
                        {track}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            <div className="disk-geometry-wrap">
              <svg viewBox="0 0 640 640" className="disk-geometry-svg" role="img" aria-label="Disk geometry">
                <circle cx="320" cy="320" r="58" className="disk-center-hole" />
                {activeDisk.sectors.map((sector) => {
                  const selectionActive = selectedFile?.id !== undefined;
                  const isSelected = selectionActive && sector.fileId === selectedFile!.id;
                  const filteredOut = sector.fileId !== undefined && !visibleFileIds.has(sector.fileId);
                  const dimmed = !isSelected && (filteredOut || selectionActive);
                  const className = [
                    "disk-sector",
                    `disk-sector-${sector.category}`,
                    isSelected ? "selected" : "",
                    dimmed ? "disk-sector-dimmed" : "",
                    filteredOut ? "disk-sector-filtered-out" : "",
                  ].filter(Boolean).join(" ");
                  const useFileColor = sector.category === "file" && sector.color && !filteredOut;
                  return (
                    <path
                      key={sector.id}
                      d={sectorPath(sector.track, sector.angleStart, sector.angleEnd)}
                      className={className}
                      style={useFileColor ? { fill: sector.color } : undefined}
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
        <span><i className="legend-swatch disk-legend-free" /> free ($00)</span>
        <span><i className="legend-swatch disk-legend-free-data" /> free w/ data</span>
        <span><i className="legend-swatch disk-legend-orphan" /> allocated, no file</span>
      </div>
    </MediumPanelShell>
  );
}

type MediaFilter = "all" | "disk" | "cartridge";

function artifactMediaClass(kind: string | undefined): "disk" | "cartridge" | "other" {
  if (!kind) return "other";
  const k = kind.toLowerCase();
  if (k.includes("d64") || k.includes("g64") || k.includes("disk")) return "disk";
  if (k.includes("crt") || k.includes("cart") || k.includes("chip")) return "cartridge";
  return "other";
}

function diskFileSelectionForEntity(snapshot: WorkspaceUiSnapshot, entityId: string): DiskFileSelection | null {
  for (const disk of snapshot.views.diskLayout.disks) {
    const file = disk.files.find((candidate) => candidate.entityId === entityId);
    if (file) return { diskArtifactId: disk.artifactId, fileId: file.id };
  }
  return null;
}

function firstDiskFileSelection(snapshot: WorkspaceUiSnapshot): DiskFileSelection | null {
  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.files.length > 0);
  const file = disk?.files[0];
  return disk && file ? { diskArtifactId: disk.artifactId, fileId: file.id } : null;
}

function diskSelectionEntityId(snapshot: WorkspaceUiSnapshot, selection: DiskFileSelection | null): string | null {
  if (!selection) return null;
  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.artifactId === selection.diskArtifactId);
  return disk?.files.find((file) => file.id === selection.fileId)?.entityId ?? null;
}

function tabHasEntity(snapshot: WorkspaceUiSnapshot, entityId: string, tab: TabId): boolean {
  const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return false;
  if (tab === "dashboard") return true;
  if (tab === "docs" || tab === "activity" || tab === "graphics" || tab === "scrub") return false;
  if (tab === "memory") {
    return Boolean(entity.addressRange)
      || snapshot.views.memoryMap.cells.some((cell) => cell.entityIds.includes(entityId) || cell.dominantEntityId === entityId)
      || snapshot.views.memoryMap.regions.some((region) => region.entityId === entityId)
      || snapshot.views.memoryMap.highlights.some((highlight) => highlight.entityId === entityId);
  }
  if (tab === "disk") return diskFileSelectionForEntity(snapshot, entityId) !== null;
  if (tab === "load") return snapshot.views.loadSequence.items.some((item) => item.primaryEntityId === entityId || item.entityIds.includes(entityId));
  if (tab === "flow") return snapshot.views.flowGraph.nodes.some((node) => node.entityId === entityId)
    || Object.values(snapshot.views.flowGraph.modes ?? {}).some((mode) => mode.nodes.some((node) => node.entityId === entityId));
  if (tab === "listing") return snapshot.views.annotatedListing.entries.some((entry) => entry.entityId === entityId);
  if (tab === "cartridge") {
    const isCartridgeEntity = entity.kind.toLowerCase().includes("chip")
      || entity.kind.toLowerCase().includes("bank")
      || entity.mediumSpans?.some((span) => span.kind === "slot")
      || entity.artifactIds.some((artifactId) => snapshot.views.cartridgeLayout.cartridges.some((cart) => cart.artifactId === artifactId));
    return Boolean(isCartridgeEntity);
  }
  return false;
}

function firstEntityForTab(snapshot: WorkspaceUiSnapshot, tab: TabId): string | null {
  if (tab === "dashboard") {
    return snapshot.findings.flatMap((finding) => finding.entityIds)[0] ?? snapshot.entities[0]?.id ?? null;
  }
  if (tab === "memory") {
    return snapshot.views.memoryMap.regions.find((region) => region.entityId)?.entityId
      ?? snapshot.views.memoryMap.highlights.find((highlight) => highlight.entityId)?.entityId
      ?? snapshot.views.memoryMap.cells.flatMap((cell) => cell.dominantEntityId ? [cell.dominantEntityId] : cell.entityIds)[0]
      ?? null;
  }
  if (tab === "cartridge") {
    return snapshot.entities.find((entity) => tabHasEntity(snapshot, entity.id, "cartridge"))?.id ?? null;
  }
  if (tab === "disk") {
    return snapshot.views.diskLayout.disks.flatMap((disk) => disk.files.map((file) => file.entityId).filter(Boolean))[0] ?? null;
  }
  if (tab === "load") {
    return snapshot.views.loadSequence.items.flatMap((item) => item.primaryEntityId ? [item.primaryEntityId] : item.entityIds)[0] ?? null;
  }
  if (tab === "flow") {
    return snapshot.views.flowGraph.nodes.find((node) => node.entityId)?.entityId
      ?? Object.values(snapshot.views.flowGraph.modes ?? {}).flatMap((mode) => mode.nodes.map((node) => node.entityId).filter(Boolean))[0]
      ?? null;
  }
  if (tab === "listing") {
    return snapshot.views.annotatedListing.entries.find((entry) => entry.entityId)?.entityId ?? null;
  }
  return null;
}

function LoadSequencePanel({
  view,
  snapshot,
  selectedEntityId,
  onSelectEntity,
}: {
  view: LoadSequenceView;
  snapshot: WorkspaceUiSnapshot;
  selectedEntityId?: string | null;
  onSelectEntity: (entityId: string) => void;
}) {
  const artifactKindById = useMemo(() => {
    const map = new Map<string, string>();
    for (const artifact of snapshot.artifacts) map.set(artifact.id, artifact.kind);
    return map;
  }, [snapshot.artifacts]);

  const diskCount = view.items.filter((item) => item.artifactIds.some((id) => artifactMediaClass(artifactKindById.get(id)) === "disk")).length;
  const cartCount = view.items.filter((item) => item.artifactIds.some((id) => artifactMediaClass(artifactKindById.get(id)) === "cartridge")).length;
  const showMediaFilter = diskCount > 0 && cartCount > 0;
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");

  const visibleItems = useMemo(() => {
    if (mediaFilter === "all") return view.items;
    return view.items.filter((item) =>
      item.artifactIds.some((id) => artifactMediaClass(artifactKindById.get(id)) === mediaFilter),
    );
  }, [view.items, artifactKindById, mediaFilter]);
  const visibleItemIds = new Set(visibleItems.map((item) => item.id));
  const visibleEdges = view.edges.filter((edge) => visibleItemIds.has(edge.fromItemId) && visibleItemIds.has(edge.toItemId));

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Load Sequence</h3>
        <span>{visibleItems.length} payloads / {visibleEdges.length} transitions</span>
      </div>
      {showMediaFilter ? (
        <div className="cart-lut-filter">
          <span className="cart-lut-filter-title">Source</span>
          <button
            type="button"
            className={mediaFilter === "all" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setMediaFilter("all")}
          >
            <span>all</span>
            <span className="cart-lut-pill-count">{view.items.length}</span>
          </button>
          <button
            type="button"
            className={mediaFilter === "disk" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setMediaFilter("disk")}
          >
            <span>disk</span>
            <span className="cart-lut-pill-count">{diskCount}</span>
          </button>
          <button
            type="button"
            className={mediaFilter === "cartridge" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setMediaFilter("cartridge")}
          >
            <span>cartridge</span>
            <span className="cart-lut-pill-count">{cartCount}</span>
          </button>
        </div>
      ) : null}
      <div className="sequence-strip">
        {visibleItems.map((item, index) => (
          <div key={item.id} className="sequence-step">
            <button
              type="button"
              className={selectedEntityId && (item.primaryEntityId === selectedEntityId || item.entityIds.includes(selectedEntityId)) ? "sequence-card active-record" : "sequence-card"}
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
            {index < visibleItems.length - 1 ? <div className="sequence-arrow" aria-hidden="true">↓</div> : null}
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
            {visibleEdges.map((edge) => (
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

function ListingPanel({
  snapshot,
  query,
  setQuery,
  selectedEntityId,
  onSelectEntity,
}: {
  snapshot: WorkspaceUiSnapshot;
  query: string;
  setQuery: (value: string) => void;
  selectedEntityId?: string | null;
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
              <tr key={entry.id} className={entry.entityId === selectedEntityId ? "active-row" : ""} onClick={() => entry.entityId && onSelectEntity(entry.entityId)}>
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

function PayloadsPanel({
  snapshot,
  onOpenHex,
  onOpenAsm,
}: {
  snapshot: WorkspaceUiSnapshot;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
}) {
  // A payload is any entity that carries payload metadata (load address
  // or kind=payload) — disk files imported via manifest-import already
  // populate this. Cart chunks are surfaced via the cartridge view's
  // chunk inspector; once they get entity records they will appear
  // here too.
  const payloads = useMemo(() => {
    return snapshot.entities
      .filter((entity) =>
        entity.kind === "payload" ||
        entity.kind === "disk-file" ||
        entity.payloadLoadAddress !== undefined
      )
      .sort((a, b) => {
        const la = a.payloadLoadAddress ?? a.addressRange?.start ?? 0xffff;
        const lb = b.payloadLoadAddress ?? b.addressRange?.start ?? 0xffff;
        if (la !== lb) return la - lb;
        return a.name.localeCompare(b.name);
      });
  }, [snapshot.entities]);

  const artifactById = useMemo(() => new Map(snapshot.artifacts.map((a) => [a.id, a])), [snapshot.artifacts]);

  const [filter, setFilter] = useState<string>("");
  const visible = filter
    ? payloads.filter((p) =>
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        (p.payloadFormat ?? "").includes(filter.toLowerCase())
      )
    : payloads;

  return (
    <section className="panel-card">
      <div className="section-heading">
        <h3>Payloads</h3>
        <span>{visible.length}{visible.length !== payloads.length ? ` of ${payloads.length}` : ""} payloads</span>
      </div>
      <input
        type="search"
        placeholder="filter by name or format"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="payload-filter-input"
      />
      <div className="payload-list">
        {visible.length === 0 ? (
          <div className="empty-state">
            No payloads yet. Run <code>extract_disk</code> / <code>extract_crt</code> against this project, or call <code>register_payload</code> to register a custom-loader blob.
          </div>
        ) : null}
        {visible.map((payload) => {
          const sourceArtifact = payload.payloadSourceArtifactId ? artifactById.get(payload.payloadSourceArtifactId) : undefined;
          const depackedArtifact = payload.payloadDepackedArtifactId ? artifactById.get(payload.payloadDepackedArtifactId) : undefined;
          const asmArtifacts = (payload.payloadAsmArtifactIds ?? [])
            .map((id) => artifactById.get(id))
            .filter((a): a is typeof snapshot.artifacts[number] => Boolean(a));
          const load = payload.payloadLoadAddress ?? payload.addressRange?.start;
          const loadText = load !== undefined ? `$${load.toString(16).toUpperCase().padStart(4, "0")}` : "—";
          return (
            <article key={payload.id} className="payload-card">
              <header>
                <strong>{payload.name}</strong>
                <span className="payload-load">load {loadText}</span>
                {payload.payloadFormat ? <span className="payload-format">{payload.payloadFormat}</span> : null}
                {payload.payloadPacker ? <span className="payload-packer">{payload.payloadPacker}</span> : null}
              </header>
              {payload.summary ? <p>{payload.summary}</p> : null}
              <footer className="payload-actions">
                {sourceArtifact ? (
                  <button
                    type="button"
                    className="payload-button payload-button-mon"
                    title={`Open hex view of ${sourceArtifact.relativePath}`}
                    onClick={() => onOpenHex(sourceArtifact.relativePath, {
                      title: `${payload.name} (raw)`,
                      baseAddress: load,
                    })}
                  >
                    mon (raw)
                  </button>
                ) : null}
                {depackedArtifact ? (
                  <button
                    type="button"
                    className="payload-button payload-button-mon"
                    title={`Open hex view of depacked bytes ${depackedArtifact.relativePath}`}
                    onClick={() => onOpenHex(depackedArtifact.relativePath, {
                      title: `${payload.name} (depacked)`,
                      baseAddress: load,
                    })}
                  >
                    mon (depacked)
                  </button>
                ) : null}
                {asmArtifacts.length > 0 ? (
                  <button
                    type="button"
                    className="payload-button payload-button-asm"
                    title={`Open disassembly (${asmArtifacts.length} source${asmArtifacts.length === 1 ? "" : "s"})`}
                    onClick={() => onOpenAsm(payload.name, bestAsmSourcesForArtifacts(asmArtifacts))}
                  >
                    asm
                  </button>
                ) : null}
                {!sourceArtifact && !depackedArtifact && asmArtifacts.length === 0 ? (
                  <span className="payload-empty">no linked artifacts (run register_payload or link_payload_to_asm)</span>
                ) : null}
              </footer>
            </article>
          );
        })}
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

function TodoComposer({
  draft,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  draft: TodoComposerState;
  saving: boolean;
  error: string | null;
  onChange: (next: TodoComposerState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="hex-overlay-backdrop" onClick={onClose}>
      <div className="hex-overlay todo-overlay" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="hex-overlay-header">
          <div>
            <h3>{draft.mode === "task" ? "New LLM Task" : "New Open Question"}</h3>
            <p>
              {draft.entityIds.length} linked entities · {draft.artifactIds.length} linked artifacts
            </p>
          </div>
          <div className="hex-overlay-header-actions">
            <button type="button" className="ghost-button" onClick={onClose}>cancel</button>
            <button type="button" className="primary-button" onClick={onSave} disabled={saving || !draft.title.trim()}>
              {saving ? "saving…" : "save"}
            </button>
          </div>
        </header>
        <div className="hex-overlay-body todo-overlay-body">
          <label className="project-input-wrap">
            <span>Title</span>
            <input
              value={draft.title}
              onChange={(event) => onChange({ ...draft, title: event.target.value })}
              placeholder={draft.mode === "task" ? "Investigate loader handoff" : "What triggers this payload?"}
              autoFocus
            />
          </label>
          <label className="project-input-wrap">
            <span>Description</span>
            <textarea
              className="todo-textarea"
              value={draft.description}
              onChange={(event) => onChange({ ...draft, description: event.target.value })}
              placeholder="Context for the LLM"
              rows={8}
            />
          </label>
          {error ? <div className="error-banner">{error}</div> : null}
        </div>
      </div>
    </div>
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

interface LlmTodoActions {
  onCreateTask: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
  onCreateQuestion: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
}

type InspectorMode = "disk-file" | "memory" | "flow" | "payload" | "cartridge" | "generic";

function EntityInspector({
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

function QuestionInspector({
  snapshot,
  question,
  onClose,
  onSelectEntity,
  onOpenDocument,
  onOpenHex,
  onCreateTask,
  onUpdateStatus,
}: {
  snapshot: WorkspaceUiSnapshot;
  question: OpenQuestionRecord;
  onClose: () => void;
  onSelectEntity: (entityId: string) => void;
  onOpenDocument: (path: string) => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onCreateTask: (defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) => void;
  onUpdateStatus: (questionId: string, status: "answered" | "invalidated" | "deferred" | "open", answerSummary?: string) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<"answered" | "invalidated" | "deferred" | "open" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runStatusChange(next: "answered" | "invalidated" | "deferred" | "open") {
    setActionError(null);
    setBusyAction(next);
    try {
      let answerSummary: string | undefined;
      if (next === "answered") {
        const reply = window.prompt("Answer summary (optional):", question.answerSummary ?? "") ?? "";
        answerSummary = reply.trim() || undefined;
      }
      await onUpdateStatus(question.id, next, answerSummary);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  const entitiesById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const findingsById = new Map(snapshot.findings.map((finding) => [finding.id, finding]));
  const artifactsById = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const linkedFindings = question.findingIds
    .map((findingId) => findingsById.get(findingId))
    .filter((finding): finding is FindingRecord => finding !== undefined);
  const linkedEntities = uniqueById(
    [...question.entityIds, ...linkedFindings.flatMap((finding) => finding.entityIds)]
      .map((entityId) => entitiesById.get(entityId))
      .filter((entity): entity is EntityRecord => entity !== undefined),
  );
  const linkedArtifacts = uniqueById(
    [...question.artifactIds, ...linkedFindings.flatMap((finding) => finding.artifactIds)]
      .map((artifactId) => artifactsById.get(artifactId))
      .filter((artifact): artifact is ArtifactRecord => artifact !== undefined),
  );

  function openArtifact(artifact: ArtifactRecord) {
    if (artifact.relativePath.toLowerCase().endsWith(".md")) {
      onOpenDocument(artifact.relativePath);
      return;
    }
    if (isC64BinaryArtifact(artifact.relativePath)) {
      onOpenHex(artifact.relativePath, { title: artifact.title });
    }
  }

  return (
    <section className="panel-card inspector-card">
      <div className="section-heading">
        <h3>Open Question</h3>
        <button type="button" className="mon-icon-button" onClick={onClose}>back</button>
      </div>
      <div className="inspector-head">
        <strong>{question.title}</strong>
        <span>{question.status}</span>
      </div>
      <div className="record-meta">
        <span>{question.kind}</span>
        <span>{question.priority}</span>
        <span>{pct(question.confidence)}</span>
        <span>{shortTime(question.updatedAt)}</span>
      </div>
      {question.description ? <p className="inspector-copy">{question.description}</p> : null}
      {question.answerSummary ? <p className="inspector-copy">{question.answerSummary}</p> : null}
      <div className="inspector-chip-row">
        {linkedEntities.slice(0, 4).map((entity) => (
          <button key={entity.id} type="button" className="inspector-chip" onClick={() => onSelectEntity(entity.id)}>
            {entity.name}
          </button>
        ))}
        <button
          type="button"
          className="inspector-chip"
          onClick={() => onCreateTask({
            title: `Resolve question: ${question.title}`,
            description: question.description,
            entityIds: linkedEntities.map((entity) => entity.id),
            artifactIds: linkedArtifacts.map((artifact) => artifact.id),
          })}
        >
          + LLM Task
        </button>
      </div>
      <div className="inspector-chip-row">
        <button
          type="button"
          className="inspector-chip"
          disabled={busyAction !== null || question.status === "answered"}
          onClick={() => runStatusChange("answered")}
        >
          {busyAction === "answered" ? "Answering…" : "Answer"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busyAction !== null || question.status === "invalidated"}
          onClick={() => runStatusChange("invalidated")}
        >
          {busyAction === "invalidated" ? "Invalidating…" : "Invalidate"}
        </button>
        <button
          type="button"
          className="inspector-chip"
          disabled={busyAction !== null || question.status === "deferred"}
          onClick={() => runStatusChange("deferred")}
        >
          {busyAction === "deferred" ? "Deferring…" : "Defer"}
        </button>
        {question.status !== "open" ? (
          <button
            type="button"
            className="inspector-chip"
            disabled={busyAction !== null}
            onClick={() => runStatusChange("open")}
          >
            {busyAction === "open" ? "Reopening…" : "Reopen"}
          </button>
        ) : null}
      </div>
      {actionError ? <div className="inspector-error">{actionError}</div> : null}
      <div className="inspector-block">
        <h4>Linked Findings</h4>
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
      <div className="inspector-block">
        <h4>Linked Artifacts</h4>
        {linkedArtifacts.length === 0 ? <div className="empty-inline">No linked artifacts.</div> : null}
        <div className="record-stack compact">
          {linkedArtifacts.map((artifact) => (
            <button key={artifact.id} type="button" className="record-card" onClick={() => openArtifact(artifact)}>
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
          ))}
        </div>
      </div>
    </section>
  );
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

function DiskFileInspector({
  snapshot,
  selection,
  onClose,
  onOpenHex,
  onOpenAsm,
  onOpenTab,
  onSelectEntity,
  onCreateTask,
  onCreateQuestion,
}: {
  snapshot: WorkspaceUiSnapshot;
  selection: { diskArtifactId: string; fileId: string };
  onClose: () => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
  onOpenTab: (tab: TabId) => void;
  onSelectEntity: (entityId: string) => void;
} & LlmTodoActions) {
  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.artifactId === selection.diskArtifactId);
  const file = disk?.files.find((candidate) => candidate.id === selection.fileId);
  const diskArtifact = snapshot.artifacts.find((artifact) => artifact.id === selection.diskArtifactId);
  // Prefer the image path (e.g. lykia_disk1.d64) over the manifest path
  // (analysis/disks/disk1/manifest.json). Sector/whole-file views need
  // the raw image, not the JSON manifest.
  const diskPath = disk?.imageRelativePath ?? diskArtifact?.relativePath;
  const isDiskImage = Boolean(diskPath && /\.(d64|g64)$/i.test(diskPath));

  if (!file || !disk) {
    return (
      <section className="panel-card inspector-card">
        <div className="section-heading">
          <h3>Disk file</h3>
          <button type="button" className="mon-icon-button" onClick={onClose}>back</button>
        </div>
        <div className="empty-state">File no longer present in snapshot.</div>
      </section>
    );
  }

  function openSectorMon(track: number, sector: number, bytesUsed: number, partIndex: number, total: number) {
    if (!diskPath) return;
    const params = new URLSearchParams({
      projectDir: snapshot.project.rootPath,
      path: diskPath,
      track: String(track),
      sector: String(sector),
    });
    onOpenHex(diskPath, {
      title: `${disk!.diskName ?? disk!.title} · ${file!.title} · T${track}/S${sector} (${partIndex + 1}/${total})`,
      baseAddress: 0,
      fetchUrl: `/api/disk/sector-bytes?${params.toString()}`,
    });
  }

  async function openWholeFileMon() {
    if (!diskPath || !isDiskImage || file!.sectorChain.length === 0) return;
    // Translate the manifest's sectorChain into explicit
    // (track, sector, offsetInSector, length) windows. Custom-LUT files
    // on protected loaders (Lykia etc.) record bytesUsed=256 with NO
    // link bytes, so we read the whole sector. Standard KERNAL files
    // record bytesUsed<=254 with the first two bytes being the link, so
    // we skip the link and read exactly bytesUsed from offset 2.
    const chain = file!.sectorChain.map((cell) => {
      const fullSector = cell.bytesUsed >= 256;
      return {
        track: cell.track,
        sector: cell.sector,
        offsetInSector: fullSector ? 0 : 2,
        length: fullSector ? 256 : cell.bytesUsed,
      };
    });
    try {
      const response = await fetch("/api/disk/assemble-chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDir: snapshot.project.rootPath,
          path: diskPath,
          chain,
          stripLoadAddress: false,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Standard D64 PRGs have a 2-byte load-address header at the
      // start; we keep it in the blob so the user sees the raw file
      // bytes. The addr column starts at the load address when known
      // (then every subsequent row reflects the C64-side address).
      const addressBase = file!.loadAddress !== undefined
        ? (file!.loadAddress - Math.min(2, bytes.length)) & 0xffff
        : 0;
      onOpenHex(diskPath, {
        title: `${disk!.diskName ?? disk!.title} · ${file!.title} · assembled (${totalSectors} sectors, ${bytes.length} B)`,
        baseAddress: addressBase,
        bytes,
        packerHint: file!.packer,
      });
    } catch (error) {
      onOpenHex(diskPath, {
        title: `${file!.title} · error`,
        bytes: new TextEncoder().encode(`Failed to assemble chain: ${error instanceof Error ? error.message : String(error)}`),
      });
    }
  }

  const totalSectors = file.sectorChain.length;
  const totalBytes = file.sectorChain.reduce((sum, cell) => sum + (cell.bytesUsed || 254), 0);

  // Cross-reference discovery — only meaningful for actual files, not
  // memory regions, so we keep this scoped to DiskFileInspector.
  const fileStem = (file.relativePath ?? file.title ?? "").split("/").pop()?.replace(/\.[^.]+$/, "")?.toLowerCase();
  const asmSources: AsmViewSource[] = fileStem
    ? bestAsmSourcesForArtifacts(
        snapshot.artifacts
          .filter((artifact) => /\.(asm|tass|s|a65)$/i.test(artifact.relativePath))
          .filter((artifact) => artifact.relativePath.toLowerCase().includes(fileStem)),
      )
    : [];
  const payloadBinaryArtifact = fileStem
    ? [...snapshot.artifacts]
        .filter((artifact) => artifact.kind === "prg" && artifact.relativePath.toLowerCase().includes(fileStem))
        .sort((left, right) => binaryArtifactPriority(right) - binaryArtifactPriority(left))[0]
    : undefined;

  const linkedLoadItems = snapshot.views.loadSequence.items.filter((item) => {
    if (file.entityId && item.entityIds.includes(file.entityId)) return true;
    if (item.artifactIds.includes(disk.artifactId)) return true;
    return false;
  });

  const headlineExtras: FileInspectorHeadlineExtra[] = [
    { key: "type", text: file.type },
    { key: "sectors", text: `${totalSectors} sectors` },
    { key: "bytes", text: `${totalBytes} bytes` },
  ];
  if (file.loadAddress !== undefined) {
    headlineExtras.push({ key: "load", text: `load ${hex(file.loadAddress)}` });
  }

  const metaRows: FileInspectorMetaRow[] = [
    {
      key: "origin",
      label: "origin",
      value: `${file.loadType}${file.loaderSource ? ` · via ${file.loaderSource}` : ""}`,
    },
    ...(payloadBinaryArtifact ? [{
      key: "payload-image",
      label: "payload image",
      value: payloadBinaryArtifact.relativePath,
    }] : []),
    {
      key: "disk-image",
      label: "disk image",
      value: diskPath ?? "(no path)",
    },
  ];

  const secondaryActions: FileInspectorActionButton[] = [];
  if (asmSources.length > 0) {
    secondaryActions.push({
      label: `.asm${asmSources.some((source) => source.dialect === "64tass") ? "/.tass" : ""}`,
      title: `Open best available source (${asmSources.map((source) => source.label).join(" / ")})`,
      enabled: true,
      onClick: () => onOpenAsm(`${file.title}`, asmSources),
    });
  }
  if (payloadBinaryArtifact && isC64BinaryArtifact(payloadBinaryArtifact.relativePath)) {
    secondaryActions.push({
      label: "mon prg",
      title: `Open payload image ${payloadBinaryArtifact.relativePath}`,
      enabled: true,
      onClick: () => onOpenHex(payloadBinaryArtifact.relativePath, {
        title: `${file.title} · ${payloadBinaryArtifact.title}`,
        baseAddress: file.loadAddress,
      }),
    });
  }
  if (linkedLoadItems.length > 0) {
    secondaryActions.push({
      label: "→ load seq",
      title: `Open in Load Sequence (${linkedLoadItems.map((item) => item.title).join(", ")})`,
      enabled: true,
      onClick: () => {
        const target = linkedLoadItems[0]!;
        if (target.primaryEntityId) onSelectEntity(target.primaryEntityId);
        onOpenTab("load");
      },
    });
  }
  secondaryActions.push({
    label: "+ task",
    title: `Create an LLM follow-up task for ${file.title}`,
    enabled: true,
    onClick: () => onCreateTask({
      title: `Investigate ${file.title}`,
      description: `${file.relativePath ?? file.title}\n${file.loadAddress !== undefined ? `Load address: ${hex(file.loadAddress)}\n` : ""}${file.loaderSource ? `Loaded via: ${file.loaderSource}\n` : ""}\nNext step:`,
      entityIds: file.entityId ? [file.entityId] : [],
      artifactIds: [disk.artifactId, ...(payloadBinaryArtifact ? [payloadBinaryArtifact.id] : [])],
    }),
  });
  secondaryActions.push({
    label: "+ question",
    title: `Create an open question for ${file.title}`,
    enabled: true,
    onClick: () => onCreateQuestion({
      title: `What is the role of ${file.title}?`,
      description: `${file.relativePath ?? file.title}\n${file.loadAddress !== undefined ? `Load address: ${hex(file.loadAddress)}\n` : ""}${file.loaderSource ? `Loaded via: ${file.loaderSource}\n` : ""}\nQuestion:`,
      entityIds: file.entityId ? [file.entityId] : [],
      artifactIds: [disk.artifactId, ...(payloadBinaryArtifact ? [payloadBinaryArtifact.id] : [])],
    }),
  });

  const spans: FileInspectorSpanRow[] = file.sectorChain.map((cell, partIndex) => ({
    id: `${cell.track}-${cell.sector}`,
    primary: `T${cell.track} / S${cell.sector}`,
    status: cell.isLast ? "last" : `→ ${cell.nextTrack}/${cell.nextSector}`,
    subText: `link $00/$01 + ${cell.bytesUsed || 254} B payload`,
    footerLeft: `step ${cell.index + 1}/${totalSectors}`,
    footerRight: diskPath?.toLowerCase().endsWith(".d64") ? `offset $${d64SectorOffset(cell.track, cell.sector).toString(16).toUpperCase().padStart(6, "0")}` : undefined,
    monEnabled: Boolean(diskPath) && Boolean(isDiskImage),
    monTitle: `Open hex view for T${cell.track}/S${cell.sector} (256 B)`,
    onMon: () => openSectorMon(cell.track, cell.sector, cell.bytesUsed, partIndex, totalSectors),
  }));

  return (
    <FileInspector
      mediumKind="disk"
      title={file.title}
      swatchColor={file.color}
      packer={file.packer}
      format={file.format}
      notes={file.notes}
      headlineExtras={headlineExtras}
      metaRows={metaRows}
      primaryAction={{
        label: `mon (${totalSectors} sectors, ${totalBytes} B)`,
        enabled: Boolean(diskPath) && Boolean(isDiskImage) && file.sectorChain.length > 0,
        onClick: openWholeFileMon,
      }}
      secondaryActions={secondaryActions}
      spansLabel={`Sector chain (${totalSectors})`}
      spans={spans}
      onClose={onClose}
    />
  );
}

function CartChunkInspector({
  snapshot,
  selection,
  onClose,
  onOpenHex,
  onOpenAsm,
}: {
  snapshot: WorkspaceUiSnapshot;
  selection: { cartridgeArtifactId: string; chunk: CartridgeLutChunk };
  onClose: () => void;
  onOpenHex: (path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) => void;
  onOpenAsm: (title: string, sources: AsmViewSource[]) => void;
}) {
  const cartridge = snapshot.views.cartridgeLayout.cartridges.find((cart) => cart.artifactId === selection.cartridgeArtifactId);
  const chunk = selection.chunk;
  const refs = chunk.refs?.length ? chunk.refs : [{ lut: chunk.lut, index: chunk.index, destAddress: chunk.destAddress }];
  const spans = chunk.spans?.length ? chunk.spans : [{ bank: chunk.bank, offsetInBank: chunk.offsetInBank, length: chunk.length }];
  const manifestArtifact = snapshot.artifacts.find((artifact) => artifact.id === selection.cartridgeArtifactId);
  const manifestDir = manifestArtifact?.relativePath.includes("/") ? manifestArtifact.relativePath.slice(0, manifestArtifact.relativePath.lastIndexOf("/")) : "";
  const slotBaseAddress = chunk.slot === "ROMH" ? (cartridge?.slotLayout?.isUltimax ? 0xe000 : 0xa000) : (chunk.slot === "ULTIMAX_ROMH" ? 0xe000 : 0x8000);

  function chipForSpan(spanBank: number) {
    return cartridge?.chips.find((candidate) => {
      const candidateSlot = candidate.slot ?? "ROML";
      if (chunk.slot === "ROML" && candidateSlot !== "ROML") return false;
      if ((chunk.slot === "ROMH" || chunk.slot === "ULTIMAX_ROMH") && candidateSlot === "ROML") return false;
      return candidate.bank === spanBank;
    });
  }

  function chipPathForSpan(spanBank: number): string | undefined {
    const chip = chipForSpan(spanBank);
    if (!chip?.file) return undefined;
    return manifestDir ? `${manifestDir}/${chip.file}` : chip.file;
  }

  function openMonSpan(span: { bank: number; offsetInBank: number; length: number }, partIndex: number) {
    const chipPath = chipPathForSpan(span.bank);
    if (!chipPath) return;
    onOpenHex(chipPath, {
      title: `${cartridge?.cartridgeName ?? "cartridge"} · ${chunk.lut}.${String(chunk.index).padStart(2, "0")} bank ${span.bank} ${chunk.slot} (part ${partIndex + 1}/${spans.length})`,
      baseAddress: slotBaseAddress + span.offsetInBank,
      offset: span.offsetInBank,
      length: span.length,
    });
  }

  async function openAssembledChunkMon() {
    if (spans.length === 0) return;
    try {
      const buffers: Uint8Array[] = [];
      for (const span of spans) {
        const chipPath = chipPathForSpan(span.bank);
        if (!chipPath) throw new Error(`No chip file for bank ${span.bank}`);
        const params = new URLSearchParams({
          path: chipPath,
          offset: String(span.offsetInBank),
          length: String(span.length),
        });
        if (snapshot.project.rootPath) params.set("projectDir", snapshot.project.rootPath);
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status} for bank ${span.bank}`);
        buffers.push(new Uint8Array(await response.arrayBuffer()));
      }
      const total = buffers.reduce((sum, buf) => sum + buf.length, 0);
      const bytes = new Uint8Array(total);
      let cursor = 0;
      for (const buf of buffers) {
        bytes.set(buf, cursor);
        cursor += buf.length;
      }
      const destAddress = chunk.destAddress ?? (slotBaseAddress + chunk.offsetInBank);
      // For Lykia BB2 (and any other packer that needs the dest-page hi
      // byte to seed its bit buffer) the depacker needs destHi as a
      // hint. We always send it when destAddress is known; the server
      // ignores it for unrelated packers.
      const packerContext: Record<string, string | number> = {};
      if (chunk.destAddress !== undefined) {
        packerContext.destHi = (chunk.destAddress >> 8) & 0xff;
        packerContext.destAddress = chunk.destAddress;
        packerContext.endAddress = (chunk.destAddress + chunk.length) & 0xffff;
      }
      onOpenHex(manifestArtifact?.relativePath ?? "cartridge", {
        title: `${cartridge?.cartridgeName ?? "cartridge"} · ${chunk.lut}.${String(chunk.index).padStart(2, "0")} assembled (${bytes.length} B${spans.length > 1 ? `, ${spans.length} spans` : ""})`,
        baseAddress: destAddress,
        bytes,
        packerHint: chunk.packer,
        packerContext: Object.keys(packerContext).length > 0 ? packerContext : undefined,
      });
    } catch (error) {
      onOpenHex("cartridge", {
        title: `${chunk.lut}.${String(chunk.index).padStart(2, "0")} · error`,
        bytes: new TextEncoder().encode(`Failed to assemble chunk: ${error instanceof Error ? error.message : String(error)}`),
      });
    }
  }

  const headlineExtras: FileInspectorHeadlineExtra[] = [
    { key: "len", text: `${chunk.length} bytes` },
    { key: "origin", text: `origin bank ${String(chunk.bank).padStart(2, "0")} ${chunk.slot}` },
    { key: "off", text: `off $${chunk.offsetInBank.toString(16).toUpperCase().padStart(4, "0")}` },
  ];
  if (spans.length > 1) {
    headlineExtras.push({ key: "spans", text: `spans ${spans.length} banks`, className: "chunk-inspector-tag" });
  }

  const metaRows: FileInspectorMetaRow[] = [];
  if (cartridge) {
    metaRows.push({
      key: "cartridge",
      label: "cartridge",
      value: cartridge.cartridgeName ?? cartridge.title,
    });
  }

  // Resolve relation-driven ASM sources. link_cart_chunk_to_asm tags the
  // chunk entity with cart-chunk:<key> and creates a derived-from
  // relation pointing at the asm artifact's entity.
  const chunkKey = `${chunk.bank}:${chunk.slot}:${chunk.offsetInBank}:${chunk.length}`;
  const chunkTag = `cart-chunk:${chunkKey}`;
  const chunkEntity = snapshot.entities.find((entity) => (entity.tags ?? []).includes(chunkTag));
  const linkedAsmArtifactIds = chunkEntity
    ? new Set(
        snapshot.relations
          .filter((relation) => relation.sourceEntityId === chunkEntity.id && relation.kind === "derived-from")
          .flatMap((relation) => {
            const target = snapshot.entities.find((entity) => entity.id === relation.targetEntityId);
            return target?.artifactIds ?? [];
          }),
      )
    : new Set<string>();
  const linkedAsmArtifacts = [...linkedAsmArtifactIds]
    .map((artifactId) => snapshot.artifacts.find((artifact) => artifact.id === artifactId))
    .filter((artifact): artifact is typeof snapshot.artifacts[number] => Boolean(artifact))
    .filter((artifact) => /\.(asm|tass|s|a65)$/i.test(artifact.relativePath));

  // Heuristic fallback: when the agent never ran link_cart_chunk_to_asm,
  // fall back to matching by chip-file stem. e.g. a chunk that lives in
  // bank_13_8000.bin with an asm artifact bank_13_8000.asm next to it
  // gets surfaced even without an explicit relation.
  let cartAsmSources: AsmViewSource[];
  if (linkedAsmArtifacts.length > 0) {
    cartAsmSources = bestAsmSourcesForArtifacts(linkedAsmArtifacts);
  } else {
    const chipStems = new Set<string>();
    for (const span of spans) {
      const chip = chipForSpan(span.bank);
      if (!chip?.file) continue;
      const stem = chip.file.replace(/\.[^.]+$/, "");
      if (stem) chipStems.add(stem);
    }
    const fallbackAsm = snapshot.artifacts.filter((artifact) => {
      if (!/\.(asm|tass|s|a65)$/i.test(artifact.relativePath)) return false;
      const stem = artifact.relativePath.split("/").pop()!.replace(/\.[^.]+$/, "");
      return chipStems.has(stem);
    });
    cartAsmSources = bestAsmSourcesForArtifacts(fallbackAsm);
  }

  const fileSpans: FileInspectorSpanRow[] = spans.map((span, partIndex) => {
    const chipPath = chipPathForSpan(span.bank);
    return {
      id: `${span.bank}-${span.offsetInBank}`,
      primary: `Bank ${String(span.bank).padStart(2, "0")} ${chunk.slot}`,
      status: `${span.length} B`,
      subText: `chip off $${span.offsetInBank.toString(16).toUpperCase().padStart(4, "0")} · C64 $${(slotBaseAddress + span.offsetInBank).toString(16).toUpperCase().padStart(4, "0")}`,
      footerLeft: chipPath ?? "(no chip)",
      footerRight: partIndex === 0 ? "head" : `cont ${partIndex + 1}/${spans.length}`,
      monEnabled: Boolean(chipPath),
      monTitle: `Open hex view of this ${span.length}-byte span`,
      onMon: () => openMonSpan(span, partIndex),
    };
  });

  const extraSections = (
    <div className="inspector-block">
      <h4>LUT references ({refs.length})</h4>
      <div className="record-stack compact">
        {refs.map((ref) => (
          <div key={`${ref.lut}-${ref.index}`} className="record-card">
            <div className="record-topline">
              <span>{ref.lut}.{String(ref.index).padStart(2, "0")}</span>
              <span className="record-status">{ref.destAddress !== undefined ? `→ $${ref.destAddress.toString(16).toUpperCase().padStart(4, "0")}` : "—"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const chunkSecondaryActions: FileInspectorActionButton[] = [];
  if (cartAsmSources.length > 0) {
    chunkSecondaryActions.push({
      label: `.asm${cartAsmSources.length > 1 ? "/.tass" : ""}`,
      title: `Open linked disassembly (${cartAsmSources.map((source) => source.label).join(" / ")})`,
      enabled: true,
      onClick: () => onOpenAsm(`${chunk.lut}.${String(chunk.index).padStart(2, "0")}`, cartAsmSources),
    });
  }

  return (
    <FileInspector
      mediumKind="cartridge"
      title={`${chunk.lut}.${String(chunk.index).padStart(2, "0")}`}
      swatchColor={chunk.color}
      packer={chunk.packer}
      format={chunk.format}
      notes={chunk.notes}
      headlineExtras={headlineExtras}
      metaRows={metaRows}
      primaryAction={{
        label: `mon (assembled — ${chunk.length} B${spans.length > 1 ? `, ${spans.length} spans` : ""})`,
        enabled: spans.length > 0,
        onClick: openAssembledChunkMon,
      }}
      secondaryActions={chunkSecondaryActions}
      spansLabel={`Physical placement (${spans.length} ${spans.length === 1 ? "span" : "spans"})`}
      spans={fileSpans}
      extraSections={extraSections}
      onClose={onClose}
    />
  );
}

function RegistrationBanner() {
  const [delta, setDelta] = useState<{ unregisteredCount: number; unregisteredByExt: Record<string, number>; unimportedAnalysisCount?: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/registration-delta`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled && d) setDelta(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!delta || dismissed) return null;
  const hasUnregistered = delta.unregisteredCount > 0;
  const hasUnimported = (delta.unimportedAnalysisCount ?? 0) > 0;
  if (!hasUnregistered && !hasUnimported) return null;
  const exts = Object.entries(delta.unregisteredByExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e, n]) => `${e}=${n}`)
    .join(", ");
  return (
    <div className="registration-banner">
      <div className="registration-banner-lines">
        {hasUnregistered ? (
          <div>
            <strong>⚠ {delta.unregisteredCount} files on disk are not registered as artifacts.</strong>
            {" "}Top extensions: {exts}. Run <code>register_existing_files</code> from the agent to fix.
          </div>
        ) : null}
        {hasUnimported ? (
          <div>
            <strong>⚠ {delta.unimportedAnalysisCount} analysis-run artifact(s) registered but never imported.</strong>
            {" "}Entities / findings missing → loadSequence Payload-Focus stages have no linked entities. Run <code>bulk_import_analysis_reports</code> to back-fill.
          </div>
        ) : null}
      </div>
      <button type="button" onClick={() => setDismissed(true)}>dismiss</button>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceUiSnapshot | null>(null);
  const [discoveredDocs, setDiscoveredDocs] = useState<DiscoveredMarkdownDoc[]>([]);
  const [graphicsItems, setGraphicsItems] = useState<GraphicsItem[]>([]);
  const [selectedGraphicsId, setSelectedGraphicsId] = useState<string | null>(null);
  const [graphicsBytes, setGraphicsBytes] = useState<Uint8Array | null>(null);
  const [graphicsLoading, setGraphicsLoading] = useState(false);
  const [graphicsError, setGraphicsError] = useState<string | null>(null);
  const [charsetPairId, setCharsetPairId] = useState<string | null>(null);
  const [charsetPairBytes, setCharsetPairBytes] = useState<Uint8Array | null>(null);
  const [graphicsMarks, setGraphicsMarks] = useState<Record<string, { status: "rejected" | "confirmed"; note?: string }>>({});
  const [hideRejectedGraphics, setHideRejectedGraphics] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [listingQuery, setListingQuery] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [tabSelections, setTabSelections] = useState<Partial<Record<TabId, string>>>({});
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null);
  const [docContent, setDocContent] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [hexOverlay, setHexOverlay] = useState<{ path: string; title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> } | null>(null);
  const [asmOverlay, setAsmOverlay] = useState<{ title: string; sources: AsmViewSource[] } | null>(null);
  const [todoComposer, setTodoComposer] = useState<TodoComposerState | null>(null);
  const [todoSaving, setTodoSaving] = useState(false);
  const [todoError, setTodoError] = useState<string | null>(null);

  function openAsmOverlay(title: string, sources: AsmViewSource[]) {
    if (sources.length === 0) return;
    setAsmOverlay({ title, sources });
  }
  const [selectedCartChunk, setSelectedCartChunk] = useState<CartChunkSelection | null>(null);
  const [selectedDiskFile, setSelectedDiskFile] = useState<DiskFileSelection | null>(null);

  function openHexOverlay(path: string, options?: { title?: string; baseAddress?: number; offset?: number; length?: number; fetchUrl?: string; bytes?: Uint8Array; packerHint?: string; packerContext?: Record<string, string | number> }) {
    setHexOverlay({
      path,
      title: options?.title,
      baseAddress: options?.baseAddress,
      offset: options?.offset,
      length: options?.length,
      fetchUrl: options?.fetchUrl,
      bytes: options?.bytes,
      packerHint: options?.packerHint,
      packerContext: options?.packerContext,
    });
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
      const [nextSnapshot, docsResponse, graphicsResponse, marksResponse] = await Promise.all([
        fetchJson<WorkspaceUiSnapshot>(`/api/workspace?projectDir=${encoded}`),
        fetchJson<DocsApiResponse>(`/api/docs?projectDir=${encoded}`).catch(() => ({ projectDir: nextProjectDir, docs: [] as DiscoveredMarkdownDoc[] })),
        fetchJson<GraphicsApiResponse>(`/api/graphics?projectDir=${encoded}`).catch(() => ({ projectDir: nextProjectDir, items: [] as GraphicsItem[], warnings: [] as string[] })),
        fetchJson<{ marks: Record<string, { status: "rejected" | "confirmed"; note?: string }> }>(`/api/graphics-marks?projectDir=${encoded}`).catch(() => ({ marks: {} })),
      ]);
      setSnapshot(nextSnapshot);
      setDiscoveredDocs(docsResponse.docs);
      setGraphicsItems(graphicsResponse.items);
      setGraphicsMarks(marksResponse.marks ?? {});
      setSelectedGraphicsId(graphicsResponse.items[0]?.id ?? null);
      setSelectedEntityId(null);
      setSelectedQuestionId(null);
      setTabSelections({});
      const nextDocs = buildDocs(nextSnapshot.artifacts, docsResponse.docs);
      setSelectedDocPath(nextDocs[0]?.relativePath ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function setGraphicsMark(itemId: string, status: "rejected" | "confirmed" | "clear") {
    if (!snapshot) return;
    try {
      const response = await fetch("/api/graphics-marks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectDir: snapshot.project.rootPath, itemId, status }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { marks: Record<string, { status: "rejected" | "confirmed"; note?: string }> };
      setGraphicsMarks(payload.marks ?? {});
    } catch (markError) {
      console.error("graphics mark failed", markError);
    }
  }

  function createTaskFromUi(defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) {
    setTodoError(null);
    setTodoComposer({
      mode: "task",
      title: defaults.title,
      description: defaults.description ?? "",
      entityIds: defaults.entityIds ?? [],
      artifactIds: defaults.artifactIds ?? [],
    });
  }

  function createQuestionFromUi(defaults: { title: string; description?: string; entityIds?: string[]; artifactIds?: string[] }) {
    setTodoError(null);
    setTodoComposer({
      mode: "question",
      title: defaults.title,
      description: defaults.description ?? "",
      entityIds: defaults.entityIds ?? [],
      artifactIds: defaults.artifactIds ?? [],
    });
  }

  async function updateQuestionStatus(
    questionId: string,
    status: "answered" | "invalidated" | "deferred" | "open",
    answerSummary?: string,
  ) {
    if (!snapshot) return;
    await postJson("/api/open-question", {
      projectDir: snapshot.project.rootPath,
      id: questionId,
      status,
      answerSummary,
    });
    await loadWorkspace(snapshot.project.rootPath);
    if (status !== "open") {
      setSelectedQuestionId(null);
    }
  }

  async function saveTodoComposer() {
    if (!snapshot || !todoComposer || !todoComposer.title.trim()) return;
    setTodoSaving(true);
    setTodoError(null);
    try {
      if (todoComposer.mode === "task") {
        await postJson("/api/task", {
          projectDir: snapshot.project.rootPath,
          title: todoComposer.title.trim(),
          description: todoComposer.description.trim() || undefined,
          kind: "llm-followup",
          priority: "medium",
          entityIds: todoComposer.entityIds,
          artifactIds: todoComposer.artifactIds,
        });
      } else {
        await postJson("/api/open-question", {
          projectDir: snapshot.project.rootPath,
          title: todoComposer.title.trim(),
          description: todoComposer.description.trim() || undefined,
          kind: "llm-question",
          priority: "medium",
          entityIds: todoComposer.entityIds,
          artifactIds: todoComposer.artifactIds,
        });
      }
      setTodoComposer(null);
      await loadWorkspace(snapshot.project.rootPath);
    } catch (saveError) {
      setTodoError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setTodoSaving(false);
    }
  }

  useEffect(() => {
    if (!snapshot || !charsetPairId) {
      setCharsetPairBytes(null);
      return;
    }
    const charsetItem = graphicsItems.find((entry) => entry.id === charsetPairId);
    if (!charsetItem) {
      setCharsetPairBytes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({
          projectDir: snapshot.project.rootPath,
          path: charsetItem.prgRelativePath,
          offset: String(charsetItem.fileOffset),
          length: String(charsetItem.length),
        });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!cancelled) setCharsetPairBytes(new Uint8Array(buffer));
      } catch {
        if (!cancelled) setCharsetPairBytes(null);
      }
    })();
    return () => { cancelled = true; };
  }, [snapshot, charsetPairId, graphicsItems]);

  useEffect(() => {
    if (!snapshot || !selectedGraphicsId) {
      setGraphicsBytes(null);
      setGraphicsError(null);
      return;
    }
    const item = graphicsItems.find((entry) => entry.id === selectedGraphicsId);
    if (!item) {
      setGraphicsBytes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setGraphicsLoading(true);
      setGraphicsError(null);
      try {
        const params = new URLSearchParams({
          projectDir: snapshot.project.rootPath,
          path: item.prgRelativePath,
          offset: String(item.fileOffset),
          length: String(item.length),
        });
        const response = await fetch(`/api/artifact/raw?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!cancelled) setGraphicsBytes(new Uint8Array(buffer));
      } catch (loadError) {
        if (!cancelled) {
          setGraphicsError(loadError instanceof Error ? loadError.message : String(loadError));
          setGraphicsBytes(null);
        }
      } finally {
        if (!cancelled) setGraphicsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [snapshot, selectedGraphicsId, graphicsItems]);

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
  const selectedQuestion = snapshot?.openQuestions.find((question) => question.id === selectedQuestionId);
  const docs = snapshot ? buildDocs(snapshot.artifacts, discoveredDocs) : [];
  const visibleTabs = snapshot
    ? allTabs.filter((tab) => {
        if (tab.id === "dashboard") return true;
        if (tab.id === "docs") return docs.length > 0;
        if (tab.id === "memory") return snapshot.views.memoryMap.cells.length > 0;
        if (tab.id === "graphics") return graphicsItems.length > 0;
        if (tab.id === "scrub") return snapshot.artifacts.some((artifact) => artifact.kind === "prg" || artifact.kind === "crt" || artifact.kind === "raw");
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

  function handleSelectEntity(entityId: string, tabId: TabId = activeTab) {
    setSelectedEntityId(entityId);
    setSelectedQuestionId(null);
    setTabSelections((current) => ({ ...current, [tabId]: entityId }));
    setSelectedCartChunk(null);
    setSelectedDiskFile(null);
  }

  function handleSelectQuestion(questionId: string) {
    if (!snapshot) return;
    const question = snapshot.openQuestions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    const linkedFindingEntityId = question.findingIds
      .map((findingId) => snapshot.findings.find((finding) => finding.id === findingId)?.entityIds[0])
      .find((entityId): entityId is string => entityId !== undefined);
    const nextEntityId = question.entityIds[0] ?? linkedFindingEntityId ?? null;
    setSelectedQuestionId(questionId);
    setSelectedEntityId(nextEntityId);
    if (nextEntityId) setTabSelections((current) => ({ ...current, dashboard: nextEntityId }));
    setSelectedCartChunk(null);
    setSelectedDiskFile(null);
  }

  function currentFocusEntityId(): string | null {
    if (!snapshot) return selectedEntityId;
    return selectedEntityId ?? diskSelectionEntityId(snapshot, selectedDiskFile);
  }

  function handleOpenTab(nextTab: TabId) {
    if (!snapshot) {
      setActiveTab(nextTab);
      return;
    }

    const preferredEntityId = currentFocusEntityId();
    const rememberedEntityId = tabSelections[nextTab];
    const nextEntityId =
      preferredEntityId && tabHasEntity(snapshot, preferredEntityId, nextTab)
        ? preferredEntityId
        : rememberedEntityId && tabHasEntity(snapshot, rememberedEntityId, nextTab)
          ? rememberedEntityId
          : firstEntityForTab(snapshot, nextTab);

    if (nextTab === "disk") {
      const nextDiskSelection =
        nextEntityId ? diskFileSelectionForEntity(snapshot, nextEntityId) : selectedDiskFile
          ?? firstDiskFileSelection(snapshot);
      setSelectedDiskFile(nextDiskSelection);
      setSelectedCartChunk(null);
      setSelectedQuestionId(null);
      setSelectedEntityId(nextEntityId ?? diskSelectionEntityId(snapshot, nextDiskSelection));
      if (nextEntityId) setTabSelections((current) => ({ ...current, disk: nextEntityId }));
    } else {
      setSelectedDiskFile(null);
      if (nextTab !== "cartridge") setSelectedCartChunk(null);
      if (nextTab !== "dashboard") setSelectedQuestionId(null);
      setSelectedEntityId(nextEntityId);
      if (nextEntityId) setTabSelections((current) => ({ ...current, [nextTab]: nextEntityId }));
    }

    setActiveTab(nextTab);
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
      <RegistrationBanner />

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
                onClick={() => handleOpenTab(tab.id)}
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
                onSelectQuestion={handleSelectQuestion}
                onOpenDocument={(path) => {
                  setSelectedDocPath(path);
                  handleOpenTab("docs");
                }}
                onReloadWorkspace={() => loadWorkspace(snapshot.project.rootPath)}
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
            {activeTab === "memory" ? <MemoryMapPanel snapshot={snapshot} selectedEntityId={selectedEntityId} onSelectEntity={(entityId) => handleSelectEntity(entityId, "memory")} /> : null}
            {activeTab === "scrub" ? (
              <ScrubPanel
                artifacts={snapshot.artifacts}
                projectRoot={snapshot.project.rootPath}
                onOpenHex={openHexOverlay}
                onOpenAsm={openAsmOverlay}
              />
            ) : null}
            {activeTab === "graphics" ? (
              <GraphicsPanel
                items={graphicsItems}
                selectedId={selectedGraphicsId}
                onSelect={setSelectedGraphicsId}
                bytes={graphicsBytes}
                loading={graphicsLoading}
                error={graphicsError}
                charsetPairId={charsetPairId}
                onSelectCharsetPair={setCharsetPairId}
                charsetBytes={charsetPairBytes}
                marks={graphicsMarks}
                onMark={setGraphicsMark}
                hideRejected={hideRejectedGraphics}
                onToggleHideRejected={setHideRejectedGraphics}
              />
            ) : null}
            {activeTab === "cartridge" ? (
              <CartridgePanel
                snapshot={snapshot}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "cartridge")}
                onSelectChunk={(cartridgeArtifactId, chunk) => {
                  setSelectedCartChunk({ cartridgeArtifactId, chunk });
                  setSelectedEntityId(null);
                  setSelectedQuestionId(null);
                }}
                onOpenHex={openHexOverlay}
              />
            ) : null}
            {activeTab === "disk" ? (
              <DiskPanel
                snapshot={snapshot}
                selectedDiskFile={selectedDiskFile}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "disk")}
                onSelectDiskFile={(diskArtifactId, fileId) => {
                  const disk = snapshot.views.diskLayout.disks.find((candidate) => candidate.artifactId === diskArtifactId);
                  const file = disk?.files.find((candidate) => candidate.id === fileId);
                  setSelectedDiskFile({ diskArtifactId, fileId });
                  setSelectedEntityId(file?.entityId ?? null);
                  setSelectedQuestionId(null);
                  if (file?.entityId) setTabSelections((current) => ({ ...current, disk: file.entityId! }));
                  setSelectedCartChunk(null);
                }}
                onOpenHex={openHexOverlay}
              />
            ) : null}
            {activeTab === "payloads" ? (
              <PayloadsPanel
                snapshot={snapshot}
                onOpenHex={openHexOverlay}
                onOpenAsm={openAsmOverlay}
              />
            ) : null}
            {activeTab === "load" ? (
              <LoadSequencePanel
                view={snapshot.views.loadSequence}
                snapshot={snapshot}
                selectedEntityId={selectedEntityId}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "load")}
              />
            ) : null}
            {activeTab === "flow" ? (
              <FlowPanel
                flowGraph={snapshot.views.flowGraph}
                entities={snapshot.entities}
                relations={snapshot.relations}
                selectedEntityId={selectedEntityId}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "flow")}
              />
            ) : null}
            {activeTab === "listing" ? (
              <ListingPanel
                snapshot={snapshot}
                query={listingQuery}
                setQuery={setListingQuery}
                selectedEntityId={selectedEntityId}
                onSelectEntity={(entityId) => handleSelectEntity(entityId, "listing")}
              />
            ) : null}
            {activeTab === "activity" ? <ActivityPanel snapshot={snapshot} /> : null}
          </section>

          {activeTab !== "docs" ? (
            <aside className="workspace-side">
              {selectedCartChunk ? (
                <CartChunkInspector
                  snapshot={snapshot}
                  selection={selectedCartChunk}
                  onClose={() => setSelectedCartChunk(null)}
                  onOpenHex={openHexOverlay}
                  onOpenAsm={openAsmOverlay}
                />
              ) : selectedDiskFile ? (
                <DiskFileInspector
                  snapshot={snapshot}
                  selection={selectedDiskFile}
                  onClose={() => setSelectedDiskFile(null)}
                  onOpenHex={openHexOverlay}
                  onOpenAsm={openAsmOverlay}
                  onOpenTab={handleOpenTab}
                  onSelectEntity={(entityId) => handleSelectEntity(entityId)}
                  onCreateTask={createTaskFromUi}
                  onCreateQuestion={createQuestionFromUi}
                />
              ) : selectedQuestion ? (
                <QuestionInspector
                  snapshot={snapshot}
                  question={selectedQuestion}
                  onClose={() => setSelectedQuestionId(null)}
                  onSelectEntity={handleSelectEntity}
                  onOpenDocument={(path) => {
                    setSelectedDocPath(path);
                    handleOpenTab("docs");
                  }}
                  onOpenHex={openHexOverlay}
                  onCreateTask={createTaskFromUi}
                  onUpdateStatus={updateQuestionStatus}
                />
              ) : (
                <EntityInspector
                  snapshot={snapshot}
                  entity={selectedEntity}
                  onSelectEntity={handleSelectEntity}
                  onOpenDocument={(path) => {
                    setSelectedDocPath(path);
                    handleOpenTab("docs");
                  }}
                  onOpenTab={handleOpenTab}
                  onOpenHex={openHexOverlay}
                  onCreateTask={createTaskFromUi}
                  onCreateQuestion={createQuestionFromUi}
                />
              )}
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
          offset={hexOverlay.offset}
          length={hexOverlay.length}
          fetchUrl={hexOverlay.fetchUrl}
          bytes={hexOverlay.bytes}
          packerHint={hexOverlay.packerHint}
          packerContext={hexOverlay.packerContext}
          onClose={() => setHexOverlay(null)}
        />
      ) : null}
      {asmOverlay ? (
        <AsmView
          title={asmOverlay.title}
          projectDir={snapshot?.project.rootPath}
          sources={asmOverlay.sources}
          onClose={() => setAsmOverlay(null)}
        />
      ) : null}
      {todoComposer ? (
        <TodoComposer
          draft={todoComposer}
          saving={todoSaving}
          error={todoError}
          onChange={setTodoComposer}
          onClose={() => {
            setTodoComposer(null);
            setTodoError(null);
          }}
          onSave={saveTodoComposer}
        />
      ) : null}
    </div>
  );
}
