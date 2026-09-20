// Spec 862 §3 — what must never be made faster.
//
// On a C64 "faster" is not always "better": some code is written the length it
// is ON PURPOSE. A delay loop IS its cycle count. A raster routine's whole
// value is that the write lands on the cycle it lands on. A fastloader's
// handshake is a conversation with a chip on the other end of a cable, and the
// other end is not being changed. And code the graph cannot follow — bytes that
// modify themselves, an indirect jump, a stack trick — cannot be reasoned about
// at all, so an "equivalent" rewrite of it is a claim nobody can back.
//
// Every exclusion is a SPAN with a reason, and the report prints all of them.
// Silence would be the failure mode: a scan that quietly skipped the hot
// routine looks exactly like a scan that found nothing there.

import { effects, BRANCHES, indexRegister } from "../knowledge-graph/isa-6502.js";
import type { Cfg, Insn } from "../cost/cfg.js";
import type { Instance } from "../cost/trace-cost.js";
import type { Unit } from "./rules.js";

export type ExclusionKind = "delay-loop" | "raster-timed" | "drive-code" | "unknown";

export interface Exclusion {
  kind: ExclusionKind;
  /** the unit it was found in */
  where: string;
  start: number;
  /** inclusive */
  end: number;
  why: string;
}

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

const IO = (addr: number): boolean => addr >= 0xd000 && addr <= 0xdfff;
/** The VIC's own registers — the ones a raster effect writes on a cycle. */
const VIC_REG = (addr: number): boolean => addr >= 0xd000 && addr <= 0xd02e;
/** $D011 and $D012: the raster line, read to wait for it. */
const RASTER_REG = (addr: number): boolean => addr === 0xd011 || addr === 0xd012;
/** CIA 2 port A and B — the C64 end of a fastloader's two-wire conversation. */
const SERIAL_PORT = (addr: number): boolean => addr === 0xdd00 || addr === 0xdd01;
/** The 1541's two VIAs. Code that touches these is drive code, wherever it sits. */
const DRIVE_VIA = (addr: number): boolean => (addr >= 0x1800 && addr <= 0x180f) || (addr >= 0x1c00 && addr <= 0x1c0f);

/** The visible display on a PAL machine: a register write here is a split. */
const DISPLAY_FIRST_LINE = 51;
const DISPLAY_LAST_LINE = 250;

/** The constant cell an instruction touches, when the mode names one. */
function cellOf(insn: Insn): number | undefined {
  if (insn.mode === "zp" || insn.mode === "abs") return insn.operand;
  // An indexed access to an I/O page reaches I/O whatever the index is, and
  // that is the only thing these predicates need from it.
  if ((insn.mode === "abs,x" || insn.mode === "abs,y") && insn.operand !== undefined) return insn.operand;
  return undefined;
}

function touchesMemory(insn: Insn): boolean {
  const e = effects(insn.mnemonic, insn.mode);
  if (insn.mode === "acc" || insn.mode === "impl" || insn.mode === "imm" || insn.mode === "rel") return false;
  return e.memRead || e.memWrite;
}

export interface ExclusionInput {
  unit: Unit;
  /** the instances the capture recorded inside this unit, when there is one */
  instances?: readonly Instance[];
  /** the graph's own verdict: this code runs on the drive's 6502 */
  onDriveCpu?: boolean;
  /** the graph's own verdict: something writes into these bytes while the program runs */
  writtenInto?: string[];
}

/**
 * §3 — every reason this unit, or a span inside it, is left alone.
 *
 * An empty list means the scan may propose anything it finds here. A non-empty
 * one does NOT mean the whole unit is out: a delay loop excludes its own span,
 * while the three unit-wide reasons exclude everything.
 */
