// Read-before-trace discipline gate.
//
// Both the Accolade and Wasteland retros record the SAME failure, across months, on
// titles far harder than anything since: the LLM reaches for a broad trace / aggregate
// statistics instead of READING the code — and the human catches it every time
// ("reached for statistics instead of reading the code — you called it out every time").
// That correction currently lives in the human. This moves it into the tool.
//
// Runtime is for CONFIRMING a hypothesis you formed by reading — not for finding
// structure by fishing. So a broad-trace arm REFUSES unless the call cites a
// read-derived hypothesis: a concrete $address + a rationale of what was read.
//
// This is NOT a wall against runtime. A genuine purpose states a hypothesis trivially
// ("validate the extractor manifest against $C000's read-set"; "confirm $B800 stores the
// typed word"). Only a fishing expedition — which has no crisp address because nothing
// was read — is blocked. And a fabricated $address is falsifiable: the trace either
// confirms it or visibly doesn't. That falsifiability is the whole point.
//
// Always on (no flag). We can only learn if it lowers the human's correction load by
// actually feeling it on a real project.

const ADDRESS_RE = /\$[0-9A-Fa-f]{2,4}\b/;

export interface TraceDisciplineResult {
  allowed: boolean;
  refusal?: string;
}

/** Gate a broad-trace arming call. `hypothesis` = the caller's stated, read-derived
 *  reason. Allowed only when it cites a concrete $address AND gives a real rationale. */
export function checkTraceDiscipline(hypothesis: string | undefined): TraceDisciplineResult {
  const h = (hypothesis ?? "").trim();
  const hasAddress = ADDRESS_RE.test(h);
  const hasRationale = h.replace(new RegExp(ADDRESS_RE, "g"), "").trim().length >= 20;
  if (hasAddress && hasRationale) return { allowed: true };
  return { allowed: false, refusal: traceRefusal(h) };
}

function traceRefusal(given: string): string {
  const why = given.length === 0
    ? "No hypothesis was given."
    : !ADDRESS_RE.test(given)
      ? "The hypothesis cites no concrete address ($XXXX)."
      : "The hypothesis has an address but no real rationale (what did you read that points there?).";
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
