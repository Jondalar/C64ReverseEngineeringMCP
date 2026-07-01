// Spec 773 — smoke test for the 5-phase lifecycle crosswalk (dist build).
// Run: npm run test:lifecycle  (== build:mcp && node scripts/lifecycle-crosswalk-smoke.mjs)
import {
  LIFECYCLE_ORDER,
  LIFECYCLE_TITLES,
  lifecycleForWorkflowPhaseId,
  lifecycleForPerArtifactPhase,
  lifecycleForStep,
  recommendedLifecyclePhase,
} from "../dist/agent-orchestrator/lifecycle.js";

let failed = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) {
    failed++;
    console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

// order + titles
eq("order length", LIFECYCLE_ORDER.length, 5);
eq("order[0]", LIFECYCLE_ORDER[0], "onboarding");
eq("order[4]", LIFECYCLE_ORDER[4], "release");
eq("title re", LIFECYCLE_TITLES.re, "Reverse Engineering");

// Model D (project workflow-state phase id) -> lifecycle
eq("D workspace-init", lifecycleForWorkflowPhaseId("workspace-init"), "onboarding");
eq("D input-registration", lifecycleForWorkflowPhaseId("input-registration"), "discovery");
eq("D deterministic-extraction", lifecycleForWorkflowPhaseId("deterministic-extraction"), "discovery");
eq("D structural-enrichment", lifecycleForWorkflowPhaseId("structural-enrichment"), "re");
eq("D semantic-enrichment", lifecycleForWorkflowPhaseId("semantic-enrichment"), "re");
eq("D runtime-capture", lifecycleForWorkflowPhaseId("runtime-capture"), "re");
eq("D view-build", lifecycleForWorkflowPhaseId("view-build"), "re");
eq("D unknown", lifecycleForWorkflowPhaseId("nope"), undefined);
eq("D empty", lifecycleForWorkflowPhaseId(undefined), undefined);

// Model A (per-artifact 7-phase) -> lifecycle: 1-2 Discovery, 3-7 RE
eq("A phase 1", lifecycleForPerArtifactPhase(1), "discovery");
eq("A phase 2", lifecycleForPerArtifactPhase(2), "discovery");
eq("A phase 3", lifecycleForPerArtifactPhase(3), "re");
eq("A phase 7", lifecycleForPerArtifactPhase(7), "re");
eq("A phase 0", lifecycleForPerArtifactPhase(0), "discovery"); // <=2 → discovery (defensive)
eq("A phase null", lifecycleForPerArtifactPhase(null), undefined);

// Model C (deterministic step id) -> lifecycle
eq("C project-init", lifecycleForStep("project-init"), "onboarding");
eq("C media-extract", lifecycleForStep("media-extract"), "discovery");
eq("C cart-chunk-inspect", lifecycleForStep("cart-chunk-inspect"), "discovery");
eq("C semantic-annotate", lifecycleForStep("semantic-annotate"), "re");
eq("C change-validate", lifecycleForStep("change-validate"), "build");
eq("C ask-human (cross)", lifecycleForStep("ask-human"), undefined);

// recommended (defaults to onboarding when unknown/absent)
eq("rec view-build", recommendedLifecyclePhase("view-build"), "re");
eq("rec unknown->onboarding", recommendedLifecyclePhase("nope"), "onboarding");
eq("rec absent->onboarding", recommendedLifecyclePhase(undefined), "onboarding");

if (failed) {
  console.error(`\nlifecycle-crosswalk-smoke: ${failed} FAILED`);
  process.exit(1);
}
console.log("lifecycle-crosswalk-smoke: all assertions passed");
