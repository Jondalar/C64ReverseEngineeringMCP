// Spec 266 — MonitorDisasm: disassembly listing view.

import React from "react";

export interface DisasmLine {
  addr: number;
  bytes: number[];
  mnemonic: string;
  operand: string;
  text: string;
}

interface Props {
  lines: DisasmLine[];
  currentPc?: number;
}

function hex4(v: number): string {
  return v.toString(16).padStart(4, "0").toUpperCase();
}

export function MonitorDisasm({ lines, currentPc }: Props): JSX.Element {
  if (lines.length === 0) {
    return <div className="mon-disasm mon-disasm-empty">(no disasm)</div>;
  }
  return (
    <div className="mon-disasm">
      {lines.map((ln) => {
        const isCurrent = currentPc !== undefined && ln.addr === currentPc;
        return (
          <div key={ln.addr} className={`mon-disasm-line${isCurrent ? " mon-disasm-current" : ""}`}>
            {isCurrent && <span className="mon-disasm-arrow">&gt;</span>}
            {!isCurrent && <span className="mon-disasm-arrow">&nbsp;</span>}
            <span className="mon-disasm-addr">${hex4(ln.addr)}</span>
            <span className="mon-disasm-bytes">
              {ln.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ").padEnd(8)}
            </span>
            <span className="mon-disasm-mne">{ln.mnemonic}</span>
            {ln.operand && <span className="mon-disasm-operand">&nbsp;{ln.operand}</span>}
          </div>
        );
      })}
    </div>
  );
}
