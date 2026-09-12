// Read-before-runtime discipline gate.
//
// Both the Accolade and Wasteland retros record the SAME failure, across months, on
// titles far harder than anything since: the LLM reaches for a broad trace / aggregate
// statistics instead of READING the code — and the human catches it every time
// ("reached for statistics instead of reading the code — you called it out every time").
// That correction currently lives in the human. This moves it into the tool.
//
// Runtime is for CONFIRMING a hypothesis you formed by reading — not for finding
// structure by fishing. So a flight-to-runtime door REFUSES unless the call cites a
// read-derived hypothesis: a concrete $address + a rationale of what was read.
//
// This is NOT a wall against runtime. A genuine purpose states a hypothesis trivially
// ("validate the extractor manifest against $C000's read-set"; "confirm $B800 stores the
// typed word"). Only a fishing expedition — which has no crisp address because nothing
// was read — is blocked. And a fabricated $address is falsifiable: the trace either
// confirms it or visibly doesn't. That falsifiability is the whole point.
//
// One door was gated first (runtime_trace_start) to feel it on a real project. Cybernoid
// (2026-07-06) proved that was not enough: the reflex walked through the gated arm on a
// plausible rationalization, then used runtime_loader_lens to "discover" a payload that
// was standard-GCR + packed = a pure static depack. The predicate is a FORM check, so it
// cannot catch the category error — but leaving the sibling doors ungated let the reflex
// pick whichever one had no gate. Tier 1 (docs/runtime-discipline-gate-plan.md) closes
// that: the SAME predicate now guards every discover-structure door, so the bar is
// uniform. Tier 2 (the substrate discriminator) is the follow-up that kills the category
// error itself.
//
// Always on (no flag). We can only learn if it lowers the human's correction load by
// actually feeling it on a real project.
//
// 2026-09-12 — Spec 844. The owner read this predicate and put his finger through it in
// one sentence: "was ist denn die Hypothese ohne die verweigert wird? doch einfach Text".
// He is right, and it was cited to him as precedent for a gate with teeth, which it is
// not: a regex for `$XXXX` plus twenty characters passes on pure invention. Two checks
// now stand behind the form check, and both are async, which is why the exported gates
// are:
//
//   • the CITATION RESOLVER (citation-resolver.ts) — the cited address must land in
//     something the project has actually read. Dormant while the project holds no
//     analysis, so it cannot brick an early phase.
//   • the ACCRUAL RATCHET (runtime-ratchet.ts) — the failure the slot list does not
//     catch: the Ultima VI session that ran runtime→build→runtime→build and had to be
//     pulled out by hand. Gated calls that leave no durable record eventually refuse.
//
// The form check stays first and unchanged: it is the cheapest, it needs no project, and
// a call that fails it never reaches the two expensive ones.

const ADDRESS_RE = /\$[0-9A-Fa-f]{2,4}\b/;

export interface TraceDisciplineResult {
  allowed: boolean;
  refusal?: string;
}

/** The shared read-derived predicate: a hypothesis passes only when it cites a concrete
 *  $address AND gives a real rationale (≥20 non-address chars of "what did you read").
 *  `why` explains the failure mode for the refusal message. */
function isReadDerived(hypothesis: string | undefined): { ok: boolean; why: string } {
  const h = (hypothesis ?? "").trim();
  const hasAddress = ADDRESS_RE.test(h);
  const hasRationale = h.replace(new RegExp(ADDRESS_RE, "g"), "").trim().length >= 20;
  if (hasAddress && hasRationale) return { ok: true, why: "" };
  const why = h.length === 0
    ? "No hypothesis was given."
    : !hasAddress
      ? "The hypothesis cites no concrete address ($XXXX)."
      : "The hypothesis has an address but no real rationale (what did you read that points there?).";
  return { ok: false, why };
}

/** Gate a broad-trace arming call. `hypothesis` = the caller's stated, read-derived
 *  reason. Allowed only when it cites a concrete $address, gives a real rationale, that
 *  citation RESOLVES against the project, and the project is still accruing records. */
export async function checkTraceDiscipline(
  hypothesis: string | undefined,
  opts: { projectDir?: string } = {},
): Promise<TraceDisciplineResult> {
  const r = isReadDerived(hypothesis);
  if (!r.ok) return { allowed: false, refusal: traceRefusal(r.why) };
  return substanceChecks(hypothesis ?? "", { tool: "trace", act: "a broad trace", ...opts });
}

/** Gate any flight-to-runtime door that DISCOVERS structure/identity from the live
 *  machine or a capture (loader-lens landing map, data-flow taint, hotspot statistics,
 *  liveness map, …). Same read-derived predicate as the trace gate; the refusal is
 *  tailored to the tool's act so the redirect is concrete. */
