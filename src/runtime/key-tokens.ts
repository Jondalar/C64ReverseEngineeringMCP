/**
 * `{F5}`, `{RETURN}`, `{CRSR DOWN}` inside the text of `runtime_type`.
 *
 * The daemon's text path (session/type) turns characters into CIA1 matrix presses and has no
 * name for the keys that print nothing. Those are pressed through its held-key verbs
 * (session/key_down / key_up), which take the matrix's own key names (the table in
 * trx64-core keyboard.rs `key_matrix`). A token is therefore a SET of matrix keys held together:
 * the keys the C64 has no key for (F2, CRSR UP, CRSR LEFT, CLR, INST) are the neighbouring key
 * plus SHIFT, exactly as on the real keyboard.
 *
 * Syntax: `{NAME}` or `{NAME+NAME}` (a combo, held together: `{C=+1}`, `{SHIFT+RETURN}`,
 * `{CTRL+3}`). Names are case-insensitive; space, `_` and `-` are interchangeable in a name.
 * An unknown name is refused (listing the known ones), never typed. A literal `{` or `}` cannot
 * be typed at all — the C64 keyboard has no such key — so there is no escape: any `{` must open
 * a token and any `}` must close one.
 */

export type TextPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "keys"; readonly keys: readonly string[]; readonly token: string };

const SHIFT = "L_SHIFT";

/** Token name → matrix keys held together. Each key is a name the daemon's key_down takes. */
const KEYS: Readonly<Record<string, readonly string[]>> = {
  RETURN: ["RETURN"], ENTER: ["RETURN"],
  "RUN STOP": ["RUN_STOP"], "RUN/STOP": ["RUN_STOP"], STOP: ["RUN_STOP"],
  HOME: ["HOME"],
  CLR: [SHIFT, "HOME"], CLEAR: [SHIFT, "HOME"], "CLR/HOME": ["HOME"],
  DEL: ["DEL"], "INST/DEL": ["DEL"],
  INST: [SHIFT, "DEL"], INSERT: [SHIFT, "DEL"],
  "CRSR DOWN": ["CRSR_DN"], "CRSR DN": ["CRSR_DN"], DOWN: ["CRSR_DN"],
  "CRSR UP": [SHIFT, "CRSR_DN"], UP: [SHIFT, "CRSR_DN"],
  "CRSR RIGHT": ["CRSR_RT"], "CRSR RT": ["CRSR_RT"], RIGHT: ["CRSR_RT"],
  "CRSR LEFT": [SHIFT, "CRSR_RT"], LEFT: [SHIFT, "CRSR_RT"],
  F1: ["F1"], F2: [SHIFT, "F1"], F3: ["F3"], F4: [SHIFT, "F3"],
  F5: ["F5"], F6: [SHIFT, "F5"], F7: ["F7"], F8: [SHIFT, "F7"],
  SPACE: ["SPACE"],
  POUND: ["POUND"], "UP ARROW": ["UP_ARROW"], "LEFT ARROW": ["LARROW"],
  // Modifiers on their own (only useful inside a combo, or to tap SHIFT / C= / CTRL by itself).
  SHIFT: [SHIFT], "L SHIFT": [SHIFT], "R SHIFT": ["R_SHIFT"],
  "C=": ["C_EQ"], CBM: ["C_EQ"], COMMODORE: ["C_EQ"], CTRL: ["CTRL"],
};

/** Names a combo may also use: a single printable key (`1`, `A`, `,`) as itself. */
const SINGLE = /^[A-Z0-9,./;:=+*@-]$/;

/** `{QUOTE}` is the scenario dialect's name for the double quote (a plain text character). */
const TEXT_TOKENS: Readonly<Record<string, string>> = { QUOTE: '"' };

const norm = (s: string): string => s.trim().replace(/[\s_-]+/g, " ").toUpperCase();

/** The names `runtime_type` refuses to guess at, for the error message. */
export function knownTokenList(): string {
  return [
    "RETURN", "RUN/STOP", "HOME", "CLR", "DEL", "INST", "CRSR UP", "CRSR DOWN", "CRSR LEFT", "CRSR RIGHT",
    "F1-F8", "SPACE", "QUOTE", "SHIFT", "C=", "CTRL", "POUND", "UP ARROW", "LEFT ARROW",
    "combos with + such as {SHIFT+RETURN} / {C=+1} / {CTRL+3}",
  ].join(", ");
}

/**
 * Split `text` into plain-text runs and key tokens. Returns an error string (naming the
 * offending token and the known ones) instead of ever typing a `{…}` literally.
 */
export function parseTypedText(text: string): { parts: TextPart[] } | { error: string } {
  const parts: TextPart[] = [];
  let run = "";
  const flush = () => { if (run) { parts.push({ kind: "text", text: run }); run = ""; } };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "}") return { error: `stray "}" at character ${i + 1}: a token is {NAME}; the C64 keyboard has no brace keys. Known tokens: ${knownTokenList()}.` };
    if (ch !== "{") { run += ch; continue; }
    const end = text.indexOf("}", i + 1);
    if (end < 0) return { error: `unclosed "{" at character ${i + 1}: a token is {NAME}. Known tokens: ${knownTokenList()}.` };
    const body = text.slice(i + 1, end);
    const name = norm(body);
    if (TEXT_TOKENS[name] !== undefined) { run += TEXT_TOKENS[name]; i = end; continue; }
    const keys = resolveCombo(body);
    if (!keys) return { error: `unknown key token {${body}}. Known tokens: ${knownTokenList()}. (RESTORE is not on the matrix and cannot be pressed.)` };
    flush();
    parts.push({ kind: "keys", keys, token: `{${body}}` });
    i = end;
  }
  flush();
  return { parts };
}

function resolveCombo(body: string): string[] | null {
  const out: string[] = [];
  // "+" itself is a key; only split on a "+" that has something on both sides.
  const names = body.length > 1 ? body.split(/(?<=.)\+(?=.)/) : [body];
  for (const raw of names) {
    const n = norm(raw);
    const k = KEYS[n] ?? (names.length > 1 && SINGLE.test(n) ? [n] : undefined);
    if (!k) return null;
    for (const key of k) if (!out.includes(key)) out.push(key);
  }
  return out.length ? out : null;
}

export function hasKeyTokens(parts: readonly TextPart[]): boolean {
  return parts.some((p) => p.kind === "keys");
}
