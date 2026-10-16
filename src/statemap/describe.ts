// A state map is described before it is run: what a state is (the bytes the game's own code indexes with),
// which moves exist, what counts as dead or as the goal, and the caps. Everything here is checked without a
// machine — a bad description costs no sandbox.

import { isC64KeyName } from "../input/keymap.js";

export type Lens = "cpu" | "ram" | "io" | "rom" | "cart";
const LENSES: readonly Lens[] = ["cpu", "ram", "io", "rom", "cart"];

/** One run of bytes that makes up the state's key. */
export interface KeyPart { readonly text: string; readonly addr: number; readonly len: number; readonly lens: Lens }

/** One thing the player can do. */
export interface Move {
  /** As the answer names it: `R`, `UF`, `N`, `key:SPACE`. */
  readonly label: string;
  readonly joystick?: { up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean };
  readonly keys?: readonly string[];
}

export type Cmp = "==" | "!=" | "<" | ">" | "<=" | ">=" | "masked";
/** `$addr[@lens] [& mask] <op> value` — the byte there, ANDed with the mask when there is one. */
export interface Predicate { readonly text: string; readonly addr: number; readonly lens: Lens; readonly mask?: number; readonly op: Cmp; readonly value: number }

export const DEFAULTS = { frames: 6, releaseFrames: 4, maxStates: 400, maxRuns: 3000, maxDepth: 64, budgetMinutes: 10, port: 2 } as const;
export const MAX_BUDGET_MINUTES = 240;
const MAX_KEY_BYTES = 256;

/** What the tool (and `c64re state map`) takes. */
export interface StateMapInput {
  anchor?: unknown; key?: unknown; actions?: unknown; port?: unknown; frames?: unknown; release_frames?: unknown;
  dead?: unknown; goal?: unknown; continue_after_goal?: unknown;
  max_states?: unknown; max_depth?: unknown; max_runs?: unknown; budget_minutes?: unknown;
  save_states?: unknown; name?: unknown; edges?: unknown;
}

export interface StateMapSpec {
  readonly anchor: string;
  readonly key: readonly KeyPart[];
  readonly moves: readonly Move[];
  readonly port: 1 | 2;
  readonly frames: number;
  readonly releaseFrames: number;
  readonly dead: readonly Predicate[];
  readonly goal?: Predicate;
  readonly continueAfterGoal: boolean;
  readonly maxStates: number;
  readonly maxRuns: number;
  readonly maxDepth: number;
  readonly budgetMinutes: number;
  readonly saveStates: boolean;
  readonly name: string;
  readonly edges: "changes" | "all";
}

/** The refusal: which field, and what it should have been. */
export class Refusal extends Error {
  constructor(readonly field: string, message: string) {
    super(`runtime_state_map: ${field} — ${message}`);
    this.name = "Refusal";
  }
}

const hex = (n: number, w = 2): string => `$${n.toString(16).toUpperCase().padStart(w, "0")}`;

function number(tok: string): number | undefined {
  const t = tok.trim();
  if (/^\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(1), 16);
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^\d+$/.test(t)) return Number(t);
  return undefined;
}

function lensOf(field: string, text: string, raw: string | undefined): Lens {
  const lens = (raw?.toLowerCase() ?? "cpu") as Lens;
  if (!LENSES.includes(lens)) throw new Refusal(field, `"${text}": ${raw} is not a lens (${LENSES.join(", ")})`);
  return lens;
}

/** `"$02"`, `"$0400:2"`, `"$D020@io"`, `"$D800:4@io"`. */
export function parseKeyPart(text: string, field = "key"): KeyPart {
  const m = /^\s*(\$[0-9a-f]+|0x[0-9a-f]+|\d+)(?::(\d+))?(?:@([a-z]+))?\s*$/i.exec(text);
  if (!m) throw new Refusal(field, `"${text}" is not a key part — write "$02", "$0400:2" (two bytes from $0400) or "$D020@io" (a lens: ${LENSES.join(", ")})`);
  const addr = number(m[1]!);
  const len = m[2] === undefined ? 1 : Number(m[2]);
  if (addr === undefined || addr > 0xffff) throw new Refusal(field, `"${text}": ${m[1]} is not an address ($0000-$FFFF)`);
  if (!Number.isInteger(len) || len < 1 || len > MAX_KEY_BYTES) throw new Refusal(field, `"${text}": a key part is 1 to ${MAX_KEY_BYTES} bytes`);
  if (addr + len > 0x10000) throw new Refusal(field, `"${text}": runs past $FFFF`);
  return { text: text.trim(), addr, len, lens: lensOf(field, text, m[3]) };
}

/**
 * `$03 == 1`, `$03 is $01`, `$02 != 0`, `$02 < 3`, `$D020@io >= $05`, `$03 & $80 == $80`, `$03 & $80`
 * (any of the masked bits set). One byte, compared with a byte.
 */
