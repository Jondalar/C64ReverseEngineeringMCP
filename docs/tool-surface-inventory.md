# MCP tool-surface inventory (Spec 722.1)

**Date:** 2026-05-29. Audit-only, generated from the actual `server.tool(...)` calls in `src/server-tools/**`. No code change.

**North star:** an LLM outside the C64RE dev repo must use the MCP without guessing between historical/dev/debug tools.

## Totals
- **271** registered tools.
- **102** (38%) have a `Spec NNN` in the description (history-encoded, not capability-first).
- **71** are advanced-tier candidates (vice / maintenance / drive-only / sandbox).
- Default-candidate (façade/workflow): **200**.

## By namespace

| namespace | tools |
|-----------|-------|
| `vice_*` | 49 |
| `runtime_*` | 48 |
| `list_*` | 17 |
| `headless_*` | 15 |
| `save_*` | 10 |
| `build_*` | 9 |
| `depack_*` | 8 |
| `pack_*` | 8 |
| `register_*` | 7 |
| `agent_*` | 6 |
| `trace_*` | 6 |
| `backfill_*` | 5 |
| `extract_*` | 5 |
| `inspect_*` | 5 |
| `project_*` | 5 |
| `record_*` | 5 |
| `link_*` | 4 |
| `import_*` | 3 |
| `run_*` | 3 |
| `scan_*` | 3 |
| `analyze_*` | 2 |
| `auto_*` | 2 |
| `bulk_*` | 2 |
| `c64ref_*` | 2 |
| `dedupe_*` | 2 |
| `disasm_*` | 2 |
| `get_*` | 2 |
| `mark_*` | 2 |
| `propose_*` | 2 |
| `read_*` | 2 |
| `render_*` | 2 |
| `sandbox_*` | 2 |
| `set_*` | 2 |
| `start_*` | 2 |
| `suggest_*` | 2 |
| `apply_*` | 1 |
| `archive_*` | 1 |
| `assemble_*` | 1 |
| `c64re_*` | 1 |
| `close_*` | 1 |
| `compare_*` | 1 |
| `confirm_*` | 1 |
| `declare_*` | 1 |
| `define_*` | 1 |
| `diff_*` | 1 |
| `disk_*` | 1 |
| `export_*` | 1 |
| `pointer_*` | 1 |
| `ram_*` | 1 |
| `reconstruct_*` | 1 |
| `rename_*` | 1 |
| `snapshot_*` | 1 |
| `try_*` | 1 |
| `update_*` | 1 |
| `verify_*` | 1 |

## Known overlap clusters (722.2 will confirm)
- runtime_* (48) vs headless_* (15) — two namespaces for one runtime
- runtime_audio_export ≡ runtime_export_audio (duplicate)
- vice_trace_* vs trace_store_* (doctrine-preferred)
- vice_monitor_* vs runtime_monitor_*
- headless_render_screen vs runtime_export_screenshot
- headless_integrated_session_status vs runtime_status

## All tools

