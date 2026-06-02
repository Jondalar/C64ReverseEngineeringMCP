# LLM-Human C64RE Swimlane

Goal: a human and an LLM work together on a C64RE project. The entry is ordered, but from the first project baseline onward the work is not linear. Depending on the game, loader, protection, goal, and current finding, trace, disassembly, inspect, changes, and validation alternate in loops.

## 1. Entry and project baseline

This part is largely linear. It makes sure the LLM knows where it is, what the goal is, and which media/artifacts exist.

| Phase | Human | LLM / Agent | MCP Project / Knowledge | Headless Runtime | TraceDB / Evidence | Workbench UI |
|---|---|---|---|---|---|---|
| Entry | Starts Claude/Codex in the project folder and says: "Connect to the MCP." | Onboards, detects a new or existing project, reports status. | `agent_onboard`, `project_status`, `get_project_profile`, `c64re_whats_next` |  |  |  |
| Clarify goal | States the goal: crack, EasyFlash port, analysis, bugfix, routine. | Sets role/workflow, asks only for missing goal info. | `agent_set_role`, `start_re_workflow`, `agent_propose_next`, `agent_record_step` |  |  |  |
| Provide media | Drops `.d64`, `.g64`, `.crt`, `.prg` and context into the project folder. | Says where media belongs, registers context. | `save_finding`, `save_entity`, `save_open_question`, `list_artifacts` |  |  |  |
| Inventory | Waits for first feedback. | Extracts and describes disk/CRT/PRG content. | `inspect_disk`, `extract_disk`, `extract_crt`, `disk_sector_allocation`, `list_payloads`, `read_artifact` |  |  | Project dashboard can be refreshed. |

## 2. Iterative workspace

From here on the flow is deliberately non-linear. The LLM picks the next sensible step based on the project goal, the current finding, and human feedback.

Possible cycles:

- `Trace -> Disassemble -> Change`
- `Disassemble -> Change -> Trace`
- `Disassemble -> Trace to validate/improve -> Change`
- `Runtime/Inspect -> Finding -> Disassembly -> Runtime`
- `Change -> Runtime test -> Trace diff -> next Change`

| Work strand | Human | LLM / Agent | MCP Project / Knowledge | Headless Runtime | TraceDB / Evidence | Workbench UI |
|---|---|---|---|---|---|---|
| Explore runtime | Gives input: RETURN, FIRE, joystick, menu choice, disk swap. | Starts or reuses a session, mounts media, runs to a sensible state. |  | `runtime_session_start`, `runtime_media_mount`, `runtime_type`, `runtime_joystick`, `runtime_session_run`, `runtime_until`, `runtime_render_screen`, `runtime_session_status` | Screens/status as evidence candidates. | Live screen visible. |
| Freeze / inspect | Judges the visible state: title, loader, error, menu, asset. | Captures a checkpoint, reads registers/memory/disasm, resolves VIC pixels/cells. | Findings/entities can emerge. | `runtime_session_snapshot`, `runtime_monitor_registers`, `runtime_monitor_memory`, `runtime_monitor_disasm`, `runtime_vic_inspect_at` | Checkpoint, VIC provenance, evidence record. | Freeze/overlay/inspector. |
| Capture trace | Lets the runtime run or helps interactively through load/play phases. | Saves or uses a trace and sets/reads relevant markers. | Trace is referenced as a project artifact. | `runtime_session_run` | `runtime_query_events`, `trace_store_info`, `trace_store_query`, `trace_store_anchor_list`, `trace_store_anchor_find` | Trace status and bounded views. |
| Analyze trace | Asks: where does the loader hang, where does the asset come from, what writes where? | Builds swimlane, taint, loader profile, path following. | `save_finding`, `save_open_question`, `link_entities` |  | `runtime_swimlane_slice`, `runtime_trace_taint`, `runtime_follow_path`, `runtime_profile_loader`, `trace_store_bus_find`, `trace_store_top_pcs` |  |
| Start/improve disassembly | Confirms the disassembly makes sense, or asks for code. | Disassembles payloads, improves labels/annotations with runtime evidence. | `analyze_prg`, `disasm_prg`, `disasm_menu`, `inspect_address_range`, `c64ref_lookup`, `link_payload_to_asm`, `propose_annotations`, `save_finding` | `runtime_resolve_pc` | Runtime refs are cited. | Annotated listing visible. |
| Link asset semantically | Marks logo/sprite/charset/screen region, or asks about it. | Matches visible data against RAM, file/payload, and code. | `save_finding`, `save_entity`, `link_entities` | `runtime_vic_inspect_at`, `runtime_monitor_memory` | Evidence record shows the source. | Overlay/inspector shows the ref. |
| Change / patch / intervention | Decides: crack, patch, EF port, fix, code overlay, test branch. | Creates or describes the change, records assumptions and risk. | `save_finding`, `save_open_question`, `agent_record_step` | Later: code-overlay/patch-branch runtime tools. | Before/after evidence. | Branch/change UI later. |
| Validation | Tests the result or gives new input. | Reproduces via runtime, trace, or views; decides the next cycle. | `agent_propose_next`, `agent_record_step`, `build_memory_map`, `build_project_dashboard`, `build_annotated_listing_view`, `build_all_views`, `render_docs` | `runtime_session_run`, `runtime_render_screen`, `runtime_session_snapshot` | Trace/checkpoint comparison. | Project state visible. |
| VICE oracle | Requests a VICE comparison only on genuine divergence. | Uses VICE deliberately as an oracle, not as the standard workflow. | Finding with an oracle reference. | Headless stays the primary path. | VICE diff as evidence. |  |

