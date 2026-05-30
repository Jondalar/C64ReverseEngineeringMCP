// Spec 266 — MonitorRegisters: CPU register display strip.

import React from "react";

export interface RegisterState {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles?: number;
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, "0").toUpperCase();
}
function hex4(v: number): string {
  return v.toString(16).padStart(4, "0").toUpperCase();
}

function flagStr(f: number): string {
  // NV-BDIZC
  const b = (bit: number) => ((f >> bit) & 1) ? "1" : "0";
  return `${b(7)}${b(6)}-${b(4)}${b(3)}${b(2)}${b(1)}${b(0)}`;
}

interface Props {
  regs: RegisterState | null;
  paused: boolean;
}

export function MonitorRegisters({ regs, paused }: Props): React.JSX.Element {
  if (!regs) {
    return <div className="mon-regs mon-regs-empty">(no registers — session paused or not started)</div>;
  }
  return (
    <div className="mon-regs">
      <span className="mon-reg">PC=<b>${hex4(regs.pc)}</b></span>
      <span className="mon-reg">A=<b>${hex2(regs.a)}</b></span>
      <span className="mon-reg">X=<b>${hex2(regs.x)}</b></span>
      <span className="mon-reg">Y=<b>${hex2(regs.y)}</b></span>
      <span className="mon-reg">SP=<b>${hex2(regs.sp)}</b></span>
      <span className="mon-reg mon-flags">NV-BDIZC=<b>{flagStr(regs.flags)}</b></span>
      {regs.cycles !== undefined && (
        <span className="mon-reg mon-cycles">cyc=<b>{regs.cycles.toLocaleString()}</b></span>
      )}
      {!paused && <span className="mon-reg mon-running">[running]</span>}
    </div>
  );
}
