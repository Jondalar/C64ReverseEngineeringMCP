#!/usr/bin/env node
// Spec 838 D1 — an entity id is not a path.
//
// Hermetic and pure: no daemon, no media, no network. The thing under test is a
// path policy, and a path policy is exactly the code that is wrong on the
// platform you do not develop on — so the whole hostile table runs on EVERY
// host, and the rules it asserts are Windows' rules whatever `process.platform`
// says. That is the point: the platform this targets is not the platform it
// runs on.
//
// The reported defect (issue #15): `artifacts/generated/payloads/${payload.id}`
// with an id of `crazy-news-c64:ram/loader:payload:0801`. On Windows `:` is
// reserved, mkdir throws ENOENT, and `extract_disk`'s automatic L2 step never
// runs — while the extraction reports success.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:838-paths

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const {
  safeSegment, isPathSafeSegment, deviceSafeName, isDosDeviceName,
  idDirUnder, idDirIn, ensureIdDirIn, idFileUnder,
  payloadOutputDir, PAYLOAD_OUTPUT_BASE,
  WINDOWS_RESERVED_CHARS, DOS_DEVICE_NAMES,
} = await import(join(ROOT, "dist/lib/id-path.js"));

let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 838 D1 — an entity id is not a path\n");
console.log(`(running on ${process.platform}; every rule below is asserted for Windows regardless)\n`);

// --------------------------------------------------------------- the Windows rule, stated once
//
// A component a Windows filesystem accepts: printable ASCII minus the reserved
// set, not a DOS device with or without an extension, not ending in a dot or a
// space, not empty, not `.` or `..`, and short enough to live inside MAX_PATH.
const WINDOWS_LEGAL = /^[A-Za-z0-9._-]+$/u;
function windowsRejects(name) {
  if (typeof name !== "string" || name.length === 0) return "empty";
  if (!WINDOWS_LEGAL.test(name)) return `illegal character in "${name}"`;
  for (const c of WINDOWS_RESERVED_CHARS) if (name.includes(c)) return `reserved character ${c}`;
  if (name === "." || name === "..") return "a relative-path component";
  if (/[. ]$/u.test(name)) return "ends in a dot or a space";
  if (/^[.]/u.test(name)) return "leads with a dot (a hidden file the walkers skip)";
  if (/^-/u.test(name)) return "leads with a dash";
  if (isDosDeviceName(name)) return `the DOS device ${name}`;
  if (name.length > 100) return `${name.length} characters — too long to survive MAX_PATH`;
  return undefined;
}

// --------------------------------------------------------------- the hostile table
//
// Each row is an id nobody should have to think about at a call site. The rule
// is asserted, not the reported instance — that one is merely row 1.
const HOSTILE = [
  ["the reported id", "crazy-news-c64:ram/loader:payload:0801"],
  ["a second payload of the same loader", "crazy-news-c64:ram/loader:payload:1000"],
  ...WINDOWS_RESERVED_CHARS.map((c) => [`the reserved character ${c}`, `left${c}right`]),
  ...[...DOS_DEVICE_NAMES].flatMap((d) => [
    [`the device ${d} alone`, d],
    [`the device ${d.toUpperCase()} in caps`, d.toUpperCase()],
    [`the device ${d} with an extension`, `${d}.prg`],
  ]),
  ["a trailing dot", "payload."],
  ["several trailing dots", "payload..."],
  ["a trailing space", "payload "],
  ["a trailing dot and space", "payload. "],
  ["a leading dot", ".payload"],
  ["a leading dash", "-payload"],
  ["the empty id", ""],
  ["only whitespace", "   "],
  ["a lone dot", "."],
  ["a parent reference", ".."],
  ["a traversal", "../../etc/passwd"],
  ["a Windows traversal", "..\\..\\windows\\system32"],
  ["a bare drive", "c:"],
  ["a single-letter slug that reads as a drive", "c:ram/loader:routine:0801"],
  ["an NTFS alternate data stream", "payload:$DATA"],
  ["a control character", "pay\u0001load"],
  ["a tab", "pay\tload"],
  ["non-ASCII", "pöyload—0801"],
  ["a name that already ends in the disambiguator's shape", "payload-1a2b3c4d"],
  ["a 300-character id", `x${"y".repeat(299)}`],
  ["mixed case", "Payload"],
  ["all caps", "PAYLOAD"],
  ["a clean id", "payload-0801"],
];

