#!/usr/bin/env node
// Spec 839 D7/D8/D9 — what the human can do, the LLM can do.
//
// Issue #18: a cartridge cannot be ejected. Not because the daemon lacks the op —
// it has taken role "cartridge", slot 0 and "auto" since the UI needed them — but
// because the ONE tool that pulls media demanded a drive number, and a cartridge
// has none. The refusal lived in this repo, in one line.
//
// Hermetic: reads the source and the generated tool surface. The defect is a guard
// and a sentence, and both are readable without a machine.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:839-media
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 839 — the media door, and the tools that lied\n");

const runtimeSrc = readFileSync(join(ROOT, "src/server-tools/runtime.ts"), "utf8");
const headlessSrc = readFileSync(join(ROOT, "src/server-tools/headless.ts"), "utf8");
const clientSrc = readFileSync(join(ROOT, "src/runtime/daemon-client.ts"), "utf8");
const inv = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const tools = Array.isArray(inv) ? inv : (inv.tools ?? []);
const desc = (name) => tools.find((t) => t.name === name)?.desc ?? "";
const names = new Set(tools.map((t) => t.name));

// ── D7 — the cartridge comes out ───────────────────────────────────────────────
const unmount = runtimeSrc.slice(
  runtimeSrc.indexOf('"runtime_media_unmount",'),
  runtimeSrc.indexOf('"runtime_media_persist",'),
);
check(/role: z\.enum\(\["drive8", "cartridge", "auto"\]\)/.test(unmount),
  "runtime_media_unmount takes a role — drive8, cartridge or auto");
check(/if \(role === "drive8"\) \{/.test(unmount),
  "…and the 8-or-9 slot guard applies only to the DRIVE (a cartridge has no drive number)");
check(!/kind: "eject", role: "drive8" \}/.test(unmount),
  "…and no longer hard-codes drive8 into the ingress call");
check(/kind: "eject", role \}/.test(unmount),
  "…it passes the caller's role through to the one media op");
check(/role\?: "drive8" \| "cartridge" \| "auto"/.test(clientSrc),
  "the daemon client can express `auto` — the daemon has resolved it under its own lock since CLI-FEEL S7");

// The description is the only place a caller learns what a cartridge eject DOES,
// and it is not the same act as a disk eject.
const ud = desc("runtime_media_unmount");
check(/cartridge/i.test(ud), "its description mentions the cartridge at all (it never did)");
check(/COLD-RESET|cold-reset/i.test(ud), "…and says pulling a cart cold-resets the machine");
check(/runtime_media_persist/.test(ud), "…and points at the tool that saves flash WITHOUT pulling the cart");
check(/auto/.test(ud), "…and explains what auto targets");
check(/drive keeps running/i.test(ud), "…and that a DISK eject, by contrast, leaves the drive turning");

// ── D8 — a tool may not claim what it does not do (Spec 833) ───────────────────
const status = headlessSrc.slice(
  headlessSrc.indexOf('"runtime_session_status",'),
  headlessSrc.indexOf('"runtime_session_close",'),
);
check(/driveStatus\(/.test(status) && /cartStatus\(/.test(status),
  "runtime_session_status actually fetches the drive and the cartridge");
check(/Drive 8: /.test(status) && /Cartridge: /.test(status),
  "…and renders both into its answer");
check(/catch \(e\)/.test(status),
  "…softly: a failed status call must not take the CPU line down with it");
const sd = desc("runtime_session_status");
check(!/both CPUs/.test(sd),
  "…and it no longer claims 'both CPUs' while returning one");
check(/device drive8/.test(sd),
  "…it names where the 1541's own registers actually are");
check(/driveStatus/.test(clientSrc) && /cartStatus/.test(clientSrc),
  "the daemon client has the two status calls the UI has always had");

// ── D9 — invisible reach is no reach (Spec 835) ────────────────────────────────
const md = desc("runtime_monitor");
for (const verb of ["reset", "power on|off", "warp", "turbo", "whowrote", "triage", "rstep", "mark", "goto", "identify"]) {
  check(md.includes(verb), `runtime_monitor names \`${verb}\` — reachable and, until now, unmentioned`);
}
for (const verb of ["mount <path>", "eject [cart|disk]", "drive", "cart", "drivepower", "recent", "tracering"]) {
  check(md.includes(verb), `runtime_monitor names the forwarded verb \`${verb}\``);
}

// ── D10 — the rest of the Visual-Origin Join ───────────────────────────────────
for (const t of ["runtime_vic_inspect_region", "runtime_vic_origin"]) {
  check(names.has(t), `${t} exists and is in the tool surface`);
  // A tool is HIDDEN until it is in DEFAULT_TOOLS — three separate bugs in one day
  // once came from exactly that, which is why it is checked and not assumed.
  check(readFileSync(join(ROOT, "src/server-tools/tier-tools.ts"), "utf8").includes(`"${t}"`),
    `…and is in DEFAULT_TOOLS, so a client can find it`);
}
// The two coordinate frames are a real trap: at_capture takes DISPLAY pixels,
// region/origin take VISIBLE-frame pixels including the border.
check(/0\.\.384/.test(desc("runtime_vic_inspect_region")) && /border/.test(desc("runtime_vic_inspect_region")),
  "runtime_vic_inspect_region says which coordinate frame it takes");
check(/0\.\.384/.test(desc("runtime_vic_origin")) && /NOT the display frame/.test(desc("runtime_vic_origin")),
  "runtime_vic_origin says its frame is NOT the one runtime_vic_inspect_at uses");
check(/runtime_generated/.test(desc("runtime_vic_origin")),
  "…and that an empty match with nothing mounted is an honest answer, not a failure");

// Every parameter described (Spec 835). These are new tools; there is no excuse.
// The inventory does not carry parameters, so this reads the schema literal out of
// the source — the same place the MCP client reads it from.
const schemaOf = (src, tool) => {
  const at = src.indexOf(`"${tool}",`);
  if (at < 0) return null;
  const open = src.indexOf("\n    {", at);
  const close = src.indexOf("\n    },", open);
  return open < 0 || close < 0 ? null : src.slice(open, close);
};
for (const [tool, src] of [
  ["runtime_vic_inspect_region", runtimeSrc],
  ["runtime_vic_origin", runtimeSrc],
  ["runtime_media_unmount", runtimeSrc],
]) {
  const schema = schemaOf(src, tool);
  const lines = (schema ?? "").split("\n").filter((l) => /^\s+[a-z_]+: z\./.test(l));
  const bare = lines.filter((l) => !l.includes(".describe(")).map((l) => l.trim().split(":")[0]);
  check(lines.length > 0 && bare.length === 0,
    `${tool}: every parameter is described${bare.length ? ` — bare: ${bare.join(", ")}` : ` (${lines.length})`}`);
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 839 media: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
