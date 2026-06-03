# Spec 752 — Extract-first grounding doctrine

**Status:** DONE (2026-06-03) — all 8 slices shipped, gate `e2e:752` 25/25.
**Cross-links:** Spec 748.2 (orchestrator teeth, was OPEN — this is its content),
748.3 (extract→cartography), BUG-032 (enforcement half). Builds on Spec 730
(`agent_next_step` ladder) + 748.1 (steering vehicle).

## 0. The principle (user, from Wasteland testing)
The agent drifts to *permanent tracing / live data / statistics / heuristics*. That is
not how we work. **Trace/stats/heuristics describe runtime *behaviour* — they do not
*ground* a file/payload claim.** What a block IS comes from the **extracted bytes + their
disassembly**, the ground truth — not from "PC was often at $X" or "heuristic says code".

This does NOT condemn tracing (Spec 746.13 etc.) — a trace answers *"when/where does it
run"*, never *"what is this block"*. The two must not be confused.

## 1. The two laws
- **L1 — extract-backing.** Every finding about a file/payload MUST cite a backing
  **extract artifact** (the extracted bytes / its `_disasm.asm` / `_analysis.json`). A
  trace `runId+cycle` or a heuristic is NOT sufficient grounding.
- **L2 — extract ⇒ always disasm + analyse.** Every extraction from disk/CRT
  AUTOMATICALLY runs `analyze_prg` + `disasm_prg` on each extracted PRG/payload. No raw
  extract without a disassembly.

## 2. Three enforcement layers (matching the Spec 748 architecture)
- **Universal doctrine →** `docs/agent-doctrine.md` (injected via the `c64re_agent_doctrine`
  prompt). The L1 law + extract-first ordering, inherited by every project.
- **Per-project steering →** `knowledge/steering.md` (written by `project_steering_set`,
  injected at the top of `agent_onboard`). Provisioned at `project_init` so new projects
  get the operational rule by default.
- **Orchestrator teeth →** the `agent_next_step` ladder (Spec 748.2). State-derived: an
  ungrounded finding or an un-disassembled extract becomes the top recommendation, ranked
  ABOVE annotate / runtime-trace / record-knowledge. Prose steering alone does not enforce
  (BUG-032) — this rung is the executable enforcement.

## 3. Key data-flow facts (verified, load-bearing)
- `importManifestArtifact()` (`service.ts:~4435-4470`) returns only COUNTS — L2 needs the
  created payload-entity IDs to chain. Widen the return.
- Disk-file payload entities (`manifest-import.ts:148-172`): `payloadFormat:'prg'|'raw'`,
  `payloadSourceArtifactId` = the MANIFEST artifact (not a per-file extract artifact yet),
  `artifactIds:[manifestId]`. The extracted bytes on disk are not their own artifact until
  the workflow registers them.
- `runPayloadReverseWorkflow()` (`prg-workflow.ts:~298`) is the correct L2 entry: resolves
  the payload's source artifact, runs analyse→disasm, registers analysis-json + asm
  artifacts, stamps `payloadAsmArtifactIds` — BUT only for `kind === "payload"`
  (`prg-workflow.ts:348` guard), not `disk-file`/`cart-chunk`. Broaden it.
- Analysis JSON is registered `kind:"other", role:"analysis-json"`; asm is
  `kind:"generated-source", role:"kickassembler-source"`. The L1 predicate must allowlist
  these — a literal `kind === "extract"` check would reject every grounded finding.
- `extract_disk_custom_lut` never calls `importManifestArtifact` → custom-LUT files never
  become payload entities. L2 silently no-ops there until fixed (the highest-value
  non-`$801` custom-loader scenario).

## 4. L1 predicate (precise, to avoid false positives)
A finding is **file/payload-scoped** iff: `payloadId` is set, OR (`addressRange` set AND
tags include one of `routine` / `segment-classification` / `annotation`). NEVER tags-alone
or addressRange-alone (a `hypothesis`/`memory-map` finding must not trip).

It is **backed** iff any artifact in `artifactIds[]` or `evidence[].artifactId` has
`kind ∈ {analysis-run, generated-source, prg, listing}` OR `role ∈ {analysis-json,
disasm, prg-analysis, kickassembler-source}`; OR its `payloadId` resolves to an entity with
non-empty `payloadAsmArtifactIds` / `payloadSourceArtifactId`.

**Soft, never hard:** an unbacked file/payload finding is PERSISTED, tagged `ungrounded`,
and gets a `finding.ungrounded` timeline event. Never throw — auto-producers
(`importAnalysisKnowledge`, `import_annotations_as_findings`) must not break (they already
cite the analysis artifact, so they pass the predicate). The `save_finding` MCP handler
appends a visible ⚠ L1 warning when the result comes back `ungrounded`.

