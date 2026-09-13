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

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
