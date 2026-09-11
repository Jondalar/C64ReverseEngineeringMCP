// Spec 841 — the keyset dialog: pick a C64 action, press your key.
//
// Deliberately plain. The owner, asked: "die Liste ist genug. Keine chichi Optik,
// nur funktional gut." Three things earn their place on screen and nothing else does:
//
// The UI strings are ENGLISH, like the rest of the workbench. They were German in the
// first cut because the conversation was — which is not a reason, and the owner caught
// it on sight.
//
//   1. the "from" column — answers "why is fire on M here" without opening two
//      files, and its [x] drops this level's override so the action falls back;
//   2. the scope switch, which is a TARGET (where the next edit lands), not a
//      filter — where the existing bindings came from is already in each row;
//   3. the warning line, which is the Ultima VI problem made visible: every host key
//      bound to a JOYSTICK action is swallowed before it can reach the C64 keyboard,
//      so binding the stick to WASD is what makes W/A/S/D untypable in a game that
//      wants both. Better read here than discovered by dying in-game.
//
// This is a sibling of InputConfig.tsx, not a replacement: that panel owns the
// gamepad and keyboard-mode halves, which Spec 841 leaves alone. Its five hardcoded
// rows cannot express a C64 KEY binding, which is the whole point here.
import { useState, useEffect, useCallback, useRef, type JSX } from "react";

// ------------------------------------------------------------------
// Model — mirrors src/input/keyset.ts
// ------------------------------------------------------------------

type JoystickBit = "up" | "down" | "left" | "right" | "fire";

export type C64Action =
  | { kind: "joystick"; port: 1 | 2; bit: JoystickBit }
  | { kind: "key"; matrix: string };

export interface ResolvedBinding {
  action: C64Action;
  code: string;
  source: "default" | "global" | "project";
}

interface KeysetResponse {
  bindings: ResolvedBinding[];
  conflicts: Array<{ code: string; actions: C64Action[] }>;
  swallowedByJoystick: string[];
  paths: { global: string; project: string };
}

export function actionId(a: C64Action): string {
  return a.kind === "joystick" ? `joy:${a.port}:${a.bit}` : `key:${a.matrix}`;
}

function actionLabel(a: C64Action): string {
  return a.kind === "joystick" ? `Joystick ${a.port}  ${a.bit}` : `Key  ${a.matrix}`;
}

/** "KeyW" → "W", "Numpad8" → "Numpad 8". The row should read like a keyboard. */
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Numpad ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return `${code.slice(5)} arrow`;
  return code;
}

// The C64 matrix names, for the "add a key binding" list. A plain list on purpose —
// a clickable C64 keyboard was considered and declined (Spec 841 D4).
const C64_KEYS = [
  "A","B","C","D","E","F","G","H","I","J","K","L","M",
  "N","O","P","Q","R","S","T","U","V","W","X","Y","Z",
  "0","1","2","3","4","5","6","7","8","9",
  "SPACE","RETURN","RUN_STOP","RESTORE","CTRL","C_EQ","L_SHIFT","R_SHIFT",
  "F1","F3","F5","F7","CRSR_DOWN","CRSR_RIGHT","DEL","CLR_HOME","INST",
  "PLUS","MINUS","STAR","SLASH","EQUAL","COMMA","PERIOD","COLON","SEMICOLON",
  "AT","POUND","UPARROW","LARROW",
];

// ------------------------------------------------------------------
// Key capture
// ------------------------------------------------------------------

/**
 * Capture ONE host keypress.
 *
 * The listener is registered only while capturing — the Spec 264 panel attached it
 * unconditionally and guarded inside the handler, which left one permanent window
 * listener per row. In the workbench that sits next to the Live tab's own capture,
 * which forwards keystrokes to the C64, so a key pressed to REBIND would also reach
 * the machine. `capture: true` takes it on the way down, before the Live tab sees it.
 */
function useKeyCapture(onCapture: (code: string) => void, active: boolean): void {
  const cb = useRef(onCapture);
  cb.current = onCapture;
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cb.current(e.code);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [active]);
}

// ------------------------------------------------------------------
// Panel
// ------------------------------------------------------------------

interface KeysetPanelProps {
  /** Project whose overrides are edited. Omitted → the server's default project. */
  projectDir?: string;
  /** Rendered as an overlay when given — the table needs more width than the
   *  inspector column has, which is where it started and did not belong. */
  onClose?: () => void;
}

const cell: React.CSSProperties = { padding: "3px 10px", verticalAlign: "middle" };
const muted: React.CSSProperties = { color: "#8a90a0" };

