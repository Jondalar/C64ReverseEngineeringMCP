// Spec 244 — Taint analysis / dataflow tracking.
//
// For a target byte at (cycle, addr), enumerate every prior write that
// contributed to its current value, recursively.  Pure forensic analysis
// on existing trace — no re-execution needed.
//
// Resolved decisions:
//   D1: followIrq=true  — recursion crosses irq_assert boundaries.
//   D2: crossDomain=true — IEC events bridged: c64 io_register_read on
//       $DD0D → drive_data_change → drive-side writes → original disk bytes.

import type { QueryEventsBackend } from "./query-events.js";
import { queryEvents } from "./query-events.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaintQuery {
  runId: string;
  startCycle: number;
  startAddr: number;          // byte to taint
  maxDepth?: number;          // default 100
  cycleWindow?: number;       // default 1_000_000
  followIrq?: boolean;        // default true
  crossDomain?: boolean;      // default true — IEC cross-domain bridge
  driveRunId?: string;        // run ID for drive-side trace (D2)
}

export type TaintContribution =
  | "direct_write"            // STA/STX/STY/STZ
  | "rmw_modify"              // INC/DEC/ASL/LSR/ROL/ROR/etc
  | "io_register_read"        // value sourced from $DC00-$DFFF (CIA/VIC/SID)
  | "stack_push"              // PHA/PHP/JSR
  | "transfer"                // TAX/TAY/TXA/TYA/TSX/TXS
  | "irq_boundary"            // crossed IRQ — followIrq=false stops here
  | "iec_bridge";             // IEC domain crossing (D2)

export interface TaintNode {
  id: string;                 // unique ID: "cycle@addr" or "reg:A@cycle"
  cycle: number;
  pc: number;
  addr: number;               // memory addr or -1 for register-only nodes
  reg?: string;               // "A" | "X" | "Y" | "SP" | "flags" when applicable
  value: number;
  contribution: TaintContribution;
  inputs: { addr?: number; reg?: string }[];
  domain: "c64" | "drive";
}

export interface TaintEdge {
  from: string;               // node ID
  to: string;                 // node ID
}

