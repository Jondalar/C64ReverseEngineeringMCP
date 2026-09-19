#!/usr/bin/env node
// An MCP client shows a tool's `structuredContent` INSTEAD of its text when both are
// there, so a tool that returns both hides its own report from the model that called it.
// Learned twice: model_read/critic (2026-09-12) and runtime_monitor (2026-09-19). This
// fails when any tool handler under src/ returns a structuredContent again.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.ts$/u.test(name)) continue;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/u.test(line)) return;
      if (/structuredContent\s*:/u.test(line)) hits.push(`${relative(ROOT, p)}:${i + 1}  ${line.trim()}`);
    });
  }
};
walk(join(ROOT, "src"));
if (hits.length > 0) {
  console.log(`RED  text-only tools: ${hits.length} handler(s) return structuredContent — the client would show that instead of the text:`);
  for (const h of hits) console.log(`  ${h}`);
  process.exit(1);
}
console.log("GREEN  text-only tools: no handler returns structuredContent.");
