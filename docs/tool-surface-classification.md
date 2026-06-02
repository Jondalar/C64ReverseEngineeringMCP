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

## Counts (corrected 2026-06-02 — Spec 746 live-trace + binary-format hardening)

`tier-tools.ts` `DEFAULT_TOOLS` + `docs/tool-surface-inventory.json` are the
authority; `scripts/probe-tool-surface.mjs` enforces the cap. Current totals:

- Total: **288** (server-tools + `src/project-knowledge/mcp-tools.ts` 80).
- **KEEP default façade: 107** (cap **108** — Spec 746 promoted `runtime_trace_start`
  107→108 so the LLM can START a live trace on a running session, not just
  finalize/status one; the §3.7/3.8/3.9 Headless Runtime + TraceDB facades were
  promoted in Spec 725/730). `probe-tool-surface.mjs` GREEN.
- **ADVANCED: ~180** (vice 49 · runtime debug/drive-only · maintenance/bulk ·
  format-forensics · sandbox) — behind `C64RE_FULL_TOOLS`.
- **MERGE: ~10** (headless↔runtime overlaps) — 722.4.
- **REWRITE: 111** (spec-numbered descriptions) — 722.5.

Façade-first means the LLM sees **~107** obvious tools by default, not 288. The
Headless Runtime (Spec 725) AND live Trace Capture (Spec 726.B / 746 —
`runtime_trace_start` / `runtime_mark` / `runtime_trace_finalize`) are now part of
the default product workflow, not advanced debug.

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
- **SUPERSEDED by Spec 725:** `runtime_*` is no longer advanced-by-default. The
  curated Headless Runtime (§3.7), Monitor/Inspect (§3.8) and TraceDB/Evidence
  (§3.9) facades are now DEFAULT (default surface = 73). Only the drive-only/
  debug/raw runtime_ tools below stay advanced.
- **`runtime_*` raw/debug remainder** — breakpoints, step, monitor,
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
- ~~`runtime_audio_export` ≡ `runtime_export_audio`~~ — 722.3b equivalence check
  showed these are NOT duplicates (session-live vs scenario). Renamed the
  session one → `runtime_session_export_audio`; both kept (advanced).
- `vice_monitor_memory|registers|display` ≡ `runtime_monitor_memory|registers|disasm`
  → keep the runtime ones (advanced), the vice ones stay only as oracle.

## RENAME

- Only if a real variant collides. Candidate: the `export`/`audio_export`
  family — after dedup, name the survivors `runtime_export_{audio,video,png}`
  consistently. No other forced renames.

## REWRITE (111)

Every description containing `Spec NNN` (41% of tools) → rewrite to:
`<verb-led one-liner>. Use when <trigger>. Not for <adjacent tool>. Inputs … Returns …`
Spec numbers move to code comments.

**`vice_*` mandate (722.5):** VICE tools are NOT deleted, but they are advanced
and must NOT read as a second normal path. The product path is headless/runtime
C64RE. Every `vice_*` description must say, verbatim sense:
> "Oracle-only. Use after the headless/runtime path shows a divergence, or when
> the user explicitly asks for a VICE comparison / source-of-truth check. Not
> for normal project workflow."
The tier gate already keeps all `vice_*` out of the default surface (722.3a);
722.5 fixes the wording so even under `C64RE_FULL_TOOLS` they read as
oracle/fallback, not an alternate workflow.

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

## Acceptance for 722 overall (updated Spec 746)
Default surface = the **107** façade tools (static analysis + Headless Runtime +
Monitor/Inspect + TraceDB + live-trace capture incl. `runtime_trace_start`), every
one capability-first; everything raw/debug/VICE/maintenance/drive-only/sandbox
behind `C64RE_FULL_TOOLS`; zero capability removed; `probe-tool-surface` GREEN (cap
108). (No emulator/UI change; no `runtime:proof` needed.)

## §3.10 — Trace binary format (`.c64retrace`, Spec 726.B / 746.x)

The default product trace is an append-only `.c64retrace` binary log (the timeline
AUTHORITY); the `.duckdb` is a derived query index rebuilt after stop on a worker
thread, or lazily on first read if missing (streaming, >2 GiB-safe).

```
FILE       := FileHeader Event*
FileHeader := MAGIC(8 "C64RETR1") version(u16) flags(u16) metaLen(u32) metaJson(metaLen)
Event      := opcode(u8) payload(self-delimiting, little-endian, cycle=f64)
```

Records (total bytes): `CPU_STEP`/`DRIVE_CPU_STEP` (0x10/0x30) = 19B (cycle f64 + PC
u16 + opcode + A/X/Y/SP/P + b1/b2); `RAM/IO/DRIVE_RAM_WRITE` (0x11/0x12/0x31) = 15B;
`VIC_REG_WRITE` (0x20) = 13B; `SID_REG_WRITE` (0x22) = 12B; `IEC_LINE_CHANGE` (0x23)
= 11B; `MARK` (0x01) = variable (cycle + u16 len + label). Self-delimiting →
forward-compatible (skip unknown opcodes). Full wire spec: `binary-format.ts` +
`docs/runtime-daemon-solution-design.md`.
