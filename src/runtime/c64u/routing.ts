// Spec 889 §5 — what the C64U backend does with each method name the tools call.
//
// Three answers and nothing else: the app serves it (RPC pass-through, the daemon's own
// params and shapes — trxmon speaks the TRX64 wire 1:1), the Ultimate's REST API serves it
// (the backend maps params and answers), or it is refused BY NAME with the reason and the way
// out. There is no fourth answer: an unlisted method is a refusal, never a guess and never a
// quiet send.

/** Exact method names the app serves (§5, board-tested 2026-10-04/06). `mark/*`, `transport/*`
 *  are passed by prefix; this list is what the capability check compares against `ping`. */
export const APP_RPC_METHODS: readonly string[] = [
  "ping",
  "session/create", "session/list", "session/close", "session/state", "session/run", "session/read_memory",
  "debug/state", "debug/pause", "debug/continue", "debug/run", "debug/step",
  "debug/break_add", "debug/break_del", "debug/break_list",
  "monitor/exec", "monitor/state",
  "trxmon/quit",
  "checkpoint/list", "checkpoint/capture", "checkpoint/restore", "checkpoint/pin", "checkpoint/unpin",
  "mark/set", "mark/list", "mark/drop", "mark/goto",
  "transport/status", "transport/frame", "transport/goto", "transport/pause", "transport/play", "transport/toggle",
  "runtime/reverse_step", "runtime/who_wrote", "runtime/crash_triage", "runtime/set_reverse_depth",
];

/** Notifications the app sends (§5). */
export const APP_NOTIFICATIONS: readonly string[] = [
  "debug/running", "debug/paused", "debug/stopped", "debug/breakpoint_hit", "debug/observer_hit",
];

const APP_PREFIXES = ["mark/", "transport/"] as const;

/** Methods the backend answers itself over the Ultimate's REST API. */
export const REST_METHODS: readonly string[] = [
  "session/type", "session/joystick_set", "session/joystick_clear",
  "session/load_prg", "runtime/run_prg",
  "media/open", "media/mount", "media/ingress", "media/unmount",
  "session/drive_status", "session/drive_power", "session/drive_reset",
  "session/reset", "session/power",
  "session/screenshot",
];

/** `api/call` verbs the backend can express on the app (the rest are refused by name). */
export const API_CALL_VERBS: readonly string[] = ["monitorRegisters", "monitorMemory", "stepInto", "status"];

export type Route =
  | { kind: "rpc" }
  | { kind: "rest" }
  | { kind: "api" }
  | { kind: "refuse"; reason: string; wayOut: string };

const SANDBOX_WAY_OUT = "use a machine of your own (runtime_sandbox_run, runtime_scene_reel, `c64re scenario run`), which is always the emulator";

interface RefusalRule { match: (m: string) => boolean; reason: string; wayOut: string }

const startsWithAny = (m: string, prefixes: readonly string[]) => prefixes.some((p) => m.startsWith(p));

