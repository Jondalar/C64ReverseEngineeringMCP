// The parity walk of Spec 906 S2: one call per runtime tool that takes a session, in an order that leaves the
// machine in a state the next call can use. The same list runs against a machine started the same way on the
// shared stand-in daemon ("shared") and on a sandbox session ("sb-…"), and the answers are compared.
//
// Each entry: tool, args(ctx) → the arguments without session_id, and optionally
//   keep(text, ctx)  — remember something from the answer (a checkpoint id) for later entries
//   expect           — "same" (default): the normalized answers are equal; "both-refuse": both refuse, equally
//   need             — a ctx key the entry needs (skipped, and said so, if an earlier entry did not provide it)

const TRACE_HYP = "$0810 INC $C000 is the loop the idle program sits in (read in the program listing the test built)";

export function walk(P) {
  return [
    { tool: "runtime_session_status", args: () => ({}) },
    { tool: "runtime_status", args: () => ({}) },
    { tool: "runtime_monitor_registers", args: () => ({}) },
    { tool: "runtime_monitor_registers", args: () => ({ memspace: "drive" }) },
    { tool: "runtime_monitor_memory", args: () => ({ start: 0xc000, end: 0xc00f }) },
    { tool: "runtime_monitor_disasm", args: () => ({ addr: 0x080d, count: 6 }) },
    { tool: "runtime_monitor", args: () => ({ command: "r" }) },
    { tool: "runtime_monitor", args: () => ({ command: "m 0801 0810" }) },
    { tool: "runtime_resolve_pc", args: () => ({ pc: 0x080d }) },
    { tool: "runtime_step_into", args: () => ({}) },
    { tool: "runtime_step_over", args: () => ({}) },
    { tool: "runtime_breakpoint_add", args: () => ({ id: "b1", pc: 0x0810 }) },
    { tool: "runtime_breakpoint_list", args: () => ({}) },
    { tool: "runtime_breakpoint_remove", args: () => ({ id: "b1" }) },
    { tool: "runtime_session_run", args: () => ({ max_instructions: 5000 }) },
    { tool: "runtime_until", args: () => ({ addr: 0x0810, budget: 200000 }) },
    { tool: "runtime_mark", args: () => ({ label: "early" }), expect: "both-refuse" },
    { tool: "runtime_trace_status", args: () => ({}) },
    { tool: "runtime_trace_start", args: (c) => ({ hypothesis: TRACE_HYP, domains: ["c64-cpu"], output: c.file("walk.duckdb") }) },
    { tool: "runtime_trace_status", args: () => ({}) },
    { tool: "runtime_session_run", args: () => ({ max_instructions: 2000 }) },
    { tool: "runtime_mark", args: () => ({ label: "phase" }) },
    { tool: "runtime_trace_finalize", args: () => ({}) },
    { tool: "runtime_checkpoint_capture", args: () => ({}), keep: (t, c) => { c.cp = /"id":\s*"([^"]+)"/.exec(t)?.[1] ?? /\b(cp[_-][A-Za-z0-9_-]+)/.exec(t)?.[1]; } },
    { tool: "runtime_checkpoint_list", args: () => ({}) },
    { tool: "runtime_checkpoint_pin", args: (c) => ({ id: c.cp }), need: "cp" },
    { tool: "runtime_checkpoint_unpin", args: (c) => ({ id: c.cp }), need: "cp" },
    { tool: "runtime_session_run", args: () => ({ max_instructions: 3000 }) },
    { tool: "runtime_checkpoint_restore", args: (c) => ({ id: c.cp }), need: "cp" },
    { tool: "runtime_recorder_status", args: () => ({}) },
    { tool: "runtime_recorder_list", args: () => ({}) },
    { tool: "runtime_rewind", args: (c) => ({ id: c.cp }), need: "cp" },
    { tool: "runtime_overlay_run", args: (c) => ({ anchor_id: c.cp, patches: [{ addr: 0xc100, bytes: [0x42] }], run_cycles: 2000 }), need: "cp" },
    { tool: "runtime_memory_access_map", args: () => ({ cycles: 100000, hypothesis: TRACE_HYP }) },
    { tool: "runtime_save_vsf", args: (c) => ({ output_path: c.file("walk.vsf") }) },
    { tool: "runtime_load_vsf", args: (c) => ({ input_path: c.file("walk.vsf") }) },
    { tool: "runtime_rip_range", args: (c) => ({ addr: 0xc000, length: 16, out_path: c.file("rip.bin") }) },
    { tool: "runtime_render_screen", args: (c) => ({ path: c.file("screen.png") }) },
    { tool: "runtime_vic_inspect_at", args: () => ({ x: 100, y: 100 }), keep: (t, c) => { c.vic = true; } },
    { tool: "runtime_vic_inspect_region", args: () => ({ x: 10, y: 10, width: 8, height: 8 }) },
    { tool: "runtime_vic_origin", args: () => ({ x: 100, y: 100 }) },
    { tool: "runtime_vic_frame_map", args: () => ({}) },
    { tool: "runtime_vic_line_trace", args: () => ({ line: 100 }) },
    { tool: "runtime_type", args: () => ({ text: "X" }) },
    { tool: "runtime_joystick", args: () => ({ fire: true, hold_frames: 2 }) },
    { tool: "runtime_load_prg", args: () => ({ prg_path: P.prg }) },
    { tool: "runtime_run_prg", args: () => ({ prg_path: P.prg, run: "080d" }) },
    { tool: "runtime_media_mount", args: () => ({ path: P.d64 }) },
    { tool: "runtime_media_swap", args: () => ({ path: P.d64 }) },
    { tool: "runtime_media_persist", args: () => ({}) },
    { tool: "runtime_swap_disk_and_continue", args: () => ({ path: P.d64, settle_cycles: 50000, post_cycles: 50000, confirm_hold_cycles: 20000 }) },
    { tool: "runtime_media_unmount", args: () => ({}) },
    { tool: "runtime_snapshot_tree", args: () => ({}) },
    { tool: "runtime_promote_branch", args: () => ({ branch_id: "nope" }), expect: "both-refuse" },
    { tool: "runtime_anchor_set", args: (c) => ({ name: `walk_${c.tag}`, why: "parity walk" }) },
    { tool: "runtime_anchor_list", args: () => ({}) },
    { tool: "runtime_session_run", args: () => ({ max_instructions: 3000 }) },
    { tool: "runtime_anchor_goto", args: (c) => ({ name: `walk_${c.tag}` }) },
    { tool: "runtime_anchor_drop", args: (c) => ({ name: `walk_${c.tag}` }) },
    { tool: "runtime_find_cheat", args: (c) => ({ before: c.cp, after: c.cp }), need: "cp" },
    { tool: "runtime_recorder_dump", args: (c) => ({ seq: 0, path: c.file("rec.c64re") }), expect: "both-refuse-or-same" },
    { tool: "runtime_scenario_list", args: () => ({}) },
    { tool: "runtime_scenario_save", args: () => ({ id: "walk-scn", diskPath: "none.d64", mode: "true-drive", cycleBudget: 1000 }) },
    { tool: "runtime_scenario_load", args: () => ({ id: "walk-scn" }) },
    { tool: "runtime_run_scenarios_parallel", args: () => ({ scenario_ids: ["none"] }), expect: "both-refuse-or-same" },
    { tool: "runtime_scenario_load", args: () => ({ id: "none" }), expect: "both-refuse" },
    { tool: "runtime_scenario_delete", args: () => ({ id: "none" }) },
    { tool: "runtime_run_scenario", args: () => ({ id: "none" }), expect: "both-refuse" },
    { tool: "runtime_batch_status", args: () => ({ batch_id: "none" }), expect: "both-refuse" },
    { tool: "runtime_batch_results", args: () => ({ batch_id: "none" }), expect: "both-refuse" },
    { tool: "runtime_session_export_audio", args: (c) => ({ out_path: c.file("a.wav"), duration_sec: 1 }), expect: "ui-only" },
  ];
}