export interface TaintGraph {
  root: TaintNode;
  nodes: Record<string, TaintNode>;
  edges: TaintEdge[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Opcode effects table
// ---------------------------------------------------------------------------

type RegisterName = "A" | "X" | "Y" | "SP" | "flags";

interface OpcodeEffects {
  kind: "direct_write" | "rmw_modify" | "io_register_read" | "stack_push" | "transfer" | "none";
  /** register that is the source of the value written (for direct_write / transfer) */
  sourceReg?: RegisterName;
  /** register that is the destination (for loads / transfers) */
  destReg?: RegisterName;
  /** true when the instruction reads the target addr before writing it (RMW) */
  isRmw?: boolean;
}

function opcodeEffects(opcode: number): OpcodeEffects {
  switch (opcode) {
    // STA — store A
    case 0x81: case 0x85: case 0x8d: case 0x91: case 0x95: case 0x99: case 0x9d:
      return { kind: "direct_write", sourceReg: "A" };

    // STX — store X
    case 0x86: case 0x8e: case 0x96:
      return { kind: "direct_write", sourceReg: "X" };

    // STY — store Y
    case 0x84: case 0x8c: case 0x94:
      return { kind: "direct_write", sourceReg: "Y" };

    // STZ (65C02, but model it for completeness) — not in 6510, skip
    // SAX (undocumented) — store A&X
    case 0x83: case 0x87: case 0x8f: case 0x97:
      return { kind: "direct_write", sourceReg: "A" };

    // SHX, SHY, AHX, TAS, SHA (undocumented high-byte stores)
    case 0x93: case 0x9b: case 0x9c: case 0x9e: case 0x9f:
      return { kind: "direct_write", sourceReg: "A" };

    // PHA
    case 0x48:
      return { kind: "stack_push", sourceReg: "A" };

    // PHP
    case 0x08:
      return { kind: "stack_push", sourceReg: "flags" };

    // JSR — pushes return address (2 bytes); treat as stack_push of PC
    case 0x20:
      return { kind: "stack_push" };

    // INC — RMW
    case 0xe6: case 0xee: case 0xf6: case 0xfe:
      return { kind: "rmw_modify", isRmw: true };

    // DEC — RMW
    case 0xc6: case 0xce: case 0xd6: case 0xde:
      return { kind: "rmw_modify", isRmw: true };

    // ASL — RMW
    case 0x06: case 0x0e: case 0x16: case 0x1e:
      return { kind: "rmw_modify", isRmw: true };

    // LSR — RMW
    case 0x46: case 0x4e: case 0x56: case 0x5e:
      return { kind: "rmw_modify", isRmw: true };

    // ROL — RMW
    case 0x26: case 0x2e: case 0x36: case 0x3e:
      return { kind: "rmw_modify", isRmw: true };

    // ROR — RMW
    case 0x66: case 0x6e: case 0x76: case 0x7e:
      return { kind: "rmw_modify", isRmw: true };

    // Undocumented compound RMW: SLO, RLA, SRE, RRA, DCP, ISC
    case 0x03: case 0x07: case 0x0f: case 0x13: case 0x17: case 0x1b: case 0x1f:
      return { kind: "rmw_modify", isRmw: true }; // SLO

    case 0x23: case 0x27: case 0x2f: case 0x33: case 0x37: case 0x3b: case 0x3f:
      return { kind: "rmw_modify", isRmw: true }; // RLA

    case 0x43: case 0x47: case 0x4f: case 0x53: case 0x57: case 0x5b: case 0x5f:
      return { kind: "rmw_modify", isRmw: true }; // SRE

    case 0x63: case 0x67: case 0x6f: case 0x73: case 0x77: case 0x7b: case 0x7f:
      return { kind: "rmw_modify", isRmw: true }; // RRA

    case 0xc3: case 0xc7: case 0xcf: case 0xd3: case 0xd7: case 0xdb: case 0xdf:
      return { kind: "rmw_modify", isRmw: true }; // DCP

    case 0xe3: case 0xe7: case 0xef: case 0xf3: case 0xf7: case 0xfb: case 0xff:
      return { kind: "rmw_modify", isRmw: true }; // ISC

    // Transfer instructions (register ← register; they write via STA after TAX etc)
    case 0xaa: return { kind: "transfer", sourceReg: "A",  destReg: "X"  }; // TAX
    case 0xa8: return { kind: "transfer", sourceReg: "A",  destReg: "Y"  }; // TAY
    case 0x8a: return { kind: "transfer", sourceReg: "X",  destReg: "A"  }; // TXA
    case 0x98: return { kind: "transfer", sourceReg: "Y",  destReg: "A"  }; // TYA
    case 0xba: return { kind: "transfer", sourceReg: "SP", destReg: "X"  }; // TSX
    case 0x9a: return { kind: "transfer", sourceReg: "X",  destReg: "SP" }; // TXS

    default:
      return { kind: "none" };
  }
}

/** True if the address is an I/O register in the CIA1/CIA2/VIC/SID range. */
function isIoRegisterAddr(addr: number): boolean {
  // $D000-$DFFF — VIC, SID, CIA1 ($DC00-$DCFF), CIA2 ($DD00-$DDFF)
  return addr >= 0xd000 && addr <= 0xdfff;
}

/** $DD0D is CIA2 ICR — the IEC-linked interrupt control register. */
function isIecBridgeAddr(addr: number): boolean {
  return addr === 0xdd0d || addr === 0xdc0d;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

interface WorkItem {
  runId: string;
  domain: "c64" | "drive";
  addr: number;
  beforeCycle: number;
  depth: number;
  parentId: string | null;
}

export async function traceTaint(
  backend: QueryEventsBackend,
  query: TaintQuery,
): Promise<TaintGraph> {
  const maxDepth   = query.maxDepth   ?? 100;
  const cycleWindow = query.cycleWindow ?? 1_000_000;
  const followIrq  = query.followIrq   ?? true;
  const crossDomain = query.crossDomain ?? true;

  const minCycle = query.startCycle - cycleWindow;
  const nodes: Record<string, TaintNode> = {};
  const edges: TaintEdge[] = [];
  let truncated = false;

  // ---- BFS work queue ----
  const queue: WorkItem[] = [{
    runId: query.runId,
    domain: "c64",
    addr: query.startAddr,
    beforeCycle: query.startCycle,
    depth: 0,
    parentId: null,
  }];

  let root: TaintNode | null = null;

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth > maxDepth) { truncated = true; continue; }
    if (item.beforeCycle < minCycle) { continue; }

    // Find most recent mem_write at item.addr before item.beforeCycle.
    const writeRows = await queryEvents(backend, {
      runId: item.runId,
      family: "mem_write",
      addrRange: [item.addr, item.addr],
      cycleRange: [Math.max(0, minCycle), item.beforeCycle - 1],
      limit: 10000,
    });

    if (writeRows.length === 0) continue;

    // Sort descending by cycle — take the most recent write.
    const writeRow = writeRows
      .filter((r) => r.family === "mem_write")
      .sort((a, b) => b.cycle - a.cycle)[0];

    if (!writeRow || writeRow.family !== "mem_write") continue;

    const nodeId = `${writeRow.cycle}@${writeRow.addr.toString(16)}`;
    if (nodes[nodeId]) {
      // Already visited; add edge only.
      if (item.parentId) edges.push({ from: item.parentId, to: nodeId });
      continue;
    }

    // Determine contribution kind from the writing opcode.
    // We look at the cpu_step that corresponds to this write's PC.
    const cpuRows = await queryEvents(backend, {
      runId: item.runId,
      family: "cpu_step",
      cycleRange: [writeRow.cycle - 10, writeRow.cycle],
      pcRange: [writeRow.pc, writeRow.pc],
      limit: 5,
    });
    const cpuRow = cpuRows.length > 0 ? cpuRows[0] : null;
    const opcode = cpuRow && cpuRow.family === "cpu_step" ? cpuRow.opcode : 0;
    const effects = opcodeEffects(opcode);

    // Classify IO register reads (the value came from CIA/VIC hardware).
    const isIo = isIoRegisterAddr(writeRow.addr) || (effects.kind === "none" && isIoRegisterAddr(writeRow.pc));

    let contribution: TaintContribution;
    if (isIo) {
      contribution = "io_register_read";
    } else if (effects.kind === "stack_push") {
      contribution = "stack_push";
    } else if (effects.kind === "transfer") {
      contribution = "transfer";
    } else if (effects.kind === "rmw_modify") {
      contribution = "rmw_modify";
    } else if (effects.kind === "direct_write") {
      contribution = "direct_write";
    } else {
      contribution = "direct_write"; // fallback
    }

    const nodeInputs: { addr?: number; reg?: string }[] = [];
    if (effects.sourceReg) nodeInputs.push({ reg: effects.sourceReg });
    if (effects.isRmw)     nodeInputs.push({ addr: writeRow.addr });

    const node: TaintNode = {
      id: nodeId,
      cycle: writeRow.cycle,
      pc: writeRow.pc,
      addr: writeRow.addr,
      value: writeRow.value,
      contribution,
      inputs: nodeInputs,
      domain: item.domain,
    };
    nodes[nodeId] = node;

    if (root === null) root = node;
    if (item.parentId) edges.push({ from: item.parentId, to: nodeId });

    // ---- IRQ-boundary check ----
    // If IRQ was asserted just before this write, record/skip as appropriate.
    // Look back up to 500 cycles to catch the most recent IRQ assertion.
    if (!followIrq) {
      const irqRows = await queryEvents(backend, {
        runId: item.runId,
        family: "irq_assert",
        cycleRange: [writeRow.cycle - 500, writeRow.cycle],
        limit: 5,
      });
      if (irqRows.length > 0) {
        // IRQ boundary: add a marker node, do not recurse.
        const irqId = `irq@${writeRow.cycle}`;
        if (!nodes[irqId]) {
          nodes[irqId] = {
            id: irqId,
            cycle: writeRow.cycle,
            pc: writeRow.pc,
            addr: writeRow.addr,
            value: writeRow.value,
            contribution: "irq_boundary",
            inputs: [],
            domain: item.domain,
          };
        }
        edges.push({ from: nodeId, to: irqId });
        continue;
      }
    }

    // ---- IEC cross-domain bridge (D2) ----
    // If the write target is $DD0D (CIA2 ICR) and crossDomain=true,
    // look for drive_data_change events near the same cycle.
    if (crossDomain && isIecBridgeAddr(writeRow.addr) && query.driveRunId) {
      const driveRunId = query.driveRunId;
      const ddcRows = await queryEvents(backend, {
        runId: item.runId,
        family: "drive_data_change",
        cycleRange: [writeRow.cycle - 500, writeRow.cycle + 100],
        limit: 10,
      });
      if (ddcRows.length > 0) {
        // Find drive-side writes around this cycle.
        const bridgeId = `iec@${writeRow.cycle}`;
        if (!nodes[bridgeId]) {
          nodes[bridgeId] = {
            id: bridgeId,
            cycle: writeRow.cycle,
            pc: writeRow.pc,
            addr: writeRow.addr,
            value: writeRow.value,
            contribution: "iec_bridge",
            inputs: [],
            domain: "c64",
          };
          edges.push({ from: nodeId, to: bridgeId });
        }
        // Enqueue drive-side write search (port B = $1800 on VIA1 of the 1541).
        queue.push({
          runId: driveRunId,
          domain: "drive",
          addr: 0x1800, // VIA1 DDRB / port B — IEC data
          beforeCycle: writeRow.cycle + 100,
          depth: item.depth + 1,
          parentId: bridgeId,
        });
      }
      // Terminate IEC sourced values — mark io_register_read.
      continue;
    }

    // ---- Recurse on source register's last load ----
    if (effects.sourceReg && cpuRow && cpuRow.family === "cpu_step") {
      // Walk backward to find where the source register got its value.
      const regAddr = registerAddr(effects.sourceReg, cpuRow);
      if (regAddr !== undefined) {
        queue.push({
          runId: item.runId,
          domain: item.domain,
          addr: regAddr,
          beforeCycle: writeRow.cycle,
          depth: item.depth + 1,
          parentId: nodeId,
        });
      } else {
        // For pure register sources, trace forward via mem_read at the load site.
        const loadSite = await findRegisterLoad(
          backend, item.runId, effects.sourceReg,
          writeRow.cycle, Math.max(0, minCycle), item.depth, maxDepth,
        );
        if (loadSite) {
          queue.push({
            runId: item.runId,
            domain: item.domain,
            addr: loadSite,
            beforeCycle: writeRow.cycle,
            depth: item.depth + 1,
            parentId: nodeId,
          });
        }
      }
    }

    // ---- RMW: recurse on prior value of the same address ----
    if (effects.isRmw) {
      queue.push({
        runId: item.runId,
        domain: item.domain,
        addr: writeRow.addr,
        beforeCycle: writeRow.cycle - 1,
        depth: item.depth + 1,
        parentId: nodeId,
      });
    }

    // Depth guard
    if (item.depth >= maxDepth) {
      truncated = true;
    }
  }

  // Build root fallback if nothing was found.
  if (!root) {
    const fallbackId = `${query.startCycle}@${query.startAddr.toString(16)}`;
    root = {
      id: fallbackId,
      cycle: query.startCycle,
      pc: 0,
      addr: query.startAddr,
      value: 0,
      contribution: "direct_write",
      inputs: [],
      domain: "c64",
    };
    nodes[fallbackId] = root;
  }

  return { root, nodes, edges, truncated };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * For transfer/load instructions, find the most recent memory read that
 * loaded the given register before the specified cycle.
 * Returns the source address or undefined.
 */
async function findRegisterLoad(
  backend: QueryEventsBackend,
  runId: string,
  reg: RegisterName,
  beforeCycle: number,
  minCycle: number,
  depth: number,
  maxDepth: number,
): Promise<number | undefined> {
  if (depth >= maxDepth) return undefined;

  // Walk backward through cpu_steps to find a load into this register.
  const steps = await queryEvents(backend, {
    runId,
    family: "cpu_step",
    cycleRange: [minCycle, beforeCycle - 1],
    limit: 10000,
  });

  // Walk from newest to oldest.
  const sorted = steps
    .filter((r) => r.family === "cpu_step")
    .sort((a, b) => b.cycle - a.cycle);

  for (const step of sorted) {
    if (step.family !== "cpu_step") continue;
    const eff = opcodeEffects(step.opcode);
    if (eff.destReg !== reg) continue;

    // This instruction loads `reg`. Now find the mem_read at its PC cycle.
    const reads = await queryEvents(backend, {
      runId,
      family: "mem_read",
      cycleRange: [step.cycle - 10, step.cycle + 10],
      pcRange: [step.pc, step.pc],
      limit: 5,
    });
    const read = reads.filter((r) => r.family === "mem_read")[0];
    if (read && read.family === "mem_read") {
      return read.addr;
    }
    // Immediate mode (no memory read) — no further recursion possible.
    return undefined;
  }

  return undefined;
}

/**
 * When the source register can map directly to a memory address (e.g. for
 * stack-relative operations), return that address.  Returns undefined when
 * the register's value came from an immediate operand or another register.
 */
function registerAddr(reg: RegisterName, cpuStep: { family: string; sp?: number }): number | undefined {
  if (reg === "SP" && cpuStep.family === "cpu_step") {
    const sp = (cpuStep as any).sp as number;
    // Stack is at $0100 + SP
    return typeof sp === "number" ? 0x0100 + sp : undefined;
  }
  return undefined;
}
