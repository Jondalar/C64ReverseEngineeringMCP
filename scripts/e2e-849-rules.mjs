#!/usr/bin/env node
// Spec 849 — provisioning, re-sync, and the one thing that must never happen: the
// provisioner overwriting a rule the owner edited.
//
// The sync exists because `project_init` alone freezes a project's rules at the day it
// was created. That makes the provisioner a thing that WRITES into an existing project on
// every `agent_onboard`, so the hand-edit case is not a nicety — it is the reason the
// ledger holds the hash of what was SHIPPED rather than of what is on disk.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:849-rules

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectRules, shippedRulesDir, shippedRules, RULES_DIR } from "../dist/project-rules/provision.js";
import { allRules, rulesForTool, parseRule } from "../dist/project-rules/rules.js";
import { ruleFooterForTool, resetRuleDelivery } from "../dist/project-rules/deliver.js";

let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 849 — harness rule provisioning\n");

const root = mkdtempSync(join(tmpdir(), "c64re-849-"));
mkdirSync(join(root, "knowledge"), { recursive: true });

const assets = shippedRulesDir();
check(!!assets, `shipped rules found: ${assets ?? "(none)"}`);
const shipped = shippedRules(assets);

// 1 — first provisioning writes everything
const first = ensureProjectRules(root);
check(first.created.length === shipped.length, `first run wrote all ${shipped.length} rules`);
const rulesDir = join(root, RULES_DIR);
check(existsSync(join(rulesDir, ".provisioned.json")), "ledger written");
for (const f of shipped) check(existsSync(join(rulesDir, f)), `${f} present`);

// 2 — a second run is a no-op
const second = ensureProjectRules(root);
check(second.created.length === 0 && second.updated.length === 0, "second run changes nothing");
check(second.unchanged.length === shipped.length, "second run sees every rule as current");

// 3 — a hand-edited rule is never overwritten
const victim = join(rulesDir, shipped[0]);
writeFileSync(victim, "---\ndescription: mine now\npaths: [\"**/*\"]\n---\nhand written\n");
const third = ensureProjectRules(root);
check(third.handEdited.includes(shipped[0]), `hand-edited ${shipped[0]} reported as kept`);
check(readFileSync(victim, "utf8").includes("hand written"), "hand-edited content survived");

// 4 — an untouched rule whose shipped version changed IS updated
const second_ = shipped[1];
const target = join(rulesDir, second_);
const ledgerPath = join(rulesDir, ".provisioned.json");
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
// simulate "we shipped an older version": record the hash of what is on disk as shipped,
// then put different content there... no — that is the hand-edit case. Instead: pretend
// the CURRENT file is what we shipped earlier by rewriting it and recording that hash.
const older = "---\ndescription: an older shipped version of this rule, unedited by anyone.\npaths: [\"**/*.none\"]\n---\nold\n";
writeFileSync(target, older);
const { createHash } = await import("node:crypto");
ledger.shipped[second_] = createHash("sha256").update(older, "utf8").digest("hex");
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
const fourth = ensureProjectRules(root);
check(fourth.updated.includes(second_), `${second_} updated from an older shipped version`);
check(readFileSync(target, "utf8") === readFileSync(join(assets, second_), "utf8"), "updated file matches what this repo ships");
check(fourth.handEdited.includes(shipped[0]), "the hand-edit is still respected on later runs");

// 5 — deleting a rule brings it back
rmSync(join(rulesDir, shipped[2]));
const fifth = ensureProjectRules(root);
check(fifth.created.includes(shipped[2]), `deleted ${shipped[2]} restored`);

// 6 — nothing but rules and the ledger lands in the directory
const stray = readdirSync(rulesDir).filter((f) => !f.endsWith(".md") && f !== ".provisioned.json");
check(stray.length === 0, `no stray files (${stray.join(", ") || "none"})`);

// ---- delivery: the path that actually fires ---------------------------------------

