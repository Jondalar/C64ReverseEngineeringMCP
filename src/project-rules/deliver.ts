// Spec 849 D5 — saying a rule once, at the moment, and not again.
//
// A rule appended to every call becomes a banner, and a banner is read once and skipped
// forever. It is delivered on the FIRST call to a tool that carries it and then kept
// quiet, because the measured behaviour is that a session which has the text keeps it:
// run 4 read all six rules at its start and their wording was still visible in slots it
// filled ninety turns later.
//
// "Once" is bounded by the session, not by the project, and `agent_onboard` is what marks
// a session's start — it is the call every session makes first, and the one a session
// makes again after a compaction. So onboarding re-arms every rule, which is exactly when
// a session has lost what it was told.
//
// The ledger is a file rather than process state because the server outlives a session
// and serves several projects at once.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRuleOverride, rulesForTool } from "./rules.js";

const LEDGER = "rules-delivered.json";

interface Delivered {
  /** rule id → ISO timestamp of the delivery that is still standing */
  delivered: Record<string, string>;
}

function ledgerPath(projectDir: string): string {
  return join(projectDir, "knowledge", LEDGER);
}

function read(projectDir: string): Delivered {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(projectDir), "utf8")) as Partial<Delivered>;
    if (raw && typeof raw.delivered === "object" && raw.delivered) {
      return { delivered: Object.fromEntries(Object.entries(raw.delivered).map(([k, v]) => [k, String(v)])) };
    }
  } catch { /* absent: nothing has been said yet */ }
  return { delivered: {} };
}

function write(projectDir: string, d: Delivered): void {
  try {
    mkdirSync(join(projectDir, "knowledge"), { recursive: true });
    writeFileSync(ledgerPath(projectDir), JSON.stringify(d, null, 2) + "\n");
  } catch { /* a ledger that cannot be written means the rule is said again; harmless */ }
}

/**
 * Re-arm every rule. Called by `agent_onboard`: a session that is onboarding is either
 * new or has just lost its context, and in both cases it has not been told anything.
 */
export function resetRuleDelivery(projectDir: string): void {
  if (!existsSync(join(projectDir, "knowledge"))) return;
  write(projectDir, { delivered: {} });
}

/**
 * The rule `toolName` owes this session, or undefined — because it carries none, because
 * it has already been said, or because this is not a project.
 *
 * A project's own `.claude/rules/<id>.md` wins over the shipped text: the provisioner
 * leaves a hand-edited rule alone, and delivering the shipped wording anyway would make
 * that promise hollow.
 */
export function ruleFooterForTool(projectDir: string | undefined, toolName: string): string | undefined {
  if (!projectDir) return undefined;
  const rules = rulesForTool(toolName);
  if (rules.length === 0) return undefined;
  if (!existsSync(join(projectDir, "knowledge"))) return undefined;

  const ledger = read(projectDir);
  const owed = rules.filter((r) => !ledger.delivered[r.id]);
  if (owed.length === 0) return undefined;

  const now = new Date().toISOString();
  for (const r of owed) ledger.delivered[r.id] = now;
  write(projectDir, ledger);

  const blocks = owed.map((rule) => [
    "---",
    `**Project rule — ${rule.id}** (said once per session; \`.claude/rules/${rule.id}.md\`)`,
    "",
    projectRuleOverride(projectDir, rule.id)?.body ?? rule.body,
  ].join("\n"));
  return ["", ...blocks].join("\n\n");
}
