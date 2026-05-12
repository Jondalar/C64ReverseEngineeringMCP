#!/usr/bin/env node
// One-shot transform: wrap every server.tool(...) handler in safeHandler(name, ...).
// Idempotent: skips already-wrapped registrations.
//
// Pattern matched (multiline):
//   server.tool(
//     "<name>",
//     "<desc>" or `desc`,
//     { schema } | schemaIdent,
//     <handler>
//   )
//
// We don't fully parse — we walk the file, find each `server.tool(` opener,
// then locate the start of the 4th arg (the handler). The handler always
// begins with `async ` or `async(` per project convention. We also stop if
// the next non-trivia token is already `safeHandler(` — then skip.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = process.argv.slice(2);
if (FILES.length === 0) {
  console.error("usage: wrap-safehandler.mjs <file...>");
  process.exit(2);
}

function ensureImport(src) {
  if (src.includes("safe-handler")) return src;
  // Find the last line that ends an import statement. Imports may span
  // multiple lines (`import {\n  a,\n  b,\n} from "...";`). The closing line
  // ends with `from "...";` (single or double quote) or `from '...';`.
  const lines = src.split("\n");
  let lastImportEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (/from\s+["'][^"']+["'];?\s*$/.test(trimmed) || /^import\s+["'][^"']+["'];?\s*$/.test(trimmed)) {
      lastImportEnd = i;
    }
  }
  if (lastImportEnd < 0) {
    // No import found — prepend.
    return `import { safeHandler } from "./safe-handler.js";\n${src}`;
  }
  // Determine the relative path to safe-handler.js from this file.
  // Caller passes file paths; we don't know absolute here. Default to "./safe-handler.js"
  // and patch to "../server-tools/safe-handler.js" externally if needed.
  lines.splice(lastImportEnd + 1, 0, `import { safeHandler } from "${SAFE_HANDLER_IMPORT}";`);
  return lines.join("\n");
}

let SAFE_HANDLER_IMPORT = "./safe-handler.js";

