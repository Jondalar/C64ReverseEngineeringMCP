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
//           resolved and the name inserted at it — one function, the same for every reply.

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

/**
 * Insert names at the spans. A point span gets ` <name[o]>` right after the printed
 * address; a range span (a dump row) gets its names appended at the line's end, so a
 * grid of bytes never moves. The numeric address is never replaced.
 */
export function decorateText(text: string, spans: MonitorSpan[], resolutions: Resolution[]): { text: string; names: NamedSpan[] } {
  const lines = text.split("\n");
  const names: NamedSpan[] = [];
  const perLine = new Map<number, Array<{ at: number; insert: string }>>();
  const tails = new Map<number, string[]>();
  spans.forEach((s, i) => {
    const r = resolutions[i];
    if (!r) return;
    const named: NamedSpan = { ...s };
    let hit = false;
    if (r.name) {
      named.name = r.name;
      hit = true;
      const list = perLine.get(s.line) ?? [];
      list.push({ at: s.end, insert: ` <${formatName(r.name)}>` });
      perLine.set(s.line, list);
    }
    if (r.inside && r.inside.length > 0) {
      named.inside = r.inside;
      hit = true;
      const tail = tails.get(s.line) ?? [];
      for (const n of r.inside) tail.push(`+$${n.offset.toString(16).padStart(2, "0")} ${n.name}${n.tag}`);
      tails.set(s.line, tail);
    }
    if (r.ambiguous) { named.ambiguous = r.ambiguous; hit = true; }
    if (hit) names.push(named);
  });
  const out = lines.map((line, i) => {
    let l = line;
    for (const e of (perLine.get(i) ?? []).sort((a, b) => b.at - a.at)) l = l.slice(0, e.at) + e.insert + l.slice(e.at);
    const tail = tails.get(i);
    if (tail && tail.length > 0) l = `${l}  ; ${tail.join("  ")}`;
    return l;
  });
  return { text: out.join("\n"), names };
}

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
  /** the reply with the names in it */
  text: string;
  names: NamedSpan[];
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
): Promise<{ text: string; names: NamedSpan[] }> {
  if (resolver.size === 0 || reply.spans.length === 0) return { text: reply.text, names: [] };
  const resolutions = await resolver.resolve(
    reply.spans.map((s) => ({ space: s.space, addr: s.addr, lens: s.lens, len: s.len })),
    { bytes, machine: reply.machine },
  );
  return decorateText(reply.text, reply.spans, resolutions);
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
  let named: { text: string; names: NamedSpan[] };
  try {
    named = await nameReply({ text: raw, spans, machine }, resolver, liveByteSource(opts.call, opts.sessionId));
  } catch {
    named = { text: raw, names: [] };
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
    resolver: { names: resolver.size, graph: resolver.layers.sources.graph, symbolFiles: resolver.layers.sources.symbolFiles.length },
  };
}
