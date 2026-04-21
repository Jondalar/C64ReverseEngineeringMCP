import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UiMark {
  id: string;
  createdAt: string;
  url: string;
  activeTab?: string;
  selectedEntityId?: string | null;
  selectedCartChunkKey?: string | null;
  selectedDiskFileKey?: string | null;
  selector?: string;
  componentPath?: string[];
  textContent?: string;
  note: string;
  status: "open" | "fixed";
}

interface MarkContext {
  projectDir: string;
  activeTab?: string;
  selectedEntityId?: string | null;
  selectedCartChunkKey?: string | null;
  selectedDiskFileKey?: string | null;
}

interface PendingMark {
  selector: string;
  componentPath: string[];
  textContent: string;
  elementRect: DOMRect;
}

// Walk the DOM upwards collecting a CSS-ish selector that identifies the
// clicked element. Prefers ids and data-mark-id attributes, falls back to
// tag + nth-of-type. Stops at the app root so selectors stay stable.
function selectorForElement(element: Element, stopAt: Element | null): string {
  const parts: string[] = [];
  let node: Element | null = element;
  let depth = 0;
  while (node && node !== stopAt && depth < 12) {
    const tag = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${tag}#${node.id}`);
      break;
    }
    const markId = node.getAttribute("data-mark-id");
    if (markId) {
      parts.unshift(`${tag}[data-mark-id="${markId}"]`);
      break;
    }
    const classList = [...node.classList].filter((name) => !name.startsWith("mark-mode"));
    const className = classList[0];
    const currentNode: Element = node;
    const parent: Element | null = currentNode.parentElement;
    const nth = parent
      ? [...parent.children].filter((child) => child.tagName === currentNode.tagName).indexOf(currentNode) + 1
      : 1;
    parts.unshift(`${tag}${className ? `.${className}` : ""}:nth-of-type(${nth})`);
    node = parent;
    depth += 1;
  }
  return parts.join(" > ");
}

// Derive a rough component path from React internals. Works against the
// Vite/React dev and prod bundles because React still attaches Fiber nodes
// to the DOM via __reactFiber$<hash>. Silently returns [] when the version
// doesn't expose them.
function componentPathForElement(element: Element): string[] {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) return [];
  let fiber: unknown = (element as unknown as Record<string, unknown>)[fiberKey];
  const path: string[] = [];
  let depth = 0;
  while (fiber && depth < 32) {
    const node = fiber as { type?: unknown; return?: unknown };
    const type = node.type;
    let name: string | undefined;
    if (typeof type === "function") {
      name = (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name;
    } else if (typeof type === "string") {
      name = type;
    }
    if (name && !path.includes(name)) path.push(name);
    fiber = (node.return ?? null);
    depth += 1;
  }
  return path.slice(0, 8);
}