| name | ns | file | spec# | tier-cand | overlap | first sentence |
|------|----|----|-------|-----------|---------|----------------|
| `agent_advance_phase` | agent | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 034: advance an artifact to a target phase (1..7) in the seven-phase RE workflow. |
| `agent_freeze_artifact` | agent | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 034: freeze an artifact at its current phase (cracker mode for asset PRGs / level data that has no relevance to the crack). |
| `agent_onboard` | agent | server-tools/agent-workflow.ts |  | default? |  | Reload the full project state into the session. |
| `agent_propose_next` | agent | server-tools/agent-workflow.ts |  | default? |  | List ranked, phase-consistent next actions across artifacts, read-only. |
| `agent_record_step` | agent | server-tools/agent-workflow.ts |  | default? |  | Record a completed work step and optionally queue the next action, so a later session can resume. |
| `agent_set_role` | agent | server-tools/agent-workflow.ts |  | default? |  | Set the working role for this session — analyst, cartographer, or implementer — which biases what agent_propose_next recommends. |
| `analyze_g64_anomalies` | analyze | server-tools/disk-g64.ts |  | default? |  | Scan a G64 image track-by-track and report duplicate, missing, unexpected, or invalid decoded sectors. |
| `analyze_prg` | analyze | server-tools/analysis-workflow.ts |  | default? |  | Run the heuristic analysis pipeline on a PRG and produce structured JSON — segments, cross-references, RAM facts, pointer tables. |
| `apply_patch_recipe` | apply | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 027: apply a patch recipe. |
| `archive_phase1_noise` | archive | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 053 (Bug 20): walk hypothesis-kind findings with addressRange, archive any that fall fully inside a routine annotation finding's addressRange. |
| `assemble_source` | assemble | server-tools/assembly.ts |  | default? |  | Assemble a .asm (KickAssembler) or .tass (64tass) file to a binary, optionally byte-comparing the rebuild against the original PRG. |
| `auto_resolve_questions` | auto | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 052: run the catch-up sweep across all auto-resolvable questions (Pfad A + B). |
| `auto_tag_relevance` | auto | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 041: heuristic-classify all artifacts and propose relevance tags (loader / protection / save / kernal / asset). |
| `backfill_finding_address_ranges` | backfill | project-knowledge/mcp-tools.ts |  | advanced? |  | Bug 28: walk findings.json and copy evidence[0].addressRange to top-level addressRange when missing. |
| `backfill_internal_flags` | backfill | project-knowledge/mcp-tools.ts | Y | advanced? |  | Bug 26 / Spec 058 follow-up: walk artifacts + entities and set `internal: true` on records where the heuristic (path / role / kind) classifies them as infrastru |
| `backfill_manifest_payload_hashes` | backfill | project-knowledge/mcp-tools.ts |  | advanced? |  | Bug 33 Fix A (manifest path): walk every artifact of kind=manifest, re-parse it, resolve each entry's file path to bytes, compute sha256, and write back into th |
| `backfill_payload_content_hashes` | backfill | project-knowledge/mcp-tools.ts |  | advanced? |  | Bug 33 Fix A: walk payload-bearing entities (kind=payload OR payloadLoadAddress set), and for each whose payloadContentHash is null AND payloadSourceArtifactId  |
| `backfill_question_address_ranges` | backfill | project-knowledge/mcp-tools.ts |  | advanced? |  | Bug 29: walk open-questions.json and copy the linked finding's addressRange (or evidence[0].addressRange as fallback) to the question's top-level addressRange w |
| `build_all_views` | build | project-knowledge/mcp-tools.ts |  | default? |  | Rebuild + persist ALL project JSON view-models in one pass (dashboard, memory map, listing, …) for the UI. |
| `build_annotated_listing_view` | build | project-knowledge/mcp-tools.ts |  | default? |  | Rebuild + persist the JSON annotated-listing view-model (disasm + annotations) for the UI. |
| `build_cartridge_layout_view` | build | project-knowledge/mcp-tools.ts |  | default? |  | Build and persist the JSON cartridge-layout view-model for the current project. |
| `build_disk_layout_view` | build | project-knowledge/mcp-tools.ts |  | default? |  | Build and persist the JSON disk-layout view-model for the current project. |
| `build_flow_graph_view` | build | project-knowledge/mcp-tools.ts |  | default? |  | Build and persist the JSON flow-graph view-model for the current project. |
| `build_load_sequence_view` | build | project-knowledge/mcp-tools.ts |  | default? |  | Build and persist the JSON load-sequence view-model for the current project. |
| `build_memory_map` | build | project-knowledge/mcp-tools.ts |  | default? |  | Rebuild + persist the JSON memory-map view-model (address-space layout) for the UI. |
| `build_project_dashboard` | build | project-knowledge/mcp-tools.ts |  | default? |  | Rebuild + persist the JSON dashboard view-model (project status overview) for the UI. |
| `build_tools` | build | server-tools/artifacts.ts |  | default? |  | Compile the TRXDis pipeline (npm run build). |
| `bulk_create_cart_chunk_payloads` | bulk | server-tools/payloads.ts |  | advanced? |  | Walk the cartridge-layout view's lutChunks and create a payload entity for each one. |
| `bulk_import_analysis_reports` | bulk | server-tools/registration.ts |  | advanced? |  | Walk every analysis-run artifact in the project and call import_analysis_report on those whose entities are not yet back-linked. |
| `c64re_whats_next` | c64re | server-tools/agent-workflow.ts |  | default? |  | Return the single next required action for the active artifact, cheaply, to call every turn. |
| `c64ref_build_rom_knowledge` | c64ref | server-tools/reference.ts |  | default? |  | Fetch and rebuild the local BASIC/KERNAL ROM knowledge snapshot from mist64/c64ref sources. |
| `c64ref_lookup` | c64ref | server-tools/reference.ts |  | default? |  | Look up C64 BASIC/KERNAL ROM knowledge by address or search term from the local reference snapshot. |
| `close_completed_tasks` | close | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 038: walk auto-suggested NEXT-hint tasks and close those whose autoCloseHint (file-exists / artifact-registered / phase-reached) is satisfied. |
| `compare_exomizer_shared_encoding_sets` | compare | server-tools/compression.ts |  | default? |  | Compare one or more shared-encoding manifest sets, e.g. |
| `confirm_question_resolution` | confirm | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 052: confirm or reject a resolution-pending question. |
| `declare_loader_entrypoint` | declare | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 028: declare a loader entry point on an artifact (jump-table, sector-load, container-decode, dispatch, init, other). |
| `dedupe_artifact_registry` | dedupe | project-knowledge/mcp-tools.ts | Y | advanced? |  | Spec 060 / Bug 30: collapse legacy duplicate artifact registrations (same absolute path, different ids) into one survivor per path. |
| `dedupe_payload_entities` | dedupe | project-knowledge/mcp-tools.ts | Y | advanced? |  | Spec 060 / Bug 31: collapse legacy duplicate payload-bearing entities into one survivor per (payloadContentHash) or (payloadSourceArtifactId + payloadLoadAddres |
| `define_runtime_scenario` | define | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 030 / R20: define a named scenario (target artifact, breakpoints, stop condition, expected milestone). |
| `depack_bwc_bitstream` | depack | server-tools/bwc-bitstream.ts |  | default? |  | Depack a BWC bit-stream chunk (Pucrunch-derived format with 'pu' magic). |
| `depack_bwc_chunk` | depack | server-tools/bwc-bitstream.ts |  | default? |  | Auto-dispatch on the first two bytes: 'pu' magic → depack_bwc_bitstream, else → depack_bwc_raw. |
| `depack_bwc_raw` | depack | server-tools/bwc-bitstream.ts |  | default? |  | Depack a BWC raw chunk (uncompressed). |
| `depack_byteboozer` | depack | server-tools/compression.ts |  | default? |  | Decompress a ByteBoozer2 raw .b2 file or executable wrapper in pure TypeScript. |
| `depack_byteboozer_lykia` | depack | server-tools/compression.ts |  | default? |  | Decompress a Lykia-variant ByteBoozer2 stream (modified 4-byte header: dest_lo, dest_hi, end_lo, end_hi; BB2_BITBUF seeded from supplied dest_hi). |
| `depack_exomizer_raw` | depack | server-tools/compression.ts |  | default? |  | Decompress an Exomizer raw stream via the built-in TypeScript implementation. |
| `depack_exomizer_sfx` | depack | server-tools/compression.ts |  | default? |  | Decompress an Exomizer self-extracting wrapper via the built-in TypeScript 6502-emulated depacker. |
| `depack_rle` | depack | server-tools/compression.ts |  | default? |  | Decompress the built-in C64 RLE format used by Mike's loader. |
| `diff_scenario_runs` | diff | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 030: diff two recorded scenario runs (baseline vs candidate). |
| `disasm_menu` | disasm | server-tools/disk-g64.ts |  | default? |  | Disassemble every payload in an extracted menu/multi-file container to KickAssembler sources at once. |
| `disasm_prg` | disasm | server-tools/analysis-workflow.ts |  | default? |  | Disassemble a PRG to KickAssembler .asm + 64tass .tass, segment-aware when given an analysis JSON. |
| `disk_sector_allocation` | disk | server-tools/media.ts |  | default? |  | Report per-track/sector ownership for an extracted disk — system (BAM/dir), kernal file, custom file, unclaimed padding, orphan data — and flag overlaps. |
| `export_menu` | export | server-tools/disk-g64.ts |  | default? |  | Export menu payload binaries from extracted CRT data. |
| `extract_crt` | extract | server-tools/media.ts |  | default? |  | Parse a cartridge image (.crt, e.g. |
| `extract_disk` | extract | server-tools/media.ts |  | default? |  | Extract files from a D64/G64 image into the project and write manifest.json. |
| `extract_disk_custom_lut` | extract | server-tools/media.ts |  | default? |  | Extract files indexed by a custom (non-DOS) LUT sector. |
| `extract_g64_raw_track` | extract | server-tools/disk-g64.ts |  | default? |  | Export the raw circular G64 half-track data for bit-level inspection. |
| `extract_g64_sectors` | extract | server-tools/disk-g64.ts |  | default? |  | Decode a G64 track via GCR and write one file per decoded sector for low-level inspection. |
| `get_artifact_lineage` | get | project-knowledge/mcp-tools.ts |  | default? |  | Return the V0..Vn version chain for an artifact (oldest→newest). |
| `get_project_profile` | get | project-knowledge/mcp-tools.ts |  | default? |  | Read the current project profile (platform, title, metadata). |
| `headless_drive_persist_writes` | headless | server-tools/headless.ts | Y | default? |  | Spec 062 Sprint 63 (Q4.C): write modified GCR tracks back to disk as <image>_session.g64. |
| `headless_drive_session_load_vsf` | headless | server-tools/headless.ts | Y | advanced? |  | Spec 062 Sprint 64: load a VSF file into a drive session. |
| `headless_drive_session_save_vsf` | headless | server-tools/headless.ts | Y | advanced? |  | Spec 062 Sprint 64: save the drive session's full state as a VICE Snapshot Format (VSF) file. |
| `headless_drive_session_start` | headless | server-tools/headless.ts | Y | advanced? |  | Spec 062 / R28 L3: open a standalone 1541 drive emulation session backed by a G64 image. |
| `headless_drive_status` | headless | server-tools/headless.ts | Y | default? |  | Spec 062 Sprint 63: snapshot of a drive session's CPU registers + head position + IRQ pending bits. |
| `headless_iec_bus_state` | headless | server-tools/headless.ts | Y | default? |  | Spec 062 Sprint 63: dump current IEC bus pin state for a drive session — line state (open-collector wired-AND result) plus each driver's contribution. |
| `headless_integrated_session_diagnose_mm` | headless | server-tools/headless.ts | Y | default? |  | Spec 093: open or reuse an integrated session, run Maniac Mansion (or any G64) until it reaches the title screen or a known stall heuristic fires (C64 stuck at  |
| `headless_integrated_session_joystick` | headless | server-tools/headless.ts |  | default? |  | Sprint 93.1: set joystick port 2 (CIA1 PA bits 0-4, active-low: up/down/left/right/fire). |
| `headless_integrated_session_load_prg` | headless | server-tools/headless.ts | Y | default? |  | Spec 062 Sprint 65: inject a PRG into the C64's RAM as if KERNAL LOAD had completed. |
| `headless_integrated_session_run` | headless | server-tools/headless.ts | Y | default? |  | Spec 062 Sprint 65: run an integrated session for up to N C64 instructions. |
| `headless_integrated_session_snapshot` | headless | server-tools/headless.ts | Y | default? |  | Spec 101 (M1.4): structured state snapshot of an integrated session — CPU + RAM + IEC + drive + keyboard + joystick. |
| `headless_integrated_session_start` | headless | server-tools/headless.ts |  | default? |  | Open an integrated C64+1541 drive session (the single product runtime: true-drive + VICE-shaped vice1541, microcoded CPU, event-catchup drive sync). |
| `headless_integrated_session_status` | headless | server-tools/headless.ts | Y | default? | runtime_status | Spec 062 Sprint 65: snapshot of an integrated session — both CPUs + IEC bus + ROM source. |
| `headless_integrated_session_type` | headless | server-tools/headless.ts |  | default? |  | Sprint 93.1: queue text typing into the integrated session's CIA1 keyboard matrix. |
| `headless_render_screen` | headless | server-tools/headless.ts | Y | default? | runtime_export_screenshot | Spec 065 Phase A: render the integrated session's current VIC state to a PNG file. |
| `import_analysis_report` | import | project-knowledge/mcp-tools.ts |  | default? |  | Import a saved analysis JSON artifact into structured entities and findings. |
| `import_annotations_as_findings` | import | server-tools/analysis-workflow.ts |  | default? |  | Turn an existing annotations file (routines + segment reclassifications) into project findings, one per routine and per reclassification. |
| `import_manifest_artifact` | import | project-knowledge/mcp-tools.ts |  | default? |  | Import a saved manifest artifact into structured entities, findings, and relations. |
| `inspect_address_range` | inspect | server-tools/inspect-range.ts |  | default? |  | Surface every static-analysis fact tied to a memory range — containing segments, VIC-register stores with decoded meaning, code xrefs into the range, copy routi |
| `inspect_disk` | inspect | server-tools/media.ts |  | default? |  | List the directory of a D64/G64 image WITHOUT extracting. |
| `inspect_g64_blocks` | inspect | server-tools/disk-g64.ts |  | default? |  | Inspect a G64 track or half-track at raw GCR block level and return JSON plus an ASCII ring map. |
| `inspect_g64_syncs` | inspect | server-tools/disk-g64.ts |  | default? |  | Inspect sync marks on a raw G64 half-track and report bit-aligned sync positions. |
| `inspect_g64_track` | inspect | server-tools/disk-g64.ts |  | default? |  | Decode a specific G64 track via GCR and report discovered sectors, missing IDs, duplicates, and raw track metadata. |
| `link_cart_chunk_to_asm` | link | server-tools/compression.ts |  | default? |  | Link a cartridge LUT chunk to a disassembly (.asm/.tass) artifact via a RelationRecord. |
| `link_entities` | link | project-knowledge/mcp-tools.ts |  | default? |  | Create a typed relation between two saved entities (e.g. |
| `link_payload_to_asm` | link | server-tools/payloads.ts |  | default? |  | Attach an ASM artifact to a payload entity when the automatic stem-match is wrong. |
| `link_payload_to_runtime` | link | server-tools/payloads.ts |  | default? |  | Record a runtime-trace artifact that proves where this payload lands at runtime. |
| `list_anti_patterns` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 031: list registered anti-patterns sorted by recency. |
| `list_artifacts` | list | server-tools/artifacts.ts |  | default? |  | List analysis artifacts (PRG, ASM, JSON, SYM, MD) in the project. |
| `list_build_pipelines` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 032: list registered build pipelines. |
| `list_container_entries` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 025 R23: list container sub-entries for a given parent artifact (or all containers if parent_artifact_id is omitted). |
| `list_entities` | list | project-knowledge/mcp-tools.ts |  | default? |  | List saved entities (routines, memory regions, banks, disk files, state vars), with optional filters. |
| `list_findings` | list | project-knowledge/mcp-tools.ts |  | default? |  | List saved findings (claims, hypotheses, confirmations, refutations), with optional filters. |
| `list_flows` | list | project-knowledge/mcp-tools.ts |  | default? |  | List saved flow / sequence models (load chains, control flows), with optional filters. |
| `list_g64_slots` | list | server-tools/disk-g64.ts |  | default? |  | List all G64 half-track slots, including raw offsets, lengths, and speed-zone metadata. |
| `list_loader_entrypoints` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 028: list declared loader entry points (optionally filtered to one artifact). |
| `list_loader_events` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 028: list recorded loader events. |
| `list_open_questions` | list | project-knowledge/mcp-tools.ts |  | default? |  | List saved open questions / ambiguities, with optional filters. |
| `list_patch_recipes` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 027: list patch recipes (optionally filtered by status or target artifact). |
| `list_payloads` | list | server-tools/payloads.ts |  | default? |  | List every payload entity in the project (extracted/loadable byte-blobs). |
| `list_project_artifacts` | list | project-knowledge/mcp-tools.ts |  | default? |  | List persisted artifacts from the project knowledge layer. |
| `list_relations` | list | project-knowledge/mcp-tools.ts |  | default? |  | List persisted relations from the project knowledge layer with optional filters. |
| `list_runtime_scenarios` | list | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 030: list defined scenarios. |
| `list_tasks` | list | project-knowledge/mcp-tools.ts |  | default? |  | List persisted project tasks from the project knowledge layer with optional filters. |
| `mark_segment_confirmed` | mark | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 053 (Bug 20): mark a sprite/charset/bitmap segment in *_analysis.json as confirmed by a render evidence. |
| `mark_segment_rejected` | mark | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 053 (Bug 20/21): mark a sprite/charset/bitmap segment in *_analysis.json as a false-positive analyzer classification. |
| `pack_bwc_bitstream` | pack | server-tools/bwc-bitstream.ts |  | default? |  | Pack a binary into a BWC bit-stream chunk that the original $C992 depacker can decompress. |
| `pack_bwc_raw` | pack | server-tools/bwc-bitstream.ts |  | default? |  | Pack a binary into the BWC raw chunk format. |
| `pack_byteboozer` | pack | server-tools/compression.ts |  | default? |  | Compress a file with ByteBoozer2 via the local b2 CLI. |
| `pack_byteboozer_native` | pack | server-tools/compression.ts |  | default? |  | Compress a file with the native TypeScript ByteBoozer tooling. |
| `pack_exomizer_raw` | pack | server-tools/compression.ts |  | default? |  | Compress a file with the built-in TypeScript Exomizer raw implementation. |
| `pack_exomizer_sfx` | pack | server-tools/compression.ts |  | default? |  | Compress one or more input files into an Exomizer self-extracting binary via the local exomizer CLI. |
| `pack_exomizer_shared_encoding` | pack | server-tools/compression.ts |  | default? |  | Discover or reuse a shared Exomizer encoding table in pure TypeScript, then pack many files without embedding the table in each payload. |
| `pack_rle` | pack | server-tools/compression.ts |  | default? |  | Compress a binary blob with the built-in C64 RLE format used by Mike's loader. |
| `pointer_report` | pointer | server-tools/analysis-workflow.ts |  | default? |  | Generate a pointer table facts report (markdown) from an analysis JSON. |
| `project_audit` | project | project-knowledge/mcp-tools.ts |  | default? |  | Read-only audit for project integrity: nested knowledge stores, missing/broken artifacts, unregistered files, unimported analysis/manifests, and stale UI views. |
| `project_checkpoint` | project | project-knowledge/mcp-tools.ts |  | default? |  | Create a durable checkpoint that snapshots the current investigation state and linked records. |
| `project_init` | project | project-knowledge/mcp-tools.ts |  | default? |  | Initialize a reverse-engineering project workspace with persistent knowledge, view, analysis, and session folders. |
| `project_repair` | project | project-knowledge/mcp-tools.ts |  | advanced? |  | Repair project knowledge integrity using audited safe operations. |
| `project_status` | project | project-knowledge/mcp-tools.ts |  | default? |  | Summarize the current project — knowledge counts + key filesystem paths. |
| `propose_annotations` | propose | server-tools/analysis-workflow.ts |  | default? |  | Generate a DRAFT annotations file (labels, segment reclassifications, routine names) from an analysis JSON + optional disasm. |
| `propose_question_resolutions` | propose | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 052: read-only proposal — list what the resolver would do for open auto-resolvable questions (Pfad A finding-overlap, Pfad B phase-reached). |
| `ram_report` | ram | server-tools/analysis-workflow.ts |  | default? |  | Generate a markdown RAM-state facts report from an analysis JSON (zero-page + RAM usage). |
| `read_artifact` | read | server-tools/artifacts.ts |  | default? |  | Read a generated artifact (ASM, JSON, SYM, MD) into context — C64 disassemblies are ≤64 KB and fit whole. |
| `read_g64_sector_candidate` | read | server-tools/disk-g64.ts |  | default? |  | Read a sector from a G64 track or half-track using a VICE-style 1541 sync/header search. |
| `reconstruct_lut` | reconstruct | server-tools/disk-g64.ts |  | advanced? |  | Reconstruct boot LUT payload groups from extracted CRT data. |
| `record_build_step_result` | record | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 032: record the outcome of a single build step (status + exit code + actual output hashes). |
| `record_cart_chunk_packer` | record | server-tools/compression.ts |  | default? |  | Persist packer / format / notes metadata for a cartridge LUT chunk. |
| `record_file_packer` | record | server-tools/compression.ts |  | default? |  | Persist packer / format / notes metadata into a disk or cart manifest so the workspace UI can render a packer tag and offer a depack-aware hex view. |
| `record_loader_event` | record | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 028: persist one observed loader call. |
| `record_runtime_event_summary` | record | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 030: persist a runtime-event summary for a scenario run. |
| `register_constraint` | register | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 029: declare a constraint rule. |
| `register_container_entry` | register | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 025 R23: declare a named sub-entry inside a container artifact (a disk file that itself contains other named payloads — Accolade /0, /1, etc.). |
| `register_existing_files` | register | server-tools/registration.ts |  | default? |  | Walk the project filesystem and register files that match one or more glob patterns into knowledge/artifacts.json. |
| `register_load_context` | register | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 023: register a runtime / after-decompression load context on an artifact. |
| `register_operation` | register | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 029: declare an operation that affects one or more resource regions (overlay-copy, flash-erase, bank-switch, etc.). |
| `register_payload` | register | server-tools/payloads.ts |  | default? |  | Create a payload entity — the working abstraction across mediums. |
| `register_resource_region` | register | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 029: declare a memory / cart / IO resource region for the constraint checker. |
| `rename_artifact_version` | rename | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 025: change an artifact's free-form versionLabel without touching bytes or hash. |
| `render_docs` | render | project-knowledge/mcp-tools.ts |  | default? |  | Render human-readable markdown summaries (findings, entities, open questions, anti-patterns, profile) under docs/. |
| `render_graphics_preview` | render | server-tools/graphics-render.ts |  | default? |  | Render a slice of a PRG (or any binary) as a PNG using one of the C64 graphics decoders (sprite, charset, bitmap, charmap). |
| `run_build_pipeline` | run | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 032 follow-up: orchestrate a build pipeline end-to-end. |
| `run_payload_reverse_workflow` | run | server-tools/analysis-workflow.ts |  | default? |  | Run the reverse-engineering workflow on a payload entity. |
| `run_prg_reverse_workflow` | run | server-tools/analysis-workflow.ts |  | default? |  | Run the full first-pass PRG reverse-engineering chain end-to-end: register, analyze, disassemble, RAM + pointer reports, import knowledge, rebuild views. |
| `runtime_audio_export` | runtime | server-tools/runtime.ts | Y | default? | runtime_export_audio | Spec 263 — render `duration_sec` PAL seconds of SID audio (resid synth) to a stereo s16le 44.1kHz WAV file. |
| `runtime_batch_results` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 271 — collect ReplayResult per scenario once batch is done. |
| `runtime_batch_status` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 271 — poll progress of a parallel batch. |
| `runtime_bookmark_add` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 242 — add trace bookmark with bind mode (cycle/event-key/both). |
| `runtime_bookmark_list` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 242 — list bookmarks for a run. |
| `runtime_breakpoint_add` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 241 — add PC breakpoint with VICE-style action (halt/log/snapshot/trace_burst). |
| `runtime_breakpoint_list` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 241 — list all registered breakpoints. |
| `runtime_breakpoint_remove` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 241 — remove breakpoint by id. |
| `runtime_diff_snapshots` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 246 — semantic diff between two VSF snapshot files. |
| `runtime_export_audio` | runtime | server-tools/runtime.ts | Y | default? | runtime_audio_export | Spec 269 / 263 — export WAV audio for a scenario. |
| `runtime_export_screenshot` | runtime | server-tools/runtime.ts | Y | default? | headless_render_screen | Spec 269 — export PNG screenshot for a scenario. |
| `runtime_export_video` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 269 — export MP4 video for a scenario via ffmpeg (must be installed). |
| `runtime_follow_path` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 233 — follow causal chain back from an event. |
| `runtime_input_load_config` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 264 — Load InputConfig from ~/.config/c64re/joystick.json, bootstrapping from vicerc if file absent. |
| `runtime_input_load_vicerc` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 264 — Parse ~/.config/vice/vicerc and return joystick keyset bindings (KeySet2*, JoyDevice2). |
| `runtime_input_save_config` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 264 — Save InputConfig to ~/.config/c64re/joystick.json. |
| `runtime_load_vsf` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 251 — restore full session state from VSF file. |
| `runtime_media_browse` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 265 — browse a directory and return filtered media entries (.d64 .g64 .crt .prg .vsf; .t64/.tap grayed). |
| `runtime_media_list_paths` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 265 — list configured fs roots for media browser (samples/, $C64RE_PROJECT_DIR, ~/Downloads, user-added). |
| `runtime_media_mount` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 265 — mount media file (.d64/.g64/.crt/.prg/.vsf) to a drive slot (8 or 9) on the active session. |
| `runtime_media_swap` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 265 — swap disk in slot (eject + mount new path, no reset). |
| `runtime_media_unmount` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 265 — eject media from drive slot. |
| `runtime_memory_access_map` | runtime | server-tools/runtime.ts |  | default? |  | Spike — per-region read/write liveness map over a runtime window. |
| `runtime_monitor_disasm` | runtime | server-tools/runtime.ts | Y | default? | vice_monitor_display | Spec 248 — disassemble N instructions starting at addr. |
| `runtime_monitor_memory` | runtime | server-tools/runtime.ts | Y | default? | vice_monitor_memory | Spec 248 — read raw memory range (c64 or drive). |
| `runtime_monitor_registers` | runtime | server-tools/runtime.ts | Y | default? | vice_monitor_registers | Spec 248 — read CPU registers (c64 or drive). |
| `runtime_profile_loader` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 245 — fastloader / protection profiling. |
| `runtime_promote_branch` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 — promote a transient rewind branch to a persistent Scenario record. |
| `runtime_query_events` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 232 — query event-indexed trace store. |
| `runtime_regression_capture_baseline` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 250 — LLM-explicit baseline capture for a scenario. |
| `runtime_regression_compare` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 250 — compare current scenario run against captured baseline. |
| `runtime_resolve_pc` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 235 — resolve PC to project label/routine/segment/source-line. |
| `runtime_run_scenario` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 / 231 — replay a saved scenario by id, returns ReplayResult hashes. |
| `runtime_run_scenarios_parallel` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 271 — run multiple scenarios in parallel via worker_threads. |
| `runtime_save_vsf` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 251 — save full session state as VICE Snapshot Format bytes. |
| `runtime_scan_fingerprints` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 247 — match routine bytes against bundled/TREX/local fingerprint libraries. |
| `runtime_scenario_delete` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 — delete a scenario JSON by id. |
| `runtime_scenario_list` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 — list scenarios from samples/scenarios/ and $C64RE_PROJECT_DIR/scenarios/. |
| `runtime_scenario_load` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 — load a single scenario by id. |
| `runtime_scenario_save` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 — save a scenario JSON to project dir (or samples if no project dir). |
| `runtime_snapshot_tree` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 268 — return the full branch tree for a rewind session. |
| `runtime_status` | runtime | server-tools/runtime.ts | Y | default? | headless_integrated_session_status | Spec 237 — AgentQueryApi facade introspection. |
| `runtime_step_into` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 248 — single-step one instruction. |
| `runtime_step_over` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 248 — defensive step-over with stack-watch + cycle budget. |
| `runtime_swimlane_slice` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 234 — transaction-level swimlane (cpu+bus+drive). |
| `runtime_trace_taint` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 244 — taint analysis / dataflow. |
| `runtime_until` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 248 — run until PC reaches target addr or budget exhausted. |
| `runtime_vic_inspect_at` | runtime | server-tools/runtime.ts | Y | default? |  | Spec 710 — resolve a frozen C64 display-area pixel to exact VIC/RAM provenance |
| `sandbox_6502_run` | sandbox | server-tools/sandbox.ts |  | advanced? |  | Run a 6502 routine in an isolated sandbox: load code/data into a flat 64K RAM, optionally hook PCs to feed bytes from an input stream (e.g. |
| `sandbox_depack` | sandbox | server-tools/sandbox-depack.ts |  | advanced? |  | Generic sandbox-driven depacker. |
| `save_anti_pattern` | save | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 031: record a 'do not try this again' anti-pattern. |
| `save_artifact` | save | project-knowledge/mcp-tools.ts |  | default? |  | Persist an input, generated, analysis, or view artifact in the project knowledge layer. |
| `save_build_pipeline` | save | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 032 / R24: define an ordered build pipeline (assemble -> patch -> pack -> CRT etc.) with step input/output artifact ids and expected hashes. |
| `save_entity` | save | project-knowledge/mcp-tools.ts |  | default? |  | Persist a structured entity — a named routine, memory region, bank, disk file, or state variable. |
| `save_finding` | save | project-knowledge/mcp-tools.ts |  | default? |  | Persist a semantic finding — a claim, hypothesis, confirmation, or refutation — with your confidence. |
| `save_flow` | save | project-knowledge/mcp-tools.ts |  | default? |  | Persist a flow or sequence model with explicit nodes and edges. |
| `save_open_question` | save | project-knowledge/mcp-tools.ts |  | default? |  | Persist an open question / ambiguity to resolve later. |
| `save_patch_recipe` | save | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 027: persist a binary patch recipe with byte-level assertions. |
| `save_project_profile` | save | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 026: persist a structured project profile (goals, non-goals, hardware constraints, destructive operations, build/test commands, danger zones, glossary, ant |
| `save_task` | save | project-knowledge/mcp-tools.ts |  | default? |  | Persist a project task, next action, or investigation item in structured form. |
| `scan_g64_headers` | scan | server-tools/disk-g64.ts |  | default? |  | Scan a G64 track or half-track like VICE's 1541 sector-header search and list discovered header candidates. |
| `scan_graphics_candidates` | scan | server-tools/graphics-render.ts |  | default? |  | Render a sweep of PNG previews across an address window — every `step` bytes, multiple kinds (sprite/charset, hires + multicolor) — so a multimodal LLM can scru |
| `scan_registration_delta` | scan | server-tools/registration.ts |  | default? |  | Read-only: scan the project filesystem for files that match c64re's known artifact extensions but are not registered in knowledge/artifacts.json. |
| `set_artifact_relevance` | set | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 041: tag an artifact with a relevance value (loader \| protection \| save \| kernal \| asset \| other). |
| `set_payload_disk_hint` | set | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 037: tag a payload entity with a disk-hint (drive-code \| protected \| raw-unanalyzed \| bad-crc \| gap). |
| `snapshot_artifact_before_overwrite` | snapshot | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 025: snapshot the on-disk bytes of an artifact to <root>/snapshots/<id>/<hash>.bin BEFORE overwriting the file. |
| `start_build_run` | start | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 032: start a build run for a pipeline. |
| `start_re_workflow` | start | server-tools/agent-workflow.ts |  | default? |  | Choose the reverse-engineering workflow template (full-re \| cracker-only \| analyst-deep \| targeted-routine \| bugfix), which sets the required phases per artifac |
| `suggest_depacker` | suggest | server-tools/compression.ts |  | default? |  | Probe a file or byte-range and suggest likely depackers (RLE, Exomizer raw, ByteBoozer-like). |
| `suggest_disk_lut_sector` | suggest | server-tools/media.ts |  | default? |  | Heuristic scan: look at every sector for plausible fixed-stride LUT entry tables and rank by confidence. |
| `trace_store_anchor_find` | trace | server-tools/trace-store.ts |  | advanced? |  | List occurrences of a single anchor by name. |
| `trace_store_anchor_list` | trace | server-tools/trace-store.ts |  | advanced? |  | List all anchors in a trace store with occurrence counts and clock range. |
| `trace_store_bus_find` | trace | server-tools/trace-store.ts |  | advanced? |  | List bus_events at a target address (read+write+RMW). |
| `trace_store_info` | trace | server-tools/trace-store.ts |  | advanced? |  | Summarize a trace-store: meta, table counts, master_clock range. |
| `trace_store_query` | trace | server-tools/trace-store.ts |  | advanced? |  | Run a read-only SELECT/WITH SQL query against the trace store. |
| `trace_store_top_pcs` | trace | server-tools/trace-store.ts |  | advanced? |  | Return the top-N most-frequent PCs for a given CPU side (c64 \| drive8). |
| `try_depack` | try | server-tools/compression.ts |  | default? |  | Run one specific depacker against a file or byte-range (built-in RLE, Exomizer raw, host-side ByteBoozer2). |
| `update_task_status` | update | project-knowledge/mcp-tools.ts |  | default? |  | Update the status of an existing task in the knowledge layer. |
| `verify_constraints` | verify | project-knowledge/mcp-tools.ts | Y | default? |  | Spec 029: run the built-in constraint checker. |
| `vice_debug_run` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_backtrace` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_bank` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_binary_save` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_breakpoint_add` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_breakpoint_delete` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_breakpoint_list` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_continue` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_display` | vice | server-tools/vice.ts |  | advanced? | runtime_monitor_disasm | Oracle-only (VICE ground-truth). |
| `vice_monitor_memory` | vice | server-tools/vice.ts |  | advanced? | runtime_monitor_memory | Oracle-only (VICE ground-truth). |
| `vice_monitor_next` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_registers` | vice | server-tools/vice.ts |  | advanced? | runtime_monitor_registers | Oracle-only (VICE ground-truth). |
| `vice_monitor_reset` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_save` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_set_registers` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_snapshot` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_step` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_monitor_write_memory` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_session_attach_media` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_session_joystick` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_session_send_keys` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_session_start` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_session_status` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_session_stop` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_add_note` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_analyze_last_session` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_build_context_index` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_build_index` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_build_pyramid_index` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_call_path` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_context_writes` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_find_bytes` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_find_memory_access` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_find_operand` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_find_pc` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_find_phase_changes` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_follow_from_pc` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_hotspots` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_list_contexts` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_list_notes` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_runtime_start` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_slice` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_slice_context` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_start` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_status` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_stop` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_stop_and_analyze` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_zoom_overview` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
| `vice_trace_zoom_window` | vice | server-tools/vice.ts |  | advanced? |  | Oracle-only (VICE ground-truth). |