console.log("--- 1. every hostile id maps to something a Windows filesystem accepts ---");
const results = new Map();
for (const [label, id] of HOSTILE) {
  const seg = safeSegment(id);
  results.set(id, seg);
  const why = windowsRejects(seg);
  check(why === undefined, `${label}: ${JSON.stringify(id)} → ${JSON.stringify(seg)}${why ? `  [${why}]` : ""}`);
}

console.log("\n--- 2. two different ids never share a directory ---");
const byResult = new Map();
for (const [id, seg] of results) {
  const seen = byResult.get(seg.toLowerCase());   // Windows compares case-insensitively
  if (seen !== undefined && seen !== id) fail(`collision: ${JSON.stringify(seen)} and ${JSON.stringify(id)} both → ${seg}`);
  byResult.set(seg.toLowerCase(), id);
}
check(byResult.size === results.size, `${results.size} distinct ids → ${byResult.size} distinct directories`);

// the pairs that would collide if the policy only replaced characters
const COLLIDING_PAIRS = [
  ["a colon and a slash", "loader:payload", "loader/payload"],
  ["a colon and a star", "loader:payload", "loader*payload"],
  ["two reserved characters", "a<b", "a>b"],
  ["case alone (one directory on Windows)", "Payload", "payload"],
  ["case alone, both changed", "PAYLOAD", "PayLoad"],
  ["past the length cap", `${"z".repeat(64)}-alpha`, `${"z".repeat(64)}-beta`],
  ["a device and its capitalisation", "con", "CON"],
  ["whitespace variants", "pay load", "pay\tload"],
  ["the same body, different origin", "payload.", "payload "],
];
for (const [label, a, b] of COLLIDING_PAIRS) {
  const sa = safeSegment(a), sb = safeSegment(b);
  check(sa.toLowerCase() !== sb.toLowerCase(), `${label}: ${JSON.stringify(a)}→${sa} vs ${JSON.stringify(b)}→${sb}`);
}

console.log("\n--- 3. the mapping is stable and findable again ---");
for (const [, id] of HOSTILE.slice(0, 6)) {
  check(safeSegment(id) === safeSegment(id), `the same id maps to the same directory every time (${JSON.stringify(id)})`);
}
check(safeSegment("crazy-news-c64:ram/loader:payload:0801") === safeSegment("crazy-news-c64:ram/loader:payload:0801"),
  "…including the reported one");
check(safeSegment("crazy-news-c64:ram/loader:payload:0801").startsWith("crazy-news-c64_ram_loader_payload_0801-"),
  `the sanitised body still reads as the id it came from (${safeSegment("crazy-news-c64:ram/loader:payload:0801")})`);
check(/-[0-9a-f]{8}$/u.test(safeSegment("crazy-news-c64:ram/loader:payload:0801")),
  "a changed id carries eight hex of its own hash, so the disambiguation is derivable, not invented");
check(safeSegment("payload-0801") === "payload-0801", "an id that is already safe is passed through verbatim — an existing project keeps its name");
check(isPathSafeSegment("payload-0801") && !isPathSafeSegment("payload:0801"), "isPathSafeSegment answers the same question the policy asks");
check(safeSegment("payload-1a2b3c4d") !== "payload-1a2b3c4d",
  "an id that already looks like a disambiguated one gets its own suffix, so verbatim and sanitised names cannot meet");

console.log("\n--- 4. the policy does not consult the platform it runs on ---");
const source = readFileSync(join(ROOT, "src/lib/id-path.ts"), "utf8");
check(!/process\.platform/u.test(source), "src/lib/id-path.ts never reads process.platform — one policy, the strictest one");
check(!/\bwin32\b/u.test(source.replace(/^\s*\/\/.*$/gmu, "")), "…and does not branch on a platform name outside its comments");

console.log("\n--- 5. a directory for an id, inside the project, never above it ---");
const project = mkdtempSync(join(tmpdir(), "c64re-838-"));
for (const [label, id] of HOSTILE) {
  const dir = idDirIn(project, PAYLOAD_OUTPUT_BASE, id);
  const base = resolve(project, PAYLOAD_OUTPUT_BASE);
  if (!dir.absolute.startsWith(`${base}${sep}`)) fail(`${label}: ${dir.absolute} escaped ${base}`);
}
check(true, `all ${HOSTILE.length} hostile ids resolve inside ${PAYLOAD_OUTPUT_BASE}/`);
check(idDirIn(project, PAYLOAD_OUTPUT_BASE, "../../etc/passwd").relative.startsWith(`${PAYLOAD_OUTPUT_BASE}/`),
  "a traversal id is one flat segment under the base, not an escape");
