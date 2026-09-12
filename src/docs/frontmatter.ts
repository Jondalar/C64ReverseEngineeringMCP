// Spec 847 D2 — the declaration at the top of a document.
//
// The fields are not invented. They are what these documents already say, in prose, in
// their own first paragraph. Ultima VI's `A_overlay_model.md` opens by naming its
// coverage ($0200-$437E, 07_game.prg, 16767 bytes), its sources, and then — the part
// nobody asked for and the most valuable line in the header — its evidence standard:
// "where the rendered listing and the binary could disagree, the binary wins; all
// 'every store to X' claims come from an exhaustive opcode scan, not from grepping the
// .asm". Spec 844 made that a project-level slot (S13). At document level it is sharper.
//
// `claims: [F-3312]` was in the first draft and is gone: not one document in any project
// names a finding id. A field nobody fills is worse than no field, because it makes the
// declaration look complete.
//
// The parser is hand-written for THIS shape rather than a YAML dependency. A full YAML
// parser accepts a great deal we could not index, and would turn a typo into a silently
// different meaning; this one refuses what it does not understand and says which line.

export const DOC_KINDS = ["synthesis", "reference", "generated", "decision"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_STATUS = ["current", "superseded"] as const;
export type DocStatus = (typeof DOC_STATUS)[number];

/** One entry of `covers`: an address range, or an artifact this document explains. */
export type Coverage =
  | { kind: "range"; start: number; end: number }
  | { kind: "artifact"; ref: string };

export interface Frontmatter {
  title: string;
  kind: DocKind;
  covers: Coverage[];
  sources: string[];
  /** The evidence standard for THIS document. Optional, and the one worth pushing for. */
  method?: string;
  /** What this document corrects. Resolves to another document (847 D5). */
  amends?: string[];
  status: DocStatus;
  /** Only on `kind: generated` — what the render was made from (847 D4). */
  generated?: { at: string; counts: Record<string, number> };
}

export interface ParseResult {
  frontmatter?: Frontmatter;
  /** Populated when there is a block but it does not parse. Never a silent default. */
  error?: string;
  /** True when the file simply has no `---` block: undeclared, not malformed. */
  absent: boolean;
  /** The document body, frontmatter stripped. */
  body: string;
}

const RANGE_RE = /^\$([0-9A-Fa-f]{1,4})\s*-\s*\$?([0-9A-Fa-f]{1,4})$/;
const SINGLE_RE = /^\$([0-9A-Fa-f]{1,4})$/;

export function parseFrontmatter(text: string): ParseResult {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { absent: true, body: norm };
  const end = norm.indexOf("\n---", 3);
  if (end < 0) return { absent: false, body: norm, error: "the frontmatter block is opened with `---` but never closed" };

  const block = norm.slice(4, end);
  const body = norm.slice(end + 4).replace(/^\n+/, "");

  let raw: Record<string, unknown>;
  try { raw = parseBlock(block); } catch (e) { return { absent: false, body, error: (e as Error).message }; }

  const title = str(raw.title);
  if (!title) return { absent: false, body, error: "`title` is required" };
  const kindRaw = str(raw.kind) ?? "";
  if (!(DOC_KINDS as readonly string[]).includes(kindRaw)) {
    return { absent: false, body, error: `\`kind\` must be one of ${DOC_KINDS.join(" | ")} (got "${kindRaw}")` };
  }
  const statusRaw = str(raw.status) ?? "current";
  if (!(DOC_STATUS as readonly string[]).includes(statusRaw)) {
    return { absent: false, body, error: `\`status\` must be ${DOC_STATUS.join(" | ")} (got "${statusRaw}")` };
  }

  const covers: Coverage[] = [];
  for (const entry of list(raw.covers)) {
    const c = parseCoverage(entry);
    if (!c) {
      // The template ships with UNPARSEABLE placeholders on purpose. If `$XXXX-$YYYY`
      // parsed, a pasted-but-unedited template would silently declare a wrong address
      // range — a false declaration, which is the thing this whole arc exists to stop.
      // So it is refused, and the refusal names the placeholder rather than reading like
      // a syntax error.
      const placeholder = /^\$X+\s*-\s*\$?Y+$/i.test(entry.trim()) || /^artifact:something/i.test(entry.trim());
      return {
        absent: false, body,
        error: placeholder
          ? `\`covers\` still holds the template placeholder "${entry}" — replace it with the range or artifact this document actually explains`
          : `\`covers\` entry "${entry}" is neither $XXXX-$YYYY nor artifact:<name>`,
      };
    }
    covers.push(c);
  }

  const fm: Frontmatter = {
    title,
    kind: kindRaw as DocKind,
    covers,
    sources: list(raw.sources),
    status: statusRaw as DocStatus,
  };
  const method = str(raw.method);
  if (method) fm.method = method;
  const amends = list(raw.amends);
  if (amends.length > 0) fm.amends = amends;
  if (raw.generated && typeof raw.generated === "object") {
    const g = raw.generated as Record<string, unknown>;
    fm.generated = {
      at: str(g.at) ?? "",
      counts: Object.fromEntries(
        Object.entries(g).filter(([k, v]) => k !== "at" && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]),
      ),
    };
  }
  return { absent: false, body, frontmatter: fm };
}