export function parsePredicate(text: string, field: string): Predicate {
  const m = /^\s*(\$[0-9a-f]+|0x[0-9a-f]+|\d+)(?:@([a-z]+))?\s*(?:&\s*(\$[0-9a-f]+|0x[0-9a-f]+|\d+)\s*)?(?:(==|=|!=|<=|>=|<|>|is\s+not|is)\s*(\$[0-9a-f]+|0x[0-9a-f]+|\d+))?\s*$/i.exec(text);
  const form = `"${text}" is not a condition — write "$03 == 1", "$03 is $01", "$02 != 0", "$02 < 3", "$D020@io >= $05" or with a mask "$03 & $80 == $80" ("$03 & $80" alone: any masked bit set)`;
  if (!m) throw new Refusal(field, form);
  const addr = number(m[1]!);
  if (addr === undefined || addr > 0xffff) throw new Refusal(field, `"${text}": ${m[1]} is not an address ($0000-$FFFF), so there is nothing to read`);
  const lens = lensOf(field, text, m[2]);
  const mask = m[3] === undefined ? undefined : number(m[3]);
  if (m[3] !== undefined && (mask === undefined || mask > 0xff || mask === 0)) throw new Refusal(field, `"${text}": the mask ${m[3]} is not a byte above zero`);
  if (m[4] === undefined) {
    if (mask === undefined) throw new Refusal(field, form);
    return { text: text.trim(), addr, lens, mask, op: "masked", value: 0 };
  }
  const value = m[5] === undefined ? undefined : number(m[5]);
  if (value === undefined || value > 0xff) throw new Refusal(field, `"${text}": ${m[5]} is not a byte`);
  const op = m[4].toLowerCase().replace(/\s+/g, " ");
  const cmp: Cmp = op === "is" || op === "=" || op === "==" ? "==" : op === "is not" || op === "!=" ? "!=" : (op as Cmp);
  return { text: text.trim(), addr, lens, ...(mask === undefined ? {} : { mask }), op: cmp, value };
}

export function holds(p: Predicate, byte: number): boolean {
  const v = p.mask === undefined ? byte : byte & p.mask;
  switch (p.op) {
    case "masked": return v !== 0;
    case "==": return v === p.value;
    case "!=": return v !== p.value;
    case "<": return v < p.value;
    case ">": return v > p.value;
    case "<=": return v <= p.value;
    case ">=": return v >= p.value;
  }
}

const JOY: Record<string, "up" | "down" | "left" | "right" | "fire"> = { U: "up", D: "down", L: "left", R: "right", F: "fire" };

export function parseMove(text: string, field = "actions"): Move {
  const t = text.trim();
  if (/^n$/i.test(t)) return { label: "N" };
  const k = /^key:(.+)$/i.exec(t);
  if (k) {
    const names = k[1]!.split(/\s*\+\s*/).map((n) => n.trim().toUpperCase()).filter(Boolean);
    const bad = names.filter((n) => !isC64KeyName(n));
    if (names.length === 0 || bad.length) throw new Refusal(field, `"${text}": ${bad.length ? `${bad.join(", ")} is not a C64 key` : "no key named"} (the matrix's own names: letters and digits as themselves, SPACE, RETURN, RUN_STOP, L_SHIFT, R_SHIFT, CTRL, C_EQ, HOME, DEL, F1/F3/F5/F7, CRSR_RT, CRSR_DN, LARROW, UP_ARROW, POUND, RESTORE)`);
    return { label: `key:${names.join("+")}`, keys: names };
  }
  const letters = [...t.toUpperCase()];
  if (letters.length === 0 || letters.some((c) => !(c in JOY)) || new Set(letters).size !== letters.length) {
    throw new Refusal(field, `"${text}" is not an action — L R U D F (left, right, up, down, fire), a combination such as "UF", N (nothing) or key:SPACE`);
  }
  const joystick = { up: false, down: false, left: false, right: false, fire: false };
  for (const c of letters) joystick[JOY[c]!] = true;
  if (joystick.left && joystick.right) throw new Refusal(field, `"${text}": left and right at once is not a position a stick has`);
  if (joystick.up && joystick.down) throw new Refusal(field, `"${text}": up and down at once is not a position a stick has`);
  // The label puts the letters in one order, so "FU" and "UF" are one move.
  const label = ["L", "R", "U", "D", "F"].filter((c) => letters.includes(c)).join("");
  return { label, joystick };
}