export function exclusionsFor(input: ExclusionInput): Exclusion[] {
  const { unit } = input;
  const out: Exclusion[] = [];
  const whole = { start: unit.start, end: unit.end };

  // ---- delay loops -------------------------------------------------------
  for (const loop of unit.cfg.loops) {
    const head = unit.cfg.blocks[loop.head]!;
    const tail = unit.cfg.blocks[loop.tail]!;
    const body = unit.cfg.insns.filter((i) => i.address >= head.start && i.address < tail.end);
    const verdict = onlyCounts(body);
    if (verdict) {
      out.push({
        kind: "delay-loop", where: unit.label, start: head.start, end: tail.end - 1,
        why: `the loop at ${hex4(head.start)} ${verdict} — it writes nothing and only counts, so its cycles ARE its purpose`,
      });
    }
  }

  // ---- raster-timed code -------------------------------------------------
  const rasterPolls = unit.cfg.insns.filter((i) => {
    const cell = cellOf(i);
    return cell !== undefined && RASTER_REG(cell) && effects(i.mnemonic, i.mode).memRead;
  });
  const vicWrites = unit.cfg.insns.filter((i) => {
    const cell = cellOf(i);
    return cell !== undefined && VIC_REG(cell) && effects(i.mnemonic, i.mode).memWrite;
  });
  const pollInLoop = rasterPolls.find((poll) =>
    unit.cfg.loops.some((loop) => {
      const head = unit.cfg.blocks[loop.head]!;
      const tail = unit.cfg.blocks[loop.tail]!;
      return poll.address >= head.start && poll.address < tail.end;
    }));
  if (pollInLoop) {
    out.push({
      kind: "raster-timed", where: unit.label, ...whole,
      why: `it waits for the raster: \`${pollInLoop.mnemonic} ${pollInLoop.text}\` at ${hex4(pollInLoop.address)} is read inside a loop, and the loop ends when the beam arrives`,
    });
  } else if (rasterPolls.length > 0 && vicWrites.length > 0) {
    out.push({
      kind: "raster-timed", where: unit.label, ...whole,
      why:
        `it reads the raster at ${hex4(rasterPolls[0]!.address)} and writes a video register at ${hex4(vicWrites[0]!.address)} `
        + `(\`${vicWrites[0]!.mnemonic} ${vicWrites[0]!.text}\`) — the write's position on the line is the effect`,
    });
  } else if (input.instances && vicWrites.length > 0) {
    // §3's second signal, and the one only a measurement can give: the write
    // landed INSIDE the displayed picture, which is what makes it a split
    // rather than a colour set during the blank.
    const byPc = new Set(vicWrites.map((i) => i.address));
    const midLine = input.instances.find(
      (i) => byPc.has(i.pc) && i.line !== null && i.line >= DISPLAY_FIRST_LINE && i.line <= DISPLAY_LAST_LINE,
    );
    if (midLine) {
      out.push({
        kind: "raster-timed", where: unit.label, ...whole,
        why:
          `the capture puts its write to a video register at ${hex4(midLine.pc)} on raster line ${midLine.line}, cycle ${midLine.cycleInLine} `
          + `— inside the displayed picture, where WHEN it lands is the effect`,
      });
    }
  }

  // ---- drive code and fastloader handshakes ------------------------------
  if (input.onDriveCpu) {
    out.push({ kind: "drive-code", where: unit.label, ...whole, why: "the graph puts this code on the drive's own 6502 — a different machine, a different clock, and the cable's timing between them" });
  }
  const viaAccess = unit.cfg.insns.find((i) => {
    const cell = cellOf(i);
    return cell !== undefined && DRIVE_VIA(cell) && touchesMemory(i);
  });
  if (viaAccess) {
    out.push({
      kind: "drive-code", where: unit.label, ...whole,
      why: `it talks to the 1541's VIA at ${hex4(cellOf(viaAccess)!)} (\`${viaAccess.mnemonic} ${viaAccess.text}\` at ${hex4(viaAccess.address)}) — GCR and the bus are timed against the disk turning`,
    });
  }
  const byteReady = unit.cfg.insns.find(
    (i) => (i.mnemonic === "bvc" || i.mnemonic === "bvs") && i.target !== undefined && i.target <= i.address && i.address - i.target <= 2,
  );
  if (byteReady) {
    out.push({
      kind: "drive-code", where: unit.label, ...whole,
      why: `\`${byteReady.mnemonic}\` at ${hex4(byteReady.address)} spins on the overflow flag — the byte-ready handshake, whose whole job is to take exactly as long as the hardware does`,
    });
  }
  const serialInLoop = unit.cfg.insns.find((i) => {
    const cell = cellOf(i);
    if (cell === undefined || !SERIAL_PORT(cell) || !touchesMemory(i)) return false;
    return unit.cfg.loops.some((loop) => {
      const head = unit.cfg.blocks[loop.head]!;
      const tail = unit.cfg.blocks[loop.tail]!;
      return i.address >= head.start && i.address < tail.end;
    });
  });
  if (serialInLoop) {
    out.push({
      kind: "drive-code", where: unit.label, ...whole,
      why: `it bangs the serial port at ${hex4(cellOf(serialInLoop)!)} inside a loop (${hex4(serialInLoop.address)}) — a fastloader handshake, and the other end of the cable is not being changed`,
    });
  }

  // ---- what 861 D1 calls UNKNOWN -----------------------------------------
  for (const block of unit.cfg.blocks) {
    for (const exit of block.unknownExits) {
      if (exit.kind === "jmp-indirect") {
        out.push({ kind: "unknown", where: unit.label, ...whole, why: `\`jmp ${exit.detail ?? "($xxxx)"}\` at ${hex4(exit.at)} — where control goes is a pointer in memory, so nothing here can say what a rewrite reaches` });
      } else if (exit.kind === "rti") {
        out.push({ kind: "unknown", where: unit.label, ...whole, why: `it leaves through an \`rti\` at ${hex4(exit.at)} — the resume address and every flag come off the stack` });
      } else if (exit.kind === "undecodable") {
        out.push({ kind: "unknown", where: unit.label, ...whole, why: `the bytes at ${hex4(exit.at)} are not instructions — the decode stopped there, so what follows is unread` });
      }
    }
  }
  const stackTrick = stackTrickIn(unit.cfg);
  if (stackTrick) out.push({ kind: "unknown", where: unit.label, ...whole, why: stackTrick });
  for (const writer of input.writtenInto ?? []) {
    out.push({ kind: "unknown", where: unit.label, ...whole, why: `${writer} — these bytes are modified while the program runs, so what is on disk is not what executes` });
  }
  const selfModified = selfModifyingIn(unit);
  if (selfModified) out.push({ kind: "unknown", where: unit.label, ...whole, why: selfModified });

  return out;
}

