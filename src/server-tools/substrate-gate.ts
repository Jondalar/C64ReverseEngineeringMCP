// Tier 2 of the read-before-runtime discipline gate (docs/runtime-discipline-gate-plan.md).
//
// The FORM gate (discipline-gate.ts) forces the caller to STATE a hypothesis, but it cannot
// tell a genuinely read-derived one from a plausible rationalization — that is the category
// error that walked Cybernoid through the form gate: a "packed payload at $08D6" hypothesis
// passed, then loader_lens "discovered" a payload that was standard-GCR + packed = a pure
// STATIC depack. "packed" is not "physics-blocked".
//
// This is the SUBSTANCE check the form gate cannot do. It reads the recorded per-medium
// substrate verdict (written by inspect_disk / extract_disk from the BAM parse, or by an
// agent that read the drivecode) and:
//   - posture 'standard-gcr' (DOS/KERNAL-readable)  => REFUSE: the payload is a static depack.
//   - posture 'unknown'      (medium not characterized) => REFUSE: characterize it first.
//   - posture 'protected'    (custom-gcr/weak-bits/mixed) => ALLOW: runtime earns its place.
//
// Scope: ONLY the payload-extraction-FROM-MEDIUM doors — runtime_loader_lens and the
// drive-mechanism trace arm that captures a loader-lens trace. The general trace-analysis
// doors (taint / follow_path / profile / hotspots / …) are stage-3/6 debugging where runtime
// is legit even on a standard-GCR disk; they carry the form gate only.
//
// No project context => allow: Tier 2 is a project-RE concern; ad-hoc runtime use falls
// through to the form gate only. Never hard-block on a resolution error.

export interface SubstrateDisciplineResult {
  allowed: boolean;
  refusal?: string;
}

export async function checkSubstrateDiscipline(
  projectDir: string | undefined,
  opts: { tool: string },
): Promise<SubstrateDisciplineResult> {
  if (!projectDir) return { allowed: true };
  let posture: "unknown" | "standard-gcr" | "protected";
  try {
    const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
    posture = new ProjectKnowledgeService(projectDir).getSubstratePosture();
  } catch {
    return { allowed: true };
  }
  if (posture === "protected") return { allowed: true };
  if (posture === "unknown") return { allowed: false, refusal: characterizeFirstRefusal(opts.tool) };
  return { allowed: false, refusal: standardGcrRefusal(opts.tool) };
}

function characterizeFirstRefusal(tool: string): string {
  return [
    `# ${tool} refused — characterize the medium first.`,
    "",
    "Runtime payload-extraction is a stage-2 step that comes AFTER you establish the medium's substrate. No substrate verdict is on record for this project — so you are reaching for runtime before you even know the medium is protected.",
    "",
    "Characterize it first (this records the verdict automatically):",
    "  • inspect_disk / extract_disk — parses the DOS directory at 18/0 → standard-gcr vs custom-gcr",
    "  • read the drivecode (disasm_prg) — does it call 1541-ROM routines (standard GCR) or a custom GCR codec?",
    "",
    "If the medium is DOS-readable, the payload is a STATIC depack (sandbox_depack) — runtime is not how you extract it.",
  ].join("\n");
}

function standardGcrRefusal(tool: string): string {
  return [
    `# ${tool} refused — standard-GCR medium, this is a static depack.`,
    "",
    "The medium is recorded as standard-GCR (DOS/KERNAL-readable): its payloads are reachable statically. A packed payload on a standard-GCR disk is a DEPACK problem, not a runtime one — \"packed\" is not \"physics-blocked\".",
    "",
    "Extract it statically:",
    "  • extract_disk to get the file bytes, then sandbox_depack / try_depack / suggest_depacker",
    "",
    "Escape hatch — ONLY if this payload really lives in CUSTOM-GCR tracks that are not in the directory: read the drivecode to confirm the custom codec, then record the real substrate —",
    "  inspect_disk(image_path=…, substrate_override=\"custom-gcr\")",
    "— and retry. That override requires you to have READ the protection first. That is the point.",
  ].join("\n");
}