/** Make two answers comparable: what is the machine's is kept, what is only THIS daemon's or THIS path's is not. */
export function normalize(text, ctx) {
  let t = String(text);
  // what is only THIS path's: any absolute temp path keeps its file name and loses the directory
  t = t.replace(/(?:\/private)?\/(?:var\/folders|tmp)\/[^\s"',)\]]*\/([^\/\s"',)\]]+)/g, "<P>/$1");
  // …and the same on Windows: C:\…\Temp\…\name, with \, \\ (inside JSON) or / as the separator
  t = t.replace(/[A-Za-z]:(?:\\{1,2}|\/)(?:[^\s"',)\]\\\/]+(?:\\{1,2}|\/))*?Temp(?:\\{1,2}|\/)(?:[^\s"',)\]\\\/]+(?:\\{1,2}|\/))*([^\\\/\s"',)\]]+)/g, "<P>/$1");
  t = t.replace(/"createdAtMs":\s*\d+/g, '"createdAtMs": <MS>');
  t = t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<TS>");
  t = t.replace(/ws:\/\/127\.0\.0\.1:\d+/g, "ws://127.0.0.1:<PORT>");
  t = t.replace(/\bport \d+/g, "port <PORT>").replace(/\bpid \d+/g, "pid <PID>");
  t = t.replace(/live_[a-z0-9]{6,}/g, "live_<ID>");
  t = t.replace(/"batchId":\s*"[0-9a-f]+"/g, '"batchId": "<BATCH>"').replace(/epoch:\d+/g, "epoch:<T>");
  // a stack trace names the module that threw, and that is the client of THIS machine
  t = t.split("\n").filter((l) => !/^\s+at /.test(l)).join("\n");
  t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
  t = t.replace(/walk_(?:shared|sb)\b/g, "walk_<TAG>").replace(/cand-(?:shared|sb)\b/g, "cand-<TAG>");
  // whose machine an answer talks about is the one thing that is SUPPOSED to differ
  t = t.replace(/\b[Tt]he shared machine\b/g, "<WHO>").replace(/\b[Ss]andbox session sb-[a-z0-9-]+/g, "<WHO>");
  for (const id of ctx.ids) t = t.split(id).join("<SID>");
  // the lines that say WHICH machine answered — the verdict of these is the point of the comparison
  t = t.split("\n").filter((l) => !/^(Backend:|Project:|Ends:|Idle exit:|Runtime session status \()/.test(l)).join("\n");
  return t.trim();
}
