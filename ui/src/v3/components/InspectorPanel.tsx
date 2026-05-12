// Spec 351 — Inspector right pane.
// Spec 424 — Drive/Cart rows with LED indicator + inline insert/eject.

import React, { useEffect, useState } from "react";
import { getClient } from "../ws-client.js";

interface Drive {
  device: number;
  ledOn: boolean;
  ledFlashing?: boolean;
  motorOn: boolean;
  rwMode?: "read" | "write";
  halfTrack: number;
  track: number;
  sector?: number;
  drivePc: number;
  dd00?: { pra: number; ddr: number };
  transferMode?: "kernal" | "custom" | "idle";
}

interface Cart {
  type: string;
  bank: number;
  activity: "read" | "write" | "idle";
}

interface RecentMedium { name: string; path: string }

type JoyMode = "off" | "port1" | "port2";
type JoyBit = "up" | "down" | "left" | "right" | "fire";

interface Props {
  sessionId: string;
  drive: Drive | null;
  drive9: Drive | null;
  cart?: Cart | null;
  activeMedia?: string;
  activeMedia9?: string;
  onMounted?: (slot: number, path: string) => void;
  joyMode?: JoyMode;
  setJoyMode?: (m: JoyMode) => void;
  joyBits?: Record<JoyBit, boolean>;
  pressedKeys?: string[];
}

interface CpuState {
  pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number;
}

interface VicState {
  rasterLine?: number; rasterCycle?: number; mode?: number;
  bank?: number; screenPtr?: number; chargenPtr?: number; bitmapPtr?: number;
  border?: number; background?: number;
}

// Spec 424 LED color matrix — user direction 2026-05-12.
function driveLedClass(d: Drive | null): string {
  if (!d) return "wb-led";
  if (d.ledFlashing) return "wb-led blink";
  if (!d.motorOn && !d.ledOn) return "wb-led off";
  if (d.ledOn && d.rwMode === "write") return "wb-led write";
  if (d.ledOn) return "wb-led read";
  if (d.motorOn) return "wb-led motor";
  return "wb-led off";
}

function cartLedClass(c: Cart | null | undefined): string {
  if (!c) return "wb-led off";
  if (c.activity === "write") return "wb-led write";
  if (c.activity === "read") return "wb-led read";
  return "wb-led off";
}

