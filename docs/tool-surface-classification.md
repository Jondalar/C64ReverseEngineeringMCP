# MCP tool-surface classification (Spec 722.2)

**Date:** 2026-05-29. Audit-only — buckets every tool, cites doctrine. No code
change. Builds on `docs/tool-surface-inventory.md` (191 tools).

**Doctrine cited:**
- **LLM-first / outside-repo:** an LLM that has never seen this repo must use
  the default surface without guessing (Spec 722 north star).
- **Façade-first:** default = normal project/workflow actions; raw
  runtime/debug/VICE/maintenance = `advanced` via `C64RE_FULL_TOOLS`. NOT "≤80
  raw tools".
- **Single-path runtime (Spec 723):** the emulator runs one way; the LLM does
  not drive it cycle-by-cycle in normal analysis — runtime internals are
  advanced.
- **Headless over VICE:** `vice_*` is oracle-only → advanced.
- **One project path (Spec 724A):** done; not a tool concern.
- **Entry points:** `agent_onboard` + `c64re_whats_next` + `agent_propose_next`
  are how an agent enters a project — must be default + obvious.

## Buckets

| bucket | meaning | action (722.3/4) |
|--------|---------|------------------|
| KEEP | default façade — project/workflow | default surface + capability-first desc |
| MERGE | duplicate / second namespace of a KEEP-or-ADVANCED | fold into survivor; drop the name |
| RENAME | real variant with a misleading/colliding name | rename so the difference is in the name |
| ADVANCED | raw runtime / debug / VICE / maintenance / format-detail | register only under `C64RE_FULL_TOOLS` |
| REWRITE | description leads with `Spec NNN` / steers to superseded flow | rewrite to the §2 template |

## Counts (proposed)

- Total: **191**.
- **KEEP default façade: ~36** (the product workflow — list below).
- **ADVANCED: ~150** (vice 49 · runtime 48 · headless 15 · compression-detail
  ~14 · g64/disk-format detail ~12 · maintenance/bulk ~8 · sandbox 2).
- **MERGE: ~10** (headless↔runtime overlaps + the audio/monitor dups).
- **REWRITE: 64** (every spec-numbered description).

Façade-first means the LLM sees ~36 obvious tools by default, not 191.

## KEEP — default façade (~36)

**Enter / orient (project entry):**
`agent_onboard` · `c64re_whats_next` · `agent_propose_next` · `agent_record_step`
· `agent_set_role` · `get_project_profile` · `project_status`

**See what's there (read knowledge):**
`list_artifacts` · `list_payloads` · `list_findings` · `list_open_questions` ·
`read_artifact` · `pointer_report` · `ram_report`

**Analyse / disassemble (core RE):**
`analyze_prg` · `disasm_prg` · `disasm_menu` · `inspect_address_range` ·
`inspect_disk` · `assemble_source` · `c64ref_lookup`

**Get bytes off media (extraction):**
`extract_disk` · `extract_crt` · `disk_sector_allocation` · `export_menu`

**Record knowledge (write):**
`save_finding` · `save_entity` · `save_open_question` · `propose_annotations` ·
`import_annotations_as_findings` · `link_payload_to_asm` · `link_cart_chunk_to_asm`

**Unpack (façade only):**
`suggest_depacker` · `try_depack`

**Build views / docs:**
`build_*` view tools (memory map / flow graph / listing / dashboard — the
`build_…_view` family) · `render_docs`

(Exact membership finalised in 722.3 as descriptions are rewritten; the rule is:
if a fresh LLM doing project RE would reach for it, it is default.)

## ADVANCED (~150) — by group + doctrine

- **`vice_*` (49)** — VICE oracle-only (headless-over-VICE). ALL advanced.
- **`runtime_*` (48)** — raw emulator internals: breakpoints, step, monitor,
  vsf save/load, snapshot tree, trace-taint, fingerprints, swimlane,
  follow-path, resolve-pc, memory-access-map, profile-loader, regression,
  scenario CRUD, bookmarks, batch, media mount/swap, input config, until,
  vic-inspect, promote-branch, export audio/video/screenshot. The LLM does not
  drive the emulator in normal analysis (single-path runtime + WS/UI own it).
  ALL advanced. (Survivors of the headless merge live here too.)
