// Spec 889 — the typed wrappers over the runtime's JSON-RPC method names.
//
// Tools call `runtimeDaemon.state(...)`, `.createSession(...)` and so on; every one of them
// is one `call(method, params)`. They live here, on the base of a backend, so the emulator
// client and the C64 Ultimate backend share them and a tool never learns which one it has:
// the BACKEND decides what a method name means (the emulator sends it to the daemon, the
// C64U maps it onto REST or the app's RPC, or refuses it by name).

import type { MachineIdentity } from "./machine-model.js";
import type { IdleExitStatus } from "./idle-exit.js";
import { runUntil, type RunOptions, type WireCall } from "./run-until.js";

/** Spec 863 — the identity fields a state reply carries (read them with `machineIdentity`). */
type MachineIdentityFields = MachineIdentity;

/** A JSON-RPC notification pushed by the backend (`debug/paused`, `debug/breakpoint_hit` …). */
export type BackendNotification = { method: string; params?: unknown };

export interface BackendIdentity {
  kind: "emulator" | "c64u";
  /** One line for a human: "Emulator" / "C64 Ultimate 192.168.1.10". */
  label: string;
  /** Present for the C64U. */
  device?: {
    host: string;
    restPort: number;
    rpcPort?: number;
    board?: string;
    core?: string;
    caps?: string;
    product?: string;
    firmwareVersion?: string;
    gitCommit?: string;
    hostname?: string;
    runtimeVersion?: string;
    trxmonVersion?: string;
    build?: unknown;
    capabilities: "listed" | "not listed (an older app: -32601 decides per method)";
    capabilityGaps: string[];
    runState?: string;
    /** Video/audio stream state (ports, per-stream start phase, paused). */
    streams?: unknown;
  };
  endpoint?: string;
  version?: string;
}

/**
 * The runtime BACKEND contract (Spec 889): what every tool reaches through `runtimeDaemon`.
 * `call(method, params)` in the daemon's method names and answer shapes, notifications, and
 * the identity. Two implementations: the emulator daemon client and the C64 Ultimate backend.
 */
export abstract class RuntimeMethods {
  /** Which backend this is. */
  abstract readonly kind: "emulator" | "c64u";
  /** The tool tells the backend which project it resolved. */
  abstract setProjectDir(dir: string | undefined): void;
  /** Subscribe to the backend's notifications; returns the unsubscribe. */
  abstract onNotification(handler: (n: BackendNotification) => void): () => void;
  /** Who answers: backend, device, versions. Never reaches out to start anything. */
  abstract describe(): Promise<BackendIdentity>;
  /** One JSON-RPC 2.0 request → response, in the daemon's method names and answer shapes. */
  abstract call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;

