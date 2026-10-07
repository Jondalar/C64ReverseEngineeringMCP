// Spec 889 §5 — the pure parts of mapping the daemon's params onto the Ultimate's REST API:
// text → keyboard events for `POST /v1/machine:input` (input_api.h's key names), joystick
// state → events, and what kind of medium a file is. No I/O here.

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** One tap: the key names pressed together (`left_shift` + key for a shifted symbol). */
export type KeyTap = readonly string[];

/**
 * C64 key(s) for one character as the BASIC editor sees it in its default (upper-case /
 * graphics) mode. Letters of either case are the unshifted letter key — what one wants when
 * typing `load"*",8,1`; a shifted letter would be a graphics symbol. undefined = no key.
 */
export function keyFor(ch: string): KeyTap | undefined {
  if (ch.length !== 1) return undefined;
  const lower = ch.toLowerCase();
  if (LETTERS.includes(lower)) return [lower];
  if (ch >= "0" && ch <= "9") return [ch];
  switch (ch) {
    case " ": return ["space"];
    case "\r": case "\n": return ["return"];
    case "!": return ["left_shift", "1"];
    case "\"": return ["left_shift", "2"];
    case "#": return ["left_shift", "3"];
    case "$": return ["left_shift", "4"];
    case "%": return ["left_shift", "5"];
    case "&": return ["left_shift", "6"];
    case "'": return ["left_shift", "7"];
    case "(": return ["left_shift", "8"];
    case ")": return ["left_shift", "9"];
    case "*": return ["star"];
    case "+": return ["plus"];
    case ",": return ["comma"];
    case "-": return ["minus"];
    case ".": return ["period"];
    case "/": return ["slash"];
    case ":": return ["colon"];
    case ";": return ["semicolon"];
    case "<": return ["left_shift", "comma"];
    case ">": return ["left_shift", "period"];
    case "=": return ["equals"];
    case "?": return ["left_shift", "slash"];
    case "@": return ["at"];
    case "[": return ["left_shift", "colon"];
    case "]": return ["left_shift", "semicolon"];
    case "^": return ["arrow_up"];
    case "_": return ["arrow_left"];
    case "£": return ["pound"];
    case "\t": return undefined;
    default: return undefined;
  }
}

/** Text → taps. Returns the characters that have no key instead of dropping them silently. */
export function textToTaps(text: string): { taps: KeyTap[]; unmapped: string[] } {
  const taps: KeyTap[] = [];
  const unmapped: string[] = [];
  for (const ch of text) {
    const k = keyFor(ch);
    if (k) taps.push(k); else unmapped.push(JSON.stringify(ch));
  }
  return { taps, unmapped };
}

/** The firmware takes at most 64 events per request (`events` must hold 1..64). */
export const MAX_INPUT_EVENTS = 64;

/** Chunk taps into `POST /v1/machine:input` bodies. */
export function tapBatches(taps: readonly KeyTap[]): { events: { kind: "keyboard"; inputs: string[]; transition: "tap" }[] }[] {
  const out: { events: { kind: "keyboard"; inputs: string[]; transition: "tap" }[] }[] = [];
  for (let i = 0; i < taps.length; i += MAX_INPUT_EVENTS) {
    out.push({ events: taps.slice(i, i + MAX_INPUT_EVENTS).map((t) => ({ kind: "keyboard" as const, inputs: [...t], transition: "tap" as const })) });
  }
  return out;
}

const JOY_DIRS = ["up", "down", "left", "right", "fire"] as const;
type JoyState = { up?: boolean; down?: boolean; left?: boolean; right?: boolean; fire?: boolean };

/** `session/joystick_set` is a STATE: what is true is pressed, everything else is released. */
export function joystickEvents(port: number, state: JoyState): { kind: "joystick"; port: number; inputs: string[]; transition: "press" | "release" }[] {
  const pressed = JOY_DIRS.filter((d) => state[d]);
  const released = JOY_DIRS.filter((d) => !state[d]);
  const ev: { kind: "joystick"; port: number; inputs: string[]; transition: "press" | "release" }[] = [];
  if (released.length) ev.push({ kind: "joystick", port, inputs: [...released], transition: "release" });
  if (pressed.length) ev.push({ kind: "joystick", port, inputs: [...pressed], transition: "press" });
  return ev;
}

export type MediaKind = "crt" | "d64" | "g64" | "d71" | "g71" | "d81" | "prg" | "snapshot" | "unknown";

/** What a file is, from its CONTENT first (the daemon decides by content too), its name second. */
export function sniffMedia(bytes: Uint8Array, name: string): MediaKind {
  const head = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
  if (head.startsWith("C64 CARTRIDGE   ")) return "crt";
  if (head.startsWith("GCR-1541")) return "g64";
  if (head.startsWith("GCR-1571")) return "g71";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "c64re") return "snapshot";
  const n = bytes.length;
  if ([174848, 175531, 196608, 197376].includes(n)) return "d64";
  if (n === 349696 || n === 351062) return "d71";
  if (n === 819200) return "d81";
  if (["d64", "g64", "d71", "g71", "d81", "crt", "prg"].includes(ext)) return ext as MediaKind;
  if (n >= 2 && n < 65536 + 2 && ext !== "bin") return "prg";
  return "unknown";
}

/** The Ultimate's drive letter for a daemon unit number: 8 → a, 9 → b. */
export function driveLetter(unit: number): "a" | "b" | undefined {
  return unit === 8 ? "a" : unit === 9 ? "b" : undefined;
}