function intField(input: StateMapInput, name: keyof StateMapInput, def: number, min: number, max: number): number {
  const v = input[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Refusal(String(name), `${JSON.stringify(v)} is not a whole number from ${min} to ${max}`);
  return v;
}

function strList(input: StateMapInput, name: "key" | "actions" | "dead", required: boolean): string[] {
  const v = input[name];
  if (v === undefined || v === null) {
    if (required) throw new Refusal(name, `missing — ${name === "key" ? 'the bytes that make a state, e.g. ["$02","$03"], read from the code that indexes rooms/levels' : 'the moves to try, e.g. ["L","R","U","D","F","N"]'}`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Refusal(name, "must be a list of strings");
  if (required && v.length === 0) throw new Refusal(name, name === "key" ? 'is empty — name the bytes that make a state, e.g. ["$02","$03"] (read them from the code that indexes rooms/levels; a key of nothing has one state)' : "is empty — name at least one move");
  return v as string[];
}

/** Check a description without a machine. Throws `Refusal` naming the field. */
export function describeSearch(input: StateMapInput): StateMapSpec {
  if (typeof input.anchor !== "string" || input.anchor.trim() === "") throw new Refusal("anchor", "missing — the name of an anchor (runtime_anchor_set) at the loop where the game waits for input");
  const key = strList(input, "key", true).map((t) => parseKeyPart(t));
  const bytes = key.reduce((n, k) => n + k.len, 0);
  if (bytes > MAX_KEY_BYTES) throw new Refusal("key", `${bytes} bytes; a key is at most ${MAX_KEY_BYTES} — a key that big is not a room number`);
  const seen = new Set<string>();
  const moves: Move[] = [];
  for (const a of strList(input, "actions", true)) {
    const mv = parseMove(a);
    if (seen.has(mv.label)) throw new Refusal("actions", `"${a}" is listed twice`);
    seen.add(mv.label);
    moves.push(mv);
  }
  const dead = strList(input, "dead", false).map((t) => parsePredicate(t, "dead"));
  let goal: Predicate | undefined;
  if (input.goal !== undefined && input.goal !== null) {
    if (typeof input.goal !== "string") throw new Refusal("goal", "must be a string such as \"$03 == 1\"");
    goal = parsePredicate(input.goal, "goal");
  }
  const port = input.port === undefined || input.port === null ? DEFAULTS.port : input.port;
  if (port !== 1 && port !== 2) throw new Refusal("port", `${JSON.stringify(port)}: a joystick is on port 1 or 2`);
  for (const [name, v] of [["continue_after_goal", input.continue_after_goal], ["save_states", input.save_states]] as const) {
    if (v !== undefined && v !== null && typeof v !== "boolean") throw new Refusal(name, "must be true or false");
  }
  if (input.name !== undefined && input.name !== null && (typeof input.name !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,60}$/i.test(input.name))) {
    throw new Refusal("name", `${JSON.stringify(input.name)}: letters, digits, "_", "-" and "." (it names the map and the anchors it writes)`);
  }
  if (input.edges !== undefined && input.edges !== null && input.edges !== "all" && input.edges !== "changes") throw new Refusal("edges", '"all" or "changes"');
  return {
    anchor: input.anchor.trim(),
    key, moves, port, dead, ...(goal ? { goal } : {}),
    frames: intField(input, "frames", DEFAULTS.frames, 1, 600),
    releaseFrames: intField(input, "release_frames", DEFAULTS.releaseFrames, 0, 600),
    continueAfterGoal: input.continue_after_goal === true,
    maxStates: intField(input, "max_states", DEFAULTS.maxStates, 1, 100_000),
    maxRuns: intField(input, "max_runs", DEFAULTS.maxRuns, 1, 1_000_000),
    maxDepth: intField(input, "max_depth", DEFAULTS.maxDepth, 1, 10_000),
    budgetMinutes: intField(input, "budget_minutes", DEFAULTS.budgetMinutes, 1, MAX_BUDGET_MINUTES),
    saveStates: input.save_states === true,
    name: typeof input.name === "string" && input.name ? input.name : input.anchor.trim(),
    edges: input.edges === "all" ? "all" : "changes",
  };
}

/** The ranges one run reads: the key first, then every address a condition looks at. */
export function readPlan(spec: StateMapSpec): { addr: number; len: number; lens: Lens }[] {
  const conds = [...spec.dead, ...(spec.goal ? [spec.goal] : [])];
  return [...spec.key.map((k) => ({ addr: k.addr, len: k.len, lens: k.lens })), ...conds.map((c) => ({ addr: c.addr, len: 1, lens: c.lens }))];
}

export const fmtKey = (parts: readonly KeyPart[], bytes: readonly number[]): string => {
  let i = 0;
  return parts.map((k) => {
    const v = bytes.slice(i, i + k.len);
    i += k.len;
    const label = k.text.split(":")[0]!.split("@")[0]!.toUpperCase().replace("0X", "$");
    return `${label}=${v.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("")}`;
  }).join(" ");
};

export { hex };
