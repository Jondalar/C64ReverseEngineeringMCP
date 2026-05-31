# Bug: Code-derived disk loads cannot be registered as rich payloads (no LUT path, save_entity makes thin records)

- **ID:** BUG-024
- **Date:** 2026-05-31
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** medium
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: master @ 7b4e4140
- Surface: mcp full
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: `save_entity` (kind=payload) / `extract_disk_custom_lut` / `list_payloads` / Disk + Memory-map views

## What happened

Wasteland loads its real game blocks with **no on-disk directory entry and no on-disk
LUT** — the (track, start-block-index, count) parameters are baked into code (the `2.0`
installer's 3 hardcoded `$FC00` reads + the engine's on-demand overlay load), and the
sector sequence is computed at runtime (zone tables + descending `$F9`). These blocks
were carved byte-exact to `.prg` + disassembled, but they are invisible in the UI because
nothing registered them as payloads:

- `extract_disk` only sees the 2 CBM-dir files (`prodos`, `2.0`).
- `extract_disk_custom_lut` **requires a fixed LUT sector** (lut_track/lut_sector + stride
  entries) — Wasteland has none, so it does not apply.
- `save_entity { kind: "payload", ... }` **does** create a payload entity, but it is a
  **thin** record: `list_payloads` shows `load=— fmt=? asm=0 src=—`. The load address,
  format, source artifact, and ASM-coverage fields are populated only by the extraction
  pipeline, not by `save_entity`, and there is no tool to attach a source `.prg` artifact
  to an existing payload entity (`link_payload_to_asm` attaches ASM, not the prg, and
  needs an artifact id the API does not surface).

Net: a verified, byte-exact, code-derived load can be named/summarised but cannot become
a first-class payload with load addr + format + prg/asm wiring.

## Expected

A way to register an already-extracted byte-exact block as a full payload from an explicit
(track, start-index, count, load-address, format, source-prg) descriptor — i.e. a
"manual / code-derived" payload create that fills the same fields the LUT/CBM extractors
fill, so `list_payloads` shows load+fmt+src+asm and the Disk/Memory views render it.
Custom loaders that compute their layout in code (very common in cracks/protections) are a
first-class case, not an edge case.

## Repro steps

1. In a project whose payloads are read by code (no CBM dir entry, no on-disk LUT), carve
   a block to `.prg` and disassemble it.
2. `save_entity { kind:"payload", name, address_start, address_end, summary }`.
3. `list_payloads`.

Minimal command / call:

```text
save_entity kind=payload name=block3_game_7E00 address_start=32256 address_end=36095 ...
list_payloads
```

## Evidence

- Error / output (verbatim):

```text
# after 3 save_entity payload creates:
Payloads: 3
  entity-block2-engine-0200-... | block2_engine_0200 | load=— fmt=? asm=0 src=—
  entity-block3-game-7e00-...   | block3_game_7E00    | load=— fmt=? asm=0 src=—
  entity-utils-overlay-7e00-... | utils_overlay_7E00  | load=— fmt=? asm=0 src=—
```

- Artifacts: project `analysis/disk/wasteland_s1[...]/` has the byte-exact prg+asm
  (`block2_engine_0200.prg`, `block3_game_7E00.prg`, `utils_overlay_7E00.prg` + `_disasm.asm`);
  load model in `Wasteland_EF/docs/LOADER.md` §3/§3a/§4 (code-derived, descending-`$F9`,
  no LUT).

## Scope guess (optional)

Payload create/ingest layer + `list_payloads`/view projection. Options:
1. A `register_payload` / `extract_disk_code_derived` tool taking explicit
   (track, start_index, count, load_address, format, source_prg) and producing a full
   payload + manifest entry with origin=`code-derived`.
2. Extend `save_entity kind=payload` to accept `load_address` / `format` / `source_prg`
   and wire them into the payload store + ASM stem-match.
3. A `link_payload_to_prg` companion to `link_payload_to_asm`.

## Notes / follow-up

- Related but distinct from BUG-023 (write-back persistence). This one is about *ingesting*
  code-derived reads as analyzable payloads.
- Workaround in use: thin `save_entity` payloads (names + summaries carry the T/S params)
  — visible by name, but no load/fmt/asm columns.
- Wasteland's documented load recipe (track, start-index=X, count, descending `$F9` zone
  tables) is exactly the descriptor such a tool would need — good first fixture.

---

## Resolution

- **Root cause:** Not a missing capability — a **discoverability/surface** bug. The rich
  `register_payload` tool already existed and already fills every field (load addr, format,
  source artifact, ASM ids, `mediumSpans`), and the views already render those (memory map
  at `payloadLoadAddress`, disk view from sector `mediumSpans`). But `register_payload` sat
  on the **advanced** surface (`C64RE_FULL_TOOLS` only), so the normal default-surface LLM
  could not reach it and fell back to the thin `save_entity kind=payload`. Two ergonomics
  gaps made the rich tool awkward even when reachable: it needed a pre-existing
  `source_artifact_id` (forcing a `project_inventory_sync` + id lookup before use), and the
  disassembly had to be linked by hand.
- **Fix (4 parts):**
  1. Promoted `register_payload` to the **default** surface (`tier-tools.ts` DEFAULT_TOOLS,
     cap 105→106) + added it to the Raw-Disk/GCR playbook and the usecase matrix
     (role=knowledge-write); excepted from the `/^register_/` maintenance-name guard in the
     two boundary probes (BUG-024 exception).
  2. Redirected `save_entity` away from payloads — its description now states
     `kind=payload` makes a thin record (no load/format/source) and points at
     `register_payload`.
  3. Added `source_prg_path` to `register_payload`: pass the carved `.prg` path and it is
     registered as the source artifact + linked automatically (no inventory-sync + id
     lookup first).
  4. Added automatic ASM **stem-match**: `block_X.prg` ↔ `block_X_disasm.asm/.tass` are
     linked via `subjectIdForArtifact` when no explicit `asm_artifact_ids` are given.
- **Fix commit:** _(this commit)_
- **Gate proving the fix:** `npm run e2e:024` (`scripts/e2e-024-payload-rich.mjs`, 15/15) —
  drives the **real default-surface** MCP server over stdio: asserts `register_payload` is
  on the default surface, that `source_prg_path` auto-registers+links the prg, that the
  disassembly is stem-matched, and that the result is rich in `list_payloads`, placed in the
  memory map at `$4000`, and carries its disk `mediumSpans` (T20/S5) for the disk view.
  Plus `npm run check:mcp-product-surface` (tool-surface + 727 matrix + 728 playbooks + E2E
  boundaries all green with `register_payload` on the default surface).
- **Regression risk:** Low. No view/store schema change — `register_payload` and the view
  renderers were already present; the change is surface tiering + two convenience inputs.
  Disk-view _painting_ at the T/S still needs `set_payload_disk_hint` (next playbook step),
  unchanged by this fix; the payload now carries the spans so the hint has something to mark.