// Every rule is reachable from a tool, and no tool carries two.
const byTool = new Map();
for (const r of allRules()) {
  check(r.tools.length > 0, `${r.id} names at least one trigger tool`);
  for (const t of r.tools) byTool.set(t, [...(byTool.get(t) ?? []), r.id]);
}
// Spec 866: the two disassembly doors became one, so the rules ride on `disasm`.
check(byTool.get("disasm")?.length === 2, "disasm carries both the listing and the boundary rule");

// 7 — a tool that carries a rule delivers it once, and then stays quiet
const rule = rulesForTool("analyze")[0];
check(!!rule, "analyze carries a rule");
const firstFooter = ruleFooterForTool(root, "analyze");
check(!!firstFooter && firstFooter.includes(rule.id), `first analyze call carries ${rule.id}`);
check(firstFooter.includes("The analyzer proposes"), "the footer carries the rule's prose");
check(ruleFooterForTool(root, "analyze") === undefined, "second call is silent");

// 8 — a different rule is unaffected by the first one's delivery
check(!!ruleFooterForTool(root, "propose_annotations"), "another tool still delivers its own rule");

// 8b — a tool carrying two rules delivers both at once, then nothing
// (re-armed first: step 8 already spent the boundary rule through propose_annotations,
// which is the correct behaviour — a rule is said once per session, not once per tool)
resetRuleDelivery(root);
const both = ruleFooterForTool(root, "disasm");
check(!!both && both.includes("listing-is-not-understanding"), "disasm delivers the listing rule");
check(!!both && both.includes("annotations-assert-boundaries"), "…and the boundary rule in the same footer");
check(ruleFooterForTool(root, "disasm") === undefined, "…and is then silent");

// 9 — a tool that carries no rule never speaks
check(ruleFooterForTool(root, "project_status") === undefined, "an unmapped tool adds nothing");

// 10 — onboarding re-arms everything: a session that onboards has been told nothing
resetRuleDelivery(root);
check(!!ruleFooterForTool(root, "analyze"), "agent_onboard re-arms the rule");

// 11 — a hand-edited rule is what gets delivered, not the shipped wording
resetRuleDelivery(root);
const edited = join(rulesDir, "heuristics-are-proposals.md");
writeFileSync(edited, "---\ndescription: mine.\npaths: [\"**/*\"]\ntools: [\"analyze\"]\n---\nMY OWN WORDING 4417\n");
const own = ruleFooterForTool(root, "analyze");
check(!!own && own.includes("MY OWN WORDING 4417"), "the project's own wording wins over the shipped text");

// 11b — CRLF (PR #23): a Windows checkout, or a project cloned there, changes nothing.
// Before: no rule parsed, and every CRLF project copy read as a hand-edit forever.
{
  const name = "g64-checksum-failures.md";
  const lf = readFileSync(join(assets, name), "utf8");
  const crlf = lf.replace(/\r?\n/g, "\r\n");
  const a = parseRule("x", lf), b = parseRule("x", crlf);
  check(!!b, "a CRLF rule file parses");
  check(!!a && !!b && JSON.stringify(a) === JSON.stringify(b), "…to exactly what the LF file parses to");
  check(!!b && !b.body.includes("\r"), "…with no \\r carried into the body a footer delivers");
  writeFileSync(join(rulesDir, name), crlf);
  const crlfRun = ensureProjectRules(root);
  check(crlfRun.unchanged.includes(name) && !crlfRun.handEdited.includes(name),
    "a CRLF project copy counts as current, not as a hand-edit");
}

// 12 — a directory that is not a project is left alone entirely
const notAProject = mkdtempSync(join(tmpdir(), "c64re-849-np-"));
check(ruleFooterForTool(notAProject, "analyze_prg") === undefined, "no knowledge/ means no footer");
rmSync(notAProject, { recursive: true, force: true });

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
