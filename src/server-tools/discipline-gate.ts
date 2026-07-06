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
 *  reason. Allowed only when it cites a concrete $address AND gives a real rationale. */
export function checkTraceDiscipline(hypothesis: string | undefined): TraceDisciplineResult {
  const r = isReadDerived(hypothesis);
  if (r.ok) return { allowed: true };
  return { allowed: false, refusal: traceRefusal(r.why) };
}

/** Gate any flight-to-runtime door that DISCOVERS structure/identity from the live
 *  machine or a capture (loader-lens landing map, data-flow taint, hotspot statistics,
 *  liveness map, …). Same read-derived predicate as the trace gate; the refusal is
 *  tailored to the tool's act so the redirect is concrete. */
export function checkRuntimeDiscipline(
  hypothesis: string | undefined,
  opts: { tool: string; act: string },
): TraceDisciplineResult {
  const r = isReadDerived(hypothesis);
  if (r.ok) return { allowed: true };
  return { allowed: false, refusal: runtimeRefusal(r.why, opts) };
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