## 5. Slices + per-slice gate (all DONE 2026-06-03, `e2e:752` 25/25)
| Slice | Change | Gate |
|---|---|---|
| **S1** ✅ | doctrine text: L1 in `docs/agent-doctrine.md`; provision L2 into `steering.md` at `project_init`; this spec | fresh `project_init` → `steering.md` has the extract-first rule; doctrine prompt has the L1 sentence |
| **S2** | `importManifestArtifact` returns `importedPayloadEntityIds` | extract a known disk → N IDs == `list_payloads` count; counts unchanged |
| **S3** | broaden `prg-workflow.ts:348` stamp to `disk-file`/`cart-chunk`, preserve original kind + disk-file fields | `runPayloadReverseWorkflow` on a disk-file entity keeps `kind`, populates `payloadAsmArtifactIds`, keeps `mediumSpans`/`addressRange` |
| **S4** | `autoAnalyzeExtractedPayloads(root, ids, {mode:'quick'})` — soft-fail per payload, ONE final view rebuild | broken payload → `status:failed`, rest `done`, helper never throws |
| **S5** | wire into `extract_disk` + fix+wire `extract_disk_custom_lut` (add missing `importManifestArtifact`) | post-extract each PRG payload has analysis+asm; extract still exit 0 if one fails; custom-LUT files become analysed payloads |
| **S6** | wire into `extract_crt` + tail of `bulk_create_cart_chunk_payloads` | promoted chunk payloads carry analysis/asm; no hard-fail on undepackable chunk |
| **S7** | L1 marker in `saveFinding` + ⚠ warn in `save_finding` handler | payload finding w/o extract → `ungrounded` tag + warning; finding citing analysis artifact → clean; auto-imported finding → clean |
| **S8** | `ungroundedFindings` signal + `agent_next_step` rung above annotate/runtime-trace/record-knowledge | one ungrounded finding → primary suggestion = ground-it (not trace), `why` names L1; zero → ladder unchanged |

S2–S8 carry a focused smoke check (knowledge-layer work — the 7-game runtime gate does
not apply). Commit per slice.

## 6. Risks
- **Auto-chain perf:** `runCli` spawns a pipeline subprocess per command; a 20-file disk =
  dozens of spawns. Mitigate: `mode:'quick'` (skip ram/pointer reports),
  `rebuildViews:false` per payload + ONE final `buildAllViews()`, per-payload timeout,
  optional cap-K-then-queue-rest for very large disks.
- **Soft-fail both directions:** one payload's depack/analyse/disasm failure must NOT make
  `extract_*` return non-zero NOR abort the rest. Extract success = bytes written + manifest
  imported; auto-disasm is additive.
- **L1 false-positives:** require the (payloadId) OR (addressRange AND file/payload tag)
  combination; verify `import_annotations_as_findings` + analysis-import outputs pass.
- **Narrow-`extract`-kind trap:** allowlist the artifacts actually produced
  (`analysis-run`/`generated-source`/`role:analysis-json`), not literal `kind:'extract'`.
- **Stamp must not downgrade disk-file entities:** carry every field (`mediumSpans`,
  `aliases`, `mediumRole`, `payloadDiskHint`, `addressRange`) through S3's re-save, or use a
  targeted append-asm-ids update.
- **Custom-LUT import gap** is a correctness fix, not just a feature — gate it explicitly.
- **Cross-disk dedup** (`payloadContentHash`): dedup resolved source paths before chaining
  so the same PRG isn't analysed twice.

## 6.5 Known follow-ups (shipped DONE, refine later)
- **Signal inconsistency:** `agent_next_step`'s `analysisArtifacts` signal counts
  `kind:analysis-run` / `role:prg-analysis`, but the auto-chain registers analysis as
  `role:analysis-json`. So a payload analysed by L2 does not increment that *signal* (the
  L1 *backing* predicate DOES allowlist `analysis-json`, so findings are still correctly
  grounded). Normalise the workflow's analysis `role` or widen the signal allowlist.
- **Cart chunk carving:** S6 auto-chains chunk payloads at the chip-blob level (the chip
  `.bin` is the source artifact). Chunk-level carving (chunk → its own artifact + depack)
  + auto-depack of compressed chunks is a refinement (`record_cart_chunk_packer` /
  `link_cart_chunk_to_asm` exist for the manual path).
- **Auto-chain cap:** `autoAnalyzeExtractedPayloads` supports `maxPayloads` but the extract
  handlers don't set it — a very large disk auto-chains every payload. Add a default cap +
  queue-the-rest via `agent_next_step` if it bites.

## 7. Non-goals
- NOT removing/penalising tracing — trace stays the runtime-behaviour tool (Spec 746.x).
- NOT a hard reject in `saveFinding` (breaks auto-producers) — soft marker + ladder teeth.
- NOT the 7-game runtime gate (knowledge-layer work).
