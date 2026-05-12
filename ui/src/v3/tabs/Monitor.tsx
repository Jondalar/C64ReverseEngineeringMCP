// Spec 266 — Monitor tab: VICE monitor parity UI.
//
// Layout:
//   [Run][Pause][Step][Over][Out][Reset]   branch: <id>
//   Reg: PC=... A=... X=... Y=... SP=... NV-BDIZC
//   ┌─ Disasm ─────┬─ Memory ────────────────┐
//   │              │                          │
//   ├──────────────┴─────────────────────────┤
//   │ Breakpoints                             │
//   ├──────────────────────────────────────-─┤
//   │ > cmd [Submit]                          │
//   └─────────────────────────────────────────┘

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TabProps } from "./Live.types.js";
import { getClient } from "../ws-client.js";
import { parseMonitorCmd } from "../monitor-cmd-parser.js";
import { MonitorRegisters, type RegisterState } from "../components/MonitorRegisters.js";
import { MonitorDisasm, type DisasmLine } from "../components/MonitorDisasm.js";
import { MonitorMemory } from "../components/MonitorMemory.js";
import { BreakpointList, type BpSpec } from "../components/BreakpointList.js";
import { MonitorCmdLine, type CmdResult } from "../components/MonitorCmdLine.js";

interface MemRange {
  start: number;
  end: number;
}

const DEFAULT_MEM: MemRange = { start: 0x0400, end: 0x04ff };

