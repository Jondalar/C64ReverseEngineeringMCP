# Spec 023: Custom Loader Semantics — Multiple Load Contexts Per Artifact

## Problem

A binary's runtime address is not always its on-disk PRG header.
Custom fastloaders place the same file at a different address (e.g.
`15_love.prg` PRG header `$A000`, runtime address `$E000` after
KERNAL replacement). VICE traces observe these placements but do not
persist them. BUGREPORT Bug 13, REQUIREMENTS R8, R14. Extends
Sprint 15 payload-centric work.

## Goal

Express load placement as a first-class concept. Memory-map and
load-sequence views show the runtime address; analysis can be run
at the runtime address without rewriting the PRG header.

## Approach

### Schema

Extend artifact / payload-entity records with:

```ts
loadContexts?: Array<{
  kind: "as-stored" | "runtime" | "after-decompression";
  address: number;
  bank?: number;
  evidence?: EvidenceRef[];
  triggeredByPc?: number;
  sourceTrack?: number;
  sourceSector?: number;
}>;
```

`as-stored` is the PRG header value; `runtime` is the placement
seen at runtime; `after-decompression` is the unpacked target. An
artifact may carry several contexts (e.g. KERNAL replacement loaded
twice at different epochs).

### MCP tool

```
register_load_context(
  artifact_id: string,
  runtime_address: number,
  kind?: "runtime" | "after-decompression",
  source_track?: number,
  source_sector?: number,
  triggered_by_pc?: number
)
```

Idempotent on `(artifactId, kind, address)`.

### Memory-map view

`build_memory_map` reads `loadContexts` and emits one cell per
context per artifact. The view JSON adds:

- `contexts: Array<{ kind, address, bank?, length }>`
- highlight overlap when two artifacts claim the same range under
  the same kind.

UI: toggle (`As stored` / `Runtime` / `After decompression`) above
the memory map; cells reload on toggle change.

### VICE trace integration (R14)

A new `load_event` entity kind:

```ts
{
  kind: "load_event",
  sourceTrack: number,
  sourceSector: number,
  sourceArtifactId?: string,
  runtimeAddrStart: number,
  runtimeAddrEnd: number,
  triggeredByPc: number,
  capturedAt: string,
}
```

`vice_trace_*` tools that observe `LDA $1c01 / STA $xxxx` chains
or `LOAD` KERNAL vector calls emit these entities and call
`register_load_context` for the matching artifact when one exists.

### Sprint 15 follow-up

Sweep extract tools and confirm every produced payload entity sets
`payloadLoadAddress`, `payloadFormat`, `payloadSourceArtifactId`
when knowable. Document gaps as TODOs against Sprint 20.

## Acceptance Criteria

- `15_love.prg` analysable end-to-end at runtime address `$E000`
  using `run_payload_reverse_workflow` after a manual
  `register_load_context` call (or a VICE trace).
- Memory-map UI toggle switches between PRG-header view and
  runtime-view; the runtime view shows the KERNAL-replacement
  overlap at `$E000-$EFFF`.
- A VICE trace of a known fastloader sequence produces ≥1
  `load_event` entity visible in the load-sequence view.

## Tests

- Smoke: register two contexts on a fixture artifact, assert the
  memory map JSON exposes both with correct `kind`.
- Smoke: assert `register_load_context` is idempotent.
- VICE smoke deferred to manual until Sprint 8 (trace throughput)
  lands.

## Out Of Scope

- Auto-discovering load contexts from analysis alone (no trace).
- Rewriting Sprint 15 payload model.

## Dependencies

- Sprint 15 payload-centric workflow (already landed).
- Sprint 17 platform marker for KERNAL-replacement context (C64 vs
  C128 KERNAL differs).
- Sprint 8 trace throughput recommended before populating
  `load_event` entities at scale.