/** Ordered: the first rule that matches names the refusal. */
const REFUSALS: readonly RefusalRule[] = [
  {
    match: (m) => m === "trace/build_from_ring",
    reason: "trace export from the ring was removed from the app (its M1); no .c64retrace file is made on a C64 Ultimate",
    wayOut: "trace on hardware is monitor/exec \"trace on|off|status\", `chis`, `whowrote`, `sd`; a captured .c64retrace comes from the emulator",
  },
  {
    match: (m) => m.startsWith("trace/") || m === "debug/memory_access_map",
    reason: "the trace store and its analyses are not in the app (trace over RPC is not offered on a C64 Ultimate)",
    wayOut: "ask the device's own monitor through runtime_monitor: `trace on|off|status`, `sd`, `chis`, `whowrote <addr>`; for a trace store capture on the emulator (runtime_sandbox_run)",
  },
  {
    match: (m) => startsWithAny(m, ["snapshot/", "ringbuffer/"]),
    reason: "no .c64re / .c64rering snapshot or ring files exist on a C64 Ultimate (removed in the app's M1)",
    wayOut: "the device keeps its own checkpoint ring: checkpoint/list|capture|restore|pin|unpin; a snapshot file is made on the emulator",
  },
  {
    match: (m) => m === "debug/observer_log",
    reason: "the app never sends the observer log",
    wayOut: "observers report through the debug/observer_hit notification; read hits with monitor/exec",
  },
  {
    match: (m) => m === "runtime/overlay_run",
    reason: "no overlay on C64 Ultimate hardware",
    wayOut: SANDBOX_WAY_OUT,
  },
  {
    match: (m) => startsWithAny(m, ["sandbox/", "runtime/candidate_", "runtime/scenario_", "runtime/promote_branch",
      "runtime/snapshot_tree", "runtime/find_cheat", "runtime/component_diff", "runtime/diff_checkpoints",
      "batch/", "recorder/", "vic/", "vsf/", "audio/", "session/model", "session/set_pacing", "session/turbo",
      "session/warp", "session/tick", "session/advance_to_frame", "session/frame_indices"]),
    reason: "an emulator-only method: the machine on a C64 Ultimate is real hardware",
    wayOut: SANDBOX_WAY_OUT,
  },
  {
    match: (m) => m === "runtime/render_screen",
    reason: "the picture of a C64 Ultimate is its video stream, not a render of emulator state",
    wayOut: "session/screenshot answers with the last complete frame of the device's video stream",
  },
  {
    match: (m) => m === "runtime/mark",
    reason: "runtime/mark stamps a trace, and there is no trace store on a C64 Ultimate",
    wayOut: "mark/set marks the device's checkpoint ring (not a trace)",
  },
  {
    match: (m) => m === "runtime/swap_disk_and_continue",
    reason: "the side-swap macro is composed from emulator state the device does not report",
    wayOut: "do it in steps: runtime_media_unmount, let the machine run, runtime_media_mount, then runtime_type RETURN",
  },
  {
    match: (m) => m === "media/persist" || m === "media/swap",
    reason: "a disk mounted from C64RE is an upload into the device's own temporary file; the device offers no route that hands the changed image back or swaps in place",
    wayOut: "mount again with media/mount; to keep a disk's writes, work the disk on the emulator",
  },
  {
    match: (m) => m === "session/cart_status",
    reason: "the Ultimate's REST API has no cartridge status",
    wayOut: "the monitor's `cart` verb: runtime_monitor command \"cart\"",
  },
  {
    match: (m) => startsWithAny(m, ["session/key_down", "session/key_up", "session/release_keys", "session/pot_", "session/input_"]),
    reason: "single key/pot events are not mapped on the C64 Ultimate",
    wayOut: "session/type (runtime_type) types text; session/joystick_set drives a joystick",
  },
  {
    match: (m) => m === "daemon/keep_alive",
    reason: "a C64 Ultimate does not end itself on idle; there is nothing to hold",
    wayOut: "none needed — the device stays up until it is powered off",
  },
  {
    match: (m) => m === "project/set",
    reason: "a C64 Ultimate serves no project; its media come from the host on each call",
    wayOut: "none needed",
  },
  {
    match: (m) => m === "runtime/call",
    reason: "the wide AgentQueryApi facade is an emulator surface",
    wayOut: "runtime_monitor (monitor/exec) speaks the device's own monitor verbs",
  },
  {
    match: (m) => m === "checkpoint/read_memory" || m === "checkpoint/clear" || m === "checkpoint/thumbnails",
    reason: "the app's checkpoint ring has no read-back of a frozen checkpoint's memory",
    wayOut: "checkpoint/restore the anchor, then session/read_memory",
  },
  {
    match: (m) => startsWithAny(m, ["device/", "fs/", "asm/", "cart/", "media/browse", "media/list_paths", "media/recent", "media/events"]),
    reason: "a host-side (emulator workbench) method with no counterpart on a C64 Ultimate",
    wayOut: "media come from the host through media/mount, media/open or media/ingress",
  },
];

/** Classify a method name. `served` is the device's own capability list when its ping carried
 *  one: a routed app method it does not list is refused by name (§2). */
export function routeOf(method: string, served?: ReadonlySet<string>): Route {
  if (method === "api/call") return { kind: "api" };
  if (REST_METHODS.includes(method)) return { kind: "rest" };
  const isApp = APP_RPC_METHODS.includes(method) || startsWithAny(method, APP_PREFIXES);
  if (isApp) {
    if (served && !served.has(method)) {
      return {
        kind: "refuse",
        reason: `this trxmon build does not serve it (its ping capabilities do not list it)`,
        wayOut: "update trxmon on the device, or use runtime_monitor for the same thing as a monitor verb",
      };
    }
    return { kind: "rpc" };
  }
  const rule = REFUSALS.find((r) => r.match(method));
  if (rule) return { kind: "refuse", reason: rule.reason, wayOut: rule.wayOut };
  return {
    kind: "refuse",
    reason: "not routed to a C64 Ultimate by this backend (it is neither a method the app serves nor one the Ultimate's REST API maps)",
    wayOut: SANDBOX_WAY_OUT,
  };
}

/** The refusal text: `<method>: <reason> — <way out>`. */
export function refusalText(method: string, r: Extract<Route, { kind: "refuse" }>): string {
  return `${method}: ${r.reason} — ${r.wayOut}`;
}

/** Accept `capabilities` in both shapes the app has documented: an array of names, or
 *  `{methods:[…], notifications:[…]}`. Returns undefined when ping carried none. */
export function parseCapabilities(raw: unknown): { methods: Set<string>; notifications: Set<string> } | undefined {
  if (Array.isArray(raw)) {
    const names = raw.filter((x): x is string => typeof x === "string");
    return { methods: new Set(names), notifications: new Set(names.filter((n) => APP_NOTIFICATIONS.includes(n))) };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { methods?: unknown; notifications?: unknown };
    const m = Array.isArray(o.methods) ? o.methods.filter((x): x is string => typeof x === "string") : [];
    const n = Array.isArray(o.notifications) ? o.notifications.filter((x): x is string => typeof x === "string") : [];
    return { methods: new Set(m), notifications: new Set(n) };
  }
  return undefined;
}

/** Methods this backend routes to the app that the device's capability list does not serve. */
export function capabilityGaps(served: ReadonlySet<string>): string[] {
  return APP_RPC_METHODS.filter((m) => m !== "ping" && !served.has(m));
}
