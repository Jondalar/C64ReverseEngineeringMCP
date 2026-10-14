// What $D000-$DFFF is when an instruction reaches it, and what an I/O register is called.
//
// Two questions the renderer asks of every absolute operand in the window:
//
//   1. IS it I/O here? The default is yes (`$01` = $35 or $37 is how games run), and the bytes
//      cannot say otherwise: the banking is program state, not an operand. The project declares
//      the exceptions in `memoryMap` — a depacker that writes under the window with `$01` at
//      $34 is RAM, however many registers it happens to share addresses with. `IoScope` holds
//      those declarations and answers per (address, instruction).
//
//   2. WHAT is it called? `ioRegisterFor`: the chips ($D000-$DBFF, CIA 1, CIA 2) answer from the
//      platform store, folding a mirror onto its register; the cartridge window ($DE00-$DFFF)
//      answers by the cartridge type (./cartridge-io).
//
// A routine, for the first question, is its entry address and everything reachable from it by
// fall-through, branches and `jmp`: that is the code that runs with the banking its entry set
// up. A `jsr` callee is a routine of its own and is not pulled in; an indirect `jmp` ends the walk.

import { cartridgeIoRegister } from "./cartridge-io";
import type { MemoryMapIndexEntry } from "./annotations";
import { decodeInstruction } from "./mos6502";
import { platformIoRegister } from "./platform-kb";

export interface ByteSource {
  /** the address of data[0] */
  base: number;
  data: Buffer;
}

export type WindowUse = "io" | "ram" | "charrom";

/** The instruction start addresses of the code reachable from `entries` without a `jsr`. */
export function routineExtent(entries: readonly number[], fetch: (address: number) => ReturnType<typeof decodeAt>): Set<number> {
  const seen = new Set<number>();
  const work = [...entries];
  while (work.length > 0) {
    const address = work.pop()! & 0xffff;
    if (seen.has(address)) continue;
    const instruction = fetch(address);
    if (!instruction || instruction.isUnknown) continue;
    seen.add(address);
    const next = (address + instruction.size) & 0xffff;
    const m = instruction.mnemonic;
    if (instruction.mode === "rel") {
      work.push(next);
      if (instruction.targetAddress !== undefined) work.push(instruction.targetAddress);
    } else if (m === "jmp") {
      if (instruction.mode === "abs" && instruction.targetAddress !== undefined) work.push(instruction.targetAddress);
    } else if (m !== "rts" && m !== "rti" && m !== "brk" && m !== "jam") {
      work.push(next);
    }
  }
  return seen;
}

function decodeAt(sources: readonly ByteSource[], address: number) {
  for (const s of sources) {
    const offset = address - s.base;
    if (offset >= 0 && offset < s.data.length) return decodeInstruction(s.data, offset, s.base);
  }
  return undefined;
}

export class IoScope {
  private readonly extents = new Map<MemoryMapIndexEntry, Set<number>>();

  constructor(private readonly map: readonly MemoryMapIndexEntry[], sources: readonly ByteSource[]) {
    for (const entry of map) {
      if (entry.routines.length > 0) this.extents.set(entry, routineExtent(entry.routines, (a) => decodeAt(sources, a)));
    }
  }

  get declared(): boolean {
    return this.map.length > 0;
  }

  /** What `address` is when the instruction at `instruction` reaches it: the last declaration that covers both wins. */
  useAt(address: number, instruction: number): WindowUse {
    let use: WindowUse = "io";
    for (const entry of this.map) {
      if (address < entry.start || address > entry.end) continue;
      const extent = this.extents.get(entry);
      if (extent && !extent.has(instruction & 0xffff)) continue;
      use = entry.as;
    }
    return use;
  }
}

export interface IoRegisterName {
  name: string;
  /** where `name` is defined */
  base: number;
  /** address - base */
  offset: number;
}

/** The register `address` is on this machine, or undefined where the window has none there. */
export function ioRegisterFor(address: number, cartridgeType: number | undefined): IoRegisterName | undefined {
  if (address >= 0xde00 && address <= 0xdfff) {
    const reg = cartridgeIoRegister(address, cartridgeType);
    return reg ? { name: reg.name, base: reg.base, offset: address - reg.base } : undefined;
  }
  return platformIoRegister(address);
}

/** `name`, or `name+$40` for an address that sits `offset` past the register the name is defined at. */
export function registerExpression(name: string, offset: number): string {
  return offset === 0 ? name : `${name}+$${offset.toString(16).toUpperCase().padStart(2, "0")}`;
}
