# Spec 029: Memory / Cartridge / Flash Constraint Checker

## Problem

Crack and port changes are constrained by scarce memory and
cartridge geometry: EasyFlash erase-sector size, free banks, overlay
RAM, `$01` CPU port state, EAPI cart visibility, VIC bitmap/colour
regions, zero-page preservation. Accolade Comics' EF save logic
hinges on Bank 63 free slots, Banks 56-62 erase margin, and
`$0C23-$0FFF` transient overlay. Today these rules live in project
docs and build comments. REQUIREMENTS R22.

## Goal

Declare constraints as structured records. Run a checker that
reports collisions and unsafe assumptions against the current
artifact / patch / build state. First iteration runs as part of
`project_audit`; later it can also run as an explicit
`verify_constraints` MCP tool.

## Approach

### Schema

New record kinds in the knowledge layer:

```ts
interface ResourceRegion {
  id: string;
  kind: "ram-range" | "zp-byte" | "vic-region" | "cart-bank"
       | "cart-erase-sector" | "eapi-runtime" | "io-register";
  name: string;
  start?: number;
  end?: number;
  bank?: number;
  attributes?: Record<string, JsonValue>; // e.g. {erasable: true, eraseGroup: 7}
  notes?: string;
}

interface Operation {
  id: string;
  kind: "overlay-copy" | "flash-erase" | "flash-write" | "bank-switch"
       | "decrunch-write" | "runtime-patch" | "kernal-call";
  triggeredBy: string;            // entity / artifact id
  affects: string[];              // resource-region ids
  preconditions?: string[];       // free-form invariants
  evidence?: EvidenceRef[];
}

interface ConstraintRule {
  id: string;
  title: string;
  appliesTo: { regionKind?: string; opKind?: string };
  rule: string;                   // free-form description
  severity: "info" | "warn" | "error";
  // Machine-evaluable predicate is out of scope for v1; rules render as
  // text and the checker compares declared regions/operations against
  // hand-written predicates registered in code.
}
```

Storage:

- `knowledge/resources.json`
- `knowledge/operations.json`
- `knowledge/constraints.json`

### Built-in rule library

A small TypeScript library implements a starter rule set:

- "flash-erase op must not affect a region whose attributes include
  `protected: true`"
- "overlay-copy op's affects[] must not overlap a region marked
  `live-code: true`"
- "kernal-call op requires CPU port `$01` in mode that exposes
  KERNAL ROM"
- "decrunch-write affects must not collide with EAPI runtime regions"
- "ZP byte used by a routine must be saved/restored if the caller
  marks it `caller-preserves: true`"

Project-level extension hooks: the project can register additional
rules via `register_constraint_rule(predicate_module_path)` for
project-specific invariants.

### MCP tools

- `register_resource_region(...)` / `register_operation(...)` /
  `register_constraint(...)`.
- `verify_constraints(scope?: artifact-id | patch-id | "project")`
  — run the rule set, return a list of `{ rule, severity, message,
  affectedIds }` items.
- `list_constraints` / `list_resources` / `list_operations`.

### Audit integration

`project_audit` runs `verify_constraints("project")` and surfaces
high-severity violations alongside the existing audit findings. The
audit cache (Spec 009) invalidates on any constraint store change.

### UI

Constraints tab (joined to Sprint 18 tabs work):

- Resource regions table (filter by kind).
- Operations table.
- Active violations list with severity badges.

## Acceptance Criteria

- Accolade Bank 63 save slots plus Banks 56-62 erase-margin and
  `$0C23-$0FFF` transient overlay can be declared.
- A patch recipe (Spec 027) that overlays into `$0C23-$0FFF` while
  a registered "live-code" region claims that range fails
  `verify_constraints` with severity `error`.
- The audit reports the violation without a separate manual call.

## Tests

- Smoke: register two overlapping regions with conflicting
  attributes, assert the rule fires.
- Smoke: constraint pass on the fixture project returns no
  violations.

## Out Of Scope

- Full SAT-style solver.
- Auto-deriving regions from analysis JSON (manual declaration in
  v1; auto-derive in a later sprint).

## Dependencies

- Sprint 17 (platform marker) — region kinds may filter by
  platform.
- Sprint 27 (Spec 027 patches) — patches declare operations.
- Sprint 9 (audit cache) — invalidate on constraint edits.
