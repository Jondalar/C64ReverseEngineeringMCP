# MCP tool-surface inventory (Spec 722.1)

**Date:** 2026-05-29. Audit-only, generated from the actual `server.tool(...)` calls in `src/server-tools/**`. No code change.

**North star:** an LLM outside the C64RE dev repo must use the MCP without guessing between historical/dev/debug tools.

## Totals
- **191** registered tools.
- **64** (34%) have a `Spec NNN` in the description (history-encoded, not capability-first).
- **63** are advanced-tier candidates (vice / maintenance / drive-only / sandbox).
- Default-candidate (façade/workflow): **128**.

## By namespace

| namespace | tools |
|-----------|-------|
| `vice_*` | 49 |
| `runtime_*` | 48 |
| `headless_*` | 15 |
| `depack_*` | 8 |
| `pack_*` | 8 |
| `trace_*` | 6 |
| `extract_*` | 5 |
| `inspect_*` | 5 |
| `agent_*` | 4 |
| `link_*` | 3 |
| `list_*` | 3 |
| `scan_*` | 3 |
| `analyze_*` | 2 |
| `bulk_*` | 2 |
| `c64ref_*` | 2 |
| `disasm_*` | 2 |
| `read_*` | 2 |
| `record_*` | 2 |
| `register_*` | 2 |
| `run_*` | 2 |
| `sandbox_*` | 2 |
| `suggest_*` | 2 |
| `assemble_*` | 1 |
| `build_*` | 1 |
| `c64re_*` | 1 |
| `compare_*` | 1 |
| `disk_*` | 1 |
| `export_*` | 1 |
| `import_*` | 1 |
| `pointer_*` | 1 |
| `propose_*` | 1 |
| `ram_*` | 1 |
| `reconstruct_*` | 1 |
| `render_*` | 1 |
| `start_*` | 1 |
| `try_*` | 1 |

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
| `agent_onboard` | agent | agent-workflow.ts |  | default? |  | Reload persistent project state at session start (or after context loss). |
| `agent_propose_next` | agent | agent-workflow.ts | Y | default? |  | [Phase agnostic] Read-only: examine workflow phases, open tasks, open questions, and current agent-state to propose ranked next actions. |
| `agent_record_step` | agent | agent-workflow.ts |  | default? |  | Record a completed step and (optionally) queue the next action. |
| `agent_set_role` | agent | agent-workflow.ts |  | default? |  | Set the cognitive role for the current agent session (analyst, cartographer, implementer). |
| `analyze_g64_anomalies` | analyze | disk-g64.ts |  | default? |  | Scan a G64 image track-by-track and report duplicate, missing, unexpected, or invalid decoded sectors. |
| `analyze_prg` | analyze | analysis-workflow.ts |  | default? |  | STEP 1 of the C64 RE workflow. |
| `assemble_source` | assemble | assembly.ts |  | default? |  | Assemble a generated KickAssembler .asm or 64tass .tass file and optionally compare the rebuilt binary against an original PRG. |
| `build_tools` | build | artifacts.ts |  | default? |  | Compile the TRXDis pipeline (npm run build). |
| `bulk_create_cart_chunk_payloads` | bulk | payloads.ts |  | advanced? |  | Walk the cartridge-layout view |
| `bulk_import_analysis_reports` | bulk | registration.ts |  | advanced? |  | Walk every analysis-run artifact in the project and call import_analysis_report on those whose entities are not yet back-linked. |
| `c64re_whats_next` | c64re | agent-workflow.ts | Y | default? |  | Spec 043: the permanent nudger — call after every user turn (Spec 044 setup wires this into the agent config). |
| `c64ref_build_rom_knowledge` | c64ref | reference.ts |  | default? |  | Fetch and rebuild the local BASIC/KERNAL ROM knowledge snapshot from mist64/c64ref sources. |
| `c64ref_lookup` | c64ref | reference.ts |  | default? |  | Look up BASIC/KERNAL ROM knowledge by address or search term from the local c64ref snapshot. |
| `compare_exomizer_shared_encoding_sets` | compare | compression.ts |  | default? |  | Compare one or more shared-encoding manifest sets, e.g. |
| `depack_bwc_bitstream` | depack | bwc-bitstream.ts |  | default? |  | Depack a BWC bit-stream chunk (Pucrunch-derived format with |
| `depack_bwc_chunk` | depack | bwc-bitstream.ts |  | default? |  | Auto-dispatch on the first two bytes: |
| `depack_bwc_raw` | depack | bwc-bitstream.ts |  | default? |  | Depack a BWC raw chunk (uncompressed). |
| `depack_byteboozer` | depack | compression.ts |  | default? |  | Decompress a ByteBoozer2 raw .b2 file or executable wrapper in pure TypeScript. |
| `depack_byteboozer_lykia` | depack | compression.ts |  | default? |  | Decompress a Lykia-variant ByteBoozer2 stream (modified 4-byte header: dest_lo, dest_hi, end_lo, end_hi; BB2_BITBUF seeded from supplied dest_hi). |
| `depack_exomizer_raw` | depack | compression.ts |  | default? |  | Decompress an Exomizer raw stream via the built-in TypeScript implementation. |
| `depack_exomizer_sfx` | depack | compression.ts |  | default? |  | Decompress an Exomizer self-extracting wrapper via the built-in TypeScript 6502-emulated depacker. |
| `depack_rle` | depack | compression.ts |  | default? |  | Decompress the built-in C64 RLE format used by Mike |
| `disasm_menu` | disasm | disk-g64.ts |  | default? |  | Generate KickAssembler sources for all menu payloads. |
| `disasm_prg` | disasm | analysis-workflow.ts |  | default? |  | STEP 2 of the C64 RE workflow. |
| `disk_sector_allocation` | disk | media.ts |  | default? |  | Walk an extracted disk manifest and report sector ownership per T/S: system (BAM/dir), kernal_file, custom_file, unclaimed_padding, orphan_data. |
| `export_menu` | export | disk-g64.ts |  | default? |  | Export menu payload binaries from extracted CRT data. |
| `extract_crt` | extract | media.ts |  | default? |  | Parse an EasyFlash CRT image, extract per-bank binaries and manifest. |
| `extract_disk` | extract | media.ts |  | default? |  | Extract files from a D64 or G64 image into a project directory and write a manifest.json. |
| `extract_disk_custom_lut` | extract | media.ts |  | default? |  | Extract files indexed by a custom (non-DOS) LUT sector. |
| `extract_g64_raw_track` | extract | disk-g64.ts |  | default? |  | Export the raw circular G64 half-track data for bit-level inspection. |
| `extract_g64_sectors` | extract | disk-g64.ts |  | default? |  | Decode a G64 track via GCR and write one file per decoded sector for low-level inspection. |
| `headless_drive_persist_writes` | headless | headless.ts | Y | default? |  | Spec 062 Sprint 63 (Q4.C): write modified GCR tracks back to disk as <image>_session.g64. |
| `headless_drive_session_load_vsf` | headless | headless.ts | Y | advanced? |  | Spec 062 Sprint 64: load a VSF file into a drive session. |
| `headless_drive_session_save_vsf` | headless | headless.ts | Y | advanced? |  | Spec 062 Sprint 64: save the drive session |
| `headless_drive_session_start` | headless | headless.ts | Y | advanced? |  | Spec 062 / R28 L3: open a standalone 1541 drive emulation session backed by a G64 image. |
| `headless_drive_status` | headless | headless.ts | Y | default? |  | Spec 062 Sprint 63: snapshot of a drive session |
| `headless_iec_bus_state` | headless | headless.ts | Y | default? |  | Spec 062 Sprint 63: dump current IEC bus pin state for a drive session — line state (open-collector wired-AND result) plus each driver |
| `headless_integrated_session_diagnose_mm` | headless | headless.ts | Y | default? |  | Spec 093: open or reuse an integrated session, run Maniac Mansion (or any G64) until it reaches the title screen or a known stall heuristic fires (C64 stuck at  |
| `headless_integrated_session_joystick` | headless | headless.ts |  | default? |  | Sprint 93.1: set joystick port 2 (CIA1 PA bits 0-4, active-low: up/down/left/right/fire). |
| `headless_integrated_session_load_prg` | headless | headless.ts | Y | default? |  | Spec 062 Sprint 65: inject a PRG into the C64 |
| `headless_integrated_session_run` | headless | headless.ts | Y | default? |  | Spec 062 Sprint 65: run an integrated session for up to N C64 instructions. |
| `headless_integrated_session_snapshot` | headless | headless.ts | Y | default? |  | Spec 101 (M1.4): structured state snapshot of an integrated session — CPU + RAM + IEC + drive + keyboard + joystick. |
| `headless_integrated_session_start` | headless | headless.ts |  | default? |  | Open an integrated C64+1541 drive session (the single product runtime: true-drive + VICE-shaped vice1541, microcoded CPU, event-catchup drive sync). |
| `headless_integrated_session_status` | headless | headless.ts | Y | default? | runtime_status | Spec 062 Sprint 65: snapshot of an integrated session — both CPUs + IEC bus + ROM source. |
| `headless_integrated_session_type` | headless | headless.ts |  | default? |  | Sprint 93.1: queue text typing into the integrated session |
| `headless_render_screen` | headless | headless.ts | Y | default? | runtime_export_screenshot | Spec 065 Phase A: render the integrated session |
| `import_annotations_as_findings` | import | analysis-workflow.ts | Y | default? |  | Spec 055 R25: walk *_annotations.json routines[] + segments[] and emit one finding per routine and per segment-reclassification. |
| `inspect_address_range` | inspect | inspect-range.ts |  | default? |  | Surface every static-analysis fact connected to a memory range: containing segments, all VIC-register stores in the program (D011/D015/D016/D018/D020-D02E/DD00  |
| `inspect_disk` | inspect | media.ts |  | default? |  | Read a D64 or G64 directory and list the contained files without extracting them. |
| `inspect_g64_blocks` | inspect | disk-g64.ts |  | default? |  | Inspect a G64 track or half-track at raw GCR block level and return JSON plus an ASCII ring map. |
| `inspect_g64_syncs` | inspect | disk-g64.ts |  | default? |  | Inspect sync marks on a raw G64 half-track and report bit-aligned sync positions. |
| `inspect_g64_track` | inspect | disk-g64.ts |  | default? |  | Decode a specific G64 track via GCR and report discovered sectors, missing IDs, duplicates, and raw track metadata. |
| `link_cart_chunk_to_asm` | link | compression.ts |  | default? |  | Link a cartridge LUT chunk to a disassembly (.asm/.tass) artifact via a RelationRecord. |
| `link_payload_to_asm` | link | payloads.ts |  | default? |  | Append an asm artifact to an existing payload |
| `link_payload_to_runtime` | link | payloads.ts |  | default? |  | Record a runtime-trace artifact that proves where this payload lands at runtime. |
| `list_artifacts` | list | artifacts.ts |  | default? |  | List analysis artifacts (PRG, ASM, JSON, SYM, MD files) in a project subdirectory. |
| `list_g64_slots` | list | disk-g64.ts |  | default? |  | List all G64 half-track slots, including raw offsets, lengths, and speed-zone metadata. |
| `list_payloads` | list | payloads.ts |  | default? |  | List all payload entities in the project. |
| `pack_bwc_bitstream` | pack | bwc-bitstream.ts |  | default? |  | Pack a binary into a BWC bit-stream chunk that the original $C992 depacker can decompress. |
| `pack_bwc_raw` | pack | bwc-bitstream.ts |  | default? |  | Pack a binary into the BWC raw chunk format. |
| `pack_byteboozer` | pack | compression.ts |  | default? |  | Compress a file with ByteBoozer2 via the local b2 CLI. |
| `pack_byteboozer_native` | pack | compression.ts |  | default? |  | Compress a file with the native TypeScript ByteBoozer tooling. |
| `pack_exomizer_raw` | pack | compression.ts |  | default? |  | Compress a file with the built-in TypeScript Exomizer raw implementation. |
| `pack_exomizer_sfx` | pack | compression.ts |  | default? |  | Compress one or more input files into an Exomizer self-extracting binary via the local exomizer CLI. |
| `pack_exomizer_shared_encoding` | pack | compression.ts |  | default? |  | Discover or reuse a shared Exomizer encoding table in pure TypeScript, then pack many files without embedding the table in each payload. |
| `pack_rle` | pack | compression.ts |  | default? |  | Compress a binary blob with the built-in C64 RLE format used by Mike |
| `pointer_report` | pointer | analysis-workflow.ts |  | default? |  | Generate a pointer table facts report (markdown) from an analysis JSON. |
| `propose_annotations` | propose | analysis-workflow.ts | Y | default? |  | Spec 042: emit a draft *_annotations.draft.json by walking *_analysis.json + (optional) *_disasm.asm. |
| `ram_report` | ram | analysis-workflow.ts |  | default? |  | Generate a RAM state facts report (markdown) from an analysis JSON. |
| `read_artifact` | read | artifacts.ts |  | default? |  | Read a generated artifact (ASM, JSON, SYM, MD). |
| `read_g64_sector_candidate` | read | disk-g64.ts |  | default? |  | Read a sector from a G64 track or half-track using a VICE-style 1541 sync/header search. |
| `reconstruct_lut` | reconstruct | disk-g64.ts |  | advanced? |  | Reconstruct boot LUT payload groups from extracted CRT data. |
| `record_cart_chunk_packer` | record | compression.ts |  | default? |  | Persist packer / format / notes metadata for a cartridge LUT chunk. |
| `record_file_packer` | record | compression.ts |  | default? |  | Persist packer / format / notes metadata into a disk or cart manifest so the workspace UI can render a packer tag and offer a depack-aware hex view. |
| `register_existing_files` | register | registration.ts |  | default? |  | Walk the project filesystem and register files that match one or more glob patterns into knowledge/artifacts.json. |
| `register_payload` | register | payloads.ts |  | default? |  | Create a payload entity — the working abstraction across mediums. |
| `render_graphics_preview` | render | graphics-render.ts |  | default? |  | Render a slice of a PRG (or any binary) as a PNG using one of the C64 graphics decoders (sprite, charset, bitmap, charmap). |
| `run_payload_reverse_workflow` | run | analysis-workflow.ts |  | default? |  | Run the reverse-engineering workflow on a payload entity. |
| `run_prg_reverse_workflow` | run | analysis-workflow.ts |  | default? |  | Run the full first-pass PRG reverse-engineering workflow: register input, analyze, disassemble, generate RAM and pointer reports, import knowledge, and rebuild  |
| `runtime_audio_export` | runtime | runtime.ts | Y | default? | runtime_export_audio | Spec 263 — render |
| `runtime_batch_results` | runtime | runtime.ts | Y | default? |  | Spec 271 — collect ReplayResult per scenario once batch is done. |
| `runtime_batch_status` | runtime | runtime.ts | Y | default? |  | Spec 271 — poll progress of a parallel batch. |
| `runtime_bookmark_add` | runtime | runtime.ts | Y | default? |  | Spec 242 — add trace bookmark with bind mode (cycle/event-key/both). |
| `runtime_bookmark_list` | runtime | runtime.ts | Y | default? |  | Spec 242 — list bookmarks for a run. |
| `runtime_breakpoint_add` | runtime | runtime.ts | Y | default? |  | Spec 241 — add PC breakpoint with VICE-style action (halt/log/snapshot/trace_burst). |
| `runtime_breakpoint_list` | runtime | runtime.ts | Y | default? |  | Spec 241 — list all registered breakpoints. |
| `runtime_breakpoint_remove` | runtime | runtime.ts | Y | default? |  | Spec 241 — remove breakpoint by id. |
| `runtime_diff_snapshots` | runtime | runtime.ts | Y | default? |  | Spec 246 — semantic diff between two VSF snapshot files. |
| `runtime_export_audio` | runtime | runtime.ts | Y | default? | runtime_audio_export | Spec 269 / 263 — export WAV audio for a scenario. |
| `runtime_export_screenshot` | runtime | runtime.ts | Y | default? | headless_render_screen | Spec 269 — export PNG screenshot for a scenario. |
| `runtime_export_video` | runtime | runtime.ts | Y | default? |  | Spec 269 — export MP4 video for a scenario via ffmpeg (must be installed). |
| `runtime_follow_path` | runtime | runtime.ts | Y | default? |  | Spec 233 — follow causal chain back from an event. |
| `runtime_input_load_config` | runtime | runtime.ts | Y | default? |  | Spec 264 — Load InputConfig from ~/.config/c64re/joystick.json, bootstrapping from vicerc if file absent. |
| `runtime_input_load_vicerc` | runtime | runtime.ts | Y | default? |  | Spec 264 — Parse ~/.config/vice/vicerc and return joystick keyset bindings (KeySet2*, JoyDevice2). |
| `runtime_input_save_config` | runtime | runtime.ts | Y | default? |  | Spec 264 — Save InputConfig to ~/.config/c64re/joystick.json. |
| `runtime_load_vsf` | runtime | runtime.ts | Y | default? |  | Spec 251 — restore full session state from VSF file. |
| `runtime_media_browse` | runtime | runtime.ts | Y | default? |  | Spec 265 — browse a directory and return filtered media entries (.d64 .g64 .crt .prg .vsf; .t64/.tap grayed). |
| `runtime_media_list_paths` | runtime | runtime.ts | Y | default? |  | Spec 265 — list configured fs roots for media browser (samples/, $C64RE_PROJECT_DIR, ~/Downloads, user-added). |
| `runtime_media_mount` | runtime | runtime.ts | Y | default? |  | Spec 265 — mount media file (.d64/.g64/.crt/.prg/.vsf) to a drive slot (8 or 9) on the active session. |
| `runtime_media_swap` | runtime | runtime.ts | Y | default? |  | Spec 265 — swap disk in slot (eject + mount new path, no reset). |
| `runtime_media_unmount` | runtime | runtime.ts | Y | default? |  | Spec 265 — eject media from drive slot. |
| `runtime_memory_access_map` | runtime | runtime.ts |  | default? |  | Spike — per-region read/write liveness map over a runtime window. |
| `runtime_monitor_disasm` | runtime | runtime.ts | Y | default? | vice_monitor_display | Spec 248 — disassemble N instructions starting at addr. |
| `runtime_monitor_memory` | runtime | runtime.ts | Y | default? | vice_monitor_memory | Spec 248 — read raw memory range (c64 or drive). |
| `runtime_monitor_registers` | runtime | runtime.ts | Y | default? | vice_monitor_registers | Spec 248 — read CPU registers (c64 or drive). |
| `runtime_profile_loader` | runtime | runtime.ts | Y | default? |  | Spec 245 — fastloader / protection profiling. |
| `runtime_promote_branch` | runtime | runtime.ts | Y | default? |  | Spec 268 — promote a transient rewind branch to a persistent Scenario record. |
| `runtime_query_events` | runtime | runtime.ts | Y | default? |  | Spec 232 — query event-indexed trace store. |
| `runtime_regression_capture_baseline` | runtime | runtime.ts | Y | default? |  | Spec 250 — LLM-explicit baseline capture for a scenario. |
| `runtime_regression_compare` | runtime | runtime.ts | Y | default? |  | Spec 250 — compare current scenario run against captured baseline. |
| `runtime_resolve_pc` | runtime | runtime.ts | Y | default? |  | Spec 235 — resolve PC to project label/routine/segment/source-line. |
| `runtime_run_scenario` | runtime | runtime.ts | Y | default? |  | Spec 268 / 231 — replay a saved scenario by id, returns ReplayResult hashes. |
| `runtime_run_scenarios_parallel` | runtime | runtime.ts | Y | default? |  | Spec 271 — run multiple scenarios in parallel via worker_threads. |
| `runtime_save_vsf` | runtime | runtime.ts | Y | default? |  | Spec 251 — save full session state as VICE Snapshot Format bytes. |
| `runtime_scan_fingerprints` | runtime | runtime.ts | Y | default? |  | Spec 247 — match routine bytes against bundled/TREX/local fingerprint libraries. |
| `runtime_scenario_delete` | runtime | runtime.ts | Y | default? |  | Spec 268 — delete a scenario JSON by id. |
| `runtime_scenario_list` | runtime | runtime.ts | Y | default? |  | Spec 268 — list scenarios from samples/scenarios/ and $C64RE_PROJECT_DIR/scenarios/. |
| `runtime_scenario_load` | runtime | runtime.ts | Y | default? |  | Spec 268 — load a single scenario by id. |
| `runtime_scenario_save` | runtime | runtime.ts | Y | default? |  | Spec 268 — save a scenario JSON to project dir (or samples if no project dir). |
| `runtime_snapshot_tree` | runtime | runtime.ts | Y | default? |  | Spec 268 — return the full branch tree for a rewind session. |
| `runtime_status` | runtime | runtime.ts | Y | default? | headless_integrated_session_status | Spec 237 — AgentQueryApi facade introspection. |
| `runtime_step_into` | runtime | runtime.ts | Y | default? |  | Spec 248 — single-step one instruction. |
| `runtime_step_over` | runtime | runtime.ts | Y | default? |  | Spec 248 — defensive step-over with stack-watch + cycle budget. |
| `runtime_swimlane_slice` | runtime | runtime.ts | Y | default? |  | Spec 234 — transaction-level swimlane (cpu+bus+drive). |
| `runtime_trace_taint` | runtime | runtime.ts | Y | default? |  | Spec 244 — taint analysis / dataflow. |
| `runtime_until` | runtime | runtime.ts | Y | default? |  | Spec 248 — run until PC reaches target addr or budget exhausted. |
| `runtime_vic_inspect_at` | runtime | runtime.ts | Y | default? |  | Spec 710 — resolve a frozen C64 display-area pixel to exact VIC/RAM provenance |
| `sandbox_6502_run` | sandbox | sandbox.ts |  | advanced? |  | Run a 6502 routine in an isolated sandbox: load code/data into a flat 64K RAM, optionally hook PCs to feed bytes from an input stream (e.g. |
| `sandbox_depack` | sandbox | sandbox-depack.ts |  | advanced? |  | Generic sandbox-driven depacker. |
| `scan_g64_headers` | scan | disk-g64.ts |  | default? |  | Scan a G64 track or half-track like VICE |
| `scan_graphics_candidates` | scan | graphics-render.ts |  | default? |  | Render a sweep of PNG previews across an address window — every |
| `scan_registration_delta` | scan | registration.ts |  | default? |  | Read-only: scan the project filesystem for files that match c64re |
| `start_re_workflow` | start | agent-workflow.ts | Y | default? |  | Spec 046: pick a workflow template (full-re \| cracker-only \| analyst-deep \| targeted-routine \| bugfix). |
| `suggest_depacker` | suggest | compression.ts |  | default? |  | Probe a file or a sliced subrange and suggest likely depackers such as RLE, Exomizer raw, or ByteBoozer-like wrappers. |
| `suggest_disk_lut_sector` | suggest | media.ts |  | default? |  | Heuristic scan: look at every sector for plausible fixed-stride LUT entry tables and rank by confidence. |
| `trace_store_anchor_find` | trace | trace-store.ts |  | advanced? |  | List occurrences of a single anchor by name. |
| `trace_store_anchor_list` | trace | trace-store.ts |  | advanced? |  | List all anchors in a trace store with occurrence counts and clock range. |
| `trace_store_bus_find` | trace | trace-store.ts |  | advanced? |  | List bus_events at a target address (read+write+RMW). |
| `trace_store_info` | trace | trace-store.ts |  | advanced? |  | Summarize a trace-store: meta, table counts, master_clock range. |
| `trace_store_query` | trace | trace-store.ts |  | advanced? |  | Run a read-only SELECT/WITH SQL query against the trace store. |
| `trace_store_top_pcs` | trace | trace-store.ts |  | advanced? |  | Return the top-N most-frequent PCs for a given CPU side (c64 \| drive8). |
| `try_depack` | try | compression.ts |  | default? |  | Try a specific depacker against a file or sliced subrange. |
| `vice_debug_run` | vice | vice.ts |  | advanced? |  | Set execution breakpoints in the active VICE session, continue execution, and return when a breakpoint, stop, or JAM event occurs. |
| `vice_monitor_backtrace` | vice | vice.ts |  | advanced? |  | Build a heuristic call stack from the 6502 stack page in the active VICE session. |
| `vice_monitor_bank` | vice | vice.ts |  | advanced? |  | List the available VICE memory banks for the active machine. |
| `vice_monitor_binary_save` | vice | vice.ts |  | advanced? |  | Save a memory range from the active VICE session as a raw binary file without a load-address header. |
| `vice_monitor_breakpoint_add` | vice | vice.ts |  | advanced? |  | Add a breakpoint/watchpoint/tracepoint in the active VICE session. |
| `vice_monitor_breakpoint_delete` | vice | vice.ts |  | advanced? |  | Delete a checkpoint from the active VICE session. |
| `vice_monitor_breakpoint_list` | vice | vice.ts |  | advanced? |  | List checkpoints currently configured in the active VICE session. |
| `vice_monitor_continue` | vice | vice.ts |  | advanced? |  | Resume execution in the active VICE session until the next breakpoint or manual stop. |
| `vice_monitor_display` | vice | vice.ts |  | advanced? | runtime_monitor_disasm | Capture the current VICE display buffer and save it as an 8-bit grayscale PGM preview plus JSON metadata. |
| `vice_monitor_memory` | vice | vice.ts |  | advanced? | runtime_monitor_memory | Read a memory range from the active VICE session. |
| `vice_monitor_next` | vice | vice.ts |  | advanced? |  | Advance the active VICE session by one instruction, stepping over subroutine calls. |
| `vice_monitor_registers` | vice | vice.ts |  | advanced? | runtime_monitor_registers | Read CPU register values from the active VICE session. |
| `vice_monitor_reset` | vice | vice.ts |  | advanced? |  | Reset the active VICE machine or one of its drives. |
| `vice_monitor_save` | vice | vice.ts |  | advanced? |  | Save a memory range from the active VICE session as a PRG file with a load-address header. |
| `vice_monitor_set_registers` | vice | vice.ts |  | advanced? |  | Set CPU register values in the active VICE session. |
| `vice_monitor_snapshot` | vice | vice.ts |  | advanced? |  | Save a VICE snapshot (.vsf) from the active session. |
| `vice_monitor_step` | vice | vice.ts |  | advanced? |  | Advance the active VICE session by one instruction and stop again. |
| `vice_monitor_write_memory` | vice | vice.ts |  | advanced? |  | Write bytes into the active VICE session memory. |
| `vice_session_attach_media` | vice | vice.ts |  | advanced? |  | Autostart or autoload media into an already running VICE session via the binary monitor. |
| `vice_session_joystick` | vice | vice.ts |  | advanced? |  | Send keyset-based joystick input into the active visible VICE session. |
| `vice_session_send_keys` | vice | vice.ts |  | advanced? |  | Feed text, PETSCII bytes, or named special keys into the active VICE keyboard buffer. |
| `vice_session_start` | vice | vice.ts |  | advanced? |  | Start a visible x64sc VICE session using a copied user config. |
| `vice_session_status` | vice | vice.ts |  | advanced? |  | Report the current or most recent VICE session state, including workspace paths and monitor-port readiness. |
| `vice_session_stop` | vice | vice.ts |  | advanced? |  | Stop the active VICE session. |
| `vice_trace_add_note` | vice | vice.ts |  | advanced? |  | Append a reasoning note/bookmark to a completed VICE trace session so investigation can proceed step by step without losing findings. |
| `vice_trace_analyze_last_session` | vice | vice.ts |  | advanced? |  | Analyze the most recently completed VICE runtime-trace session. |
| `vice_trace_build_context_index` | vice | vice.ts |  | advanced? |  | Build a persistent interrupt/context index for the VICE runtime trace so IRQ/NMI-like execution paths can be isolated without scanning the full raw trace every  |
| `vice_trace_build_index` | vice | vice.ts |  | advanced? |  | Build a persistent search index for a completed runtime trace, including continuity metrics and optional semantic links from an annotations JSON. |
| `vice_trace_build_pyramid_index` | vice | vice.ts |  | advanced? |  | Build a persistent semantic zoom index over the raw VICE runtime trace, including multi-scale windows, aggregate routine/segment/address summaries, and phase de |
| `vice_trace_call_path` | vice | vice.ts |  | advanced? |  | Heuristically reconstruct the JSR caller chain leading to an anchor clock in a completed runtime trace. |
| `vice_trace_context_writes` | vice | vice.ts |  | advanced? |  | Show the dominant memory writes and call edges recorded for one indexed interrupt context. |
| `vice_trace_find_bytes` | vice | vice.ts |  | advanced? |  | Find instructions in a completed VICE runtime trace by raw byte pattern. |
| `vice_trace_find_memory_access` | vice | vice.ts |  | advanced? |  | Find direct memory accesses to a specific address in a completed VICE runtime trace, classified as read, write, or readwrite when possible. |
| `vice_trace_find_operand` | vice | vice.ts |  | advanced? |  | Find instructions in a completed VICE runtime trace whose raw instruction bytes contain a target operand address. |
| `vice_trace_find_pc` | vice | vice.ts |  | advanced? |  | Find occurrences of a specific PC in a completed VICE runtime trace. |
| `vice_trace_find_phase_changes` | vice | vice.ts |  | advanced? |  | List the strongest phase boundaries detected from the trace window feature vectors. |
| `vice_trace_follow_from_pc` | vice | vice.ts |  | advanced? |  | Follow the concrete linear execution path after entering a given PC in the completed runtime trace. |
| `vice_trace_hotspots` | vice | vice.ts |  | advanced? |  | Summarize the hottest PCs in a completed VICE runtime trace. |
| `vice_trace_list_contexts` | vice | vice.ts |  | advanced? |  | List indexed IRQ/NMI/interrupt contexts so you can isolate a handler execution path before opening raw trace slices. |
| `vice_trace_list_notes` | vice | vice.ts |  | advanced? |  | List saved reasoning notes/bookmarks for a completed VICE trace session. |
| `vice_trace_runtime_start` | vice | vice.ts |  | advanced? |  | Start a visible VICE session with periodic CPU-history sampling. |
| `vice_trace_slice` | vice | vice.ts |  | advanced? |  | Return a focused instruction window around an anchor clock from a completed VICE runtime trace. |
| `vice_trace_slice_context` | vice | vice.ts |  | advanced? |  | Return the raw instruction slice for one indexed interrupt context, with optional padding before and after the context span. |
| `vice_trace_start` | vice | vice.ts |  | advanced? |  | Enable periodic CPU-history sampling on the active VICE session without restarting the emulator. |
| `vice_trace_status` | vice | vice.ts |  | advanced? |  | Report whether runtime tracing is currently active on the active VICE session. |
| `vice_trace_stop` | vice | vice.ts |  | advanced? |  | Stop periodic CPU-history sampling on the active VICE session without closing VICE. |
| `vice_trace_stop_and_analyze` | vice | vice.ts |  | advanced? |  | Capture a final register snapshot plus CPU history from the active VICE session, stop the session, write trace artifacts, and return a compact analysis summary. |
| `vice_trace_zoom_overview` | vice | vice.ts |  | advanced? |  | Summarize the multi-scale trace pyramid so you can zoom out to the dominant windows and detected execution phases before opening raw slices. |
| `vice_trace_zoom_window` | vice | vice.ts |  | advanced? |  | Inspect one window from the trace pyramid, or drill into all base windows that belong to a detected phase. |
