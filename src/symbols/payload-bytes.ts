// Spec 804 §4.2 — the bytes that decide residency.
//
// "Which payload is in memory at this address right now" is answered by BYTES: a
// payload's CODE bytes near the address, compared with what the machine holds. Every
// analysed payload's `<owner>_analysis.json` carries its decoded instructions with their
// bytes — the depacked runtime bytes, by address — so C64RE has what it needs without
// asking the runtime anything but memory.
//
// Only code is compared. Data changes at run time (a variable, a buffer) and would make
// a resident payload look absent; a byte some instruction of the payload WRITES (a
// self-modified operand) is dropped for the same reason. Relocated code is shifted to the
// address it RUNS at (Spec 842 D4 keys the graph on the runtime address).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { payloadKey, type PayloadRef } from "./types.js";

export interface Relocation {
  fileStart: number;
  fileEnd: number;
  runtimeAddr: number;
}

/** The nearest code bytes compared, at most. */
export const COMPARE_MAX = 24;
/** Fewer code bytes than this near the address and residency is undecidable → no name. */
export const COMPARE_MIN = 4;
/** How far from the address a compared code byte may lie. */
export const COMPARE_WINDOW = 256;

interface InstructionFact { address: number; bytes?: number[]; provenance?: string }
interface Xref { targetAddress?: number; type?: string }
interface AnalysisDoc {
  codeAnalysis?: { instructions?: InstructionFact[]; xrefs?: Xref[] };
  probableCodeAnalysis?: { instructions?: InstructionFact[]; xrefs?: Xref[] };
}

export function ownerOfAnalysisFile(path: string): string {
  return basename(path).replace(/_analysis\.json$/u, "").toLowerCase();
}

/** Every `*_analysis.json` under the project, by owner (the lowercased stem). */
export function findAnalysisFiles(projectDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith("_analysis.json")) {
        const owner = ownerOfAnalysisFile(p);
        if (!out.has(owner)) out.set(owner, p);
      }
    }
  };
  walk(projectDir, 0);
  return out;
}

export class PayloadBytes {
  private analysisFiles?: Map<string, string>;
  private readonly code = new Map<string, Map<number, number>>();
  private readonly sorted = new Map<string, number[]>();

  constructor(
    private readonly projectDir: string,
    private readonly relocations: ReadonlyMap<string, Relocation[]>,
    private readonly crtOwners: ReadonlyMap<number, string[]>,
  ) {}

  hasAnalysis(owner: string): boolean {
    return this.files().has(owner);
  }

  private files(): Map<string, string> {
    if (!this.analysisFiles) this.analysisFiles = findAnalysisFiles(this.projectDir);
    return this.analysisFiles;
  }

  /** address → byte for every compared code byte of the payload (runtime addresses). */
  codeBytes(ref: PayloadRef): Map<number, number> {
    const key = payloadKey(ref);
    let map = this.code.get(key);
    if (map) return map;
    map = new Map();
    if (ref.kind === "analysis") this.addAnalysis(ref.owner, map);
    else if (ref.kind === "crt") for (const owner of this.crtOwners.get(ref.bank) ?? []) this.addAnalysis(owner, map);
    else this.addPrg(ref.path, map);
    this.code.set(key, map);
    return map;
  }

  private addAnalysis(owner: string, into: Map<number, number>): void {
    const path = this.files().get(owner);
    if (!path) return;
    let doc: AnalysisDoc;
    try { doc = JSON.parse(readFileSync(path, "utf8")) as AnalysisDoc; } catch { return; }
    const confirmed = doc.codeAnalysis?.instructions ?? [];
    const instructions = confirmed.length > 0 ? confirmed : (doc.probableCodeAnalysis?.instructions ?? []);
    const written = new Set<number>();
    for (const x of [...(doc.codeAnalysis?.xrefs ?? []), ...(doc.probableCodeAnalysis?.xrefs ?? [])]) {
      if (x.type === "write" && typeof x.targetAddress === "number") written.add(x.targetAddress & 0xffff);
    }
    const relocs = this.relocations.get(owner) ?? [];
    const runtimeOf = (stored: number): number => {
      const r = relocs.find((w) => stored >= w.fileStart && stored <= w.fileEnd);
      return r ? (stored - r.fileStart + r.runtimeAddr) & 0xffff : stored;
    };
    for (const ins of instructions) {
      const bytes = ins.bytes ?? [];
      for (let i = 0; i < bytes.length; i++) {
        const stored = (ins.address + i) & 0xffff;
        if (written.has(stored)) continue;
        into.set(runtimeOf(stored), bytes[i]! & 0xff);
      }
    }
  }

  private addPrg(path: string, into: Map<number, number>): void {
    if (!existsSync(path)) return;
    const buf = readFileSync(path);
    if (buf.length < 3) return;
    const load = buf[0]! | (buf[1]! << 8);
    for (let i = 2; i < buf.length; i++) into.set((load + i - 2) & 0xffff, buf[i]!);
  }

  /**
   * The code bytes of the payload nearest `addr` (at most COMPARE_MAX, within
   * COMPARE_WINDOW). Fewer than COMPARE_MIN → [] : residency is undecidable there.
   */
  comparisonSet(ref: PayloadRef, addr: number): number[] {
    const key = payloadKey(ref);
    let addrs = this.sorted.get(key);
    if (!addrs) {
      addrs = [...this.codeBytes(ref).keys()].sort((a, b) => a - b);
      this.sorted.set(key, addrs);
    }
    // the insertion point, then walk outward taking the nearer side each time
    let lo = 0, hi = addrs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (addrs[mid]! < addr) lo = mid + 1; else hi = mid; }
    let left = lo - 1, right = lo;
    const out: number[] = [];
    while (out.length < COMPARE_MAX) {
      const dl = left >= 0 ? addr - addrs[left]! : Infinity;
      const dr = right < addrs.length ? addrs[right]! - addr : Infinity;
      if (dl === Infinity && dr === Infinity) break;
      if (Math.min(dl, dr) > COMPARE_WINDOW) break;
      if (dr <= dl) out.push(addrs[right++]!);
      else out.push(addrs[left--]!);
    }
    return out.length >= COMPARE_MIN ? out.sort((a, b) => a - b) : [];
  }
}
