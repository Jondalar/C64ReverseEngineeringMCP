// Spec 266 — VICE-syntax command parser for the Monitor command line.
//
// Parses a subset of VICE monitor commands into a structured ParsedCmd.
// No eval(); pure string parsing. Used by MonitorCmdLine + smoke tests.
//
// Supported commands:
//   r                       — show registers (no-arg)
//   r <reg>=<val>           — set register (e.g. r a=$42)
//   m [<start> [<end>]]     — memory dump
//   d [<addr>]              — disasm from addr
//   g <addr>                — goto (set PC)
//   z                       — step into
//   n                       — step over
//   ret                     — step out
//   until <addr>            — run until PC == addr
//   w <addr> <byte>...      — write memory bytes
//   bk <addr> [if <cond>]   — add PC breakpoint (optionally conditional)
//   watch <addr>            — add mem watchpoint
//   delete <id>             — remove breakpoint
//   disable <id>            — disable breakpoint
//   enable <id>             — enable breakpoint
//   bookmark <label>        — add trace bookmark

export type ParsedCmd =
  | { kind: "r_show" }
  | { kind: "r_set"; reg: string; value: number }
  | { kind: "m"; start: number; end?: number }
  | { kind: "d"; addr?: number; count?: number }
  | { kind: "g"; addr: number }
  | { kind: "z" }
  | { kind: "n" }
  | { kind: "ret" }
  | { kind: "until"; addr: number }
  | { kind: "w"; addr: number; bytes: number[] }
  | { kind: "bk"; addr: number; cond?: string }
  | { kind: "watch"; addr: number; mode?: "read" | "write" | "both" }
  | { kind: "delete"; id: string }
  | { kind: "disable"; id: string }
  | { kind: "enable"; id: string }
  | { kind: "bookmark"; label: string }
  | { kind: "unknown"; raw: string };

/** Parse a hex literal: $XXXX or 0xXXXX or bare-hex XXXX or decimal. */
function parseNum(s: string): number {
  const t = s.trim();
  if (t.startsWith("$")) return parseInt(t.slice(1), 16);
  if (t.startsWith("0x") || t.startsWith("0X")) return parseInt(t.slice(2), 16);
  // Bare hex: if all chars are hex digits and contains at least one a-f, treat as hex.
  if (/^[0-9a-fA-F]+$/.test(t) && /[a-fA-F]/.test(t)) return parseInt(t, 16);
  return parseInt(t, 10);
}

function isValidNum(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (t.startsWith("$")) return /^[0-9a-fA-F]+$/.test(t.slice(1));
  if (t.startsWith("0x") || t.startsWith("0X")) return /^[0-9a-fA-F]+$/.test(t.slice(2));
  // Bare hex or decimal — all hex digit chars are valid.
  return /^[0-9a-fA-F]+$/.test(t);
}

/**
 * Parse a VICE-style monitor command string into a structured object.
 * Returns `{ kind: "unknown", raw }` for unrecognised input.
 */
