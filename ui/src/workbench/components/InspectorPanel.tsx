// Spec 351 — Inspector right pane.
// Spec 424 — Drive/Cart rows with LED indicator + inline insert/eject.

import React, { useCallback, useEffect, useState } from "react";
import { getClient } from "../ws-client.js";

interface Drive {
  device: number;
  ledOn: boolean;
  ledFlashing?: boolean;
  ledPwm?: number;  // Spec 424 VICE 1:1 — 0..1000 brightness
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
  // BUG-042 — machine booted from this cart (green LED base state).
  booted?: boolean;
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
  /** Spec 709.12 — mounted CART (slot 0) path, shown on the CART row. */
  activeCartMedia?: string;
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

interface SidState { regs: number[]; streaming: boolean }

// Decode one SID voice (7 regs from offset vb) into a display row.
const PAL_SID_CLOCK = 985248;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(freqReg: number): string {
  if (freqReg <= 0) return "—";
  const hz = (freqReg * PAL_SID_CLOCK) / 16777216;
  if (hz < 8) return "—";
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  if (midi < 0 || midi > 127) return "—";
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function waveform(control: number): string {
  const w: string[] = [];
  if (control & 0x10) w.push("△");  // triangle
  if (control & 0x20) w.push("◣");  // sawtooth
  if (control & 0x40) w.push("⊓");  // pulse
  if (control & 0x80) w.push("∿");  // noise
  return w.length ? w.join("") : "—";
}
function decodeVoice(regs: number[], vb: number): { wave: string; gate: boolean; note: string } {
  const ctrl = regs[vb + 4] ?? 0;
  const freq = (regs[vb] ?? 0) | ((regs[vb + 1] ?? 0) << 8);
  return { wave: waveform(ctrl), gate: (ctrl & 1) !== 0, note: noteName(freq) };
}

// Spec 623 §4.3 — control-flow stack (main/irq/nmi/brk).
interface FlowRegs { a: number; x: number; y: number; sp: number; p: number; }
interface FlowFrame { kind: string; pc: number; returnPc: number; cycle: number; regs?: FlowRegs; }
interface FlowState { focus: string; current: string; stack: FlowFrame[]; }
interface Vectors { irq: number; nmi: number; cinv: number; cbinv: number; }

// Spec 424 LED color matrix — user direction 2026-05-12.
function driveLedClass(d: Drive | null): string {
  if (!d) return "wb-led";
  // Spec 424 VICE 1:1 PWM model: ledPwm 0..1000 = perceptual brightness.
  // Drop blink animation; brightness IS the signal.
  const pwm = d.ledPwm ?? (d.ledOn ? 1000 : 0);
  if (pwm < 50 && !d.motorOn) return "wb-led off";
  if (pwm < 50 && d.motorOn) return "wb-led motor";  // yellow: motor only
  if (d.rwMode === "write") return pwm >= 700 ? "wb-led write" : "wb-led write-dim";
  return pwm >= 700 ? "wb-led read" : "wb-led read-dim";
}
function driveLedStyle(d: Drive | null): React.CSSProperties | undefined {
  if (!d) return undefined;
  const pwm = d.ledPwm ?? (d.ledOn ? 1000 : 0);
  if (pwm <= 0) return undefined;
  const alpha = Math.max(0.2, Math.min(1, pwm / 1000));
  return { opacity: alpha };
}

// BUG-042 CART LED semantics (user direction 2026-06-11). CSS class names are
// drive-LED colors, mapped by COLOR here: write=red, motor=yellow, read=green.
//   red blink = flash/EEPROM writes in flight
//   yellow    = cart mapped, being read ("CART on")
//   green     = inserted + machine booted from it (base state)
//   grey      = inserted but not booted from / no cart
function cartLedClass(c: Cart | null | undefined): string {
  if (!c) return "wb-led off";
  if (c.activity === "write") return "wb-led write blink";
  if (c.activity === "read") return "wb-led motor";
  return c.booted ? "wb-led read" : "wb-led off";
}

function DeviceRow({
  label, ledClass, ledStyle, mediaList, currentPath, onMount, onEject, exts, secondLine, onPower, onOpen,
}: {
  label: string;
  ledClass: string;
  ledStyle?: React.CSSProperties;
  mediaList: RecentMedium[];
  currentPath: string;
  onMount: (path: string) => void;
  onEject: () => void;
  exts: string[];
  secondLine: React.ReactNode;
  onPower?: () => void;
  onOpen?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const filtered = mediaList.filter(m => exts.some(e => m.path.toLowerCase().endsWith(e)));
  const currentName = currentPath ? currentPath.split("/").pop() ?? "" : "";
  const buttonLabel = currentPath ? currentName : "[insert ▾]";
  return (
    <div className="wb-device-row">
      <div className="wb-device-line1">
        <h3 className="wb-device-label">{label}</h3>
        <span className={ledClass} style={ledStyle} title="LED" />
        {onPower && (
          <button
            className="wb-device-power"
            onClick={onPower}
            title="Power-cycle / re-initialize drive"
          >⏻</button>
        )}
        <button
          className={currentPath ? "wb-device-eject" : "wb-device-insert"}
          onClick={() => setOpen(o => { if (!o) onOpen?.(); return !o; })}
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
  sessionId, drive, drive9, cart, activeMedia = "", activeMedia9 = "", activeCartMedia = "",
  onMounted, joyMode = "off", setJoyMode, joyBits, pressedKeys,
}: Props): React.JSX.Element {
  const [cpu, setCpu] = useState<CpuState | null>(null);
  const [vic, setVic] = useState<VicState | null>(null);
  const [sid, setSid] = useState<SidState | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [vectors, setVectors] = useState<Vectors | null>(null);
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
          setSid(s.sid ?? null);
          setFlow(s.flow ?? null);
          setVectors(s.vectors ?? null);
        }
      } catch { /* ignore */ }
      if (alive) setTimeout(tick, 250);
    };
    tick();
    return () => { alive = false; };
  }, [sessionId]);

  // Refresh the recent-media list on demand. Built at connect + reconnect, and
  // again each time a device dropdown opens (so a file added since connect shows
  // without a reconnect). No-op while the socket is not open.
  const refreshMedia = useCallback(() => {
    const c = getClient();
    if (c.getState() !== "open") return;
    c.call<RecentMedium[]>("media/recent")
      .then(r => { if (Array.isArray(r)) setMedia(r); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const c = getClient();
    if (c.getState() === "open") refreshMedia();
    c.onState((st: string) => { if (st === "open") refreshMedia(); });
  }, [refreshMedia]);

  const hex = (n: number, w = 2) => "$" + n.toString(16).padStart(w, "0").toUpperCase();

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
  const drivePower = async () => {
    if (!sessionId) return;
    try {
      await getClient().call("session/drive_power", { session_id: sessionId });
    } catch (e) { console.error("drive_power:", e); }
  };

  // T/S formatted as fixed-width "XX.X/YY" (zero-padded) so the layout doesn't
  // shift when track/sector drop a digit.
  const tsFmt = (d: Drive): string => {
    const t = d.track.toString().padStart(2, "0");
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
      {/* CPU (Spec 623 §4.3). ONE 6502, time-sliced — NOT parallel CPUs.
          A/X/Y/SP/P are SHARED (shown once); only the PC differs per context.
          MAIN/IRQ/NMI PCs shown ALWAYS: the executing context = live PC
          (highlighted ◀); the others = handler entry from the vectors
          (IRQ $FFFE / NMI $FFFA; KERNAL RAM hooks CINV $0314 / CBINV $0318). */}
      <section>
        <h3>CPU</h3>
        {cpu ? (() => {
          const cur = flow?.current ?? "main";
          const stack = flow?.stack ?? [];
          const pflags = "NV-BDIZC".split("").map((f, i) => ((cpu.flags >> (7 - i)) & 1) ? f : f.toLowerCase()).join("");
          const mainPc = cur === "main" ? cpu.pc : (stack[0]?.returnPc ?? cpu.pc);
          const ctxs = [
            { kind: "MAIN", pc: mainPc, active: cur === "main", hook: null as null | [string, number] },
            { kind: "IRQ", pc: cur === "irq" ? cpu.pc : (vectors?.irq ?? 0), active: cur === "irq", hook: ["$0314", vectors?.cinv ?? 0] as [string, number] },
            { kind: "NMI", pc: cur === "nmi" ? cpu.pc : (vectors?.nmi ?? 0), active: cur === "nmi", hook: ["$0318", vectors?.cbinv ?? 0] as [string, number] },
          ];
          return (
            <table className="wb-regs wb-cpu">
              <tbody>
                {ctxs.map((c) => (
                  <tr key={c.kind} className={c.active ? "wb-flow-active" : ""}>
                    <th>{c.kind}{c.active ? " ◀" : ""}</th>
                    <td>{hex(c.pc, 4)}</td>
                    <td colSpan={2} className="wb-vec-note">
                      {c.hook ? `${c.hook[0]}→${hex(c.hook[1], 4)}` : ""}
                    </td>
                  </tr>
                ))}
                <tr className="wb-cpu-sep"><td colSpan={4}></td></tr>
                <tr><th>A</th><td>{hex(cpu.a)}</td><th>X</th><td>{hex(cpu.x)}</td></tr>
                <tr><th>Y</th><td>{hex(cpu.y)}</td><th>SP</th><td>{hex(cpu.sp)}</td></tr>
                <tr><th>P</th><td colSpan={3}>{pflags}</td></tr>
                <tr><th>cyc</th><td colSpan={3}>{cpu.cycles.toLocaleString()}</td></tr>
              </tbody>
            </table>
          );
        })() : <p>—</p>}
      </section>
      <section>
        <h3>VIC</h3>
        {vic ? (
          <table className="wb-regs">
            <tbody>
              <tr><th>raster</th><td>{String(vic.rasterLine ?? 0).padStart(3, "0")}.{String(vic.rasterCycle ?? 0).padStart(2, "0")}</td></tr>
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

      <section>
        <h3>
          SID
          <span
            className={sid?.streaming ? "wb-led read" : "wb-led off"}
            style={{ marginLeft: 6, verticalAlign: "middle" }}
            title={sid?.streaming ? "audio streaming" : "audio off"}
          />
          <span className="wb-muted" style={{ marginLeft: 4, fontSize: 10 }}>
            {sid?.streaming ? "on" : "off"}
          </span>
        </h3>
        {sid ? (() => {
          const r = sid.regs;
          const vol = (r[0x18] ?? 0) & 0x0f;
          const fmode = [
            (r[0x18] ?? 0) & 0x10 ? "LP" : "",
            (r[0x18] ?? 0) & 0x20 ? "BP" : "",
            (r[0x18] ?? 0) & 0x40 ? "HP" : "",
          ].filter(Boolean).join("+") || "—";
          const cutoff = ((r[0x15] ?? 0) & 7) | ((r[0x16] ?? 0) << 3);
          const res = (r[0x17] ?? 0) >> 4;
          const voices = [0x00, 0x07, 0x0e].map((vb) => decodeVoice(r, vb));
          return (
            <table className="wb-regs">
              <tbody>
                <tr><th></th><th>wave</th><th>note</th><th>gate</th></tr>
                {voices.map((v, i) => (
                  <tr key={i} className={v.gate ? "wb-flow-active" : ""}>
                    <th>V{i + 1}</th>
                    <td>{v.wave}</td>
                    <td>{v.note}</td>
                    <td>{v.gate ? "●" : "○"}</td>
                  </tr>
                ))}
                <tr className="wb-cpu-sep"><td colSpan={4}></td></tr>
                <tr><th>vol</th><td>{vol}</td><th>filt</th><td>{fmode}</td></tr>
                <tr><th>fc</th><td>{hex(cutoff, 3)}</td><th>res</th><td>{res}</td></tr>
              </tbody>
            </table>
          );
        })() : <p>—</p>}
      </section>

      {drive && (
        <section>
          <DeviceRow
            label="DRIVE 8"
            ledClass={driveLedClass(drive)}
            ledStyle={driveLedStyle(drive)}
            mediaList={media}
            currentPath={activeMedia}
            onMount={(p) => mountSlot(8, p)}
            onEject={() => ejectSlot(8)}
            exts={[".d64", ".g64"]}
            secondLine={driveSecondLine(drive)}
            onPower={drivePower}
            onOpen={refreshMedia}
          />
        </section>
      )}

      {drive9 && (
        <section>
          <DeviceRow
            label="DRIVE 9"
            ledClass={driveLedClass(drive9)}
            ledStyle={driveLedStyle(drive9)}
            mediaList={media}
            currentPath={activeMedia9}
            onMount={(p) => mountSlot(9, p)}
            onEject={() => ejectSlot(9)}
            exts={[".d64", ".g64"]}
            secondLine={driveSecondLine(drive9)}
            onOpen={refreshMedia}
          />
        </section>
      )}

      <section>
        <DeviceRow
          label="CART"
          ledClass={cartLedClass(cart)}
          mediaList={media}
          currentPath={activeCartMedia}
          onMount={(p) => mountSlot(0, p)}
          onEject={() => ejectSlot(0)}
          exts={[".crt"]}
          secondLine={cartSecondLine(cart)}
          onOpen={refreshMedia}
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
    </aside>
  );
}