export function parseCoverage(entry: string): Coverage | undefined {
  const t = entry.trim();
  if (t.startsWith("artifact:")) {
    const ref = t.slice("artifact:".length).trim();
    return ref.length > 0 ? { kind: "artifact", ref } : undefined;
  }
  const r = RANGE_RE.exec(t);
  if (r) {
    const start = parseInt(r[1], 16), end = parseInt(r[2], 16);
    return end >= start ? { kind: "range", start, end } : undefined;
  }
  const s = SINGLE_RE.exec(t);
  if (s) { const a = parseInt(s[1], 16); return { kind: "range", start: a, end: a }; }
  return undefined;
}

/** Render a block back out. Used by render_docs (D4) and by the template. */
export function renderFrontmatter(fm: Frontmatter): string {
  const lines = ["---", `title: ${fm.title}`, `kind: ${fm.kind}`];
  if (fm.covers.length > 0) {
    lines.push("covers:");
    for (const c of fm.covers) {
      lines.push(`  - ${c.kind === "range" ? `$${hex(c.start)}-$${hex(c.end)}` : `artifact:${c.ref}`}`);
    }
  }
  if (fm.sources.length > 0) lines.push(`sources: [${fm.sources.join(", ")}]`);
  if (fm.method) {
    lines.push("method: >");
    for (const l of fm.method.split("\n")) lines.push(`  ${l.trim()}`);
  }
  if (fm.amends?.length) lines.push(`amends: [${fm.amends.join(", ")}]`);
  lines.push(`status: ${fm.status}`);
  if (fm.generated) {
    lines.push("generated:");
    lines.push(`  at: ${fm.generated.at}`);
    for (const [k, v] of Object.entries(fm.generated.counts)) lines.push(`  ${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * The template a refusal hands back (847 D7).
 *
 * A gate that says "this needs frontmatter" and stops is a gate people learn to route
 * around; one that hands back the block with the fields already named is one edit away
 * from satisfied. That is the Spec 834 pattern at the file boundary.
 */
export function template(kind: DocKind, title: string): string {
  const t = [
    "---",
    `title: ${title}`,
    `kind: ${kind}`,
    "covers:",
    "  - $XXXX-$YYYY              # the address range this document explains",
    "  - artifact:something.prg   # and/or the artifact it is about",
    "sources: [what.asm, you.prg] # what you read to write it",
    "method: >",
    "  How you know. Which instrument decides when two sources disagree, and what",
    "  a negative claim here rests on. One or two sentences.",
    "status: current",
    "---",
  ];
  return t.join("\n") + "\n";
}

// ---------------------------------------------------------------- the tiny parser

function parseBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) { i++; continue; }
    if (/^\s/.test(line)) throw new Error(`unexpected indented line ${i + 1}: "${line.trim()}"`);
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`line ${i + 1} is not \`key: value\`: "${line.trim()}"`);
    const key = line.slice(0, colon).trim();
    const rest = stripComment(line.slice(colon + 1)).trim();
    i++;

    if (rest === ">" || rest === "|") {              // folded / literal block
      const buf: string[] = [];
      while (i < lines.length && (/^\s{2,}/.test(lines[i]) || lines[i].trim() === "")) {
        buf.push(lines[i].trim()); i++;
      }
      out[key] = buf.join(" ").trim();
      continue;
    }
    if (rest === "") {                               // block list, or nested map
      const items: string[] = [];
      const map: Record<string, unknown> = {};
      while (i < lines.length && /^\s{2,}/.test(lines[i])) {
        const t = stripComment(lines[i]).trim();
        i++;
        if (t === "") continue;
        if (t.startsWith("- ")) { items.push(t.slice(2).trim()); continue; }
        const c = t.indexOf(":");
        if (c < 0) throw new Error(`line ${i}: "${t}" is neither a \`- item\` nor \`key: value\``);
        map[t.slice(0, c).trim()] = t.slice(c + 1).trim();
      }
      out[key] = items.length > 0 ? items : map;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) { // inline list
      out[key] = rest.slice(1, -1).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      continue;
    }
    out[key] = unquote(rest);
  }
  return out;
}

/** `sources: [a.asm] # what you read` — strip the trailing comment, keep `#` inside quotes. */
function stripComment(s: string): string {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") quoted = !quoted;
    if (ch === "#" && !quoted && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
  const s = str(v);
  return s ? [s] : [];
}
function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
