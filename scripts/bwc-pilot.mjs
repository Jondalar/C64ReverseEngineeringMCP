#!/usr/bin/env node
// Sprint 5 BWC pilot. Run audit + dry-run repair against the BWC Reverse
// project, report state, optionally apply safe repair and the PRG workflow
// when the user passes --apply.
import { auditProject, auditProjectCached } from "../dist/project-knowledge/audit.js";
import { repairProject } from "../dist/project-knowledge/repair.js";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

const PROJECT = process.argv[2] ?? "/Users/alex/Development/C64/Cracking/BWC Reverse";
const APPLY = process.argv.includes("--apply");
const RUN_PRG = process.argv.find((arg) => arg.startsWith("--run-prg="))?.split("=")[1];

function header(title) {
  console.log("\n=== " + title + " ===");
}

async function main() {
  header("audit (cached)");
  const cached = auditProjectCached(PROJECT, { includeFileScan: true });
  console.log(`severity=${cached.audit.severity} cacheStatus=${cached.cacheStatus} cachedAt=${cached.cachedAt ?? "-"}`);
  console.log("counts:", cached.audit.counts);
  for (const finding of cached.audit.findings.slice(0, 8)) {
    console.log(`- [${finding.severity}] ${finding.title}: ${finding.suggestedFix}`);
  }

  header("audit (fresh)");
  const fresh = auditProject(PROJECT, { includeFileScan: true });
  console.log(`severity=${fresh.severity} safeRepairAvailable=${fresh.safeRepairAvailable}`);
  console.log("findings count:", fresh.findings.length);

  header("repair dry-run");
  const dryRun = repairProject(PROJECT, { mode: "dry-run" });
  console.log(`planned=${dryRun.planned.length} skipped=${dryRun.skipped.length}`);
  for (const line of dryRun.planned.slice(0, 12)) console.log("plan:", line);

  if (!APPLY) {
    console.log("\nPass --apply to run safe repair and workflow.");
  } else {
    header("repair safe");
    const safe = repairProject(PROJECT, { mode: "safe" });
    console.log(`executed=${safe.executed.length} skipped=${safe.skipped.length}`);
    for (const line of safe.executed.slice(0, 12)) console.log("exec:", line);
    if (safe.after) {
      console.log(`after severity=${safe.after.severity}`);
    }
  }

  if (RUN_PRG) {
    header(`run_prg_reverse_workflow → ${RUN_PRG}`);
    const { runPrgReverseWorkflow } = await import("../dist/lib/prg-workflow.js");
    const result = await runPrgReverseWorkflow({
      projectRoot: PROJECT,
      prgPath: RUN_PRG,
      mode: "full",
      rebuildViews: true,
    });
    console.log(`status=${result.status}`);
    for (const phase of result.phases) {
      console.log(`- [${phase.status}] ${phase.phase}${phase.reason ? " — " + phase.reason : ""}`);
    }
    console.log("imported:", result.importedCounts);
    console.log("artifacts:", result.artifactsWritten);
    console.log("next:", result.nextRequiredAction);
  }

  header("knowledge counts (after pilot)");
  const service = new ProjectKnowledgeService(PROJECT);
  const status = service.getProjectStatus();
  console.log(status.counts);
  console.log("project status:", status.project.status);
}

main().catch((error) => {
  console.error("BWC pilot failed:", error);
  process.exitCode = 1;
});