export async function checkRuntimeDiscipline(
  hypothesis: string | undefined,
  opts: { tool: string; act: string; projectDir?: string },
): Promise<TraceDisciplineResult> {
  const r = isReadDerived(hypothesis);
  if (!r.ok) return { allowed: false, refusal: runtimeRefusal(r.why, opts) };
  return substanceChecks(hypothesis ?? "", opts);
}

/** The two checks behind the form check. Shared so every gated door has the same bar —
 *  the lesson of Cybernoid, where the reflex simply picked the door that had no gate. */
async function substanceChecks(
  hypothesis: string,
  opts: { tool: string; act: string; projectDir?: string },
): Promise<TraceDisciplineResult> {
  const projectDir = opts.projectDir ?? currentProjectDir();

  const { resolveCitation } = await import("./citation-resolver.js");
  const cite = await resolveCitation(hypothesis, projectDir);
  if (!cite.resolved) {
    return { allowed: false, refusal: citationRefusal(cite.detail, opts) };
  }

  const { checkRatchet } = await import("./runtime-ratchet.js");
  const ratchet = await checkRatchet(opts.tool, projectDir);
  if (!ratchet.allowed) return { allowed: false, refusal: ratchet.refusal };

  return { allowed: true };
}

/** The project the gate is standing in, or undefined. Deliberately env-only and
 *  non-throwing: resolveProjectDir() walks parents and throws when it finds nothing, and
 *  a gate is the last place that may turn "no project" into an error. */
function currentProjectDir(): string | undefined {
  const env = process.env.C64RE_PROJECT_DIR?.trim();
  return env && env.length > 0 ? env : undefined;
}

function citationRefusal(detail: string, opts: { tool: string; act: string }): string {
  return [
    `# ${opts.tool} refused — the citation does not resolve.`,
    "",
    `The hypothesis has the right SHAPE, but ${detail}.`,
    "",
    "A citation is not a formality. It has to name something this project has already",
    `read, because ${opts.act} confirms a hypothesis — it does not manufacture one.`,
    "",
    "Cite one of:",
    "  • an address inside a routine, finding or entity that exists (graph_find, list_findings)",
    "  • an address the disassembly covers (disasm_prg, inspect_address_range)",
    "  • a finding or entity id directly, e.g. the one that made you suspect this",
    "",
    "If none of those exists for the region yet, that IS the answer: read it first.",
    "  • disasm_prg / the annotated listing for the region",
    "  • project_search for what is already known",
  ].join("\n");
}

function runtimeRefusal(why: string, opts: { tool: string; act: string }): string {
  return [
    `# ${opts.tool} refused — read first, then cite.`,
    "",
    `Runtime ${opts.act} CONFIRMS a hypothesis you formed by READING the code — it is not a way to find structure by fishing. ${why}`,
    "",
    "To proceed, pass `hypothesis` with:",
    "  • a concrete address you are investigating, e.g. `$C000`, and",
    "  • what you READ that points there (a routine, an annotation, a finding).",
    "",
    "If you have no address yet, you haven't read enough. Read first:",
    "  • disasm_prg / the annotated listing for the region",
    "  • inspect_address_range, project_search for what is already known",
    "  • form the hypothesis FROM the code, then use runtime to confirm it.",
    "",
    "A fished result produces data you can spin into any story. A read-derived one is falsifiable — cite $XXXX and the runtime either confirms it or visibly does not. That is the point.",
  ].join("\n");
}

function traceRefusal(why: string): string {
  return [
    "# Trace refused — read first, then cite.",
    "",
    "A broad trace is for CONFIRMING a hypothesis you formed by READING the code — not for finding structure by fishing. " + why,
    "",
    "To proceed, pass `hypothesis` with:",
    "  • a concrete address you are investigating, e.g. `$C000`, and",
    "  • what you READ that points there (a routine, an annotation, a finding).",
    "",
    "Example: hypothesis=\"$C000 should hold the manual-check result; the input routine at $B800 stores the typed word there (block2_engine_disasm.asm, JSR chain).\"",
    "",
    "If you have no address yet, you haven't read enough. Read first:",
    "  • disasm_prg / the annotated listing for the region",
    "  • inspect_address_range, project_search for what is already known",
    "  • form the hypothesis FROM the code, then trace to confirm it.",
    "",
    "A fished trace produces data you can spin into any story. A read-derived one is falsifiable — cite $XXXX and the trace either confirms it or visibly does not. That is the point.",
  ].join("\n");
}