/**
 * Does this loop body do nothing but count?
 *
 * "Nothing but count" is strict on purpose: no I/O at all, no call, and no
 * memory touched other than the one cell the counter itself lives in. A body
 * that reads a table is computing something, and its cycles are a cost rather
 * than a purpose.
 */
function onlyCounts(body: readonly Insn[]): string | null {
  const cells = new Set<number>();
  let counters = 0;
  for (const insn of body) {
    if (insn.mnemonic === "jsr") return null;
    if (BRANCHES.has(insn.mnemonic) || insn.mnemonic === "jmp") continue;
    if (["inx", "iny", "dex", "dey", "nop"].includes(insn.mnemonic)) { counters += 1; continue; }
    if (!touchesMemory(insn)) {
      // a register-only instruction that is not a counter step: this is doing work
      if (["cpx", "cpy", "cmp", "txa", "tya", "tax", "tay"].includes(insn.mnemonic)) continue;
      return null;
    }
    const cell = cellOf(insn);
    if (cell === undefined || IO(cell)) return null;
    if (indexRegister(insn.mode) !== undefined) return null;   // an indexed access is a table, not a counter
    if (insn.mnemonic === "inc" || insn.mnemonic === "dec") { cells.add(cell); counters += 1; continue; }
    return null;   // any other memory access is work
  }
  if (counters === 0) return null;
  return cells.size > 0 ? `steps only the counter at ${hex4([...cells][0]!)}` : "steps only a register";
}

/** An `rts` the routine did not earn, or a stack pointer moved by data. */
function stackTrickIn(cfg: Cfg): string | null {
  for (const insn of cfg.insns) {
    if (insn.mnemonic === "txs") return `\`txs\` at ${hex4(insn.address)} sets the stack pointer from data — where an \`rts\` goes after it is not in the code`;
  }
  let depth = 0;
  for (const insn of cfg.insns) {
    if (insn.mnemonic === "jsr" || insn.mnemonic === "rts") continue;
    const e = effects(insn.mnemonic, insn.mode);
    if (Number.isFinite(e.stack)) depth += e.stack;
  }
  if (depth > 0) {
    return `it leaves ${depth} byte(s) on the stack — an \`rts\` here returns to an address the code pushed, not to its caller`;
  }
  return null;
}

/** A store in this unit whose target lands inside the unit's own bytes. */
function selfModifyingIn(unit: Unit): string | null {
  for (const insn of unit.cfg.insns) {
    const e = effects(insn.mnemonic, insn.mode);
    if (!e.memWrite) continue;
    const cell = cellOf(insn);
    if (cell === undefined) continue;
    if (cell < unit.start || cell > unit.end) continue;
    return `\`${insn.mnemonic} ${insn.text}\` at ${hex4(insn.address)} writes ${hex4(cell)}, inside this very range — the bytes modify themselves`;
  }
  return null;
}

/** Is this address inside something the scan must leave alone? */
export function excluded(exclusions: readonly Exclusion[], address: number): Exclusion | null {
  for (const e of exclusions) if (address >= e.start && address <= e.end) return e;
  return null;
}
