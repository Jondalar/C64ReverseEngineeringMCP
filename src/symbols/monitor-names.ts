// Spec 804 §2 — the monitor with names, WITHOUT a parser of its own.
//
// TRX64 defines the monitor command set; C64RE only USES it. This module never looks at
// which verb was typed, carries no list of verbs and no table of instructions, and never
// reads an address out of the runtime's text. It does exactly two generic things:
//
//   INPUT   a token that is not the first, is not a number in the monitor's own syntax,
//           and is exactly a name the resolver knows for a payload resident NOW (in the
//           monitor's current space) becomes `$XXXX`. Anything else is left alone, so an
//           unknown name reaches the runtime and gets the runtime's own error.
//   OUTPUT  the runtime returns WHERE it printed each address (spans). Each span is
//           resolved and its name laid out in a label or an annotation column — one
//           function, the same for every reply.

import { formatName, SymbolResolver } from "./resolver.js";
import { liveByteSource, type RuntimeCall } from "./live-bytes.js";
import type { MachineState, Resolution, ResolvedName, RuntimeSpace } from "./types.js";

// ---------------------------------------------------------------- input

export interface CommandToken {
  index: number;
  start: number;
  end: number;
  text: string;
}

const DELIMITERS = new Set([" ", "\t", ",", "(", ")", "="]);

/** Tokens of a raw command: split on whitespace , ( ) = — never inside a "quoted" run. */
export function tokenize(command: string): CommandToken[] {
  const out: CommandToken[] = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "\"") {
      // A quoted run is one opaque token (a file name, a note): never substituted.
      const close = command.indexOf("\"", i + 1);
      const end = close < 0 ? command.length : close + 1;
      out.push({ index: out.length, start: i, end, text: command.slice(i, end) });
      i = end;
      continue;
    }
    if (DELIMITERS.has(c)) { i += 1; continue; }
    let j = i;
    while (j < command.length && !DELIMITERS.has(command[j]!) && command[j] !== "\"") j += 1;
    out.push({ index: out.length, start: i, end: j, text: command.slice(i, j) });
    i = j;
  }
  return out;
}

/** A number in the monitor's own syntax: $hex, %bin, 0xhex, bare hex, decimal — optionally after `#`. */
export function isMonitorNumber(token: string): boolean {
  const t = token.startsWith("#") ? token.slice(1) : token;
  return /^\$[0-9a-f]+$/iu.test(t) || /^%[01]+$/u.test(t) || /^0x[0-9a-f]+$/iu.test(t) || /^[0-9a-f]+$/iu.test(t);
}

export interface Substitution {
  token: string;
  address: number;
  origin: string;
  payload: string | null;
}

export interface SubstituteResult {
  command: string;
  substitutions: Substitution[];
  /** names that are known but could not be substituted, and why */
  refused: Array<{ token: string; reason: string }>;
}

export async function substituteNames(
  command: string,
  resolver: SymbolResolver,
  ctx: { space: RuntimeSpace; call: RuntimeCall; sessionId?: string; machine?: MachineState },
): Promise<SubstituteResult> {
  const substitutions: Substitution[] = [];
  const refused: Array<{ token: string; reason: string }> = [];
  if (resolver.size === 0) return { command, substitutions, refused };
  const bytes = liveByteSource(ctx.call, ctx.sessionId);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const tok of tokenize(command)) {
    if (tok.index === 0 || tok.text.startsWith("\"") || isMonitorNumber(tok.text)) continue;
    const hit = await resolver.lookupName(tok.text, ctx.space, { bytes, machine: ctx.machine });
    if (!hit) continue;
    if ("ambiguous" in hit) {
      refused.push({ token: tok.text, reason: `resident at ${hit.ambiguous.map((a) => `$${a.toString(16).padStart(4, "0")}`).join(" and ")} — not substituted` });
      continue;
    }
    const text = `$${hit.address.toString(16).padStart(4, "0")}`;
    edits.push({ start: tok.start, end: tok.end, text });
    substitutions.push({ token: tok.text, address: hit.address, origin: hit.entry.origin, payload: hit.entry.payload ? (hit.entry.payload.kind === "analysis" ? hit.entry.payload.owner : hit.entry.payload.kind === "crt" ? `crt bank ${hit.entry.payload.bank}` : hit.entry.payload.path) : null });
  }
  let out = command;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { command: out, substitutions, refused };
}

// ---------------------------------------------------------------- output

/** One address the runtime printed (TRX64 `monitor/exec` `spans`, Spec 804 §3.2). */
export interface MonitorSpan {
  line: number;
  start: number;
  end: number;
  addr: number;
  space: RuntimeSpace;
  role: string;
  lens?: string;
  len?: number;
}

