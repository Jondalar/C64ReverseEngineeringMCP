# Bug: thirteen tooling defects an autonomous RE run wrote down as it hit them

- **ID:** BUG-054
- **Date:** 2026-09-20
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: `fix-tooling-round`, off `9efbcfa9`
- Surface: mcp default
- Project dir: an RE project on the Crazy News disks (`crazy-news`)
- Tool / endpoint / tab: thirteen tools, listed below

## What happened

One autonomous session ran a full reverse-engineering pass — three D64s, 245 extracted
files, 271 cart chunks, 46 `doc_register` calls, five subagents — and recorded every
place the tooling got in its way. Thirteen distinct defects, ordered here by what they
cost. They are one bug entry rather than thirteen because they were found in one run and
fixed in one round; each has its own root cause and its own check.

## Evidence

```text
 1  Error: No payload with id crazy-news:ram/pack1_nameint1:payload:0000
    …while nodes holds 758 rows of kind='payload' and list_payloads shows 269.
 2  {"fileStart":"E800",…} → relocation has invalid range: {"fileStart":null,…,"runtimeAddr":2000}
    "E800" became null; "2000" was read as decimal. entry_points accepts bare "E800".
    A zero-page relocation threw a node stack out of prg-disasm, four times.
 3  CRAZY1:04_pack2@$E000: extracted blob is 8002 bytes but its 26 declared sector
    span(s) cover only 6472 … ×232, every one of them a packed payload.
 4  medium_path: "input/disk/CRAZY1.D64" → (no probe — no medium at input/disk/CRAZY1.D64)
 5  21 of 46 doc_register calls refused, one field at a time; five subagents each
    rediscovered the same four-step ladder. `- "$C820-$CFFF"` → covers entry
    ""$C820-$CFFF"" is neither $XXXX-$YYYY nor artifact:<name>
 6  245 listings from the L2 auto-chain, not one carrying `rebuild verified byte-identical`
 7  Written runs: 18 — $0D00-$1FD8 (4825 bytes), … +6 more   (one hidden run was 2000 bytes)
 8  Coverage: 13514 / 1184478 bytes = 1.1 %
    ✓ S5 Runtime count  finding "One resident image per phase, five in all…"
    · S6 Runtime linkage  S5 has not stated a runtime count yet
    Slots: 1/12 filled, 11 open  …later…  Slots: 10/14 filled, 4 open   (over a list of 15)
 9  a slot answer that needs a sentence becomes an unreadable finding title
10  refutation-without-casualty: … invalidated nothing   (stayed red through two fixes)
11  Skipped (10)   — for 616 files. analysis/disk/*/manifest.spec784.json reported every run.
12  ⚠ … Run `bulk_import_analysis_reports` to back-fill.   ToolSearch finds no such tool.
13  {"format":"exomizer_sfx","confidence":0.93,
     "reason":"Exomizer self-extracting wrapper decrunch succeeded structurally."}
    …on a payload whose real codec is a $B3-escape RLE.
```

- Artifacts: the run's own transcript; the checks below reproduce each one.

## Scope guess (optional)

`records.ts` / `payloads.ts`, `pipeline/src/cli.ts`, `loader-manifest.ts`,
`lut-medium.ts`, `docs/frontmatter.ts`, `prg-workflow.ts`, `sandbox.ts`,
`slots/state.ts`, `slots.ts`, `critic/run.ts`, `inventory-sync.ts`,
`compression-tools.ts`.

## Notes / follow-up

Two of the thirteen turned out to be one cause wearing two faces, and one report
was wrong about where its own cause lived — see the resolution.

---

## Resolution (fill on fix)

