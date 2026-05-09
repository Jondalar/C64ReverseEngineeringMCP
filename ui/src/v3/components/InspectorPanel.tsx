// Spec 351 — Inspector right pane.
// Shows CPU / VIC / CIA / IEC / Drive 8/9 + breakpoints.

import React, { useEffect, useState } from "react";
import { getClient } from "../ws-client.js";

interface Drive {
  device: number; ledOn: boolean; motorOn: boolean;
  halfTrack: number; track: number; drivePc: number;
}

interface Props {
  sessionId: string;
  drive: Drive | null;
  drive9: Drive | null;
}

interface CpuState {
  pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number;
}

interface VicState {
  rasterLine?: number; rasterCycle?: number; mode?: number;
  bank?: number; screenPtr?: number; chargenPtr?: number; bitmapPtr?: number;
  border?: number; background?: number;
}

export function InspectorPanel({ sessionId, drive, drive9 }: Props): JSX.Element {
  const [cpu, setCpu] = useState<CpuState | null>(null);
  const [vic, setVic] = useState<VicState | null>(null);

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

  const hex = (n: number, w = 2) => "$" + n.toString(16).padStart(w, "0").toUpperCase();
  const flags = cpu ? "NV-BDIZC".split("").map((f, i) => ((cpu.flags >> (7-i)) & 1) ? f : f.toLowerCase()).join("") : "";

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
      <section>
        <h3>Drive 8</h3>
        {drive ? (
          <table className="wb-regs">
            <tbody>
              <tr><th>LED</th><td><span className={`wb-led ${drive.ledOn ? "on" : ""}`} /></td></tr>
              <tr><th>motor</th><td>{drive.motorOn ? "on" : "off"}</td></tr>
              <tr><th>track</th><td>{drive.track}{drive.halfTrack % 2 === 1 ? ".5" : ""}</td></tr>
              <tr><th>PC</th><td>{hex(drive.drivePc, 4)}</td></tr>
            </tbody>
          </table>
        ) : <p>—</p>}
      </section>
      {drive9 && (
        <section>
          <h3>Drive 9</h3>
          <table className="wb-regs">
            <tbody>
              <tr><th>LED</th><td><span className={`wb-led ${drive9.ledOn ? "on" : ""}`} /></td></tr>
              <tr><th>motor</th><td>{drive9.motorOn ? "on" : "off"}</td></tr>
              <tr><th>track</th><td>{drive9.track}</td></tr>
            </tbody>
          </table>
        </section>
      )}
      <section>
        <h3>Breakpoints</h3>
        <p className="wb-muted">none</p>
      </section>
    </aside>
  );
}