export function parseMonitorCmd(raw: string): ParsedCmd {
  const line = raw.trim();
  if (!line) return { kind: "unknown", raw };

  // Tokenise by whitespace, but preserve the rest for `if` conditions.
  const tokens = line.split(/\s+/);
  const cmd = tokens[0]!.toLowerCase();

  // ---- r (registers) ----
  if (cmd === "r") {
    if (tokens.length === 1) return { kind: "r_show" };
    // r <reg>=<val>  e.g. r a=$42  or r a=42
    const rest = tokens.slice(1).join(" ");
    const m = rest.match(/^([a-zA-Z]{1,2})\s*=\s*(.+)$/);
    if (m) {
      const reg = m[1]!.toLowerCase();
      const valStr = m[2]!.trim();
      if (isValidNum(valStr)) {
        return { kind: "r_set", reg, value: parseNum(valStr) };
      }
    }
    return { kind: "unknown", raw };
  }

  // ---- m <start> [<end>] ----
  if (cmd === "m") {
    if (tokens.length === 1) return { kind: "m", start: 0, end: 0xff };
    if (!isValidNum(tokens[1]!)) return { kind: "unknown", raw };
    const start = parseNum(tokens[1]!);
    if (tokens.length >= 3 && isValidNum(tokens[2]!)) {
      return { kind: "m", start, end: parseNum(tokens[2]!) };
    }
    return { kind: "m", start, end: start + 0xff };
  }

  // ---- d [<addr> [<count>]] ----
  if (cmd === "d") {
    if (tokens.length === 1) return { kind: "d" };
    if (!isValidNum(tokens[1]!)) return { kind: "unknown", raw };
    const addr = parseNum(tokens[1]!);
    const count = tokens[2] && isValidNum(tokens[2]) ? parseNum(tokens[2]) : 10;
    return { kind: "d", addr, count };
  }

  // ---- g <addr> ----
  if (cmd === "g") {
    if (!tokens[1] || !isValidNum(tokens[1])) return { kind: "unknown", raw };
    return { kind: "g", addr: parseNum(tokens[1]) };
  }

  // ---- z (step into) ----
  if (cmd === "z") return { kind: "z" };

  // ---- n (step over) ----
  if (cmd === "n") return { kind: "n" };

  // ---- ret (step out) ----
  if (cmd === "ret") return { kind: "ret" };

  // ---- until <addr> ----
  if (cmd === "until") {
    if (!tokens[1] || !isValidNum(tokens[1])) return { kind: "unknown", raw };
    return { kind: "until", addr: parseNum(tokens[1]) };
  }

  // ---- w <addr> <byte>... ----
  if (cmd === "w") {
    if (!tokens[1] || !isValidNum(tokens[1])) return { kind: "unknown", raw };
    const addr = parseNum(tokens[1]);
    const byteStrs = tokens.slice(2);
    if (byteStrs.length === 0) return { kind: "unknown", raw };
    const bytes: number[] = [];
    for (const bs of byteStrs) {
      if (!isValidNum(bs)) return { kind: "unknown", raw };
      bytes.push(parseNum(bs) & 0xff);
    }
    return { kind: "w", addr, bytes };
  }

  // ---- bk <addr> [if <cond>] ----
  if (cmd === "bk" || cmd === "break" || cmd === "b") {
    if (!tokens[1] || !isValidNum(tokens[1])) return { kind: "unknown", raw };
    const addr = parseNum(tokens[1]);
    // Check for optional `if <condition>` — everything after `if`
    const ifIdx = tokens.findIndex((t) => t.toLowerCase() === "if");
    if (ifIdx !== -1) {
      const cond = tokens.slice(ifIdx + 1).join(" ");
      return { kind: "bk", addr, cond: cond || undefined };
    }
    return { kind: "bk", addr };
  }

  // ---- watch <addr> ----
  if (cmd === "watch" || cmd === "wp") {
    if (!tokens[1] || !isValidNum(tokens[1])) return { kind: "unknown", raw };
    const addr = parseNum(tokens[1]);
    const mode: "read" | "write" | "both" =
      tokens[2]?.toLowerCase() === "r" ? "read"
      : tokens[2]?.toLowerCase() === "w" ? "write"
      : "both";
    return { kind: "watch", addr, mode };
  }

  // ---- delete / del <id> ----
  if (cmd === "delete" || cmd === "del") {
    if (!tokens[1]) return { kind: "unknown", raw };
    return { kind: "delete", id: tokens[1] };
  }

  // ---- disable <id> ----
  if (cmd === "disable") {
    if (!tokens[1]) return { kind: "unknown", raw };
    return { kind: "disable", id: tokens[1] };
  }

  // ---- enable <id> ----
  if (cmd === "enable") {
    if (!tokens[1]) return { kind: "unknown", raw };
    return { kind: "enable", id: tokens[1] };
  }

  // ---- bookmark <label> ----
  if (cmd === "bookmark") {
    const label = tokens.slice(1).join(" ");
    if (!label) return { kind: "unknown", raw };
    return { kind: "bookmark", label };
  }

  return { kind: "unknown", raw };
}