- **Root cause:** one per defect.
  1. Not `entityKindOf`, as reported. `save_entity({kind:"disk-file"})` stores
     `legacy_kind` and reads it back, which is correct round-tripping — making the node
     kind win would break `list_entities({kind:"disk-file"})`. The wrong code was the
     READER: five payload doors filtered `listEntities({kind:"payload"})` while
     `list_loader_models`, ten lines above, counted four kinds. One predicate now
     (`project-knowledge/payload-kinds.ts`) and every door imports it. Separately,
     `projectDir()` with no hint resolved from the cwd — the MCP repo — instead of the
     project the session had just onboarded into.
  2. `pipeline/src/cli.ts parseAddr` fell back to `parseInt(s, 10)` for a bare string
     in the same call where `entry_points` read bare strings as hex. One rule now,
     stated in `ADDRESS_RULE` and in every refusal; relocations are parsed and held
     against the PRG in the MCP tool, so an out-of-range entry is a refusal naming the
     field, not a stack trace out of the renderer.
  3. The guard compared blob length against sector coverage, which only holds for an
     uncompressed payload. It now steps aside when the payload declares a packer or a
     compressed/unknown format, and the warning names that escape.
  4. `readerForMedium` resolved against `process.cwd()` alone. It takes the project
     root now, like every other path argument, and the refusal says what it tried.
  5. `parseFrontmatter` returned on the first problem; it accumulates now. Block-list
     and inline-list items never passed through `unquote()` — only the scalar branch
     did — so a quoted `covers` entry was rejected with its own quotes doubled into the
     message. Second half: the rule that states the contract was bound to
     `doc_template` + `render_docs`, and `doc_template` took no `project_dir`, so
     `ruleFooterForTool` resolved no directory and returned early — structurally
     undeliverable. `doc_register` now carries it too and `doc_template` takes the
     directory.
  6. `runPrgReverseWorkflow` — the function the L2 chain runs — never verified;
     `disasm_prg` did. The verifier moved to `src/lib/rebuild-verify.ts` and both use
     it. A raw blob is compared past the 2-byte header the assembler adds. Fixing this
     exposed a latent hazard: `saveArtifact` dedups by content hash, so registering a
     byte-identical rebuild-check OVERWROTE the source artifact's own row and took the
     payload entity internal with it. A verified rebuild-check is no longer registered.
  7. `RUN_LIST_CAP` truncated with `, … +N more`. It paginates (`write_runs_from`) and
     the tail states the hidden total in runs AND bytes and names the largest hidden run.
  8. Three faults. The denominator summed every registered artifact, counting the same
     content five and six times; it counts each distinct content hash / lineage once
     and says what it is made of. S6 printed "S5 has not stated a runtime count yet"
     whether S5 was unanswered or answered without a parseable number. The header's
     denominator moves as conditional slots become applicable and never said so.
  9. The answer WAS the title. `slot_record` takes an optional `title`, derives a
     headline when it is omitted, and keeps the whole answer in the body.
 10. `verdict()` reduced each blocking critic finding to `check: title` and dropped
     `settleBy`. It carries it now, and the refutation check names the literal
     `amends:<name>` tag and the call that writes it.
 11. `delta.unregistered.slice(0, 10)` was both the sample AND the count. Separated.
     A project can declare its own directories in `knowledge/inventory-patterns.json`,
     and the report prints the shape. `manifest.spec784.json` got a shipped pattern.
     The version-tie hint names `set_current_artifact_version`, not the Inspector.
     While doing this: `matchesGlob` compiled `**/` to `.*` with the slash kept, so
     `docs/**/*.md` never matched `docs/index.md` — every shipped pattern was missing
     its top-level files.
 12. `bulk_import_analysis_reports` is advanced-tier and invisible to a default
     session. `project_inventory_sync`, the facade built for exactly this, was simply
     missing the phase; it back-fills now and the four recommendation sites name it.
 13. The probe emulates the file's own code from a pattern-scored prologue
     (`SEI / LDA #imm / STA $01`) and watches it write memory — which every C64
     depacker stub does. Nothing Exomizer-specific was checked. Confidence is now 0.5
     at most, the BASIC-SYS bonus is gone, the reason states what was observed and what
     was not, and `analyze_prg` no longer says "likely Exomizer-packed" below 0.6.
- **Fix commit:** the `fix-tooling-round` series.
- **Gate proving the fix:** `npm run e2e:tooling-defects` (87 checks, hermetic), plus
  `e2e:838-harvest` for the run-list contract, `e2e:752` for the artifact-dedup hazard
  and `e2e:741` / `e2e:750-lut` for the relocation and LUT doors (both were red on
  master for want of an `agent_onboard` call and are green again).
- **Regression risk:** the `**/` glob fix widens what every shipped registration
  pattern matches — deliberately, and `e2e:mcp-product-surface` covers the registration
  flow. The rebuild verification adds one assembler run per extracted payload; it
  short-circuits after the first failure to start the assembler.