## 3. Loop rule

After every substantial step the LLM does three things:

1. Save the result in the project, not just in the chat.
2. Propose the next sensible step.
3. Justify why trace, disassembly, inspect, change, or validation is the right thing to do now.

There is no hard requirement to fully trace first or fully disassemble first. The right order is project-dependent.

## 4. Default-tool consequence

The default MCP must support this iterative workspace. It must not offer only static analysis/knowledge.

Default-visible:

- Agent/workflow: `agent_onboard`, `agent_propose_next`, `agent_record_step`, `start_re_workflow`
- Knowledge: `save_finding`, `save_entity`, `save_open_question`, `list_*`, `read_artifact`, `link_*`
- Media/extraction: `inspect_disk`, `extract_disk`, `extract_crt`, `disk_sector_allocation`
- Analysis/disassembly: `analyze_prg`, `disasm_prg`, `disasm_menu`, `inspect_address_range`, `c64ref_lookup`
- Headless Runtime: `runtime_session_start`, `runtime_media_mount`, `runtime_session_run`, `runtime_type`, `runtime_joystick`, `runtime_render_screen`, `runtime_session_snapshot`
- Monitor/inspect: `runtime_monitor_registers`, `runtime_monitor_memory`, `runtime_monitor_disasm`, `runtime_until`, `runtime_resolve_pc`, `runtime_vic_inspect_at`
- Trace capture/control: `runtime_trace_start`, `runtime_mark`, `runtime_trace_finalize` (all on the default surface, Spec 746 — the LLM starts a live trace on the running session, no cold-boot)
- Trace/evidence: `runtime_query_events`, `trace_store_*`, `runtime_swimlane_slice`, `runtime_trace_taint`, `runtime_follow_path`, `runtime_profile_loader`

Not default:

- `vice_*`: oracle/backup on divergence.
- Drive-only debug tools.
- Maintenance/backfill/repair/bulk.
- Old runtime modes, lockstep switches, legacy paths.

## 5. What the swimlane is built from — the `.c64retrace` (Spec 726.B / 746.x)

The swimlane (offline stepping: `C64 A X Y SP $00 $01 NV-BDIZC LIN CYC` + the 1541
lane + PC/IRQ + media/cart bytes) is reconstructed from the trace's authoritative
binary log, `.c64retrace`. DuckDB is only a rebuildable query index over it.

```
FILE       := FileHeader Event*
FileHeader := MAGIC(8 "C64RETR1") version(u16) flags(u16) metaLen(u32) metaJson(metaLen)
Event      := opcode(u8) payload(self-delimiting, little-endian)
```

- `cycle` is **f64** in every event — it IS the global stopwatch the C64 and 1541
  lanes are aligned on. (u32 would wrap on a real PAL session.)
- One swimlane CPU row = one `CPU_STEP` (0x10, 19 bytes): `cycle f64 + PC u16 +
  opcode + A + X + Y + SP + P + b1 + b2`. The 1541 lane is `DRIVE_CPU_STEP` (0x30,
  same shape). Memory writes (`0x11/0x12/0x31`, 15B), VIC (`0x20`), SID (`0x22`),
  IEC line changes (`0x23`), and phase `MARK`s (`0x01`, variable) interleave by cycle.
- Events are self-delimiting (fixed opcodes have a static size; `MARK` embeds a u16
  length), so a reader streams the log sequentially and skips unknown opcodes —
  forward-compatible across format bumps.

**How a slice is served:** the LLM/UI never opens the store itself — it asks the
daemon (`runtime_swimlane_slice` / `trace_store_*` route through `trace/read`),
which ensures the DuckDB index exists (lazy-rebuilds from the `.c64retrace` if
missing, streaming + >2 GiB-safe) and returns a bounded slice. The binary log is the
truth; a buggy reconstruction would diverge from the recorded PC stream, so the log
doubles as a checksum on any replay. Full wire spec:
`src/runtime/headless/trace/binary-format.ts`.
