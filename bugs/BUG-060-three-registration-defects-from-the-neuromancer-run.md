# Bug: three registration defects from the Neuromancer run

- **ID:** BUG-060
- **Date:** 2026-09-21
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

This file covers the **registration slice** of what the Neuromancer run reported:
the inventory sync's recommendation, the payload/listing owner split, and the
Spec 784 chain guard. Other defects from the same run are recorded separately.

## Environment

- Branch: `fix-060-registration`
- Surface: mcp default
- Project dir: an RE project on a multi-side Neuromancer disk set
- Tools: `project_inventory_sync`, `extract_disk`, `disasm`,
  `register_payloads_from_manifest`

## 1. `project_inventory_sync` talked a caller into wrecking the coverage metric

The answer said:

```
2747 tool-produced file(s) are on disk and registered by nothing — 2732 in analysis/g64/, …
```

…and, in the same answer, handed over an `inventory-patterns.json` skeleton. The
caller did the obvious thing: it wrote a `patterns` entry for the bulk. All 2732
per-sector `.bin` dumps registered. **S12 coverage fell from 22.2 % to 7.6 %** and
not one byte had become less understood — the dumps' bytes joined the coverage
denominator and nothing joined the numerator.

Moving the glob to `intentional` afterwards stopped NEW registrations and nothing
else. The rows stayed, the next sync reported `Files registered: 0` — correctly,
and uselessly — and there was no door that takes a row back out.

Two things were wrong, and both of them are the same thing said twice: a number a
caller can act on wrongly has to carry what the action costs, and an action a
caller can take wrongly has to have an inverse.

## 2. The payload-node owner and the listing owner disagreed for stock-DOS files

`extract_disk` files a stock-DOS row under the CBM directory name (`p`) and writes
its bytes into `03_p.prg`. Every analysis producer keys that file's graph rows on
the FILE stem (`ownerFromAnalysisPath` → `03_p`), and so does the S12 coverage
measure (`stemOf(relativePath)`). The payload's owner stem came from its NAME, so
the payload node stood under `ram/p` and its disassembly under `ram/03_p`.

Result: the payload node for `p` read **0 % classified** although the file was
fully annotated and rebuilt byte-identically. All seven side-1 DOS files were
affected, and it is a large part of why the S12 number looked bad.

## 3. The chain guard counted the extractor's own PRG header as a missing sector

```
extracted blob is 12543 bytes but its 49 declared sector span(s) cover only 12541
— the block chain looks incomplete (start-only?)
```

The chain was complete. The two bytes are the load-address header a `.prg` carries
and the medium does not. The run silenced the warning by declaring the first
sector's span from offset 0 with length+2 — a span claiming the payload starts
inside the sector's T/S link bytes, which is false for every loader that is not
this one. A guard that can only be satisfied by a lie is worse than no guard.

## Resolution

**1.** The tool-output line now says what the files ARE (machine output, standing
behind the run's manifest), what registering them COSTS (the bytes, and what those
bytes do to coverage), and which key settles it — `intentional`, which silences,
never `patterns`, which registers. No `patterns` skeleton is offered for such a
bulk. `howToSilenceToolOutput` is the one place that answers for it, so
`project_inventory_sync` and `scan_registration_delta` say the same thing. The
byte totals are measured in the shared scan (`toolOutputBytes` /
`toolOutputBytesByDir`) rather than guessed at by the reporter.

And there is a way back: `unregister_files(glob=…)` takes artifact rows out of the
store. It never deletes a file — the bulk it exists for is a tool's output and the
tool will read those bytes again — and it refuses any row somebody has written
about: cited by a finding / entity / relation / flow / open question, sitting in a
lineage, carrying a version history, or whose subject holds more than one version.
Each refusal is named with its reason.

**2.** A payload's owner stem is the stem of the artifact holding its extracted
bytes, falling back to its name when there is no blob. The file wins because it is
what the rest of the system already counts. The link has to exist BEFORE the row
is keyed — a node id is derived on first save and re-saving an existing entity
keeps it — so the manifest import registers the blob and points the row at it
itself; Spec 752's `linkExtractedPayloadFiles` stays as the catch-up path for rows
imported before this. The CBM directory name survives as the entity's name.

**3.** The guard accounts for the header: for a payload the manifest declares
`prg`, a shortfall of EXACTLY two bytes is the load header. Three bytes still
warns, a start-only chain still warns, and the warning now says the header is
already allowed for so nobody pads a span to cover it again.

## Gates

| Defect | Gate |
|---|---|
| 1 | `npm run e2e:inventory-truth` — section 10. Registers the bulk, measures the coverage denominator before/after/after-undo, and checks the refusal. |
| 2 | `npm run e2e:subject-identity` — section 5. A real D64, `extract_disk`, the import, and the payload node's owner against `ownerFromAnalysisPath`. |
| 3 | `npm run e2e:chain-coverage` — section 5. Newly wired: the gate existed but was not in `package.json` and had bit-rotted on a missing `initProject`, so it had not run. |
