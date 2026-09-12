// Spec 846 D2/D3 — the checks, and where severity comes from.
//
// D3 is the answer to the calibration risk the owner and I both named: a critic that
// finds nothing is worthless, and one that finds everything blocks. The tempting fix —
// judge how important each individual finding is — is a model call, arbitrary and
// unauditable. So severity is a property of the CHECK, declared once, in a table that can
// be argued with:
//
//   blocking      a downstream claim is UNSAFE while this stands
//   important     the model is weaker than it looks
//   nice-to-have  hygiene
//
// Every check must produce the record that proves it. "There is a problem" without the
// edge, the id or the number is exactly the confident assertion this whole arc exists to
// stop (Spec 833: a tool may not claim what it did not do).

export type Severity = "blocking" | "important" | "nice-to-have";

export type CheckId =
  | "negative-claim-refuted"
  | "refutation-without-casualty"
  | "finding-without-evidence"
  | "overlapping-boundaries"
  | "empty-boundary"
  | "orphan-ratio"
  | "unreachable-routine";

export interface CheckDef {
  id: CheckId;
  severity: Severity;
  /** What it finds, in one line — printed in the report header. */
  finds: string;
  /** What closes it. Becomes `settleBy:` on the open question the critic raises (D6). */
  settleBy: string;
  /** Why this severity, when that is not self-evident. */
  because?: string;
}

export const CHECKS: readonly CheckDef[] = [
  {
    id: "negative-claim-refuted",
    severity: "blocking",
    finds: "a standing claim that something is never read/written/called, which the graph contradicts",
    settleBy: "read the counter-example edge, then correct or narrow the claim and record a refutation",
    because: "Every one of Ultima VI's four false negatives cost a rebuild, and each was refutable against that project's own graph.",
  },
  {
    id: "refutation-without-casualty",
    severity: "blocking",
    finds: "a refutation that invalidated nothing — no `amends:` tag and no superseded finding",
    settleBy: "tag the refutation `amends:<what it killed>`, or archive the claim it refutes",
    because: "Ultima VI's `amended` list records which documents a refutation forced to be rewritten. A refutation with no casualty either was never acted on, or the thing it refutes is still being believed somewhere — both are the state this arc exists to prevent.",
  },
  {
    id: "finding-without-evidence",
    severity: "important",
    finds: "a finding asserting something with no evidence and no address range",
    settleBy: "attach the listing line, address range or run that establishes it, or delete it",
    because: "The cheap record. Spec 844's ratchet counts records and cannot tell this from work; this check can.",
  },
  {
    id: "overlapping-boundaries",
    severity: "important",
    finds: "two Spec 845 boundaries at the same level claiming the same bytes",
    settleBy: "narrow one boundary, or demote the inner one to `component`",
  },
  {
    id: "empty-boundary",
    severity: "important",
    finds: "a boundary asserted over a range that holds no analysed node",
    settleBy: "analyse the range, or correct the boundary — an empty container is a guess wearing a name",
  },
  {
    id: "orphan-ratio",
    severity: "important",
    finds: "most of the graph sits outside every named boundary",
    settleBy: "assert the boundaries the orphans fall into (model_assert), or say why they are outside the model",
  },
  {
    id: "unreachable-routine",
    severity: "nice-to-have",
    finds: "a routine nothing reaches and that is not an entry point",
    settleBy: "either it is dead code — record that — or code discovery missed a seed into it",
    because: "Ambiguous by nature: both readings are common and both are worth knowing, neither makes a downstream claim unsafe.",
  },
] as const;

export const CHECK_BY_ID: ReadonlyMap<CheckId, CheckDef> = new Map(CHECKS.map((c) => [c.id, c]));

export interface CriticFinding {
  check: CheckId;
  severity: Severity;
  /** One line: what is wrong, with the identifier. */
  title: string;
  /** The record that proves it — an edge, an id, a number. Never a bare assertion. */
  proof: string;
  /** What would close it, from the check definition. */
  settleBy: string;
}
