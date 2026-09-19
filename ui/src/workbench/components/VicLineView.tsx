// Spec 859 — the raster line as the VIC saw it.
//
// The layout follows vicspector (elysium64, MIT): cycles run left to right the way the beam
// does, one lane per thing that happens in a cycle. The data does not follow it: every cell
// here is a record the TRX64 core produced while replaying the frame on screen — the VIC's
// two half-cycle accesses, BA and AEC, what the CPU did on the bus, the instruction it was
// in. Nothing is computed from a timing table on this side (Spec 859 D1: measured, never
// modelled).

import React, { useEffect, useMemo, useState } from "react";
import { getClient } from "../ws-client.js";
import { frameGeometry, type FrameHeader as GeometryHeader } from "../../../../src/runtime/frame-geometry.js";

// Spec 863 C3 — how many cycles a line has (63 PAL, 65 NTSC), how many lines a frame has
// (312 / 263), where the visible window sits and whether it wraps (NTSC draws raster lines
// 0–11 below line 262) all come from the frame header, through frame-geometry.ts.

interface Access { k: "f" | "r" | "w" | "dr" | "dw"; a: number; v: number }
interface Cycle {
  c: number;
  clk: number;
  raster: number;
  phi1: { k: "i" | "r" | "g" | "gi" | "p" | "s"; spr: number; a: number; rom: boolean; v: number };
  phi2: { k: "cpu" | "c" | "s"; spr: number; a: number; v: number; blocked: boolean };
  ba: boolean;
  aec: boolean;
  cpu: Access[];
  badLine: boolean;
  idle: boolean;
  vc: number;
  vcbase: number;
  rc: number;
  vmli: number;
  spriteDma: number;
  spriteDisplay: number;
  mc: number[];
  mcbase: number[];
  mainBorder: boolean;
  vBorder: boolean;
  fbX: number;
  fbLine: number;
  d011: number;
  d016: number;
  d018: number;
  vbank: number;
}
interface Instr { pc: number; bytes: number[]; text: string; start: number; end: number; interrupt: number | null; interruptStart: number | null }
interface Line { line: number; badLine: boolean; cycles: Cycle[]; instructions: Instr[] }
interface FrameHeader extends GeometryHeader {
  which: "displayed" | "next";
  verified: boolean | null;
  startClk: number;
  replayedCycles: number;
}

const hex = (n: number, w = 4) => `$${(n >>> 0).toString(16).padStart(w, "0")}`;
const bits = (m: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => m & (1 << i));

/** What the CPU did in a cycle, from its bus accesses and BA. */
function cpuState(c: Cycle): "stall" | "w" | "r" | "f" | "idle" {
  const real = c.cpu.filter((a) => a.k !== "dr" && a.k !== "dw");
  if (c.cpu.length === 0) return c.ba ? "stall" : "idle";
  if (real.some((a) => a.k === "w") || c.cpu.some((a) => a.k === "dw")) return "w";
  if (real.some((a) => a.k === "f")) return "f";
  return "r";
}

const PHI1_LABEL: Record<Cycle["phi1"]["k"], string> = { i: "i", r: "r", g: "g", gi: "g", p: "p", s: "s" };

interface Props {
  sessionId: string;
  checkpointId: string;
  /** The line to open on (the clicked pixel's raster line). */
  line: number;
  /** The clicked pixel's framebuffer column, to mark the cycle that drew it. */
  fbX?: number | null;
  /** Spec 860 — a cycle clicked in the grid (the blanking included): open on it. */
  cycle?: number | null;
}

