// Spec 906 D3 — which runtime tools work on a sandbox session, and which refuse one.
//
// A sandbox session (`runtime_sandbox_start`) is a daemon of the LLM's own. Every runtime tool that
// does not serve a human UI works on it exactly as on the shared session, because the routing is by
// session id (`sb-…` → that sandbox's daemon, anything else → the active backend). This table is
// the verdict per tool, kept in CODE so a new runtime tool without a verdict fails the gate
// (`scripts/e2e-906-sandbox-session.mjs` derives the registered tool list from the live server and
// compares it with the keys here).
//
// `works` carries a scope, because "works on a sandbox" means three different things:
//   session      — takes a `session_id`; with an `sb-…` id the call goes to that sandbox's daemon.
//   files        — reads or writes files and the project, and involves no machine; identical on any id.
//   own-machine  — starts a machine of its own per call; no session involved.
//   sandbox-door — the sandbox's own lifecycle doors.
// `ui-only` carries the reason, and the tool refuses a sandbox id by name with it.

export type ParityVerdict =
  | { verdict: "works"; scope: "session" | "files" | "own-machine" | "sandbox-door" }
  | { verdict: "ui-only"; reason: string };

const session: ParityVerdict = { verdict: "works", scope: "session" };
const files: ParityVerdict = { verdict: "works", scope: "files" };
const ownMachine: ParityVerdict = { verdict: "works", scope: "own-machine" };
const door: ParityVerdict = { verdict: "works", scope: "sandbox-door" };
const ui = (reason: string): ParityVerdict => ({ verdict: "ui-only", reason });

const LIFECYCLE =
  "a sandbox session is started with runtime_sandbox_start and ended with runtime_sandbox_end (or ends itself on its budget, idle limit or owner's death); this tool is the shared session's lifecycle";