export function MarkMode({
  projectDir,
  activeTab,
  selectedEntityId,
  selectedCartChunkKey,
  selectedDiskFileKey,
}: MarkContext) {
  const [active, setActive] = useState(false);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [pending, setPending] = useState<PendingMark | null>(null);
  const [note, setNote] = useState("");
  const [marks, setMarks] = useState<UiMark[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appRootRef = useRef<Element | null>(null);

  useEffect(() => {
    appRootRef.current = document.querySelector(".app-root") ?? document.body;
  }, []);

  const reloadMarks = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: "all" });
      if (projectDir) params.set("projectDir", projectDir);
      const response = await fetch(`/api/marks?${params.toString()}`);
      if (!response.ok) return;
      const body = (await response.json()) as { marks?: UiMark[] };
      setMarks(body.marks ?? []);
    } catch {
      /* noop */
    }
  }, [projectDir]);

  useEffect(() => {
    void reloadMarks();
  }, [reloadMarks]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.shiftKey && event.altKey && (event.key === "M" || event.key === "m")) {
        event.preventDefault();
        setActive((current) => !current);
      }
      if (event.key === "Escape") {
        setActive(false);
        setPending(null);
        setHoverRect(null);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    if (!active || pending) {
      setHoverRect(null);
      return;
    }
    function handleMove(event: MouseEvent) {
      const target = event.target as Element | null;
      if (!target || target.closest(".mark-mode-root")) {
        setHoverRect(null);
        return;
      }
      setHoverRect(target.getBoundingClientRect());
    }
    function handleClick(event: MouseEvent) {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest(".mark-mode-root")) return;
      event.preventDefault();
      event.stopPropagation();
      const selector = selectorForElement(target, appRootRef.current);
      const componentPath = componentPathForElement(target);
      const text = (target.textContent ?? "").trim().slice(0, 400);
      setPending({
        selector,
        componentPath,
        textContent: text,
        elementRect: target.getBoundingClientRect(),
      });
      setNote("");
    }
    document.addEventListener("mousemove", handleMove, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("mousemove", handleMove, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, [active, pending]);

  async function saveMark() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (projectDir) params.set("projectDir", projectDir);
      const response = await fetch(`/api/marks?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: window.location.pathname + window.location.search + window.location.hash,
          activeTab,
          selectedEntityId,
          selectedCartChunkKey,
          selectedDiskFileKey,
          selector: pending.selector,
          componentPath: pending.componentPath,
          textContent: pending.textContent,
          note,
          status: "open",
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPending(null);
      setNote("");
      await reloadMarks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMark(id: string) {
    const params = new URLSearchParams({ id });
    if (projectDir) params.set("projectDir", projectDir);
    await fetch(`/api/marks?${params.toString()}`, { method: "DELETE" });
    await reloadMarks();
  }

  async function toggleStatus(mark: UiMark) {
    const params = new URLSearchParams();
    if (projectDir) params.set("projectDir", projectDir);
    await fetch(`/api/marks/${encodeURIComponent(mark.id)}?${params.toString()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: mark.status === "open" ? "fixed" : "open" }),
    });
    await reloadMarks();
  }

  const openCount = useMemo(() => marks.filter((mark) => mark.status === "open").length, [marks]);

  return (
    <div className="mark-mode-root">
      <button
        type="button"
        className={active ? "mark-mode-toggle mark-mode-toggle-active" : "mark-mode-toggle"}
        onClick={() => setActive((current) => !current)}
        title="Toggle mark mode (Shift+Alt+M)"
      >
        {active ? "● marking" : "mark"}
      </button>
      <button
        type="button"
        className="mark-mode-toggle"
        onClick={() => setOpen((current) => !current)}
        title="Open / close marks panel"
      >
        marks <span className="mark-mode-count">{openCount}</span>
      </button>

      {active && !pending ? (
        <div className="mark-mode-banner">mark mode: click anything · esc to exit</div>
      ) : null}

      {active && hoverRect && !pending ? (
        <div
          className="mark-mode-hover-outline"
          style={{
            left: `${hoverRect.left}px`,
            top: `${hoverRect.top}px`,
            width: `${hoverRect.width}px`,
            height: `${hoverRect.height}px`,
          }}
        />
      ) : null}

      {pending ? (
        <>
          <div
            className="mark-mode-pending-outline"
            style={{
              left: `${pending.elementRect.left}px`,
              top: `${pending.elementRect.top}px`,
              width: `${pending.elementRect.width}px`,
              height: `${pending.elementRect.height}px`,
            }}
          />
          <div className="mark-mode-dialog" role="dialog" aria-modal="true">
            <header>
              <strong>New mark</strong>
              <button type="button" onClick={() => { setPending(null); setNote(""); }} title="Cancel">×</button>
            </header>
            <div className="mark-mode-dialog-context">
              <span>tab: {activeTab ?? "(n/a)"}</span>
              {pending.componentPath.length > 0 ? <span>component: {pending.componentPath.slice(0, 3).join(" > ")}</span> : null}
              {pending.textContent ? <span className="mark-mode-dialog-text">“{pending.textContent.slice(0, 80)}{pending.textContent.length > 80 ? "…" : ""}”</span> : null}
            </div>
            <textarea
              autoFocus
              rows={4}
              value={note}
              placeholder="What should change here?"
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveMark();
                }
              }}
            />
            {error ? <div className="mark-mode-error">{error}</div> : null}
            <footer>
              <button type="button" onClick={() => { setPending(null); setNote(""); }} disabled={busy}>cancel</button>
              <button type="button" className="mark-mode-save" onClick={() => void saveMark()} disabled={busy || note.trim().length === 0}>
                {busy ? "saving…" : "save (⌘⏎)"}
              </button>
            </footer>
          </div>
        </>
      ) : null}

      {open ? (
        <aside className="mark-mode-panel">
          <header>
            <strong>UI marks ({marks.length})</strong>
            <button type="button" onClick={() => setOpen(false)} title="Close">×</button>
          </header>
          {marks.length === 0 ? <div className="mark-mode-empty">No marks yet. Toggle mark mode (Shift+Alt+M) and click anything.</div> : null}
          <ul>
            {marks.map((mark) => (
              <li key={mark.id} className={mark.status === "fixed" ? "mark-mode-item mark-mode-item-fixed" : "mark-mode-item"}>
                <div className="mark-mode-item-header">
                  <span>{mark.id}</span>
                  <span className="mark-mode-item-tag">{mark.activeTab ?? "—"}</span>
                </div>
                <p className="mark-mode-item-note">{mark.note}</p>
                {mark.componentPath && mark.componentPath.length > 0 ? (
                  <p className="mark-mode-item-meta">{mark.componentPath.slice(0, 3).join(" > ")}</p>
                ) : null}
                {mark.textContent ? <p className="mark-mode-item-meta">“{mark.textContent.slice(0, 80)}{mark.textContent.length > 80 ? "…" : ""}”</p> : null}
                <div className="mark-mode-item-actions">
                  <button type="button" onClick={() => void toggleStatus(mark)}>
                    {mark.status === "open" ? "mark fixed" : "reopen"}
                  </button>
                  <button type="button" onClick={() => void deleteMark(mark.id)}>delete</button>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </div>
  );
}
