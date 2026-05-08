// Spec 266 — MonitorCmdLine: VICE-syntax command input + output log.

import React, { useState, useRef, useEffect } from "react";
import { parseMonitorCmd } from "../monitor-cmd-parser.js";

export interface CmdResult {
  cmd: string;
  output: string;
  error?: boolean;
}

interface Props {
  onCmd: (raw: string) => Promise<string>;
  history?: CmdResult[];
}

export function MonitorCmdLine({ onCmd, history = [] }: Props): JSX.Element {
  const [input, setInput] = useState<string>("");
  const [histIdx, setHistIdx] = useState<number>(-1);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when history updates.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [history]);

  const submit = async () => {
    const raw = input.trim();
    if (!raw || busy) return;
    setInput("");
    setHistIdx(-1);
    setInputHistory((h) => [raw, ...h].slice(0, 50));
    setBusy(true);
    try {
      await onCmd(raw);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histIdx + 1, inputHistory.length - 1);
      setHistIdx(next);
      if (inputHistory[next] !== undefined) setInput(inputHistory[next]!);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(histIdx - 1, -1);
      setHistIdx(next);
      setInput(next === -1 ? "" : (inputHistory[next] ?? ""));
    }
  };

  // Show parsed hint while typing.
  const parsed = input.trim() ? parseMonitorCmd(input.trim()) : null;

  return (
    <div className="mon-cmdline-wrap">
      <div className="mon-cmdlog" ref={logRef}>
        {history.map((h, i) => (
          <div key={i} className={`mon-cmdlog-entry${h.error ? " mon-cmdlog-error" : ""}`}>
            <span className="mon-cmdlog-cmd">&gt; {h.cmd}</span>
            {h.output && <pre className="mon-cmdlog-out">{h.output}</pre>}
          </div>
        ))}
      </div>
      <div className="mon-cmdline-input-row">
        <span className="mon-cmdline-prompt">&gt;</span>
        <input
          className="mon-cmdline-input"
          type="text"
          value={input}
          onChange={(e) => { setInput(e.target.value); setHistIdx(-1); }}
          onKeyDown={onKeyDown}
          placeholder="VICE command (w, r, bk, m, d, z, n, ret, until…)"
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="mon-cmdline-submit"
          onClick={submit}
          disabled={busy || !input.trim()}
        >
          {busy ? "…" : "Submit"}
        </button>
      </div>
      {parsed && parsed.kind !== "unknown" && (
        <div className="mon-cmdline-hint">
          parsed: <span className="mon-cmdline-hint-kind">{parsed.kind}</span>
        </div>
      )}
      {parsed && parsed.kind === "unknown" && input.trim() && (
        <div className="mon-cmdline-hint mon-cmdline-hint-err">unknown command</div>
      )}
    </div>
  );
}