export const SANDBOX_PARITY: Readonly<Record<string, ParityVerdict>> = {
  // ── the sandbox's own doors and the other machines of your own
  runtime_sandbox_start: door,
  runtime_sandbox_end: door,
  runtime_sandbox_list: door,
  runtime_sandbox_run: ownMachine,
  runtime_scene_reel: ownMachine,

  // ── machine, run control, input, picture
  runtime_session_run: session,
  runtime_session_status: session,
  runtime_run_prg: session,
  runtime_load_prg: session,
  runtime_type: session,
  runtime_joystick: session,
  runtime_render_screen: session,
  runtime_status: session,
  runtime_monitor: session,
  runtime_monitor_registers: session,
  runtime_monitor_memory: session,
  runtime_monitor_disasm: session,
  runtime_memory_access_map: session,
  runtime_step_into: session,
  runtime_step_over: session,
  runtime_until: session,
  runtime_breakpoint_add: session,
  runtime_breakpoint_list: session,
  runtime_breakpoint_remove: session,
  runtime_resolve_pc: session,
  runtime_find_cheat: session,
  runtime_rip_range: session,

  // ── trace
  runtime_trace_start: session,
  runtime_trace_finalize: session,
  runtime_trace_status: session,
  runtime_mark: session,

  // ── time machine
  runtime_checkpoint_capture: session,
  runtime_checkpoint_list: session,
  runtime_checkpoint_pin: session,
  runtime_checkpoint_unpin: session,
  runtime_checkpoint_restore: session,
  runtime_recorder_status: session,
  runtime_recorder_list: session,
  runtime_recorder_dump: session,
  runtime_rewind: session,
  runtime_overlay_run: session,
  runtime_snapshot_tree: session,
  runtime_promote_branch: session,
  runtime_save_vsf: session,
  runtime_load_vsf: session,

  // ── VIC
  runtime_vic_inspect_at: session,
  runtime_vic_inspect_region: session,
  runtime_vic_origin: session,
  runtime_vic_frame_map: session,
  runtime_vic_line_trace: session,

  // ── media
  runtime_media_mount: session,
  runtime_media_unmount: session,
  runtime_media_persist: session,
  runtime_media_swap: session,
  runtime_swap_disk_and_continue: session,
  runtime_media_list_paths: files,
  runtime_media_browse: files,

  // ── anchors and candidates: a sandbox has marks of its own and runs its clones inside itself
  runtime_anchor_set: session,
  runtime_anchor_list: session,
  runtime_anchor_drop: session,
  runtime_anchor_goto: session,
  runtime_candidate_create: session,
  runtime_candidate_run: session,
  runtime_candidate_variant: files,
  runtime_candidate_list: files,
  runtime_candidate_choose: files,
  runtime_candidate_derive_delta: files,
  runtime_candidate_verify_build: files,
  runtime_candidate_delete: files,
  runtime_candidate_patch: files,
  runtime_candidate_remove_patch: files,
  runtime_candidate_export: files,
  runtime_inject_range: files,

  // ── scenarios and batches: the daemon's own registry, on the daemon the session id names
  runtime_scenario_list: session,
  runtime_scenario_save: session,
  runtime_scenario_load: session,
  runtime_scenario_delete: session,
  runtime_run_scenario: session,
  runtime_run_scenarios_parallel: session,
  runtime_batch_status: session,
  runtime_batch_results: session,

  // ── trace stores and snapshot files: read from disk, no machine involved
  runtime_query_events: files,
  runtime_follow_path: files,
  runtime_swimlane_slice: files,
  runtime_trace_taint: files,
  runtime_profile_loader: files,
  runtime_scan_fingerprints: files,
  runtime_loader_lens: files,
  runtime_diff_snapshots: files,
  runtime_component_diff: files,
  runtime_install: files,

  // ── what a human's UI is for
  runtime_session_start: ui("it starts or attaches the SHARED machine the workbench shows; " + LIFECYCLE),
  runtime_session_close: ui(LIFECYCLE),
  runtime_keep_alive: ui("it holds the shared daemon up against its idle exit; a sandbox's life is its budget and idle limit, set at runtime_sandbox_start"),
  runtime_session_export_audio: ui("it renders the live A/V stream's SID audio; a sandbox is born headless, with no A/V stream"),
  runtime_input_load_vicerc: ui("it configures the keymap the workbench's keyboard uses; a sandbox has no keyboard of a human"),
  runtime_input_load_config: ui("it configures the keymap the workbench's keyboard uses; a sandbox has no keyboard of a human"),
  runtime_input_save_config: ui("it configures the keymap the workbench's keyboard uses; a sandbox has no keyboard of a human"),
  runtime_backend: ui("it chooses what the SHARED runtime is (the emulator or a C64 Ultimate); a sandbox is always the emulator and never follows that choice"),
  runtime_down: ui("it ends every C64RE process on the machine, other projects' sandboxes included; a sandbox ends itself or is ended with runtime_sandbox_end"),
};

export const SANDBOX_ID = /^sb-/;

/** True for an id this feature hands out (`sb-<slug>-<n>`); the shared session is "shared". */
export function isSandboxId(id: unknown): id is string {
  return typeof id === "string" && SANDBOX_ID.test(id);
}

/** The runtime tools: everything whose name starts `runtime_`. */
export function isRuntimeToolName(name: string): boolean {
  return name.startsWith("runtime_");
}

/** Registered runtime tools that have no verdict — a gate failure: a new tool must say what it does on a sandbox. */
export function unclassifiedRuntimeTools(registered: Iterable<string>): string[] {
  return [...registered].filter((n) => isRuntimeToolName(n) && !(n in SANDBOX_PARITY)).sort();
}

/** Verdicts for tools that are not registered any more — a table that outlives its tools lies. */
export function staleParityEntries(registered: Iterable<string>): string[] {
  const have = new Set(registered);
  return Object.keys(SANDBOX_PARITY).filter((n) => !have.has(n)).sort();
}

/** The refusal a ui-only tool answers a sandbox id with, or undefined when the tool works (or the id is not a sandbox's). */
export function sandboxRefusal(tool: string, sessionId: unknown): string | undefined {
  if (!isSandboxId(sessionId)) return undefined;
  const v = SANDBOX_PARITY[tool];
  if (!v || v.verdict !== "ui-only") return undefined;
  return `${tool}: refused for sandbox session ${sessionId} — ${v.reason}. Nothing was done.`;
}
