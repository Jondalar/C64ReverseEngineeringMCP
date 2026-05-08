// Spec 264 — Input configuration panel.
//
// Shows current keyboard mode, joystick port, keyset bindings, gamepad
// settings. Allows editing and saving via the input/save_config WebSocket
// handler (V3 WS protocol) or the runtime_input_save_config MCP tool.
//
// The component is intentionally self-contained: it manages its own
// load/save state and does not require a parent WS session.

import { useState, useEffect, useCallback, type JSX } from "react";

// ------------------------------------------------------------------
// Config types (mirrors src/runtime/headless/input/input-config.ts)
// ------------------------------------------------------------------

interface KeysetBindings {
  north: string;
  east: string;
  south: string;
  west: string;
  fire: string;
}

interface GamepadBindings {
  axisH: number;
  axisV: number;
  deadzone: number;
  fireButton: number;
}

interface InputConfig {
  version: 1;
  keyboardMode: "qwerty" | "positional";
  joystickPort: 1 | 2;
  keyset: KeysetBindings;
  gamepad: GamepadBindings;
}

const DEFAULT_CONFIG: InputConfig = {
  version: 1,
  keyboardMode: "qwerty",
  joystickPort: 2,
  keyset: { north: "KeyW", east: "KeyD", south: "KeyS", west: "KeyA", fire: "Space" },
  gamepad: { axisH: 0, axisV: 1, deadzone: 0.5, fireButton: 0 },
};

// ------------------------------------------------------------------
// Sub-component: keyset binding row
// ------------------------------------------------------------------

interface BindingRowProps {
  label: string;
  code: string;
  onCapture: (code: string) => void;
}

function BindingRow({ label, code, onCapture }: BindingRowProps): JSX.Element {
  const [capturing, setCapturing] = useState(false);

  const startCapture = () => setCapturing(true);
  const stopCapture = () => setCapturing(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!capturing) return;
      e.preventDefault();
      onCapture(e.code);
      setCapturing(false);
    },
    [capturing, onCapture],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <tr>
      <td style={{ padding: "4px 8px", fontWeight: 600 }}>{label}</td>
      <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{code}</td>
      <td style={{ padding: "4px 8px" }}>
        {capturing ? (
          <button onClick={stopCapture} style={{ background: "#c00", color: "#fff", border: "none", padding: "2px 8px", cursor: "pointer" }}>
            press key…
          </button>
        ) : (
          <button onClick={startCapture} style={{ padding: "2px 8px", cursor: "pointer" }}>
            Rebind
          </button>
        )}
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------
// Main component
// ------------------------------------------------------------------

interface InputConfigProps {
  /** Optional function to fetch current config from WS / API. */
  fetchConfig?: () => Promise<InputConfig>;
  /** Optional function to save config via WS / API. */
  saveConfig?: (cfg: InputConfig) => Promise<void>;
}

export function InputConfigPanel({ fetchConfig, saveConfig }: InputConfigProps): JSX.Element {
  const [config, setConfig] = useState<InputConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Load config on mount.
  useEffect(() => {
    if (!fetchConfig) return;
    setLoading(true);
    fetchConfig()
      .then((cfg) => { setConfig(cfg); setLoading(false); })
      .catch((e) => { setStatus(`Load failed: ${(e as Error).message}`); setLoading(false); });
  }, [fetchConfig]);

  const handleSave = async () => {
    setStatus("");
    try {
      if (saveConfig) {
        await saveConfig(config);
        setStatus("Saved.");
      } else {
        // Fallback: display JSON for copy-paste into MCP tool.
        setStatus("No save handler — copy JSON below.");
      }
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  };

  const updateKeyset = (field: keyof KeysetBindings, code: string) => {
    setConfig((c) => ({ ...c, keyset: { ...c.keyset, [field]: code } }));
  };

  const containerStyle: React.CSSProperties = {
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    padding: 16,
    maxWidth: 480,
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: 16,
    border: "1px solid #ccc",
    borderRadius: 4,
    padding: 12,
  };

  return (
    <div style={containerStyle}>
      <h3 style={{ margin: "0 0 12px" }}>Input Configuration</h3>

      {loading && <p style={{ color: "#888" }}>Loading…</p>}

      {/* Keyboard mode */}
      <div style={sectionStyle}>
        <strong>Keyboard Mode</strong>
        <div style={{ marginTop: 8 }}>
          {(["qwerty", "positional"] as const).map((m) => (
            <label key={m} style={{ marginRight: 16, cursor: "pointer" }}>
              <input
                type="radio"
                name="kbMode"
                value={m}
                checked={config.keyboardMode === m}
                onChange={() => setConfig((c) => ({ ...c, keyboardMode: m }))}
              />
              {" "}{m === "qwerty" ? "QWERTY translate (default)" : "Positional (game layout)"}
            </label>
          ))}
        </div>
      </div>

      {/* Joystick port */}
      <div style={sectionStyle}>
        <strong>Joystick Port</strong>
        <div style={{ marginTop: 8 }}>
          {([1, 2] as const).map((p) => (
            <label key={p} style={{ marginRight: 16, cursor: "pointer" }}>
              <input
                type="radio"
                name="joyPort"
                value={p}
                checked={config.joystickPort === p}
                onChange={() => setConfig((c) => ({ ...c, joystickPort: p }))}
              />
              {" "}Port {p}{p === 2 ? " (game default)" : " (player 1)"}
            </label>
          ))}
        </div>
      </div>

      {/* Keyboard keyset */}
      <div style={sectionStyle}>
        <strong>Joystick Keyset</strong>
        <table style={{ marginTop: 8, borderCollapse: "collapse" }}>
          <tbody>
            {(["north", "east", "south", "west", "fire"] as const).map((dir) => (
              <BindingRow
                key={dir}
                label={{ north: "Up", east: "Right", south: "Down", west: "Left", fire: "Fire" }[dir]}
                code={config.keyset[dir]}
                onCapture={(code) => updateKeyset(dir, code)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Gamepad settings */}
      <div style={sectionStyle}>
        <strong>Gamepad API</strong>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "auto auto", gap: "4px 12px" }}>
          <label>Deadzone</label>
          <input
            type="number"
            min={0} max={1} step={0.05}
            value={config.gamepad.deadzone}
            onChange={(e) => setConfig((c) => ({ ...c, gamepad: { ...c.gamepad, deadzone: parseFloat(e.target.value) } }))}
            style={{ width: 60 }}
          />
          <label>Fire button index</label>
          <input
            type="number"
            min={0} max={31}
            value={config.gamepad.fireButton}
            onChange={(e) => setConfig((c) => ({ ...c, gamepad: { ...c.gamepad, fireButton: parseInt(e.target.value) } }))}
            style={{ width: 60 }}
          />
        </div>
      </div>

      <button
        onClick={handleSave}
        style={{ padding: "6px 16px", cursor: "pointer", fontWeight: 600 }}
      >
        Save
      </button>
      {status && (
        <span style={{ marginLeft: 12, color: status.startsWith("Save failed") ? "#c00" : "#060" }}>
          {status}
        </span>
      )}

      {/* Raw JSON fallback when no save handler */}
      {!saveConfig && (
        <pre style={{ marginTop: 12, background: "#f5f5f5", padding: 8, fontSize: 11, overflow: "auto" }}>
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  );
}
