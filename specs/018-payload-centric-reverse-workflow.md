# Spec 018: Payload-Centric Reverse Workflow

## Problem

`run_prg_reverse_workflow` (Spec 003) only handles PRG-header files.
Real C64 projects ship plenty of binaries that are not PRGs:

- cart bank chunks pulled out of CRT extraction whose load address
  comes from a custom LUT, not from a 2-byte header.
- disk files extracted by a non-DOS loader that streams raw bytes to
  a known address with no extension.
- depacker outputs (Exomizer / Byteboozer / Lykia / BWC) materialised
  as raw bytes ready to execute.
- byte slices recovered from runtime traces.

Each of these is reversable using exactly the same analyse → disasm →
report → import pipeline, provided the caller can supply the load
address and the bytes. Forcing every input through a `.prg` header
either loses information (re-prefixing wastes the manifest's authority)
or blocks reverse engineering entirely.

## Goal

A payload-centric workflow that runs against any binary artifact for
which the project knows (or can be told) a load address. Inspect /
extract phases produce payload entities that carry everything the
workflow needs; the workflow consumes a payload id (or an explicit
`{ artifactId, loadAddress }` pair).

## Pipeline Changes

Pipeline `analyze-prg` keeps backwards compatibility (PRG header in
the first two bytes). Add an explicit raw mode:

```
analyze-prg <input> [outputJson] [entryHex,...] [--load-address $XXXX]
```

When `--load-address` is supplied, the pipeline skips the 2-byte
header and treats the entire file as raw bytes loaded at the given
address. Existing PRG callers ignore the flag.

`analyze-prg` should publish the resolved load address into the
output report header so downstream tools (disasm, ram-report,
pointer-report) read the same mapping. Disasm already takes the
analysis JSON and follows it.

## Workflow Library

Extend `src/lib/prg-workflow.ts` (or rename to `payload-workflow.ts`
in a follow-up):

- `runPayloadReverseWorkflow({ projectRoot, payloadId })`
  - Resolves the payload entity.
  - Picks the source artifact: `payloadDepackedArtifactId` if set,
    otherwise `payloadSourceArtifactId`.
  - Reads `payloadLoadAddress` and `payloadFormat`.
  - Calls the existing analyse → disasm → reports → import → views
    chain with raw mode when format is not `prg`.
  - Stores back the produced asm/analysis artifact ids on the payload
    entity (`payloadAsmArtifactIds`, etc.).

`runPrgReverseWorkflow(opts)` keeps its current signature and becomes
a thin caller that infers `loadAddress` from a `.prg` header.

## MCP / UI Surface

- Add `run_payload_reverse_workflow(payload_id)` MCP tool. Wraps the
  library and returns the same envelope shape as the PRG variant.
- Add `POST /api/run-payload-workflow` to the workspace UI server.
- UI: surface a `reverse workflow` button on every payload entry in
  the Payloads tab, the cart chunk inspector, and the disk file
  inspector — even when the source path lacks a `.prg` extension.
  Disable + tooltip when load address is unknown.

## Inspect / Extract Coverage

For the workflow to be ergonomic, every inspect / extract tool must
produce payload entities with complete metadata when it knows the
load address:

- `extract_crt`: register one payload per chip / per LUT entry,
  filling `payloadLoadAddress` from the LUT, `payloadFormat` from
  packer detection, `payloadSourceArtifactId` to the chip bytes,
  `payloadDepackedArtifactId` when a depack tool was applied.
- `extract_disk` / `extract_disk_custom_lut` (Sprint 7): one payload
  per file, load address from the directory entry or the LUT.
- `extract_g64_*`: one payload per recovered sector candidate when
  the load address is known.
- `depack_*` tools: when they materialise a depacked payload, link
  the new artifact id to the originating payload via
  `payloadDepackedArtifactId`.

## Acceptance Criteria

- A payload with `payloadFormat=raw` and a known `payloadLoadAddress`
  can be analysed end-to-end without any `.prg` header rewrite.
- The cart chunk inspector and disk file inspector show the
  `reverse workflow` button on every payload entry, regardless of
  the file extension.
- Re-running the workflow on the same payload is idempotent: existing
  artifact ids on the payload entity update in place rather than
  duplicating.

## Tests

- Pipeline: a synthetic raw blob fixture analysed twice, once with
  `--load-address $4000` and once via PRG header, produces structurally
  similar reports.
- Library: `runPayloadReverseWorkflow` against a seeded raw payload
  in the UI smoke fixture.
- UI typecheck + manual button verification.

## Out Of Scope

- Re-packing or rebuild verification for raw payloads.
- Cross-payload comparison views.
- Automatic load-address inference from disassembly heuristics (a
  separate research item).
