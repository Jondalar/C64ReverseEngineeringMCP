// Spec 352 — Monitor VICE-compat console.
// Mounts as bottom-of-Live panel. [max] toggles overlay mode.
// VICE syntax priority: g/step/next/finish/until/reset, r/registers/cpu,
// m/mem/d/disass/>/fill/compare/hunt, bk/break/watch/trace,
// dump/undump/load/save/bload/bsave, c:/8:/9:/io:/ram:/rom:.

import React, { useEffect, useRef, useState } from "react";
import { getClient } from "../ws-client.js";

interface Props {
  sessionId: string;
  maximized: boolean;
  onToggleMax: () => void;
  // Set by the Live run-loop when emulation halts at a breakpoint. The
  // changing `seq` re-triggers the in-monitor "BREAK" report + input focus.
  breakpoint?: { pc: number; num: number; registers: string; seq: number } | null;
}

interface MonLine { kind: "in" | "out" | "err"; text: string; }

export function MonitorPanel({ sessionId, maximized, onToggleMax, breakpoint }: Props): React.JSX.Element {
  const [history, setHistory] = useState<MonLine[]>([
    { kind: "out", text: "C64RE Monitor — VICE-compat. Try: r, m c000 c0ff, d e000, bk e5cf, help" },
  ]);
  const [input, setInput] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1);
  // Spec 754 §3.3c — modal prompt (assemble mode). Non-null = the server is in a
  // line-prompt mode; show it instead of `>` and send empty lines (exit signal).
  const [prompt, setPrompt] = useState<string | null>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [history]);

  const append = (lines: MonLine[]) => setHistory((h) => [...h, ...lines]);

  // Breakpoint halt: drop into the monitor — print "BREAK", the register
  // dump, and focus the input so the user can step (z/n) or continue (g).
  useEffect(() => {
    if (!breakpoint) return;
    const pcHex = breakpoint.pc.toString(16).padStart(4, "0").toUpperCase();
    setHistory((h) => [
      ...h,
      { kind: "err", text: `#${breakpoint.num} BREAK at $${pcHex}` },
      ...breakpoint.registers.split(/\r?\n/).map((t) => ({ kind: "out" as const, text: t })),
    ]);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakpoint?.seq]);

  const dispatch = async (raw: string) => {
    const cmd = raw.trim();
    // Empty line: a no-op normally; in a modal prompt (assemble) it's the exit.
    if (!cmd && prompt === null) return;
    append([{ kind: "in", text: (prompt ?? "> ") + cmd }]);
    if (cmd) { setCmdHistory((h) => [...h, cmd]); setCmdHistoryIdx(-1); }
    if (!sessionId) {
      append([{ kind: "err", text: "no session" }]);
      return;
    }
    try {
      const r = await getClient().call<{ output?: string; error?: string; prompt?: string }>("monitor/exec", {
        session_id: sessionId, command: cmd,
      });
      if (r.error) append([{ kind: "err", text: r.error }]);
      if (r.output) append(r.output.split(/\r?\n/).map((t) => ({ kind: "out" as const, text: t })));
      setPrompt(r.prompt ?? null);
    } catch (e: any) {
      // monitor/exec may not exist yet — fall back to inline parser
      const out = inlineDispatch(cmd);
      if (out) append([{ kind: "out", text: out }]);
      else append([{ kind: "err", text: `monitor backend not wired (${e.message ?? e}).` }]);
      setPrompt(null);
    }
  };

  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const v = input;
      setInput("");
      await dispatch(v);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const idx = cmdHistoryIdx < 0 ? cmdHistory.length - 1 : Math.max(0, cmdHistoryIdx - 1);
      setCmdHistoryIdx(idx);
      setInput(cmdHistory[idx] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = cmdHistoryIdx + 1;
      if (idx >= cmdHistory.length) { setCmdHistoryIdx(-1); setInput(""); }
      else { setCmdHistoryIdx(idx); setInput(cmdHistory[idx] ?? ""); }
    }
  };

  return (
    <div className={`wb-monitor ${maximized ? "max" : ""}`}>
      <div className="wb-monitor-bar">
        <span>Monitor</span>
        <button onClick={onToggleMax} title={maximized ? "Restore" : "Maximize"}>
          {maximized ? "[restore]" : "[max]"}
        </button>
      </div>
      <div ref={outRef} className="wb-monitor-out">
        {history.map((l, i) => (
          <div key={i} className={`wb-mon-${l.kind}`}>{l.text || " "}</div>
        ))}
      </div>
      <div className="wb-monitor-in">
        <span className="wb-prompt">{prompt ? prompt.trimEnd() : ">"}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
    </div>
  );
}

// Inline fallback help/parser when backend monitor route not wired.
function inlineDispatch(cmd: string): string | null {
  const tokens = cmd.toLowerCase().split(/\s+/);
  const op = tokens[0];
  if (op === "help" || op === "?") {
    return [
      "VICE-compat monitor commands (subset):",
      "  Execution: g <addr>, step, next, finish, until <addr>, reset",
      "  Registers: r | registers | cpu",
      "  Memory:    m <a> [b], d <a> [b], > <a> <byte...>, fill, compare, hunt",
      "  Bp/watch:  bk | break | watch | trace | delete | enable | disable | condition",
      "  File:      load | save | bload | bsave | dump | undump",
      "  Spaces:    c:, 8:, 9:, io:, ram:, rom:",
      "(backend wiring TBD — commands return error until monitor/exec lands)",
    ].join("\n");
  }
  return null;
}