check(!idDirIn(project, PAYLOAD_OUTPUT_BASE, "crazy:ram/loader:payload:0801").relative.slice(PAYLOAD_OUTPUT_BASE.length + 1).includes("/"),
  "an id carrying a slash becomes ONE directory, not a nested pair");

console.log("\n--- 6. the mkdir that used to throw ---");
const reported = "crazy-news-c64:ram/loader:payload:0801";
let threw;
try { threw = undefined; ensureIdDirIn(project, PAYLOAD_OUTPUT_BASE, reported); } catch (e) { threw = e; }
check(threw === undefined, `ensureIdDirIn creates the directory for ${reported} without throwing`);
check(existsSync(payloadOutputDir(project, reported).absolute), "…and it is there afterwards");
for (const [label, id] of HOSTILE) {
  try { ensureIdDirIn(project, PAYLOAD_OUTPUT_BASE, id); } catch (e) { fail(`${label}: mkdir threw ${e.message}`); }
}
check(true, "every hostile id in the table is mkdir-able on this host too");

console.log("\n--- 7. a project written before Spec 838 is not orphaned ---");
const legacyProject = mkdtempSync(join(tmpdir(), "c64re-838-legacy-"));
const legacyDir = join(legacyProject, "artifacts", "generated", "payloads", "crazy-news-c64:ram", "loader:payload:0801");
mkdirSync(legacyDir, { recursive: true });
writeFileSync(join(legacyDir, "widget_analysis.json"), "{}\n");
const found = payloadOutputDir(legacyProject, reported);
check(found.legacy === true, "a pre-existing directory under the raw id is recognised as legacy");
check(resolve(found.absolute) === resolve(legacyDir), `…and read where it is (${found.relative})`);
check(existsSync(join(found.absolute, "widget_analysis.json")), "…so the analysis already written there is still the one that is found");
const freshFound = payloadOutputDir(project, reported);
check(freshFound.legacy === false && !freshFound.relative.includes(":"),
  `a project without one gets the portable name (${freshFound.relative})`);

console.log("\n--- 8. a file named after an id ---");
const filesDir = join(project, "session", "checkpoints");
mkdirSync(filesDir, { recursive: true });
const f1 = idFileUnder(filesDir, "checkpoint-loader-abc", ".json");
check(f1.name === "checkpoint-loader-abc.json" && f1.legacy === false, `a clean id keeps its file name (${f1.name})`);
const f2 = idFileUnder(filesDir, "cp:loader/1", ".json");
check(windowsRejects(f2.name.replace(/\.json$/u, "")) === undefined, `a hostile id gives a legal file name (${f2.name})`);
const f3 = idFileUnder(filesDir, "nul", ".json");
check(!isDosDeviceName(f3.name), `a device id with an extension is still not a device (${f3.name})`);
writeFileSync(join(filesDir, "weird:id.json"), "{}\n");
const f4 = idFileUnder(filesDir, "weird:id", ".json");
check(f4.legacy === true && f4.name === "weird:id.json", "a file written before Spec 838 keeps being written where it is");

console.log("\n--- 9. deviceSafeName: the narrow guard for a name the host already accepted ---");
check(deviceSafeName("Wasteland") === "Wasteland", "an ordinary image stem is untouched — no existing project directory moves");
check(deviceSafeName("Neuromancer Side A") === "Neuromancer Side A", "…spaces and all");
for (const d of DOS_DEVICE_NAMES) {
  check(!isDosDeviceName(deviceSafeName(d)) && !isDosDeviceName(deviceSafeName(`${d.toUpperCase()}.g64`)),
    `${d}: the device name is defused with and without an extension (${deviceSafeName(d)} / ${deviceSafeName(`${d.toUpperCase()}.g64`)})`);
}
check(isDosDeviceName("CON.txt") && isDosDeviceName("com1.foo.bar"), "a device is a device with ANY extension — that is the rule Windows applies");

console.log("\n--- 10. idDirUnder on an absolute base ---");
const snapRoot = join(project, "snapshots");
check(idDirUnder(snapRoot, "artifact-widget-prg-abc123").name === "artifact-widget-prg-abc123", "a minted artifact id is passed through verbatim");
check(windowsRejects(idDirUnder(snapRoot, "aj:widget:0801").name) === undefined, "a colon-carrying artifact id is not");

console.log(`\n--- report ---`);
console.log(`hostile ids exercised: ${HOSTILE.length}`);
console.log(`reported id → ${safeSegment(reported)}`);
console.log(`temp projects: ${project}, ${legacyProject}`);
console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 838 paths: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