export function MonitorTab({ sessionId }: TabProps): JSX.Element {
  const [paused, setPaused] = useState<boolean>(true);
  const [regs, setRegs] = useState<RegisterState | null>(null);
  const [disasm, setDisasm] = useState<DisasmLine[]>([]);
  const [memBytes, setMemBytes] = useState<number[]>([]);
  const [memRange, setMemRange] = useState<MemRange>(DEFAULT_MEM);
  const [breakpoints, setBreakpoints] = useState<BpSpec[]>([]);
  const [cmdHistory, setCmdHistory] = useState<CmdResult[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const client = getClient();

  // ---- Helpers ----

  function pushCmd(cmd: string, output: string, isError = false) {
    setCmdHistory((h) => [...h, { cmd, output, error: isError }].slice(-200));
  }

  const safeRuntime = useCallback(async <T,>(
    op: string,
    ...args: unknown[]
  ): Promise<T | null> => {
    if (!sessionId) {
      setError("No session selected.");
      return null;
    }
    try {
      return await client.runtime<T>(sessionId, op, ...args);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [client, sessionId]);

  // ---- Refresh regs + disasm ----

  const refreshRegs = useCallback(async () => {
    const r = await safeRuntime<RegisterState>("monitorRegisters", "c64");
    if (r) setRegs(r);
  }, [safeRuntime]);

  const refreshDisasm = useCallback(async (pc?: number) => {
    const addr = pc ?? regs?.pc ?? 0;
    const lines = await safeRuntime<DisasmLine[]>("monitorDisasm", addr, 10);
    if (lines) setDisasm(lines);
  }, [safeRuntime, regs]);

  const refreshMem = useCallback(async (range?: MemRange) => {
    const r = range ?? memRange;
    const raw = await safeRuntime<number[]>("monitorMemory", r.start, r.end);
    if (raw) setMemBytes(Array.from(raw));
  }, [safeRuntime, memRange]);

  const refreshBreakpoints = useCallback(async () => {
    const bps = await safeRuntime<BpSpec[]>("listBreakpoints");
    if (bps) setBreakpoints(bps);
  }, [safeRuntime]);

  const refreshAll = useCallback(async () => {
    await refreshRegs();
    await refreshDisasm();
    await refreshMem();
    await refreshBreakpoints();
  }, [refreshRegs, refreshDisasm, refreshMem, refreshBreakpoints]);

  // Poll registers every 500ms when paused + session exists.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!sessionId || !paused) return;
    pollRef.current = setInterval(refreshRegs, 500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionId, paused, refreshRegs]);

  // Initial load when session changes.
  useEffect(() => {
    if (sessionId) refreshAll();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Toolbar actions ----

  const doStep = useCallback(async (op: "stepInto" | "stepOver" | "stepOut") => {
    const r = await safeRuntime<{ finalPc?: number } | null>(op);
    if (r !== null) {
      await refreshAll();
    }
  }, [safeRuntime, refreshAll]);

  const doRun = useCallback(async () => {
    setPaused(false);
    await safeRuntime("run");
  }, [safeRuntime]);

  const doPause = useCallback(async () => {
    await safeRuntime("pause");
    setPaused(true);
    await refreshAll();
  }, [safeRuntime, refreshAll]);

  const doReset = useCallback(async () => {
    await safeRuntime("reset");
    setPaused(true);
    await refreshAll();
  }, [safeRuntime, refreshAll]);

  // ---- Memory edit (auto-branch) ----

  const handleMemEdit = useCallback(async (addr: number, value: number) => {
    const patch = { kind: "mem_byte" as const, addr, value };
    const snap = await safeRuntime<{ id: string } | string>("applyPatch", "root", [patch]);
    if (snap) {
      const id = typeof snap === "string" ? snap : snap.id;
      setBranchId(id.slice(0, 8));
      pushCmd(`edit $${addr.toString(16).padStart(4, "0").toUpperCase()} = ${value.toString(16).padStart(2, "0").toUpperCase()}`,
              `branch: ${id.slice(0, 8)}`);
      await refreshMem();
    }
  }, [safeRuntime, refreshMem]);

  // ---- Breakpoints ----

  const handleBpToggle = useCallback(async (id: string, enabled: boolean) => {
    await safeRuntime("enableBreakpoint", id, enabled);
    await refreshBreakpoints();
  }, [safeRuntime, refreshBreakpoints]);

  const handleBpRemove = useCallback(async (id: string) => {
    await safeRuntime("removeBreakpoint", id);
    await refreshBreakpoints();
  }, [safeRuntime, refreshBreakpoints]);

  // ---- Command line ----

  let _bpSeq = breakpoints.length;
  const nextBpId = () => `bp${++_bpSeq}`;

  const handleCmd = useCallback(async (raw: string): Promise<string> => {
    const parsed = parseMonitorCmd(raw);
    let output = "";
    try {
      switch (parsed.kind) {
        case "r_show": {
          const r = await safeRuntime<RegisterState>("monitorRegisters", "c64");
          if (r) {
            setRegs(r);
            output = `PC=$${r.pc.toString(16).padStart(4,"0").toUpperCase()} A=$${r.a.toString(16).padStart(2,"0").toUpperCase()} X=$${r.x.toString(16).padStart(2,"0").toUpperCase()} Y=$${r.y.toString(16).padStart(2,"0").toUpperCase()} SP=$${r.sp.toString(16).padStart(2,"0").toUpperCase()}`;
          }
          break;
        }
        case "r_set": {
          const patch = { kind: "register" as const, reg: parsed.reg, value: parsed.value };
          const snap = await safeRuntime<string>("applyPatch", "root", [patch]);
          if (snap) {
            const id = typeof snap === "string" ? snap : (snap as any).id;
            setBranchId(id.slice(0, 8));
            output = `branch: ${id.slice(0, 8)}`;
          }
          await refreshRegs();
          break;
        }
        case "m": {
          const start = parsed.start;
          const end = parsed.end ?? start + 0xff;
          const raw2 = await safeRuntime<number[]>("monitorMemory", start, end);
          if (raw2) {
            setMemBytes(Array.from(raw2));
            setMemRange({ start, end });
            // Format as hex dump.
            const lines: string[] = [];
            for (let i = 0; i < raw2.length; i += 16) {
              const addr = (start + i).toString(16).padStart(4, "0").toUpperCase();
              const row = Array.from(raw2.slice(i, i + 16))
                .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                .join(" ");
              lines.push(`$${addr}  ${row}`);
            }
            output = lines.join("\n");
          }
          break;
        }
        case "d": {
          const pc = parsed.addr ?? regs?.pc ?? 0;
          const count = parsed.count ?? 10;
          const lines = await safeRuntime<DisasmLine[]>("monitorDisasm", pc, count);
          if (lines) {
            setDisasm(lines);
            output = lines.map((l) => l.text).join("\n");
          }
          break;
        }
        case "g": {
          await safeRuntime("goto", parsed.addr);
          await refreshRegs();
          output = `PC set to $${parsed.addr.toString(16).padStart(4,"0").toUpperCase()}`;
          break;
        }
        case "z": {
          await safeRuntime("stepInto");
          await refreshAll();
          output = "stepped";
          break;
        }
        case "n": {
          const res = await safeRuntime<{ haltReason: string; finalPc: number }>("stepOver");
          if (res) {
            await refreshAll();
            output = `stepOver: ${res.haltReason} PC=$${res.finalPc.toString(16).padStart(4,"0").toUpperCase()}`;
          }
          break;
        }
        case "ret": {
          const res = await safeRuntime<{ finalPc: number }>("stepOut");
          if (res) {
            await refreshAll();
            output = `stepOut: PC=$${res.finalPc.toString(16).padStart(4,"0").toUpperCase()}`;
          }
          break;
        }
        case "until": {
          const res = await safeRuntime<{ halted: boolean; finalPc: number }>("until", parsed.addr);
          if (res) {
            await refreshAll();
            output = `until: halted=${res.halted} PC=$${res.finalPc.toString(16).padStart(4,"0").toUpperCase()}`;
          }
          break;
        }
        case "w": {
          // Build PokePatch: mem_range
          const patch = { kind: "mem_range" as const, addr: parsed.addr, bytes: parsed.bytes };
          const snap = await safeRuntime<string>("applyPatch", "root", [patch]);
          if (snap) {
            const id = typeof snap === "string" ? snap : (snap as any).id;
            setBranchId(id.slice(0, 8));
            output = `wrote ${parsed.bytes.length} byte(s) @ $${parsed.addr.toString(16).padStart(4,"0").toUpperCase()}. branch: ${id.slice(0, 8)}`;
          }
          await refreshMem();
          break;
        }
        case "bk": {
          const id = nextBpId();
          const result = await safeRuntime<string>(
            "addPcBreakpoint",
            id,
            parsed.addr,
            "halt"
          );
          await refreshBreakpoints();
          output = `breakpoint added: ${result ?? id} @ $${parsed.addr.toString(16).padStart(4,"0").toUpperCase()}${parsed.cond ? ` if ${parsed.cond}` : ""}`;
          break;
        }
        case "watch": {
          const id = nextBpId();
          await safeRuntime(
            "addBreakpoint",
            {
              id,
              predicate: {
                kind: parsed.mode === "read" ? "mem_read" : parsed.mode === "write" ? "mem_write" : "or",
                ...(parsed.mode === "both"
                  ? { left: { kind: "mem_read", addr: parsed.addr }, right: { kind: "mem_write", addr: parsed.addr } }
                  : { addr: parsed.addr }),
              },
              action: "halt",
              enabled: true,
            }
          );
          await refreshBreakpoints();
          output = `watchpoint added: ${id} @ $${parsed.addr.toString(16).padStart(4,"0").toUpperCase()}`;
          break;
        }
        case "delete": {
          await safeRuntime("removeBreakpoint", parsed.id);
          await refreshBreakpoints();
          output = `deleted: ${parsed.id}`;
          break;
        }
        case "disable": {
          await safeRuntime("enableBreakpoint", parsed.id, false);
          await refreshBreakpoints();
          output = `disabled: ${parsed.id}`;
          break;
        }
        case "enable": {
          await safeRuntime("enableBreakpoint", parsed.id, true);
          await refreshBreakpoints();
          output = `enabled: ${parsed.id}`;
          break;
        }
        case "bookmark": {
          await safeRuntime("addBookmark", { label: parsed.label });
          output = `bookmark added: ${parsed.label}`;
          break;
        }
        default:
          output = `unknown command: ${raw}`;
          pushCmd(raw, output, true);
          return output;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushCmd(raw, msg, true);
      return msg;
    }
    pushCmd(raw, output);
    return output;
  }, [safeRuntime, refreshAll, refreshRegs, refreshMem, refreshBreakpoints, regs, breakpoints.length]);

  // ---- Render ----

  const hasSession = !!sessionId;

  return (
    <div className="mon-tab">
      {/* Toolbar */}
      <div className="mon-toolbar">
        <button className="mon-btn" onClick={doRun}     disabled={!hasSession || !paused} title="Run">Run</button>
        <button className="mon-btn" onClick={doPause}   disabled={!hasSession || paused}  title="Pause">Pause</button>
        <button className="mon-btn" onClick={() => doStep("stepInto")}  disabled={!hasSession} title="Step Into">Step</button>
        <button className="mon-btn" onClick={() => doStep("stepOver")}  disabled={!hasSession} title="Step Over">Over</button>
        <button className="mon-btn" onClick={() => doStep("stepOut")}   disabled={!hasSession} title="Step Out">Out</button>
        <button className="mon-btn mon-btn-reset" onClick={doReset} disabled={!hasSession} title="Reset">Reset</button>
        {branchId && <span className="mon-branch-badge">branch: {branchId}</span>}
        {error && <span className="mon-error-badge" title={error}>ERR</span>}
      </div>

      {/* Registers */}
      <div className="mon-regs-row">
        <MonitorRegisters regs={regs} paused={paused} />
      </div>

      {/* Disasm + Memory side by side */}
      <div className="mon-body">
        <div className="mon-pane mon-pane-disasm">
          <div className="mon-pane-title">Disasm</div>
          <MonitorDisasm lines={disasm} currentPc={regs?.pc} />
        </div>
        <div className="mon-pane mon-pane-mem">
          <div className="mon-pane-title">
            Memory
            <span className="mon-mem-range-hint">
              &nbsp;${memRange.start.toString(16).padStart(4,"0").toUpperCase()}–${memRange.end.toString(16).padStart(4,"0").toUpperCase()}
            </span>
          </div>
          <MonitorMemory
            bytes={memBytes}
            baseAddr={memRange.start}
            onEdit={handleMemEdit}
          />
        </div>
      </div>

      {/* Breakpoints */}
      <div className="mon-section">
        <div className="mon-section-title">Breakpoints</div>
        <BreakpointList
          breakpoints={breakpoints}
          onToggle={handleBpToggle}
          onRemove={handleBpRemove}
        />
      </div>

      {/* Command line */}
      <div className="mon-section mon-section-cmd">
        <MonitorCmdLine onCmd={handleCmd} history={cmdHistory} />
      </div>

      {!hasSession && (
        <div className="mon-no-session">No session selected. Start a session via the Media tab.</div>
      )}
    </div>
  );
}
