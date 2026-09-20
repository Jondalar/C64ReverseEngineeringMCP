// A document demand, resolved — Spec 848's `deliver.documents`, checked.
//
// The demand is written at kickoff, in whatever vocabulary the human has then. Three
// vocabularies turn up, and until now only one of them could ever be satisfied:
//
//   * an ADDRESS RANGE — `$4300-$73FC`. Checked against the ranges a document declares.
//   * a ROLE — "the loader". Resolved through the Spec 845 model: the boundary carrying
//     that name gives the range, and a document overlapping it satisfies the demand.
//   * a MEDIUM or a file — `artifact:CRAZY1.D64`. This one had no path at all. It fell
//     into the role branch, matched no boundary, and answered "no model boundary is
//     named for it yet (model_assert)" — advice that cannot be followed, because a whole
//     D64 has no address range to assert and the document that covers it correctly
//     declares `covers: artifact:CRAZY1.D64`. The run that hit this restated its own
//     deliverable as `$0200-$FFFE` purely to make the check pass: a false declaration,
//     produced by the checker.
//
// A document about a whole medium is a real deliverable. It is satisfiable as one here.

import { basename } from "node:path";
import type { Coverage } from "../docs/frontmatter.js";

export interface DemandRange { start: number; end: number }

/** A boundary from the Spec 845 model — only the fields this check reads. */
export interface DemandBoundary { name: string; start: number; end: number }

/** A registered artifact — only the fields this check reads. */
export interface DemandArtifact {
  id: string;
  title?: string;
  path?: string;
  relativePath?: string;
  addressRange?: { start: number; end: number };
}

export type ResolvedDemand =
  | { kind: "range"; label: string; ranges: DemandRange[] }
  | { kind: "role"; label: string; ranges: DemandRange[]; via: string }
  | { kind: "artifact"; label: string; display: string; names: Set<string>; ranges: DemandRange[]; via?: string }
  | { kind: "unresolved"; label: string };

const RANGE_RE = /^\$?([0-9a-fA-F]{1,4})\s*-\s*\$?([0-9a-fA-F]{1,4})$/;

/** `artifact:Foo.D64`, `analysis/disk/Foo.D64` and `Foo.D64` are the same thing named
 *  three ways. Compared on these normal forms, never by substring: a substring rule on
 *  one-letter disk-file names ("a", "i", "p") matches everything. */
export function artifactNameForms(ref: string): Set<string> {
  const n = ref.trim().toLowerCase().replace(/^artifact:/, "");
  if (!n) return new Set();
  return new Set([n, basename(n)].filter(Boolean));
}

function shareAName(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Every spelling by which this artifact may be named in a `covers:` line. */
function namesOf(artifact: DemandArtifact): Set<string> {
  const out = new Set<string>();
  for (const candidate of [artifact.id, artifact.title, artifact.relativePath, artifact.path]) {
    if (!candidate) continue;
    for (const form of artifactNameForms(candidate)) out.add(form);
  }
  return out;
}

export function resolveDocumentDemand(
  covers: string,
  ctx: { boundaries: readonly DemandBoundary[]; artifacts: readonly DemandArtifact[] },
): ResolvedDemand {
  const want = covers.trim();
  const range = RANGE_RE.exec(want);
  if (range) {
    return { kind: "range", label: want, ranges: [{ start: parseInt(range[1]!, 16), end: parseInt(range[2]!, 16) }] };
  }

  const explicitArtifact = /^artifact:/i.test(want);
  const wantForms = artifactNameForms(want);

  // An explicit `artifact:` prefix is the human saying which vocabulary this is, so it
  // is not second-guessed against the model.
  if (!explicitArtifact) {
    const ranges: DemandRange[] = [];
    let via = "";
    for (const b of ctx.boundaries) {
      if (!b.name.toLowerCase().includes(want.toLowerCase())) continue;
      ranges.push({ start: b.start, end: b.end });
      via = via ? `${via}, "${b.name}"` : `"${b.name}"`;
    }
    if (ranges.length > 0) return { kind: "role", label: want, ranges, via };
  }

  const hit = ctx.artifacts.find((a) => shareAName(wantForms, namesOf(a)));
  if (hit) {
    const names = new Set([...wantForms, ...namesOf(hit)]);
    return {
      kind: "artifact",
      label: want,
      // The spelling a human would write on a `covers:` line, with its own case.
      display: hit.title || hit.relativePath || want.replace(/^artifact:/i, ""),
      names,
      ranges: hit.addressRange ? [hit.addressRange] : [],
      via: hit.id !== want ? hit.id : undefined,
    };
  }
  if (explicitArtifact) {
    // Named as an artifact but not registered. Still an artifact demand: a document may
    // declare it before the medium is registered, and refusing on registration order
    // would be the same dead end in a different place.
    return { kind: "artifact", label: want, display: want.replace(/^artifact:/i, ""), names: wantForms, ranges: [] };
  }
  return { kind: "unresolved", label: want };
}

/** Does any declared document cover what this demand asks for? */
export function demandSatisfiedBy(demand: ResolvedDemand, declared: ReadonlyArray<{ covers: readonly Coverage[] }>): boolean {
  if (demand.kind === "unresolved") return false;
  const wantNames = demand.kind === "artifact" ? demand.names : artifactNameForms(demand.label);
  return declared.some((doc) => doc.covers.some((c) => {
    if (c.kind === "artifact") return shareAName(wantNames, artifactNameForms(c.ref));
    // Overlap, not containment: a document about the loader need not cover the boundary
    // to the byte, and demanding that would fail on a range the session refined.
    return demand.ranges.some((w) => c.start <= w.end && w.start <= c.end);
  }));
}

/** The blocker, in the demand's own vocabulary, naming the door that settles it. */
export function documentDemandBlocker(demand: ResolvedDemand, why?: string): string {
  const reason = why ? ` — ${why}` : "";
  switch (demand.kind) {
    case "range":
      return `the contract asks for a document covering ${demand.label}${reason}, and none declares that range`;
    case "role":
      return `the contract asks for a document covering "${demand.label}" (${demand.via})${reason}, and none declares that range`;
    case "artifact":
      return `the contract asks for a document covering the artifact "${demand.display}"`
        + `${demand.via ? ` (${demand.via})` : ""}${reason}, and no declared document names it. `
        + `A document about a whole medium has no address range of its own: give it a \`covers:\` entry `
        + `\`artifact:${demand.display}\` and register it with doc_register.`;
    case "unresolved":
      return `the contract asks for a document covering "${demand.label}"${reason}, and nothing answers to that name yet: `
        + `no model boundary carries it (model_assert) and no registered artifact matches it (list_artifacts). `
        + `Name a medium or file as \`artifact:<name>\` if that is what it is.`;
  }
}
