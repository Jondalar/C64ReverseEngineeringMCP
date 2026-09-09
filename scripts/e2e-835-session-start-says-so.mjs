#!/usr/bin/env node
// Spec 835 — a tool that can do a thing has to say so.
//
// `runtime_session_start` has taken a cartridge through `media_path` since
// BUG-041. Nothing said so: `media_path` had no description at all, the tool's
// own text said "C64+1541", and the only other visible parameter was called
// `disk_path`. A session that wanted to boot a CRT could not find the door.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:835
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 835 — the session tool says what it accepts\n");

const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const tools = Array.isArray(inv) ? inv : (inv.tools ?? []);
const start = tools.find((t) => t.name === "runtime_session_start");
check(start !== undefined, "runtime_session_start is in the generated tool surface");

// The description is what an agent reads first, and it is where the answer to
// "how do I boot a cartridge" has to be.
check(/\.crt|cartridge/i.test(start?.desc ?? ""), "its description names the cartridge case — the one a caller could not find");
check(/media_path/.test(start?.desc ?? ""), "…and names the parameter that takes it");

// The source is checked for the per-parameter descriptions, because the
// inventory records descriptions of TOOLS, not of their parameters.
const src = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");
const schema = src.slice(src.indexOf('"runtime_session_start"'), src.indexOf("device_id: z.number"));
check(/media_path: z\.string\(\)\.optional\(\)\.describe\(/.test(schema), "media_path carries a description, not a bare z.string()");
check(/\.crt/.test(schema) && /CARTRIDGE/.test(schema), "…which names .crt explicitly");
check(/\.c64re|snapshot/i.test(schema), "…and the snapshot case, which is the other thing nobody expects it to take");
check(/content/i.test(schema), "…and says the type comes from the file's content, so nobody looks for a per-type tool");
check(/disk_path: z\.string\(\)\.optional\(\)\.describe\(/.test(src), "the deprecated disk_path says it is an alias, since its NAME is the misleading part");

// Every parameter of this tool is described. The rule is the point: an
// undescribed parameter is invisible reach.
const paramBlock = src.slice(src.indexOf('"runtime_session_start"'), src.indexOf("trace_domains:"));
const params = [...paramBlock.matchAll(/^\s{6}([a-z_0-9]+): z\./gm)].map((m) => m[1]);
const undescribed = params.filter((name) => {
  const i = paramBlock.indexOf(`      ${name}: z.`);
  const line = paramBlock.slice(i, paramBlock.indexOf("\n", i));
  return !line.includes(".describe(");
});
check(params.length > 5, `the tool has ${params.length} parameters worth checking`);
check(undescribed.length === 0, `every one of them is described${undescribed.length ? ` — missing: ${undescribed.join(", ")}` : ""}`);

// The doc a human reads has the recipe, and the word collision that sends
// people to the wrong tool is stated where they will hit it.
const doc = readFileSync(join(ROOT, "docs/tools/headless.md"), "utf8");
check(/media_path\s*=\s*\S+\.crt/.test(doc), "docs/tools/headless.md shows the cartridge call, not just prose about it");
check(/sandbox_6502_run/.test(doc) && /CPU sandbox|CPU SANDBOX/i.test(doc), "…and says that 'sandbox' means two different things here, which is why the wrong tool gets found");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 835: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