export function KeysetPanel({ projectDir, onClose }: KeysetPanelProps): JSX.Element {
  const [data, setData] = useState<KeysetResponse | null>(null);
  const [scope, setScope] = useState<"global" | "project">("project");
  const [capturing, setCapturing] = useState<string | null>(null); // actionId
  const [adding, setAdding] = useState(false);
  const [newAction, setNewAction] = useState<C64Action>({ kind: "joystick", port: 2, bit: "up" });
  const [status, setStatus] = useState("");

  const query = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : "";

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/input/keyset${query}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as KeysetResponse);
      setStatus("");
    } catch (e) {
      setStatus(`Load failed: ${(e as Error).message}`);
    }
  }, [query]);

  useEffect(() => { void reload(); }, [reload]);

  const write = useCallback(async (action: C64Action, code: string | null) => {
    try {
      const r = await fetch("/api/input/keyset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectDir, scope, action, code }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  }, [projectDir, scope, reload]);

  // One capture at a time: whichever row (or the add-dialog) armed it.
  useKeyCapture((code) => {
    const target = capturing;
    setCapturing(null);
    if (!target) return;
    const action = target === "__new__"
      ? newAction
      : data?.bindings.find((b) => actionId(b.action) === target)?.action;
    if (action) void write(action, code);
    if (target === "__new__") setAdding(false);
  }, capturing !== null);

  const frame = (body: JSX.Element): JSX.Element => (onClose
    ? (
      <div className="wb-overlay" role="dialog" aria-label="Key bindings">
        <div className="wb-overlay-panel">
          <div className="wb-overlay-bar">
            <strong>⌨ Key bindings</strong>
            <span style={{ flex: 1 }} />
            <button className="wb-btn" onClick={onClose}>close</button>
          </div>
          {body}
        </div>
      </div>
    )
    : body);

  if (!data) {
    return frame(<div style={{ padding: 12 }}>{status || "Loading…"}</div>);
  }

  const rows = [...data.bindings].sort((a, b) => actionLabel(a.action).localeCompare(actionLabel(b.action)));
  const swallowed = data.swallowedByJoystick.map(codeLabel);

  return frame(
    <div style={{ padding: 12, fontSize: 13 }}>
      <div style={{ marginBottom: 10 }}>
        <strong>Changes apply:</strong>{" "}
        {(["global", "project"] as const).map((s) => (
          <label key={s} style={{ marginLeft: 12, cursor: "pointer" }}>
            <input type="radio" name="keysetScope" checked={scope === s} onChange={() => setScope(s)} />
            {" "}{s === "global" ? "everywhere" : "in this project only"}
          </label>
        ))}
        <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
          {scope === "global" ? data.paths.global : data.paths.project}
        </div>
      </div>

      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ ...muted, textAlign: "left", fontWeight: 400 }}>
            <th style={cell}>C64 action</th>
            <th style={cell}>your key</th>
            <th style={cell}>from</th>
            <th style={cell}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const id = actionId(b.action);
            const isCapturing = capturing === id;
            return (
              <tr key={id}>
                <td style={cell}>{actionLabel(b.action)}</td>
                <td style={{ ...cell, fontFamily: "monospace" }}>{codeLabel(b.code)}</td>
                <td style={{ ...cell, ...muted }}>{b.source}</td>
                <td style={cell}>
                  <button onClick={() => setCapturing(isCapturing ? null : id)}>
                    {isCapturing ? "press a key…" : "rebind"}
                  </button>
                  {b.source !== "default" && (
                    <button
                      onClick={() => void write(b.action, null)}
                      title={`remove the ${b.source} override`}
                      style={{ marginLeft: 6 }}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!adding ? (
        <button style={{ marginTop: 10 }} onClick={() => setAdding(true)}>+ Add binding</button>
      ) : (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid #3a4056" }}>
          <div style={{ marginBottom: 6 }}><strong>What should the C64 do?</strong></div>
          <label style={{ marginRight: 12 }}>
            <input
              type="radio" name="newKind" checked={newAction.kind === "joystick"}
              onChange={() => setNewAction({ kind: "joystick", port: 2, bit: "up" })}
            />{" "}Joystick
          </label>
          <label>
            <input
              type="radio" name="newKind" checked={newAction.kind === "key"}
              onChange={() => setNewAction({ kind: "key", matrix: "RUN_STOP" })}
            />{" "}Key
          </label>

          <div style={{ marginTop: 8 }}>
            {newAction.kind === "joystick" ? (
              <>
                <select
                  value={newAction.port}
                  onChange={(e) => setNewAction({ ...newAction, port: Number(e.target.value) === 1 ? 1 : 2 })}
                >
                  <option value={1}>Port 1</option>
                  <option value={2}>Port 2</option>
                </select>
                <select
                  style={{ marginLeft: 6 }}
                  value={newAction.bit}
                  onChange={(e) => setNewAction({ ...newAction, bit: e.target.value as JoystickBit })}
                >
                  {(["up", "down", "left", "right", "fire"] as const).map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </>
            ) : (
              <select
                value={newAction.matrix}
                onChange={(e) => setNewAction({ kind: "key", matrix: e.target.value })}
              >
                {C64_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <button onClick={() => setCapturing("__new__")}>
              {capturing === "__new__" ? "press a key…" : "assign a key"}
            </button>
            <button style={{ marginLeft: 6 }} onClick={() => { setAdding(false); setCapturing(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {swallowed.length > 0 && (
        <div style={{ marginTop: 12, color: "#e0b050" }}>
          ! While the joystick is on, these do not type: {swallowed.join("  ")}
        </div>
      )}

      {data.conflicts.length > 0 && (
        <div style={{ marginTop: 6, color: "#e07050" }}>
          ! Bound twice: {data.conflicts.map((c) => codeLabel(c.code)).join("  ")}
        </div>
      )}

      {status && <div style={{ marginTop: 8, color: "#e07050" }}>{status}</div>}
    </div>
  );
}
