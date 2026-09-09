#!/usr/bin/env node
// Spec 836 D1/D2 — an attach never changes the shared machine's medium, and
// every runtime tool says whose machine it is.
//
// Hermetic: reads the source and the generated tool surface. The defect is a
// WRITE to a machine somebody else is using, so the gate must not need that
// machine to exist in order to check it.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:836-attach
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 836 — whose machine is this\n");

const src = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");

// D1 — the write that should never have been unconditional.
check(/if \(absMedia && !r\.attached\)/.test(src), "media/open runs only when the session was CREATED, never on an attach");
check(!/^\s*if \(absMedia\) \{$/m.test(src), "…and the unconditional form is gone — that form swapped the medium under the human");
check(/refusedLine/.test(src), "an attach with a media_path answers with a refusal rather than silently ignoring it");
check(/runtime_media_mount/.test(src), "…and names the door for a DELIBERATE swap of the shared medium");
check(/runtime_scene_reel/.test(src), "…and the door for running your own medium on your own machine");
// A message that names a tool is a promise that the tool exists. This one
// named runtime_sandbox_run before it was built — the same defect the spec is
// about, committed inside the fix for it.
const invNames = new Set((JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8")).tools ?? []).map((t) => t.name));
// Comments quote retired and neighbouring tool names on purpose — the same
// trap Spec 830's gate hit — so strip them before looking at what a CALLER
// would be told.
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
const named = [...codeOnly.matchAll(/`[^`]*?\b(runtime_[a-z_0-9]+)\b[^`]*?`/g)].map((m) => m[1]);
const missing = [...new Set(named)].filter((n) => !invNames.has(n));
check(missing.length === 0, `every runtime tool named in a message to the caller exists${missing.length ? ` — missing: ${missing.join(", ")}` : ` (${new Set(named).size} named)`}`);

// D2 — whose machine, said where a caller reads it.
const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const tools = Array.isArray(inv) ? inv : (inv.tools ?? []);
const desc = (name) => tools.find((t) => t.name === name)?.desc ?? "";

check(/SHARED/.test(desc("runtime_session_start")), "runtime_session_start says it is the SHARED machine");
check(/co-drive|co-driven|human/i.test(desc("runtime_session_start")), "…that a human co-drives it");
check(/runtime_sandbox_run|runtime_scene_reel/.test(desc("runtime_session_start")), "…and where to go for a machine of your own");
check(/own|private/i.test(desc("runtime_scene_reel")), "runtime_scene_reel says its machine is private");
check(/budget/i.test(desc("runtime_scene_reel")), "…and that it ends on a budget, which is what makes it safe to start one");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 836 attach: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
