// Spec 861 §3.1 — what an instruction costs, on the ESM side.
//
// THE GRID BELOW IS THE SAME GRID AS `pipeline/src/lib/mos6502.ts`, character
// for character. `src/` is ESM and `pipeline/src/` is CommonJS and the two
// cannot import each other — the reason `src/monitor/disasm6502.ts` already
// carries a copy of the opcode table. `npm run check:cycle-table` reads the
// literal out of both files and fails if they differ, so this copy cannot drift
// the way that one could.
//
// Sixteen rows of sixteen, the way every 6502 reference prints it. `*` = an
// indexed READ pays one more when the index crosses a page, `^` = a branch (+1
// taken, +1 again when the target is on another page), `-` = a JAM, which has
// no cycle count because it never retires. A store and a read-modify-write
// never pay the page penalty: they spend that cycle unconditionally and it is
// already in the base.
//
// Proved against the machine, not against a book: `npm run smoke:861` runs
// every opcode here on the runtime with the display off and asserts that the
// measured cycles are these cycles.

export const CYCLE_GRID = `
  7  6  -  8  3  3  5  5  3  2  2  2  4  4  6  6
  2^ 5* -  8  4  4  6  6  2  4* 2  7  4* 4* 7  7
  6  6  -  8  3  3  5  5  4  2  2  2  4  4  6  6
  2^ 5* -  8  4  4  6  6  2  4* 2  7  4* 4* 7  7
  6  6  -  8  3  3  5  5  3  2  2  2  3  4  6  6
  2^ 5* -  8  4  4  6  6  2  4* 2  7  4* 4* 7  7
  6  6  -  8  3  3  5  5  4  2  2  2  5  4  6  6
  2^ 5* -  8  4  4  6  6  2  4* 2  7  4* 4* 7  7
  2  6  2  6  3  3  3  3  2  2  2  2  4  4  4  4
  2^ 6  -  6  4  4  4  4  2  5  2  5  5  5  5  5
  2  6  2  6  3  3  3  3  2  2  2  2  4  4  4  4
  2^ 5* -  5* 4  4  4  4  2  4* 2  4* 4* 4* 4* 4*
  2  6  2  8  3  3  5  5  2  2  2  2  4  4  6  6
  2^ 5* -  8  4  4  6  6  2  4* 2  7  4* 4* 7  7
  2  6  2  8  3  3  5  5  2  2  2  2  4  4  6  6
  2^ 5* -  8  4  4  6  6  2  4* 2  7  4* 4* 7  7
`;

export interface OpcodeTiming {
  /** cycles with no page crossing and, for a branch, not taken */
  base: number;
  /** an indexed READ that crosses a page pays one more */
  pageCross: boolean;
  /** +1 when taken, +1 again when the target is on another page */
  branch: boolean;
}

function parseCycleGrid(grid: string): (OpcodeTiming | undefined)[] {
  const cells = grid.trim().split(/\s+/u);
  if (cells.length !== 256) throw new Error(`the cycle grid has ${cells.length} cells, not 256`);
  return cells.map((cell) => {
    if (cell === "-") return undefined;
    const m = /^(\d+)([*^]?)$/u.exec(cell);
    if (!m) throw new Error(`"${cell}" is not a cycle cell (3, 4*, 2^ or -)`);
    return { base: Number(m[1]), pageCross: m[2] === "*", branch: m[2] === "^" };
  });
}

const TIMINGS = parseCycleGrid(CYCLE_GRID);

/** What one opcode costs. `undefined` for the twelve JAMs — a JAM never retires. */
export function opcodeTiming(opcode: number): OpcodeTiming | undefined {
  return TIMINGS[opcode & 0xff];
}

/** A cost that is not one number: `[min, max]`, equal when it is exact. */
export interface Span {
  min: number;
  max: number;
}

export const span = (min: number, max = min): Span => ({ min, max });
export const addSpans = (a: Span, b: Span): Span => ({ min: a.min + b.min, max: a.max + b.max });
export const scaleSpan = (s: Span, n: number): Span => ({ min: s.min * n, max: s.max * n });
export const isExact = (s: Span): boolean => s.min === s.max;
export const formatSpan = (s: Span): string => (isExact(s) ? String(s.min) : `${s.min}–${s.max}`);

/**
 * The cycle span of one instruction with nothing known about its data: the base,
 * plus the page penalty as the difference between min and max, plus the branch's
 * two conditional cycles.
 */
export function timingSpan(opcode: number): Span | undefined {
  const t = opcodeTiming(opcode);
  if (!t) return undefined;
  if (t.branch) return { min: t.base, max: t.base + 2 };
  if (t.pageCross) return { min: t.base, max: t.base + 1 };
  return { min: t.base, max: t.base };
}

/** Does `base + index` leave the page `base` is on? */
export function crossesPage(base: number, index: number): boolean {
  return ((base & 0xff) + (index & 0xff)) > 0xff;
}

/** Are these two addresses on different pages? (the branch's second penalty) */
export function differentPage(from: number, to: number): boolean {
  return (from & 0xff00) !== (to & 0xff00);
}