function DeviceRow({
  label, ledClass, mediaList, currentPath, onMount, onEject, exts, secondLine,
}: {
  label: string;
  ledClass: string;
  mediaList: RecentMedium[];
  currentPath: string;
  onMount: (path: string) => void;
  onEject: () => void;
  exts: string[];
  secondLine: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const filtered = mediaList.filter(m => exts.some(e => m.path.toLowerCase().endsWith(e)));
  const currentName = currentPath ? currentPath.split("/").pop() ?? "" : "";
  const buttonLabel = currentPath ? currentName : "[insert ▾]";
  return (
    <div className="wb-device-row">
      <div className="wb-device-line1">
        <h3 className="wb-device-label">{label}</h3>
        <span className={ledClass} title="LED" />
        <button
          className={currentPath ? "wb-device-eject" : "wb-device-insert"}
          onClick={() => setOpen(o => !o)}
          title={currentPath || "insert"}
        >{buttonLabel}</button>
      </div>
      {open && (
        <ul className="wb-device-picker">
          {currentPath && (
            <li>
              <button
                className="wb-picker-eject"
                onClick={async () => { setOpen(false); await onEject(); }}
              >✕ eject</button>
            </li>
          )}
          {filtered.length === 0 ? (
            <li className="wb-muted">no media</li>
          ) : filtered.map(m => (
            <li key={m.path}>
              <button
                className={m.path === currentPath ? "wb-picker-current" : ""}
                onClick={() => { onMount(m.path); setOpen(false); }}
              >{m.name}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="wb-device-line2">{secondLine}</div>
    </div>
  );
}

export function InspectorPanel({
  sessionId, drive, drive9, cart, activeMedia = "", activeMedia9 = "",
  onMounted, joyMode = "off", setJoyMode, joyBits, pressedKeys,
}: Props): JSX.Element {
  const [cpu, setCpu] = useState<CpuState | null>(null);
  const [vic, setVic] = useState<VicState | null>(null);
  const [media, setMedia] = useState<RecentMedium[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const s = await getClient().call<any>("session/state", { session_id: sessionId });
        if (alive) {
          setCpu(s.cpu ?? { pc: 0, a: 0, x: 0, y: 0, sp: 0, flags: 0, cycles: s.c64Cycles ?? 0 });
          setVic(s.vic ?? null);
        }
      } catch { /* ignore */ }
      if (alive) setTimeout(tick, 250);
    };
    tick();
    return () => { alive = false; };
  }, [sessionId]);

  useEffect(() => {
    const c = getClient();
    const fetchMedia = () => c.call<RecentMedium[]>("media/recent")
      .then(r => { if (Array.isArray(r)) setMedia(r); })
      .catch(() => {});
    if (c.getState() === "open") fetchMedia();
    c.onState((st: string) => { if (st === "open") fetchMedia(); });
  }, []);

  const hex = (n: number, w = 2) => "$" + n.toString(16).padStart(w, "0").toUpperCase();
  const flags = cpu ? "NV-BDIZC".split("").map((f, i) => ((cpu.flags >> (7-i)) & 1) ? f : f.toLowerCase()).join("") : "";

  const mountSlot = async (slot: number, path: string) => {
    if (!sessionId) return;
    try {
      await getClient().call("media/mount", { session_id: sessionId, slot, path });
      onMounted?.(slot, path);
    } catch (e) { console.error("mount:", e); }
  };
  const ejectSlot = async (slot: number) => {
    if (!sessionId) return;
    try {
      await getClient().call("media/unmount", { session_id: sessionId, slot });
      onMounted?.(slot, "");
    } catch (e) { console.error("eject:", e); }
  };

  // T/S formatted as "XX.X/YY" — track + halfTrack-bit + sector zero-padded.
  const tsFmt = (d: Drive): string => {
    const t = d.track.toString();
    const half = (d.halfTrack % 2 === 1) ? "5" : "0";
    const sec = (d.sector ?? 0).toString().padStart(2, "0");
    return `${t}.${half}/${sec}`;
  };

  // $DD00 bit decode — show output bits ATN/CLK/DATA + bank.
  const dd00Bits = (pra: number, ddr: number): string => {
    const bank = (pra & 0x03) ^ 0x03;  // VIC bank = inverted (0..3)
    const atn  = (pra & 0x08) ? "ATN" : "atn";
    const clk  = (pra & 0x10) ? "CLK" : "clk";
    const dat  = (pra & 0x20) ? "DAT" : "dat";
    return `${atn} ${clk} ${dat} bank=${bank}`;
  };

  const transferLabel = (m?: "kernal" | "custom" | "idle"): string => {
    if (m === "kernal") return "KERNAL";
    if (m === "custom") return "CUSTOM";
    return "—";
  };

  // Render device row "second line" as wb-regs table for tabular alignment.
  function driveSecondLine(d: Drive): React.ReactNode {
    return (
      <table className="wb-regs">
        <tbody>
          <tr><th>T/S</th><td>{tsFmt(d)}</td><th>PC</th><td>{hex(d.drivePc, 4)}</td></tr>
          <tr><th>xfer</th><td colSpan={3}>{transferLabel(d.transferMode)}</td></tr>
          {d.dd00 && (
            <tr>
              <th>$DD00</th>
              <td colSpan={3}>{hex(d.dd00.pra)} {dd00Bits(d.dd00.pra, d.dd00.ddr)}</td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  function cartSecondLine(c: Cart | null | undefined): React.ReactNode {
    if (!c) return (
      <table className="wb-regs">
        <tbody>
          <tr><th>state</th><td className="wb-muted">— empty —</td></tr>
        </tbody>
      </table>
    );
    return (
      <table className="wb-regs">
        <tbody>
          <tr><th>type</th><td>{c.type}</td><th>bank</th><td>{c.bank.toString().padStart(2, "0")}</td></tr>
        </tbody>
      </table>
    );
  }

  return (
    <aside className="wb-inspector">
      <section>
        <h3>CPU</h3>
        {cpu ? (
          <table className="wb-regs">
            <tbody>
              <tr><th>PC</th><td>{hex(cpu.pc, 4)}</td><th>SP</th><td>{hex(cpu.sp)}</td></tr>
              <tr><th>A</th><td>{hex(cpu.a)}</td><th>X</th><td>{hex(cpu.x)}</td></tr>
              <tr><th>Y</th><td>{hex(cpu.y)}</td><th>P</th><td>{flags}</td></tr>
              <tr><th>cyc</th><td colSpan={3}>{cpu.cycles.toLocaleString()}</td></tr>
            </tbody>
          </table>
        ) : <p>—</p>}
      </section>
      <section>
        <h3>VIC</h3>
        {vic ? (
          <table className="wb-regs">
            <tbody>
              <tr><th>raster</th><td>{vic.rasterLine ?? "?"}.{vic.rasterCycle ?? "?"}</td></tr>
              <tr><th>mode</th><td>{vic.mode ?? "?"}</td></tr>
              <tr><th>bank</th><td>{hex((vic.bank ?? 0) << 14, 4)}</td></tr>
              <tr><th>screen</th><td>{hex(vic.screenPtr ?? 0, 4)}</td></tr>
              <tr><th>chargen</th><td>{hex(vic.chargenPtr ?? 0, 4)}</td></tr>
              <tr><th>border</th><td>{hex(vic.border ?? 0)}</td></tr>
              <tr><th>bg</th><td>{hex(vic.background ?? 0)}</td></tr>
            </tbody>
          </table>
        ) : <p>—</p>}
      </section>

      {drive && (
        <section>
          <DeviceRow
            label="DRIVE 8"
            ledClass={driveLedClass(drive)}
            mediaList={media}
            currentPath={activeMedia}
            onMount={(p) => mountSlot(8, p)}
            onEject={() => ejectSlot(8)}
            exts={[".d64", ".g64"]}
            secondLine={driveSecondLine(drive)}
          />
        </section>
      )}

      {drive9 && (
        <section>
          <DeviceRow
            label="DRIVE 9"
            ledClass={driveLedClass(drive9)}
            mediaList={media}
            currentPath={activeMedia9}
            onMount={(p) => mountSlot(9, p)}
            onEject={() => ejectSlot(9)}
            exts={[".d64", ".g64"]}
            secondLine={driveSecondLine(drive9)}
          />
        </section>
      )}

      <section>
        <DeviceRow
          label="CART"
          ledClass={cartLedClass(cart)}
          mediaList={media}
          currentPath=""
          onMount={(p) => mountSlot(0, p)}
          onEject={() => ejectSlot(0)}
          exts={[".crt"]}
          secondLine={cartSecondLine(cart)}
        />
      </section>

      {/* Spec 310 — virtual joystick segmented control + live status. */}
      <section>
        <h3>Virtual JOY</h3>
        <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          {(["off", "port1", "port2"] as JoyMode[]).map(m => {
            const label = m === "off" ? "OFF" : m === "port1" ? "1" : "2";
            return (
              <button
                key={m}
                onClick={() => setJoyMode?.(m)}
                style={{
                  padding: "2px 10px",
                  background: joyMode === m ? "#4a90e2" : "#222",
                  color: joyMode === m ? "#fff" : "#aaa",
                  border: "1px solid #444",
                  cursor: "pointer",
                  fontFamily: "monospace",
                  flex: "1 1 auto",
                  minWidth: 0,
                }}
              >{label}</button>
            );
          })}
        </div>
        <table className="wb-regs">
          <tbody>
            <tr><th>bits</th><td style={{ minWidth: 110 }}>{
              joyMode === "off" ? "—" : ((["up","down","left","right","fire"] as JoyBit[])
                .filter(b => joyBits?.[b]).join(" ") || "—")
            }</td></tr>
            <tr><th>keys</th><td style={{ minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{
              pressedKeys && pressedKeys.length > 0 ? pressedKeys.join(" ") : "—"
            }</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3>Breakpoints</h3>
        <p className="wb-muted">none</p>
      </section>
    </aside>
  );
}