  // -- typed wrappers over the V3 protocol (the acceptance-critical surface) --
  /** Spec 863 — `model` (a row of the runtime's model table) STARTS the session as that
   *  model: the same model attaches, another one is a power-on on that row. It replaces the
   *  old `pal` flag the runtime ignored. The reply carries the machine's identity fields. */
  createSession(p: { disk_path?: string; device_id?: number; model?: string; start_track?: number; write_protected?: boolean; trace_out?: string; trace_domains?: string[] }) {
    return this.call<{ sessionId: string; mode: string; diskPath: string; c64Cycles: number; pc: number; trace: unknown; attached?: boolean } & Partial<MachineIdentityFields>>("session/create", p);
  }
  listSessions() { return this.call<Array<{ sessionId: string; mode: string; diskPath: string; c64Cycles: number }>>("session/list"); }
  /** Spec 886 / TRX64 887 — hold the daemon N s from now; null = never end on idle. */
  keepAlive(seconds: number | null) {
    return this.call<IdleExitStatus & { armed: boolean }>("daemon/keep_alive", { seconds });
  }
  state(sessionId: string) { return this.call<{ c64Cycles: number; idleExit?: IdleExitStatus; mode: string; runState?: string; controlOwner?: string; cpu: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number } } & Partial<MachineIdentityFields>>("session/state", { session_id: sessionId }); }
  /** Spec 863 — every model the runtime knows, runnable or not (with what it lacks). */
  models() { return this.call<{ models: Array<Record<string, unknown> & { name: string }>; current: string }>("session/models"); }
  /** Spec 863 — switch the running machine to another model at the next frame boundary
   *  (not a power cycle: the running program keeps its state). */
  switchModel(sessionId: string, name: string) { return this.call<Record<string, unknown>>("session/model", { session_id: sessionId, name, source: "llm" }); }
  /** Spec 839 — the drive and the cartridge as the machine has them right now. The
   *  human reads both off the cockpit; `runtime_session_status` claimed to report them
   *  and did not. Both are read-only status calls with no side effect on the machine. */
  driveStatus(sessionId: string) { return this.call<Record<string, unknown>>("session/drive_status", { session_id: sessionId }); }
  /** `null` when no cartridge is inserted — that is the answer, not a failure. */
  cartStatus(sessionId: string) { return this.call<Record<string, unknown> | null>("session/cart_status", { session_id: sessionId }); }
  closeSession(sessionId: string) { return this.call<{ existed: boolean; released: string[] }>("session/close", { session_id: sessionId }); }
  /** Spec 910 D10 — the one run: `debug/run` with a stop (`cycles`, any armed breakpoint) and, with `wait`, held until the machine has stopped. */
  runUntil(sessionId: string, o: Omit<RunOptions, "wait"> & { wait?: boolean }) {
    return runUntil(this.call.bind(this) as WireCall, sessionId, { wait: true, source: "llm", ...o });
  }
  pause(sessionId: string) { return this.call("debug/pause", { session_id: sessionId, source: "llm" }); }
  resume(sessionId: string) { return this.call("debug/continue", { session_id: sessionId, source: "llm" }); }
  /** Returns { dataUrl } base64 PNG; caller writes to disk if a path is needed. */
  screenshot(sessionId: string) { return this.call<{ dataUrl?: string; width?: number; height?: number }>("session/screenshot", { session_id: sessionId }); }
  mark(sessionId: string, label: string) { return this.call("runtime/mark", { session_id: sessionId, label }); }
  /** Spec 744 §7.2 / BUG-027 — hardware-style disk-swap-and-continue. */
  swapDiskAndContinue<T = unknown>(sessionId: string, path: string, opts: { confirm_input?: string; settle_cycles?: number; post_cycles?: number; confirm_hold_cycles?: number; unit?: number } = {}) {
    return this.call<T>("runtime/swap_disk_and_continue", { session_id: sessionId, path, ...opts });
  }

  /** Spec 744.4c slice 2 — invoke an AgentQueryApi method on the SHARED daemon
   *  session (monitor/step/breakpoint analysis). Returns the same value the
   *  in-process `createAgentQueryApi({session})[method](...args)` would, with
   *  TypedArrays normalized to plain arrays daemon-side. */
  apiCall<T = unknown>(sessionId: string, method: string, args: unknown[] = []) {
    return this.call<T>("api/call", { session_id: sessionId, method, args });
  }

  /** Spec 744.4c slice 2b — the abstract media operation on the SHARED daemon
   *  session. Routes to the daemon's `media/ingress` (Spec 709 single media
   *  authority) — the SAME op the UI uses, which broadcasts media/changed so the
   *  human sees the LLM's mount live. The caller brings the medium (absolute
   *  `path`, or `bytes_b64`) + the action (`kind`). */
  mediaIngress<T = unknown>(sessionId: string, req: {
    kind?: "disk" | "prg" | "crt" | "eject";
    path?: string; bytes_b64?: string; name?: string;
    mode?: "load" | "inject-run"; entry?: number;
    // Spec 839 — "auto" is the daemon resolving the target against the live machine
    // (cartridge if one is in, else the disk), atomically under its own lock. The
    // cockpit has sent it since CLI-FEEL S7; the MCP could not name it.
    resetPolicy?: "reset" | "power-cycle"; role?: "drive8" | "cartridge" | "auto";
  }) {
    return this.call<T>("media/ingress", { session_id: sessionId, ...req, source: "llm" });
  }

  // -- Spec 744.4c slice 2c — rewind/branch on the SHARED daemon session --
  snapshotTree<T = unknown>(sessionId: string) {
    return this.call<T>("runtime/snapshot_tree", { session_id: sessionId });
  }
  promoteBranch<T = unknown>(sessionId: string, branchId: string) {
    return this.call<T>("runtime/promote_branch", { session_id: sessionId, branch_id: branchId });
  }
  // -- Spec 744.4c slice 2c — persist + VSF + memory-access-map + vic-inspect on
  //    the SHARED daemon session. Paths are abs-resolved on the MCP side; the
  //    daemon (localhost) reads/writes them → write-through to the caller's file
  //    is preserved (Spec 742). --
  mediaPersist<T = unknown>(sessionId: string, slot: number, role?: string) {
    return this.call<T>("media/persist", { session_id: sessionId, slot, role });
  }
  vsfSave<T = unknown>(sessionId: string, outputPath: string) {
    return this.call<T>("vsf/save", { session_id: sessionId, output_path: outputPath });
  }
  vsfLoad<T = unknown>(sessionId: string, inputPath: string) {
    return this.call<T>("vsf/load", { session_id: sessionId, input_path: inputPath });
  }
  memoryAccessMap<T = unknown>(sessionId: string, cycles: number, classes: string[], minBytes: number) {
    return this.call<T>("debug/memory_access_map", { session_id: sessionId, cycles, classes, min_bytes: minBytes });
  }
  vicInspectAt<T = unknown>(sessionId: string, x: number, y: number, checkpointId?: string) {
    return this.call<T>("vic/inspect/at_capture", { session_id: sessionId, x, y, checkpoint_id: checkpointId });
  }
  /** Spec 859 — lines `from..=to` of the frame a retained checkpoint shows, cycle by
   *  cycle, as the VIC and CPU did them (a replay in a clone; the live machine stays). */
  vicLineTrace<T = unknown>(sessionId: string, checkpointId: string, from: number, to: number) {
    return this.call<T>("vic/line_trace", { session_id: sessionId, checkpoint_id: checkpointId, from, to });
  }
  /** Spec 860 — the frozen frame as a view: objects with their bytes, stores to the VIC,
   *  techniques, per-line summaries; the lines × cycles cell grid (312×63 PAL, 263×65
   *  NTSC — Spec 863) only when asked for. */
  vicFrameMap<T = unknown>(sessionId: string, checkpointId: string, includeCells: boolean) {
    return this.call<T>("vic/frame_map", { session_id: sessionId, checkpoint_id: checkpointId, include_cells: includeCells });
  }

  /** Spec 839 / Spec 721 — the two halves of the Visual-Origin Join the human has in
   *  the UI and the LLM did not. Both need a RETAINED checkpoint: `at_capture` is the
   *  one place that captures and pins one, so a caller without an id gets it from
   *  there rather than from a second capture policy living here.
   *
   *  Coordinates: these two take VISIBLE-frame pixels (0..384 x 0..272 PAL, 0..247 NTSC, border
   *  included). `vicInspectAt` takes DISPLAY pixels (0..319 x 0..199). Same machine,
   *  two frames of reference — see the tool descriptions. */
  /** Spec 843 D9 — bytes out of a FROZEN checkpoint, so a rip takes the bytes that
   *  drew the picture rather than whatever the live machine holds now. */
  checkpointReadMemory(sessionId: string, checkpointId: string, addr: number, length: number) {
    return this.call<{ addr: number; length: number; bytes: number[] }>(
      "checkpoint/read_memory", { session_id: sessionId, checkpoint_id: checkpointId, addr, length });
  }
  /** Live machine, same shape. */
  async readMemoryRange(sessionId: string, addr: number, length: number): Promise<{ bytes: number[] }> {
    // The emulator's runtime reads `ranges` ({addr, len, lens?}) and answers `chunks` of base64, at most 32 KiB
    // a read; the C64 Ultimate's app takes `addr` + `length` and answers `bytes`. Both are sent, whichever
    // answers is read. (This used to send {addr, length} alone, which the emulator's runtime refuses: a live
    // runtime_rip_range never worked.)
    const bytes: number[] = [];
    for (let done = 0; done < length; done += 0x8000) {
      const at = (addr + done) & 0xffff;
      const len = Math.min(0x8000, length - done);
      const r = await this.call<{ bytes?: number[]; data?: number[]; chunks?: Array<{ bytes: string }> }>(
        "session/read_memory", { session_id: sessionId, addr: at, length: len, ranges: [{ addr: at, len }] });
      if (Array.isArray(r.chunks)) for (const c of r.chunks) bytes.push(...Buffer.from(c.bytes, "base64"));
      else bytes.push(...(r.bytes ?? r.data ?? []));
    }
    return { bytes };
  }
  vicInspectRegion<T = unknown>(sessionId: string, checkpointId: string, region: { x: number; y: number; width: number; height: number }) {
    return this.call<T>("vic/inspect/region", { session_id: sessionId, checkpoint_id: checkpointId, region });
  }
  vicOrigin<T = unknown>(sessionId: string, checkpointId: string, x: number, y: number) {
    return this.call<T>("vic/inspect/origin", { session_id: sessionId, checkpoint_id: checkpointId, x, y });
  }

  // -- BUG-028 — INPUT/DRIVE on the SHARED daemon session. Read tools (status/
  //    render) were daemon-routed but these write/drive tools were not, so the LLM
  //    could see the human's session but not type/joystick/mark/load into it. --
  typeText<T = unknown>(sessionId: string, text: string, holdCycles?: number, gapCycles?: number) {
    return this.call<T>("session/type", { session_id: sessionId, text, hold_cycles: holdCycles, gap_cycles: gapCycles, source: "llm" });
  }
  /** Hold / release one matrix key by the daemon's key name ("F1", "L_SHIFT", "RUN_STOP", ...). */
  keyDown<T = unknown>(sessionId: string, key: string) {
    return this.call<T>("session/key_down", { session_id: sessionId, key, source: "llm" });
  }
  keyUp<T = unknown>(sessionId: string, key: string) {
    return this.call<T>("session/key_up", { session_id: sessionId, key, source: "llm" });
  }
  joystickSet<T = unknown>(sessionId: string, port: number, state: { up?: boolean; down?: boolean; left?: boolean; right?: boolean; fire?: boolean }) {
    return this.call<T>("session/joystick_set", { session_id: sessionId, port, ...state, source: "llm" });
  }
  joystickClear<T = unknown>(sessionId: string, port: number) {
    return this.call<T>("session/joystick_clear", { session_id: sessionId, port, source: "llm" });
  }
  // (mark() already exists above — runtime/mark — reused by runtime_mark.)
  loadPrg<T = unknown>(sessionId: string, prgPath: string, loadAddress?: number) {
    return this.call<T>("session/load_prg", { session_id: sessionId, prg_path: prgPath, load_address: loadAddress, source: "llm" });
  }

  // Spec 769 — load + autostart a .prg (BASIC RUN / machine-code g <entry>).
  runPrg<T = unknown>(sessionId: string, prgPath: string, run?: number) {
    return this.call<T>("runtime/run_prg", { session_id: sessionId, prg_path: prgPath, run });
  }

  // -- Spec 746.2/746.3 — live trace control on the SHARED session (the three-gate
  //    control: this MCP path + the UI button + the Monitor command all converge on
  //    the daemon's trace/* WS methods). The default session is built producers-on
  //    (746.1) so iec/drive/memory domains have data when started mid-session. --
  traceStartDomains<T = unknown>(sessionId: string, domains: string[], output?: string) {
    return this.call<T>("trace/start_domains", { session_id: sessionId, domains, output });
  }
  /** Spec 746.x — ONE stop path. `waitIndex` is the policy flag: the UI omits it
   *  (instant button, index publishes in the background); the MCP/LLM passes true
   *  to block until the DuckDB store is queryable (its next step is a query). */
  traceStop<T = unknown>(sessionId: string, waitIndex = false, timeoutMs?: number) {
    return this.call<T>("trace/run/stop", { session_id: sessionId, wait_index: waitIndex }, timeoutMs);
  }
  traceStatus<T = unknown>(sessionId: string) {
    return this.call<T>("trace/run/status", { session_id: sessionId });
  }
  /** Spec 802 — read a trace store IN the runtime process, which owns the format and
   *  reads it natively. This is the ONLY trace-read path C64RE has; go through
   *  `server-tools/trace-read.ts` rather than calling this directly.
   *  op = index | store_fn | map | swimlane | swimlane_text | taint | taint_text
   *       (+ query_events | follow_path | profile_loader — on the wire contract, no
   *        native reader yet; the runtime answers those with an explicit error).
   *  The raw `sql` op is DROPPED (Spec 802 OQ1) — use store_fn/safeQuery.
   *  `duckdbPath` must be absolute (caller-resolved). */
  traceRead<T = unknown>(op: string, duckdbPath: string, args: Record<string, unknown>) {
    return this.call<T>("trace/read", { op, duckdb_path: duckdbPath, args });
  }

  // -- Spec 746.4 — checkpoint ring (scrub/rewind) on the SHARED daemon session.
  //    The ring auto-captures every 25 frames while running; these let the LLM
  //    list/capture/pin/restore the same keyframes the human scrubs. --
  checkpointList<T = unknown>(sessionId: string) {
    return this.call<T>("checkpoint/list", { session_id: sessionId });
  }
  checkpointCapture<T = unknown>(sessionId: string) {
    return this.call<T>("checkpoint/capture", { session_id: sessionId, source: "llm" });
  }
  checkpointPin<T = unknown>(sessionId: string, id: string) {
    return this.call<T>("checkpoint/pin", { session_id: sessionId, id });
  }
  checkpointUnpin<T = unknown>(sessionId: string, id: string) {
    return this.call<T>("checkpoint/unpin", { session_id: sessionId, id });
  }
  checkpointRestore<T = unknown>(sessionId: string, id: string, then?: "pause" | "run" | "keep") {
    return this.call<T>("checkpoint/restore", { session_id: sessionId, id, then, source: "llm" });
  }
  // Spec 766.5 — shared-memory recorder (worker-store scrub history).
  recorderStatus<T = unknown>(sessionId: string) {
    return this.call<T>("recorder/status", { session_id: sessionId });
  }
  recorderList<T = unknown>(sessionId: string) {
    return this.call<T>("recorder/list", { session_id: sessionId });
  }
  recorderDump<T = unknown>(sessionId: string, seq: number, path: string) {
    return this.call<T>("recorder/dump", { session_id: sessionId, seq, path });
  }
  // Spec 769.2 — code-overlay debug loop: rewind→patch→run→observe.
  overlayRun<T = unknown>(sessionId: string, params: Record<string, unknown>) {
    return this.call<T>("runtime/overlay_run", { session_id: sessionId, ...params });
  }
  // One-tool monitor remote-control: run any monitor command string, get its text.
  monitorExec<T = unknown>(sessionId: string, command: string) {
    // Spec 767 — source="llm" so the UI shows the LLM is co-driving (green border).
    return this.call<T>("monitor/exec", { session_id: sessionId, command, source: "llm" });
  }
}
