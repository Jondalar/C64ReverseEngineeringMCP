// Spec 889 §4 — the runtime backend selector in the top bar.
//
// "TRX64 (emulator)" plus every C64 Ultimate that answered the scan, each with its reason: offered,
// greyed out (stock core, trxmon not answering), or "Start monitor" (our core, the app not running).
// Switching asks first, in the shape of the project switch (ProjectMismatch): the machine changes,
// so what is on screen becomes another machine's. A device's REST password is asked for here and
// held in this component's memory and the server's — never in browser storage, never in a file.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackendView, type DeviceRowView, type DevicesView } from "../rest-client";
import { getClient } from "../ws-client";

const mono: React.CSSProperties = { fontFamily: "monospace", wordBreak: "break-all" };

interface Target { backend: "emulator" | "c64u"; host?: string; restPort?: number; label: string; startMonitor?: boolean }

const OUTCOME_LABEL: Record<DeviceRowView["outcome"], string> = {
  stock: "stock core",
  "core-no-monitor": "monitor not running",
  offered: "ready",
  "not-offered": "not offered",
  unreachable: "not reachable",
};

export function BackendSelector({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<BackendView | null>(null);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DevicesView | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ target: Target; from: string } | null>(null);
  // The password a device asked for, by "host:restPort". Memory only (a ref, not state, not storage).
  const passwords = useRef(new Map<string, string>());
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwInput, setPwInput] = useState("");

  // The selection is the machine's, not this page's: the assistant (or another page) can switch it. The
  // page notices within a couple of seconds, says so, and reconnects to the endpoint /api/config names now.
  const lastKey = useRef<string | undefined>(undefined);
  const [announce, setAnnounce] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.runtimeBackend().then((v) => { if (v.selection?.key) lastKey.current = v.selection.key; setView(v); }).catch(() => setView(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      api.runtimeBackend().then((v) => {
        const key = v.selection?.key;
        if (!key) return;
        if (lastKey.current !== undefined && key !== lastKey.current) {
          lastKey.current = key;
          setView(v);
          setDevices(null);
          setAnnounce(`The runtime was switched to ${v.kind === "c64u" ? (v.identity?.label ?? "a C64 Ultimate") : "TRX64 (emulator)"}${v.selection?.by ? ` by ${v.selection.by}` : ""} — this page follows.`);
          getClient().restart();
          onChanged?.();
        } else lastKey.current = key;
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [onChanged]);

  const scan = useCallback(async () => {
    setScanning(true);
    setErr(null);
    try { setDevices(await api.runtimeDevices()); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setScanning(false); }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) { refresh(); if (!devices) void scan(); }
  };

  const key = (d: { host: string; restPort: number }) => `${d.host}:${d.restPort}`;

  const unlock = async (d: DeviceRowView) => {
    if (!pwInput) return;
    passwords.current.set(key(d), pwInput);
    setBusy(key(d));
    setErr(null);
    try {
      setDevices(await api.runtimeDevices({ host: d.host, restPort: d.restPort, password: pwInput }));
      setPwFor(null);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(null); setPwInput(""); }
  };

  const startMonitor = async (d: DeviceRowView) => {
    setBusy(key(d));
    setErr(null);
    try {
      const r = await api.startRuntimeMonitor({ host: d.host, restPort: d.restPort, password: passwords.current.get(key(d)) });
      setDevices((cur) => cur ? { ...cur, devices: cur.devices.map((x) => (key(x) === key(d) ? r.device : x)) } : cur);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  const doSelect = async (t: Target, confirmed: boolean) => {
    setBusy(t.host ? `${t.host}:${t.restPort ?? 80}` : "emulator");
    setErr(null);
    try {
      const pw = t.host ? passwords.current.get(`${t.host}:${t.restPort ?? 80}`) : undefined;
      const r = await api.selectRuntimeBackend({ backend: t.backend, host: t.host, restPort: t.restPort, password: pw, startMonitor: t.startMonitor, confirmed });
      if (r.needsConfirm) { setConfirm({ target: t, from: r.from ?? "the current runtime" }); return; }
      if (!r.ok) {
        setConfirm(null);
        setErr(r.error ?? `select failed (HTTP ${r.status})`);
        if (/REST password/i.test(r.error ?? "") && t.host) setPwFor(`${t.host}:${t.restPort ?? 80}`);
        return;
      }
      setConfirm(null);
      setOpen(false);
      setView(r.view ?? null);
      if (r.view?.selection?.key) lastKey.current = r.view.selection.key;
      setAnnounce(null);
      // The page now talks to another machine: reconnect to whatever /api/config names, and let the
      // tabs pick their session again.
      getClient().restart();
      onChanged?.();
      setDevices(null);
      refresh();
    } catch (e: any) {
      setConfirm(null);
      setErr(e?.message ?? String(e));
    } finally { setBusy(null); }
  };

  const kind = view?.kind ?? "emulator";
  const chipLabel = kind === "c64u" ? (view?.identity?.label ?? "C64 Ultimate") : "TRX64 (emulator)";

  return (
    <div className="backend-selector">
      <button
        type="button"
        className={`backend-chip backend-${kind}`}
        onClick={toggle}
        title={view?.envError ? `The environment names a runtime backend that does not parse: ${view.envError}` : "Which runtime the workbench drives — click to choose"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="backend-dot" />
        {chipLabel}
      </button>

      {announce && (
        <div className="backend-announce" role="status">
          {announce} <button type="button" onClick={() => setAnnounce(null)}>OK</button>
        </div>
      )}

      {open && (
        <div className="backend-pop" role="dialog" aria-label="Runtime backend">
          <div className="backend-pop-head">
            <strong>Runtime</strong>
            <button type="button" onClick={() => void scan()} disabled={scanning}>{scanning ? "Scanning…" : "Rescan"}</button>
          </div>
          {view?.envError && <div className="backend-err">{view.envError}</div>}

          <div className={`backend-row${kind === "emulator" ? " active" : ""}`}>
            <div>
              <div className="backend-row-title">TRX64 (emulator)</div>
              <div className="backend-row-reason">the default; sandboxes, reels and scenario runs always use it</div>
            </div>
            {kind === "emulator"
              ? <span className="backend-badge ok">active</span>
              : <button type="button" disabled={busy !== null} onClick={() => void doSelect({ backend: "emulator", label: "TRX64 (emulator)" }, false)}>Select</button>}
          </div>

          {(devices?.devices ?? []).map((d) => {
            const k = key(d);
            const active = kind === "c64u" && view?.identity?.device?.host === d.host && view.identity.device.restPort === d.restPort;
            const ours = d.outcome === "offered" || d.outcome === "core-no-monitor" || d.outcome === "not-offered";
            return (
              <div key={k} className={`backend-row${active ? " active" : ""}${d.selectable || d.action ? "" : " grey"}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="backend-row-title">
                    C64 Ultimate <span style={mono}>{d.host}{d.restPort !== 80 ? `:${d.restPort}` : ""}</span>
                    {d.hostname ? ` · ${d.hostname}` : ""}{d.board ? ` [${d.board}]` : ""}
                  </div>
                  <div className="backend-row-reason">{OUTCOME_LABEL[d.outcome]} — {d.reason}</div>
                  {ours && (
                    <div className="backend-row-note">
                      The app's RPC port has no password — anyone on this network can reach it, even when the device's REST has one.
                    </div>
                  )}
                  {d.passwordProtected && pwFor === k && (
                    <form className="backend-pw" onSubmit={(e) => { e.preventDefault(); void unlock(d); }}>
                      <input type="password" autoComplete="off" autoFocus placeholder="REST password (this session only)"
                        value={pwInput} onChange={(e) => setPwInput(e.target.value)} />
                      <button type="submit" disabled={!pwInput || busy !== null}>Unlock</button>
                    </form>
                  )}
                </div>
                <div className="backend-row-actions">
                  {active && <span className="backend-badge ok">active</span>}
                  {!active && d.selectable && (
                    <button type="button" disabled={busy !== null} onClick={() => void doSelect({ backend: "c64u", host: d.host, restPort: d.restPort, label: `C64 Ultimate ${d.host}` }, false)}>Select</button>
                  )}
                  {!active && d.action === "start_monitor" && (
                    <button type="button" disabled={busy !== null} onClick={() => void startMonitor(d)}>{busy === k ? "Starting…" : "Start monitor"}</button>
                  )}
                  {d.passwordProtected && pwFor !== k && !d.selectable && (
                    <button type="button" disabled={busy !== null} onClick={() => { setPwFor(k); setPwInput(""); }}>Password…</button>
                  )}
                </div>
              </div>
            );
          })}
          {devices && devices.devices.length === 0 && (
            <div className="backend-row-reason" style={{ padding: "6px 8px" }}>No C64 Ultimate answered the scan on this network.</div>
          )}
          {err && <div className="backend-err">{err}</div>}
        </div>
      )}

      {confirm && (
        <div role="dialog" aria-modal="true" aria-labelledby="be889-title" style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}>
          <div style={{
            background: "#1a1a1a", border: "1px solid #d47f00", borderRadius: 6,
            width: 560, maxWidth: "calc(100vw - 32px)", padding: 20, color: "#ccc", fontSize: 13,
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div id="be889-title" style={{ fontSize: 15, color: "#f0d9a8", fontWeight: 600 }}>Switch the runtime?</div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
              <span style={{ color: "#888" }}>now</span>
              <span style={mono}>{confirm.from}</span>
              <span style={{ color: "#888" }}>switch to</span>
              <span style={mono}>{confirm.target.label}</span>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
              The machine changes: what is on screen — picture, registers, memory, breakpoints — becomes another machine's.
              {confirm.target.backend === "c64u"
                ? " On a C64 Ultimate, media, PRGs and cartridges reach the machine only after the same bytes passed in the emulator; nothing falls back to the emulator by itself."
                : " The C64 Ultimate is released; its machine keeps running as it is."}
            </div>
            {err && <div style={{ color: "#ff8080", fontSize: 12 }}>{err}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button id="be889-leave" autoFocus onClick={() => setConfirm(null)} disabled={busy !== null} style={{ fontWeight: 600 }}>Leave it</button>
              <button id="be889-switch" onClick={() => void doSelect(confirm.target, true)} disabled={busy !== null}>
                {busy !== null ? "Switching…" : "Switch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