- **`headless_*` (15)** — session lifecycle + drive-only debug. MERGE into the
  runtime namespace (722.3), then advanced. `headless_drive_session_*` = pure
  debug bring-up.
- **compression detail (~14)** — the specific `pack_*` / `depack_*` variants
  (exomizer/byteboozer/bwc/rle). Advanced; the façade is `suggest_depacker` +
  `try_depack`.
- **g64 / disk-format detail (~12)** — `extract_g64_*`, `inspect_g64_*`,
  `analyze_g64_anomalies`, `reconstruct_lut`, `suggest_disk_lut_sector`,
  `extract_disk_custom_lut`, `list_g64_slots`, `scan_g64_*`. Advanced (format
  forensics, not normal workflow).
- **maintenance / bulk (~8)** — `backfill_*`, `dedupe_*`, `repair_*`,
  `register_existing_files`, `scan_registration_delta`, `bulk_*`,
  `c64ref_build_rom_knowledge`, `build_tools`. One-shot ops, not workflow.
- **`sandbox_*` (2)** — raw 6502/ depack sandbox. Advanced.

## MERGE (~10) — one runtime namespace + dedup

- `headless_integrated_session_*` → fold into `runtime_*` (one front door for
  the single runtime). `headless_integrated_session_status` ≡ `runtime_status`;
  `…_run` ≡ `runtime_until`/`runtime_run_scenario`; `…_snapshot` ≡
  `runtime_save_vsf`; `headless_render_screen` ≡ `runtime_export_screenshot`.
- `runtime_audio_export` ≡ `runtime_export_audio` → one.
- `vice_monitor_memory|registers|display` ≡ `runtime_monitor_memory|registers|disasm`
  → keep the runtime ones (advanced), the vice ones stay only as oracle.

## RENAME

- Only if a real variant collides. Candidate: the `export`/`audio_export`
  family — after dedup, name the survivors `runtime_export_{audio,video,png}`
  consistently. No other forced renames.

## REWRITE (64)

Every description containing `Spec NNN` (34% of tools) → rewrite to:
`<verb-led one-liner>. Use when <trigger>. Not for <adjacent tool>. Inputs … Returns …`
Spec numbers move to code comments.

## 722.3 / 722.4 slices (proposed)

- **722.3 — tier gate + dedup (code).** Add `src/server-tools/tier-tools.ts`
  (`name → default | advanced`) + the gate at the `server.tool()` wrapper
  (`src/server.ts` Spec-039 injector): `if (tier === "advanced" && !env.C64RE_FULL_TOOLS) return;`.
  Seed the registry from this doc. Dedup the audio pair. Gate: build +
  `probe-tool-surface` + a launch with/without `C64RE_FULL_TOOLS` shows ~36 vs
  191.
- **722.4 — namespace merge (code).** Fold `headless_*` runtime tools into
  `runtime_*` (advanced tier); update the WS/agent callers. No external alias
  unless a non-repo caller needs it (OQ3).
- **722.5 — descriptions (code).** Rewrite the 64 spec-numbered + all KEEP
  descriptions to the template; strip `Spec NNN`.
- **722.6 — guard (code).** `scripts/probe-tool-surface.mjs`: inventory builds;
  default-tier ⊆ the KEEP list; no `Spec\s+\d` in any description; no
  duplicate-capability name in default; vice/maintenance/drive-only/sandbox all
  advanced; default count ≤ cap (~40).

## Acceptance for 722 overall
Default surface = the ~36 façade tools, every one capability-first; everything
raw/debug/VICE/maintenance behind `C64RE_FULL_TOOLS`; zero capability removed;
`probe-tool-surface` GREEN. (No emulator/UI change; no `runtime:proof` needed.)