export interface NamedSpan extends MonitorSpan {
  name?: ResolvedName;
  inside?: ResolvedName[];
  ambiguous?: Resolution["ambiguous"];
}

/** Where a name sits in the laid-out text, and whose it is — the workbench colours these. */
export interface NameMark {
  line: number;
  start: number;
  end: number;
  origin: ResolvedName["origin"];
}

interface Note { text: string; origin: ResolvedName["origin"] }

/**
 * Lay the names out in two FIXED columns — one function for every reply, by its spans:
 *
 *   $0c37  wait_frame    a9 01     LDA #$01
 *   $0c3d                d0 fc     BNE $0c3b                 ; W0C3B
 *                wait_frames_or_fire
 *   $0c49                20 37 0c  JSR $0c37                 ; wait_frame
 *
 * LABEL column: a line whose first printed address is a single address (not a dump row's
 * range) gets a column of LABEL_WIDTH right after that address — blank where there is no
 * label; a longer label gets a line of its own above. ANNOTATION column: every other name
 * on the line (a branch target, an operand, the names inside a dump row) from
 * ANNOTATION_COLUMN on. Fixed, so paging never moves a column. The runtime's text is never
 * cut or reordered and the numeric address always stays. `tags: false` drops the
 * `[u]`/`[b]`/`[?]` tags — for a reader that shows the origin as colour (the marks).
 */
export function decorateText(
  text: string,
  spans: MonitorSpan[],
  resolutions: Resolution[],
  opts: { tags?: boolean } = {},
): { text: string; names: NamedSpan[]; marks: NameMark[] } {
  const tags = opts.tags !== false;
  const lines = text.split("\n");
  const names: NamedSpan[] = [];
  const show = (n: ResolvedName): string => formatName(tags ? n : { ...n, tag: "" });
  const firstColumn = lines.map((l) => l.length - l.trimStart().length);
  const heads = new Map<number, { end: number; label?: Note }>();
  const notes = new Map<number, Note[]>();
  const note = (line: number, n: Note): void => { notes.set(line, [...(notes.get(line) ?? []), n]); };

  spans.forEach((s, i) => {
    const range = (s.len ?? 1) > 1;
    const head = !range && !heads.has(s.line) && s.start === firstColumn[s.line];
    if (head) heads.set(s.line, { end: s.end });
    const r = resolutions[i];
    if (!r) return;
    const named: NamedSpan = { ...s };
    let hit = false;
    if (r.inside && r.inside.length > 0) {
      named.inside = r.inside;
      hit = true;
      for (const n of r.inside) {
        note(s.line, { text: `+$${n.offset.toString(16).padStart(2, "0")} ${n.name}${tags ? n.tag : ""}`, origin: n.origin });
      }
    }
    if (r.name) {
      named.name = r.name;
      hit = true;
      if (head) heads.get(s.line)!.label = { text: show(r.name), origin: r.name.origin };
      else if (!named.inside) note(s.line, { text: show(r.name), origin: r.name.origin });
    }
    if (r.ambiguous) { named.ambiguous = r.ambiguous; hit = true; }
    if (hit) names.push(named);
  });

  // Both columns are FIXED, so paging through a listing never moves them: a label wider
  // than its column gets a line of its own above the address line.
  const marks: NameMark[] = [];
  const out: string[] = [];
  lines.forEach((line, i) => {
    const h = heads.get(i);
    let l = line;
    if (h) {
      const label = h.label?.text ?? "";
      const fits = label.length <= LABEL_WIDTH;
      if (h.label && !fits) {
        const at = h.end + 2;
        marks.push({ line: out.length, start: at, end: at + label.length, origin: h.label.origin });
        out.push(`${" ".repeat(at)}${label}`);
      }
      if (h.label && fits) marks.push({ line: out.length, start: h.end + 2, end: h.end + 2 + label.length, origin: h.label.origin });
      l = `${line.slice(0, h.end)}  ${(fits ? label : "").padEnd(LABEL_WIDTH)}${line.slice(h.end)}`;
    }
    const list = notes.get(i);
    if (list && list.length > 0) {
      l = `${l.trimEnd().padEnd(ANNOTATION_COLUMN - 2)}  ; `;
      list.forEach((n, k) => {
        if (k > 0) l += ", ";
        marks.push({ line: out.length, start: l.length, end: l.length + n.text.length, origin: n.origin });
        l += n.text;
      });
    }
    out.push(l);
  });
  return { text: out.join("\n"), names, marks };
}

/** The label column's width. A longer label goes on a line of its own. */
export const LABEL_WIDTH = 12;
/** Where the annotation column starts (`; name`); a longer line pushes only its own. */
export const ANNOTATION_COLUMN = 44;

// ---------------------------------------------------------------- the whole path