export function VicLineView({ sessionId, checkpointId, line: initialLine, fbX, cycle: initialCycle }: Props): React.JSX.Element {
  const [line, setLine] = useState(initialLine);
  const [data, setData] = useState<{ frame: FrameHeader; line: Line } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [lineInput, setLineInput] = useState(String(initialLine));

  useEffect(() => { setLine(initialLine); setLineInput(String(initialLine)); }, [initialLine]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr(null);
    getClient()
      .call<{ frame: FrameHeader; lines: Line[] }>("vic/line_trace", { session_id: sessionId, checkpoint_id: checkpointId, from: line, to: line })
      .then((r) => {
        if (cancelled) return;
        setData({ frame: r.frame, line: r.lines[0] });
      })
      .catch((e: any) => { if (!cancelled) setErr(e?.message ?? String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [sessionId, checkpointId, line]);

  // The frame's geometry, from its header. An old runtime's header lacks it — said, not guessed.
  const { geo, geoError } = useMemo(() => {
    if (!data) return { geo: null, geoError: null };
    try { return { geo: frameGeometry(data.frame), geoError: null }; }
    catch (e) { return { geo: null, geoError: e instanceof Error ? e.message : String(e) }; }
  }, [data]);
  // The framebuffer row this line is drawn into — itself, or on a wrapped (NTSC) window,
  // below the frame's last line.
  const fbRow = geo ? geo.fbRowOfLine(line) : line;

  // The cycle whose draw produced the clicked pixel, on the clicked line only.
  const drawnBy = useMemo(() => {
    if (!data || fbX == null || line !== initialLine) return null;
    const c = data.line.cycles.find((c) => c.fbLine === fbRow && fbX >= c.fbX && fbX < c.fbX + 8);
    return c ? c.c : null;
  }, [data, fbX, line, initialLine, fbRow]);

  useEffect(() => { setSel(drawnBy ?? (line === initialLine ? initialCycle ?? null : null)); }, [drawnBy, initialCycle, line, initialLine]);

  const lastLine = (geo?.linesPerFrame ?? data?.frame.linesPerFrame ?? 1) - 1;
  const go = (n: number) => {
    const v = Math.max(0, Math.min(lastLine, n));
    setLine(v);
    setLineInput(String(v));
  };

  const header = () => {
    if (!data) return null;
    const f = data.frame;
    const verdict =
      f.which === "next"
        ? <span className="vl-warn" title="No ring anchor reaches back to the frame on screen, so the frame after it was recorded.">next frame — the ring does not reach back</span>
        : f.verified === true
          ? <span className="vl-ok" title="The replay drew exactly the picture the frozen machine shows.">frame on screen ✓</span>
          : f.verified === false
            ? <span className="vl-bad" title="The replay drew a different picture — input during the replay window is the usual cause.">replay differs from the picture</span>
            : <span className="vl-warn" title="The checkpoint carries no picture to compare with.">frame on screen (unverified)</span>;
    return verdict;
  };

  const summary = useMemo(() => {
    if (!data) return null;
    let run = 0, stalled = 0, writesUnderBa = 0, vicOwned = 0;
    for (const c of data.line.cycles) {
      const s = cpuState(c);
      if (s === "stall") stalled++;
      else if (s !== "idle") run++;
      if (s === "w" && c.ba) writesUnderBa++;
      if (c.aec) vicOwned++;
    }
    return { run, stalled, writesUnderBa, vicOwned };
  }, [data]);

  const cycles = data?.line.cycles ?? [];
  const CPL = geo?.cyclesPerLine ?? cycles.length;
  const lo = cycles[0]?.clk ?? 0;
  const hi = cycles[cycles.length - 1]?.clk ?? 0;
  const col = (clk: number) => Math.max(0, Math.min(CPL - 1, clk - lo)); // 0-based column

  // Sprites that do anything on this line.
  const spritesActive = useMemo(() => {
    const s = new Set<number>();
    for (const c of cycles) {
      if (c.phi1.k === "s") s.add(c.phi1.spr);
      if (c.phi2.k === "s") s.add(c.phi2.spr);
    }
    return [...s].sort((a, b) => a - b);
  }, [cycles]);

  const focus = hover ?? sel;
  const fc = focus != null ? cycles[focus - 1] : null;
  const fcInstr = fc && data ? data.line.instructions.find((i) => fc.clk >= i.start && fc.clk < Math.max(i.end, i.start + 1)) : null;

  const cell = (c: Cycle, extra: string) => ({
    className: `vl-cell ${extra}${sel === c.c ? " vl-sel" : ""}${hover === c.c ? " vl-hover" : ""}${drawnBy === c.c ? " vl-drawn" : ""}`,
    onMouseEnter: () => setHover(c.c),
    onClick: () => setSel(sel === c.c ? null : c.c),
  });

  return (
    <div className="wb-explore-node wb-vicline">
      <div className="vl-head">
        <strong>Line {line}</strong>
        <span className="wb-muted">{hex(line, 3)}</span>
        {data?.line.badLine && <span className="vl-chip vl-chip-bad">bad line</span>}
        {header()}
        <span className="vl-nav">
          <button onClick={() => go(line - 1)} disabled={line <= 0} aria-label="Previous line">◀</button>
          <input
            id="vl-line-input"
            value={lineInput}
            onChange={(e) => setLineInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const t = lineInput.trim();
              const n = t.startsWith("$") ? parseInt(t.slice(1), 16) : parseInt(t, 10);
              if (!Number.isNaN(n)) go(n);
            }}
            onBlur={() => setLineInput(String(line))}
            aria-label="Raster line"
          />
          <button onClick={() => go(line + 1)} disabled={line >= lastLine} aria-label="Next line">▶</button>
        </span>
        {geo && <span className="wb-muted">{data?.frame.model ? `${data.frame.model} · ` : ""}{geo.cyclesPerLine} cycles · lines 0–{lastLine}</span>}
        {busy && <span className="wb-muted">recording…</span>}
      </div>
      {err && <div className="vl-bad">{err}</div>}
      {geoError && <div className="vl-bad">{geoError}</div>}
      {summary && (
        <div className="vl-summary wb-muted">
          CPU ran {summary.run} · stalled {summary.stalled}
          {summary.writesUnderBa > 0 && <> · {summary.writesUnderBa} write(s) under BA</>}
          {" "}· VIC owned the bus {summary.vicOwned}
        </div>
      )}
      {data && (
        <div className="vl-scroll">
          {/* Hover is cleared when the pointer leaves the GRID, not a cell: the 1px gaps
              between cells would otherwise blank the detail on every move. */}
          <div className="vl-grid" style={{ gridTemplateColumns: `var(--vl-label) repeat(${CPL}, var(--vl-cell))` }}
            onMouseLeave={() => setHover(null)}>
            {/* cycle ruler */}
            <div className="vl-label">cycle</div>
            {cycles.map((c) => (
              <div key={c.c} {...cell(c, `vl-ruler`)}>{c.c % 5 === 0 || c.c === 1 ? c.c : ""}</div>
            ))}

            {/* zone: offscreen / border / display, from the chip's flip-flops and the draw column */}
            <div className="vl-label" title="Where the cycle's 8 pixels landed: outside the visible window, in the border, or in the display window">zone</div>
            {cycles.map((c) => {
              const vx = geo ? c.fbX - geo.fbOrigin.x : -8;
              const off = !geo || vx + 8 <= 0 || vx >= geo.width || c.fbLine !== fbRow;
              const z = off ? "off" : c.mainBorder || c.vBorder ? "brd" : "disp";
              return <div key={c.c} {...cell(c, `vl-zone vl-zone-${z}`)} />;
            })}

            {/* Φ1 */}
            <div className="vl-label" title="VIC first half-cycle: g graphics, p sprite pointer, s sprite data, r refresh, i idle">Φ1 VIC</div>
            {cycles.map((c) => (
              <div key={c.c} {...cell(c, `vl-acc vl-p1-${c.phi1.k}`)}>
                {PHI1_LABEL[c.phi1.k]}{c.phi1.k === "p" || c.phi1.k === "s" ? <sub>{c.phi1.spr}</sub> : null}
              </div>
            ))}

            {/* Φ2 */}
            <div className="vl-label" title="Second half-cycle: c video matrix, s sprite data — otherwise the CPU's">Φ2</div>
            {cycles.map((c) => (
              <div key={c.c} {...cell(c, `vl-acc vl-p2-${c.phi2.k}${c.phi2.blocked ? " vl-blocked" : ""}`)}>
                {c.phi2.k === "c" ? "c" : c.phi2.k === "s" ? <>s<sub>{c.phi2.spr}</sub></> : ""}
              </div>
            ))}

            {/* BA / AEC */}
            <div className="vl-label" title="BA low: the VIC takes the bus in 3 cycles — CPU reads stall, writes complete">BA</div>
            {cycles.map((c) => <div key={c.c} {...cell(c, `vl-bar${c.ba ? " vl-ba" : ""}`)} />)}
            <div className="vl-label" title="AEC low in Φ2: the VIC owns the address bus">AEC</div>
            {cycles.map((c) => <div key={c.c} {...cell(c, `vl-bar${c.aec ? " vl-aec" : ""}`)} />)}

            {/* CPU */}
            <div className="vl-label" title="What the 6510 did: F fetch, R read, W write, ▨ stalled on a read">CPU</div>
            {cycles.map((c) => {
              const s = cpuState(c);
              return (
                <div key={c.c} {...cell(c, `vl-acc vl-cpu-${s}`)}>
                  {s === "w" ? "W" : s === "r" ? "R" : s === "f" ? "F" : ""}
                </div>
              );
            })}

            {/* instructions as pills over their cycles */}
            <div className="vl-label">code</div>
            <div className="vl-pills" style={{ gridColumn: `2 / span ${CPL}` }}>
              {data.line.instructions.flatMap((i, n) => {
                const out: React.JSX.Element[] = [];
                if (i.interrupt != null && i.interruptStart != null && i.interruptStart < i.start) {
                  const a = col(i.interruptStart), b = col(Math.min(i.start - 1, hi));
                  if (i.start - 1 >= lo) {
                    out.push(
                      <div key={`irq${n}`} className="vl-pill vl-pill-irq" style={{ gridColumn: `${a + 1} / ${b + 2}` }}
                        title={`interrupt → ${hex(i.interrupt)}`}>IRQ</div>,
                    );
                  }
                }
                const endIncl = Math.max(i.start, i.end - 1);
                if (endIncl < lo || i.start > hi) return out;
                const a = col(i.start), b = col(Math.min(endIncl, hi));
                const cutL = i.start < lo, cutR = endIncl > hi;
                out.push(
                  <div key={n} className={`vl-pill${cutL ? " vl-cut-l" : ""}${cutR ? " vl-cut-r" : ""}`}
                    style={{ gridColumn: `${a + 1} / ${b + 2}` }}
                    title={`${hex(i.pc)}  ${i.text}  (${i.end - i.start} cycles)`}>
                    {i.text}
                  </div>,
                );
                return out;
              })}
            </div>

            {/* sprite lanes, only the sprites that fetch on this line */}
            {spritesActive.map((s) => (
              <React.Fragment key={`spr${s}`}>
                <div className="vl-label">sprite {s}</div>
                {cycles.map((c) => {
                  const on = (c.phi1.k === "s" && c.phi1.spr === s) || (c.phi2.k === "s" && c.phi2.spr === s) || (c.phi1.k === "p" && c.phi1.spr === s);
                  return <div key={c.c} {...cell(c, `vl-bar${on ? " vl-spr" : ""}`)} />;
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {data && (
        // Always there, always the same rows: the panel must not change height while the
        // pointer moves across the grid. Nothing focused → the rows stand empty.
        <div className="vl-detail">
          <div className="vl-detail-title">
            {fc ? <>cycle {fc.c}<span className="wb-muted"> · clk {fc.clk} · $D012 reads {fc.raster}{fc.raster !== line ? " (the counter resets one cycle late)" : ""}</span></>
              : <span className="wb-muted">point at a cycle</span>}
            {fc && drawnBy === fc.c && <span className="vl-chip">drew the clicked pixel</span>}
          </div>
          <table className="wb-regs vl-detail-table"><tbody>
            <tr><td>Φ1</td><td>{fc ? <>{fc.phi1.k === "gi" ? "g (idle)" : fc.phi1.k}{fc.phi1.k === "p" || fc.phi1.k === "s" ? ` sprite ${fc.phi1.spr}` : ""} · {hex(fc.phi1.a)}{fc.phi1.rom ? " char ROM" : ""} = {hex(fc.phi1.v, 2)}</> : ""}</td></tr>
            <tr><td>Φ2</td><td>{fc ? <>{fc.phi2.k === "cpu" ? "CPU" : fc.phi2.k === "c" ? `c (matrix) · ${hex(fc.phi2.a)} = ${hex(fc.phi2.v, 2)}` : `s sprite ${fc.phi2.spr}`}{fc.phi2.blocked ? " — blocked, AEC still high" : ""}</> : ""}</td></tr>
            <tr><td>BA / AEC</td><td>{fc ? `${fc.ba ? "low" : "high"} / ${fc.aec ? "low" : "high"}` : ""}</td></tr>
            <tr><td>CPU</td><td>{fc ? (fc.cpu.length === 0
              ? (fc.ba ? "stalled — its read waits for BA" : "no bus access")
              : fc.cpu.map((a) => `${a.k.toUpperCase()} ${hex(a.a)} = ${hex(a.v, 2)}`).join("   ")) : ""}</td></tr>
            <tr><td>code</td><td>{fcInstr ? `${hex(fcInstr.pc)}  ${fcInstr.text}` : fc ? "—" : ""}</td></tr>
            <tr><td>counters</td><td>{fc ? `VC ${hex(fc.vc, 3)} · VCBASE ${hex(fc.vcbase, 3)} · RC ${fc.rc} · VMLI ${fc.vmli} · ${fc.idle ? "idle" : "display"} state${fc.badLine ? " · bad line" : ""}` : ""}</td></tr>
            <tr><td>sprites</td><td>{fc ? `DMA ${bits(fc.spriteDma).join(",") || "—"} · display ${bits(fc.spriteDisplay).join(",") || "—"}${bits(fc.spriteDma).map((i) => `  #${i} MC ${fc.mc[i]}/${fc.mcbase[i]}`).join("")}` : ""}</td></tr>
            <tr><td>border</td><td>{fc ? `main ${fc.mainBorder ? "on" : "off"} · vertical ${fc.vBorder ? "on" : "off"}` : ""}</td></tr>
            <tr><td>regs</td><td>{fc ? `$D011 ${hex(fc.d011, 2)} · $D016 ${hex(fc.d016, 2)} · $D018 ${hex(fc.d018, 2)} · bank ${hex(fc.vbank)}` : ""}</td></tr>
            <tr><td>drew</td><td>{fc && geo ? (fc.fbLine === fbRow
              ? `pixels x ${fc.fbX - geo.fbOrigin.x}..${fc.fbX - geo.fbOrigin.x + 7} of the visible frame (the draw runs a cycle behind)`
              : `the last pixels of line ${geo.lineOfFbRow(fc.fbLine)} (the draw runs a cycle behind)`) : ""}</td></tr>
          </tbody></table>
        </div>
      )}
      <div className="vl-credit wb-muted">layout after <a href="https://github.com/elysium64/vicspector" target="_blank" rel="noreferrer">vicspector</a> · data: this machine</div>
    </div>
  );
}