// Find "    server.tool(" and process each
function transform(src) {
  src = ensureImport(src);
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  let wraps = 0;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)server\.tool\(\s*$/);
    if (!m) { out.push(line); i++; continue; }

    // Capture the registration block
    const indent = m[1];
    out.push(line); i++;

    // Next line: tool name as quoted string
    const nameLine = lines[i];
    const nm = nameLine.match(/^\s*"([^"]+)"\s*,\s*$/);
    if (!nm) { out.push(nameLine); i++; continue; }
    out.push(nameLine); i++;
    const toolName = nm[1];

    // Now scan forward, copying lines, until we hit the handler arg start.
    // The handler line begins with `<spaces>async ` or `<spaces>async(`.
    // We must match brace/paren depth in case the schema arg contains nested ().
    // Strategy: copy lines verbatim until we hit, at the *outer* arg level,
    // a line that begins (after leading whitespace) with `async ` or `async(`
    // OR `safeHandler(`.

    // Track paren depth from line text. Start with 1 (we already consumed the opening `server.tool(`).
    // Track depth from name line going forward — but name line is just `"...",` so depth stays at 1.
    let depth = 1;
    // Already counted `server.tool(` (open). Name line has no parens of consequence.
    // Walk lines, counting unbalanced parens (ignoring strings/comments — naive).

    function countParens(s) {
      let inStr = null; let escape = false; let open = 0; let close = 0;
      for (let k = 0; k < s.length; k++) {
        const c = s[k];
        if (escape) { escape = false; continue; }
        if (inStr) {
          if (c === "\\") { escape = true; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
        if (c === "/" && s[k+1] === "/") break; // line comment
        if (c === "(") open++;
        else if (c === ")") close++;
      }
      return [open, close];
    }

    const [no, nc] = countParens(nameLine);
    depth += no - nc;

    // Scan until we find handler line at depth === 1 (only the outer server.tool( still open).
    let handlerLineIdx = -1;
    let scanI = i;
    while (scanI < lines.length) {
      const cur = lines[scanI];
      const trimmed = cur.replace(/^\s+/, "");
      if (depth === 1 && (trimmed.startsWith("async ") || trimmed.startsWith("async(") || trimmed.startsWith("safeHandler("))) {
        handlerLineIdx = scanI;
        break;
      }
      const [oo, cc] = countParens(cur);
      depth += oo - cc;
      // If depth dropped to 0 we've left the server.tool call without finding a handler — abort.
      if (depth <= 0) { handlerLineIdx = -2; break; }
      scanI++;
    }

    if (handlerLineIdx < 0) {
      // Couldn't find handler — copy rest as-is from i and continue.
      while (i < lines.length && i <= scanI) { out.push(lines[i]); i++; }
      continue;
    }

    // Copy intermediate lines verbatim.
    while (i < handlerLineIdx) { out.push(lines[i]); i++; }

    // Now i === handlerLineIdx, lines[i] is the handler-start line.
    const handlerLine = lines[i];
    const trimmed = handlerLine.replace(/^\s+/, "");
    if (trimmed.startsWith("safeHandler(")) {
      // Already wrapped, skip.
      out.push(handlerLine); i++;
      continue;
    }

    // Find handler indent
    const hIndentMatch = handlerLine.match(/^(\s*)/);
    const hIndent = hIndentMatch ? hIndentMatch[1] : "";

    // Locate the matching close-paren of the handler. We need to find where the
    // server.tool call closes, then insert ")" before that close paren.
    //
    // Walk from handlerLine onward, counting parens. Depth is currently 1
    // (server.tool open). Add the parens of handlerLine and onwards; when depth
    // returns to 0 we've found the server.tool closer.

    // Reset depth at handler line: we know depth coming in is 1 (only server.tool open).
    depth = 1;
    let closerLineIdx = -1;
    let closerCharIdx = -1;
    for (let k = i; k < lines.length; k++) {
      const cur = lines[k];
      // Count parens char by char to find the exact position of the closer
      let inStr = null; let escape = false;
      for (let p = 0; p < cur.length; p++) {
        const c = cur[p];
        if (escape) { escape = false; continue; }
        if (inStr) {
          if (c === "\\") { escape = true; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
        if (c === "/" && cur[p+1] === "/") break;
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) { closerLineIdx = k; closerCharIdx = p; break; }
        }
      }
      if (closerLineIdx >= 0) break;
    }

    if (closerLineIdx < 0) {
      // Couldn't find closer. Bail.
      out.push(handlerLine); i++;
      continue;
    }

    // Wrap: replace handlerLine's `async` token with `safeHandler("name", async`,
    // and insert `)` before the server.tool closer.
    const wrappedHandler = handlerLine.replace(/^(\s*)(async)/, `$1safeHandler("${toolName}", $2`);
    out.push(wrappedHandler); i++;

    // Copy intermediate lines until closerLineIdx.
    while (i < closerLineIdx) { out.push(lines[i]); i++; }

    // closerLine: insert ")" before position closerCharIdx.
    const closerLine = lines[closerLineIdx];
    const before = closerLine.slice(0, closerCharIdx);
    const after = closerLine.slice(closerCharIdx);
    // Trim trailing whitespace from before, then add ')'.
    const newCloser = `${before.trimEnd()})${after}`;
    out.push(newCloser);
    i = closerLineIdx + 1;
    wraps++;
  }

  return { src: out.join("\n"), wraps };
}

let total = 0;
for (const file of FILES) {
  const abs = resolve(file);
  // Pick correct relative import path: server-tools/* vs project-knowledge/*
  if (abs.includes("/project-knowledge/")) {
    SAFE_HANDLER_IMPORT = "../server-tools/safe-handler.js";
  } else {
    SAFE_HANDLER_IMPORT = "./safe-handler.js";
  }
  const src = readFileSync(abs, "utf8");
  const { src: out, wraps } = transform(src);
  if (wraps > 0 || out !== src) {
    writeFileSync(abs, out);
    console.log(`${file}: wrapped ${wraps}`);
    total += wraps;
  } else {
    console.log(`${file}: nothing to wrap`);
  }
}
console.log(`total wraps: ${total}`);