export interface MonitorWithNames {
  /** the command as it reached the runtime */
  sent: string;
  substitutions: Substitution[];
  refused: SubstituteResult["refused"];
  output?: string;
  error?: string;
  prompt?: string;
  spans: MonitorSpan[];
  machine?: MachineState;
  /** the reply with the names in it, in label and annotation columns */
  text: string;
  names: NamedSpan[];
  /** where each name sits in `text` */
  marks: NameMark[];
  resolver: { names: number; graph: boolean; symbolFiles: number };
}

interface ExecReply {
  output?: string;
  error?: string;
  prompt?: string;
  spans?: MonitorSpan[];
  machine?: MachineState;
}

/** The `machine` block of a monitor reply (or `monitor/state`), typed. */
export function machineFromReply(raw: unknown): MachineState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  return {
    device: m.device === "drive8" ? "drive8" : "c64",
    cpuPortDirection: typeof m.cpuPortDirection === "number" ? m.cpuPortDirection : undefined,
    cpuPortValue: typeof m.cpuPortValue === "number" ? m.cpuPortValue : undefined,
    exrom: typeof m.exrom === "number" ? m.exrom : undefined,
    game: typeof m.game === "number" ? m.game : undefined,
    cartBank: typeof m.cartBank === "number" ? m.cartBank : null,
  };
}

/** Resolve every span of a reply and decorate its text — the same for any reply. */
export async function nameReply(
  reply: { text: string; spans: MonitorSpan[]; machine?: MachineState },
  resolver: SymbolResolver,
  bytes: ReturnType<typeof liveByteSource>,
  opts: { tags?: boolean } = {},
): Promise<{ text: string; names: NamedSpan[]; marks: NameMark[] }> {
  if (resolver.size === 0 || reply.spans.length === 0) return { text: reply.text, names: [], marks: [] };
  const resolutions = await resolver.resolve(
    reply.spans.map((s) => ({ space: s.space, addr: s.addr, lens: s.lens, len: s.len })),
    { bytes, machine: reply.machine },
  );
  return decorateText(reply.text, reply.spans, resolutions, opts);
}

/**
 * The monitor as C64RE offers it: substitute names in, run the command unchanged
 * otherwise, name the reply's addresses. `source` is passed through ("llm" from the MCP
 * tool; absent from the human's workbench).
 */
export async function execMonitorWithNames(opts: {
  call: RuntimeCall;
  sessionId?: string;
  command: string;
  projectDir?: string;
  source?: string;
  resolver?: SymbolResolver;
  /** false: no `[u]`/`[b]`/`[?]` in the text — the reader colours by `marks` instead */
  tags?: boolean;
}): Promise<MonitorWithNames> {
  const resolver = opts.resolver ?? SymbolResolver.forProject(opts.projectDir);
  const session = opts.sessionId ? { session_id: opts.sessionId } : {};
  let sub: SubstituteResult = { command: opts.command, substitutions: [], refused: [] };
  if (resolver.size > 0) {
    let machine: MachineState | undefined;
    try { machine = machineFromReply(await opts.call("monitor/state", session)); } catch { machine = undefined; }
    // A name that cannot be resolved is left as typed — substitution never blocks a command.
    try {
      sub = await substituteNames(opts.command, resolver, { space: machine?.device ?? "c64", call: opts.call, sessionId: opts.sessionId, machine });
    } catch (e) {
      sub = { command: opts.command, substitutions: [], refused: [{ token: "*", reason: `names not substituted: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
  const reply = (await opts.call("monitor/exec", { ...session, command: sub.command, ...(opts.source ? { source: opts.source } : {}) })) as ExecReply;
  const spans = Array.isArray(reply.spans) ? reply.spans : [];
  const machine = machineFromReply(reply.machine);
  const raw = reply.error !== undefined ? reply.error : (reply.output ?? "");
  // The command HAS run now. Naming its reply may fail; the reply is returned either way,
  // so no caller is tempted to run the command a second time.
  let named: { text: string; names: NamedSpan[]; marks: NameMark[] };
  try {
    named = await nameReply({ text: raw, spans, machine }, resolver, liveByteSource(opts.call, opts.sessionId), { tags: opts.tags });
  } catch {
    named = { text: raw, names: [], marks: [] };
  }
  return {
    sent: sub.command,
    substitutions: sub.substitutions,
    refused: sub.refused,
    ...(reply.output !== undefined ? { output: reply.output } : {}),
    ...(reply.error !== undefined ? { error: reply.error } : {}),
    ...(reply.prompt !== undefined ? { prompt: reply.prompt } : {}),
    spans,
    machine,
    text: named.text,
    names: named.names,
    marks: named.marks,
    resolver: { names: resolver.size, graph: resolver.layers.sources.graph, symbolFiles: resolver.layers.sources.symbolFiles.length },
  };
}
