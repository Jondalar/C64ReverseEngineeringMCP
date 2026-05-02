#!/usr/bin/env node
// Bootstrap the UI smoke fixture: wipe generated state, init the project,
// run the PRG workflow against the committed sample PRG, and seed a few
// representative tasks / questions / checkpoints so the dashboard panels
// have content to show.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";
import { runPrgReverseWorkflow } from "../dist/lib/prg-workflow.js";

const FIXTURE = resolve(process.argv[2] ?? "fixtures/ui-smoke-project");
const PRG_REL = "input/prg/sample.prg";

function wipe(dir) {
  for (const sub of ["knowledge", "views", "analysis", "session", "artifacts"]) {
    const path = resolve(dir, sub);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(resolve(FIXTURE, PRG_REL))) {
    throw new Error(`Sample PRG missing at ${resolve(FIXTURE, PRG_REL)}`);
  }
  wipe(FIXTURE);

  const service = new ProjectKnowledgeService(FIXTURE);
  service.initProject({
    name: "UI Smoke Project",
    description: "Synthetic fixture used to validate the workspace UI.",
    tags: ["fixture", "ui-smoke"],
  });

  const result = await runPrgReverseWorkflow({
    projectRoot: FIXTURE,
    prgPath: PRG_REL,
    mode: "full",
    outputDir: "artifacts/generated",
    rebuildViews: true,
  });
  if (result.status === "blocked") {
    throw new Error(`Workflow blocked: ${JSON.stringify(result.phases.filter((p) => p.status === "blocked"), null, 2)}`);
  }

  // Seed a small number of varied open questions so the upcoming Questions
  // tab and the dashboard panel have material to display. Idempotent: ids
  // are deterministic so re-running the bootstrap updates them in place.
  const seedQuestions = [
    { id: "ui-smoke-question-1", title: "What does the busy-loop do after print?", kind: "behavior", priority: "low", confidence: 0.55 },
    { id: "ui-smoke-question-2", title: "Why is the BASIC stub padded to 14 bytes?", kind: "structure", priority: "medium", confidence: 0.4 },
    { id: "ui-smoke-question-3", title: "Could the message live in screen RAM directly?", kind: "design", priority: "medium", confidence: 0.5 },
    { id: "ui-smoke-question-4", title: "Is the JSR $FFD2 the only KERNAL touchpoint?", kind: "interface", priority: "high", confidence: 0.7 },
    { id: "ui-smoke-question-5", title: "How would a packed variant differ?", kind: "compression", priority: "low", confidence: 0.3 },
    { id: "ui-smoke-question-6", title: "Why HELLO instead of READY.?", kind: "trivia", priority: "low", confidence: 0.2, status: "deferred" },
  ];
  for (const q of seedQuestions) {
    service.saveOpenQuestion({
      id: q.id,
      kind: q.kind,
      title: q.title,
      priority: q.priority,
      confidence: q.confidence,
      status: q.status ?? "open",
    });
  }

  service.saveTask({
    id: "ui-smoke-task-1",
    kind: "review",
    title: "Add a label for the print loop",
    priority: "medium",
  });

  service.createCheckpoint({
    id: "ui-smoke-checkpoint-1",
    title: "Bootstrap baseline",
    summary: "Fixture rebuilt by scripts/bootstrap-ui-fixture.mjs.",
  });

  // Refresh views so the seeded records show up immediately.
  service.buildAllViews();

  const status = service.getProjectStatus();
  console.log("UI smoke fixture ready at:", FIXTURE);
  console.log("counts:", status.counts);
  console.log("workflow status:", result.status);
}

main().catch((error) => {
  console.error("Fixture bootstrap failed:", error);
  process.exitCode = 1;
});
