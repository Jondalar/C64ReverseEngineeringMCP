import { isAbsolute, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Spec 723.4b: standalone HeadlessSessionManager + its record formatters retired.
// Spec 806 step 2: the trace-query / trace-index imports were already unused here —
// they were the last static edges from this file into the TS emulator, and they go
// with the in-process branches below.
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

// BUG-052 — how long a loader-lens fold may block the tool call before it becomes
// a background job. Well under the host's ~180 s stall limit; a normal capture
// finishes inside it and the caller never sees the difference.
const LOADER_LENS_JOB_GRACE_MS = 20_000;

function parseHexWord(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
    throw new Error(`Invalid 16-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

// Spec 834 D1 — the hint is a PARAMETER every caller has to state, not something
// a call site can omit by accident. The old shape took `hintPath?` and, with none
// given, resolved `context.projectDir(undefined, true)`: the resolver then has
// nothing to walk up from and answers from C64RE_PROJECT_DIR, or from the process
// cwd happening to sit inside a project. Every headless call site carried a path
// all along — media_path, prg_path, capture_path, the file it is about to write —
// and threw it away, so the tool worked quietly against the wrong project or none.
function resolveHeadlessProjectDir(context: ServerToolContext, hintPath: string | undefined): string {
  // Spec 723.4b: no longer consults the standalone HeadlessSessionManager.
  return context.projectDir(hintPath, true);
}

// Spec 723.4b: headlessSessionToContent + headlessRunResultToContent removed —
// they formatted the retired standalone HeadlessSessionManager records.

// Spec 806 step 2: resolveHeadlessTraceProjectDir + formatHeadlessTraceMatch removed —
// callerless leftovers of the same retired standalone-session trace surface.

export function registerHeadlessTools(server: McpServer, context: ServerToolContext): void {
  // Spec 723.4b: the standalone-session interrupt tools (headless_interrupt_request,
  // headless_io_interrupt_trigger, headless_interrupt_clear) were retired — they
  // drove the legacy Cpu6510-based HeadlessSessionManager, had no programmatic
  // caller, and have no IntegratedSession equivalent. No interrupt-injection was
  // added to IntegratedSession.

  // Spec 806 step 3 — the STANDALONE-DRIVE family is RETIRED, not routed:
  // `runtime_drive_session_start` / `_status` / `_persist_writes` /
  // `_session_save_vsf` / `_session_load_vsf` and `runtime_iec_bus_state`.
  // All six sat on `drive1541/drive-session-manager` — a 1541 with NO C64
  // attached. The runtime has no such object (its drive only exists inside a
  // machine), so there was nothing to route them to; the two .vsf tools were
  // LEGACY by their own description. All six were ADVANCED-only, so the default
  // surface is unchanged. (Spec 806 §7.1)

  // Spec 062 Sprint 65: integrated C64+drive session.
  // Real KERNAL/BASIC/CHARROM loaded so LISTEN/SECOND/CIOUT/UNLSN
  // bit-bang $DD00, drive sees it via IEC bus, drive ROM responds.
  // Path to Murder boot trace.
  server.tool(
    "runtime_session_start",
    "Start a headless C64+1541 session — the product runtime (real KERNAL/BASIC, cycle-accurate 1541, event-catchup). Use to begin a runtime session for loading/running/inspecting a title, from ANY medium: pass media_path=<file> for a .crt cartridge, a .d64/.g64/.d81 disk, a .prg or a .c64re snapshot — the daemon reads the file to decide which, so a cartridge start needs no separate tool and no placeholder disk. Pass trace_out=<path> (+ optional trace_domains=['c64-cpu','memory',...]) to stream a persistent trace.duckdb across the session; then drive with runtime_session_run / runtime_until, stamp phases with runtime_mark, read the live screen with runtime_render_screen, finalize the trace with runtime_trace_finalize, query offline with trace_store_* / runtime_query_events, and runtime_session_close when done (else the session keeps running and pegs a core). ONE MACHINE PER PROCESS: a daemon process runs exactly ONE live machine — the human's UI and you co-drive the SAME session (shared-attach). Before starting, list/status existing sessions and attach to one instead; a SECOND in-process session is NOT isolated — it rebinds the process-global VIC/drive and corrupts the first session's rendering (boot text goes black) until a process restart. For a truly isolated machine (e.g. a throwaway build test) use a SEPARATE backend process. Not for a one-shot PRG run without a persistent session (use runtime_run_prg). Inputs: media_path — ANY of .d64/.g64/.crt/.prg/.c64re, identified by CONTENT not by extension, and optional: a session is a machine, and a medium is something you put in it. A .crt is inserted, a disk is mounted, a .c64re REPLACES the machine, and a .prg is loaded — and typed RUN only when it loads at $0801 behind a valid BASIC line (which is also how SYS-stub releases are meant to start; anything else loads and stops). disk_path is the deprecated alias, kept so existing callers keep working. Also optional: device_id, pal, trace_out, trace_domains. Returns: session id + resolved config + trace status when streaming.",
    {
      // BUG-041 — a session is a MACHINE; a medium is something you put in it. This
      // used to be a REQUIRED disk_path that a shared attach never acted on (the daemon
      // says so itself: the attach params "do NOT reconstruct the singleton machine"),
      // with no cart/PRG/snapshot equivalent — so starting from a cartridge meant naming
      // a .g64 nobody uses to satisfy the schema, then mounting the CRT.
      //
      // The type is decided by CONTENT in the DAEMON (media/open), never here: putting
      // it in the tool would mean the next client reimplements it with a different edge
      // case at $0801.
      media_path: z.string().optional().describe("The medium to put in the machine: a .crt CARTRIDGE, a .d64 / .g64 / .d81 disk, a .prg, or a .c64re snapshot. One parameter for all of them — the daemon decides the type from the file's CONTENT, so a cartridge needs nothing special here. Absolute, or relative to the project. Omit it to attach to the shared session as it stands."),
      /** @deprecated use media_path — kept so existing callers keep working. */
      disk_path: z.string().optional().describe("Deprecated alias for media_path, kept so existing callers keep working. The name is misleading: media_path takes a cartridge or a snapshot just as well as a disk."),
      // Spec 834 D1 — which project this session belongs to, in the shape every
      // other path-taking tool uses: named, or walked up from the call's own path.
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from media_path (or trace_out) to knowledge/phase-plan.json."),
      device_id: z.number().int().min(8).max(11).optional().describe("Drive number the medium is mounted on (8–11). Disk media only; ignored for a cartridge."),
      pal: z.boolean().optional().describe("PAL timing (6569). Default true; NTSC is not supported."),
      start_track: z.number().int().min(1).max(40).optional().describe("Park the drive head on this track before the run — for a loader that assumes where it left off. Disk media only."),
      write_protected: z.boolean().optional().describe("Mount the disk read-only. Note the project default is read/write with auto-persist back into the original image, so set this when the run must not change the medium."),
      // Spec 723.2/723.4a: neither useCycleLockstep nor useMicrocodedCpu is a
      // product/workflow param — the runtime is true-drive + microcoded
      // unconditionally. Neither is exposed here.
      // Spec 093: diagnostic ring buffers.
      trace_iec: z.boolean().optional().describe("Keep an in-memory IEC bus ring for this session (ATN/CLK/DATA transitions). For a durable capture use trace_out + trace_domains instead."),
      trace_iec_capacity: z.number().int().min(8).max(65536).optional().describe("How many IEC transitions the in-memory ring holds before it wraps."),
      trace_drive: z.boolean().optional().describe("Keep an in-memory 1541 ring (head steps, byte-ready, block reads). For a durable capture use trace_out + trace_domains instead."),
      trace_drive_capacity: z.number().int().min(8).max(65536).optional().describe("How many drive events the in-memory ring holds before it wraps."),
      // Spec 093: KERNAL trap toggles (default false for real serial).
      enable_kernal_fileio_traps: z.boolean().optional().describe("Shortcut the KERNAL's file I/O instead of running it cycle by cycle. Faster, but a loader that depends on the real timing will behave differently — leave it off when the timing is the subject."),
      enable_kernal_serial_traps: z.boolean().optional().describe("Shortcut the KERNAL's serial routines. Off for any fastloader work: the custom transfer IS the thing under study."),
      enable_kernal_io_traps: z.boolean().optional().describe("Shortcut the remaining KERNAL I/O entry points. Same caveat as the other two traps."),
      // Spec 726: persistent runtime trace. When set, the session streams a
      // durable trace.duckdb (query later with trace_store_* / runtime_query_events).
      trace_out: z.string().optional().describe("Path (abs or under the project) for the trace.duckdb. Enables persistent streaming trace capture."),
      trace_domains: z.array(z.enum(["c64-cpu", "drive8-cpu", "iec", "vic", "memory"])).optional().describe("Which domains to capture (default c64-cpu + memory). Enables the matching passive producers."),
    },
    // Spec 806 step 2: the trace_iec / trace_drive / enable_kernal_*_traps inputs are
    // IntegratedSession construction options the daemon never took; they were only ever
    // read by the removed in-process branch. Left in the schema (accepted + ignored, as
    // in daemon mode today) — pruning the input surface is a separate decision.
    safeHandler("runtime_session_start", async ({
      media_path, disk_path, project_dir, device_id, pal, start_track, write_protected,
      trace_out, trace_domains,
    }) => {
      // BUG-041 — one input. `disk_path` is the deprecated alias.
      const mediaIn = media_path ?? disk_path;
      // Spec 744.4c — the product MCP creates the session IN THE DAEMON (the one
      // process-stable authority the UI also uses), NOT a private session in the MCP
      // process. The LLM still sees this stable tool; the daemon owns the machine.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      // Spec 744.4c — the daemon is a PROJECT-AGNOSTIC runtime host: it may serve
      // several projects at once. The session must be self-describing, so the MCP
      // resolves every path to ABSOLUTE against ITS OWN project context here and
      // hands the daemon already-resolved paths. The daemon then resolves nothing
      // against its own spawn-project (resolveTraceOut passes absolute through), so
      // the disk + the trace.duckdb always land in the *caller's* project — not the
      // daemon's. (projectDir-at-spawn below is only the daemon's default-session /
      // UI base; it is not load-bearing for MCP-created sessions.)
      // Spec 834 D1 — the hint is a path this call already carries: the project the
      // caller named, else the medium being put in the machine, else the trace it is
      // about to write. D3 — and it is no longer wrapped in a try/catch that turned
      // "which project am I in" into `undefined`: that is not the daemon-is-absent
      // failure DOCTRINE rule 1 asks a tool to survive and report, and swallowing it
      // is exactly how a session ends up resolving its disk against the wrong root.
      const projectHint = project_dir ?? mediaIn ?? trace_out;
      // A bare attach names no path at all — no medium, no trace — and nothing below
      // is then resolved against a root, so the resolver is not asked. Same decision
      // Spec 833 recorded for a hex_bytes-only sandbox run: asking hintlessly IS the
      // defect, so where the answer is not needed the question is not put.
      const mcpProject = projectHint === undefined
        ? undefined
        : resolveHeadlessProjectDir(context, projectHint);
      const { resolveTraceOut } = await import("./runtime-trace-sink.js");
      // Resolve to ABSOLUTE the same way the trace path is (absolute as-is, else
      // under the MCP's project). NOTE: context.projectDir() returns the project
      // ROOT, not a resolved file path — it is the wrong tool for this.
      const absMedia = mediaIn
        // A medium implies a hint above, so mcpProject is a resolved root here or the
        // call has already thrown — the cwd branch is unreachable with a medium.
        ? (resolve(mcpProject ?? process.cwd(), mediaIn))
        : undefined;
      const absTraceOut = trace_out ? resolveTraceOut(trace_out, mcpProject) : undefined;
      // Seed the auto-spawn base so a daemon we start lives in a real project.
      runtimeDaemon.setProjectDir(mcpProject);
      const r = await runtimeDaemon.createSession({ disk_path: absMedia, device_id, pal, start_track, write_protected, trace_out: absTraceOut, trace_domains });
      // BUG-041 — the medium is OPENED after the session exists, by the daemon, which
      // decides what it is from the CONTENT. A shared attach never acted on the
      // create-time path (its own comment: the attach params "do NOT reconstruct the
      // singleton machine"), which is why naming a .g64 you did not need was the only way
      // to start from a cartridge.
      let openedLine: string | undefined;
      if (absMedia) {
        try {
          const opened = await runtimeDaemon.call<{ message?: string }>("media/open", { path: absMedia });
          openedLine = typeof opened?.message === "string" ? opened.message : `Opened: ${absMedia}`;
        } catch (e) {
          openedLine = `Could not open ${absMedia}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const lines = r.attached
        ? [
            `Attached to the existing shared session in the Runtime Daemon (one machine per process — the human's UI and you co-drive the SAME machine).`,
            `Session: ${r.sessionId}`,
            openedLine ?? `Mounted disk: ${r.diskPath || "(none)"}`,
            `Mode: ${r.mode}`,
            `C64 cycles: ${r.c64Cycles}  PC: ${formatHexWord(r.pc)}`,
            // BUG-041 — the medium IS opened now (media/open, above), so the old
            // "requested but not auto-mounted, do it yourself" line is gone: it
            // described the schema's inertia, not a policy.
            ...(openedLine ? [] : []),
          ]
        : [
            `Integrated session started (Runtime Daemon — shared with the UI).`,
            `Session: ${r.sessionId}`,
            openedLine ?? `Media: ${absMedia ?? "(none)"}`,
            `Mode: ${r.mode}`,
            `C64 cycles: ${r.c64Cycles}  PC: ${formatHexWord(r.pc)}`,
          ];
      const t = r.trace as { outputPath?: string; domains?: string[]; runId?: string } | null;
      if (t?.runId) lines.push(`Trace: streaming → ${t.outputPath} [${(t.domains ?? []).join(",")}] run=${t.runId}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
));

  server.tool(
    "runtime_session_run",
    "Advance a session up to N C64 instructions (drive runs proportional cycles), with optional breakpoints / cycle budget / named stop condition. Use to step the machine forward. When the session has a streaming trace active (runtime_session_start trace_out=...), this run automatically chunks + drains the trace queue to trace.duckdb between chunks (behaviour-neutral). Not for run-to-PC only (use runtime_until) or for phase markers (use runtime_mark between calls). Inputs: session_id, max_instructions, optional breakpoints/until/cycle_budget. Returns: counts + final PC.",
    {
      session_id: z.string(),
      max_instructions: z.number().int().min(1).max(10_000_000),
      breakpoints: z.array(z.string()).optional().describe("Hex PC addresses to break on."),
      cycle_budget: z.number().int().optional(),
      until: z.object({
        kind: z.enum(["pc", "raster", "iec", "stable_screen"]).describe("Named stop condition: pc | raster | iec | stable_screen."),
        pc: z.string().optional().describe("Hex PC address (for kind=pc)."),
        side: z.enum(["c64", "drive"]).optional().describe("Which CPU's PC to watch (for kind=pc). Default c64."),
        count: z.number().int().min(1).optional().describe("Number of hits to wait for (for kind=pc). Default 1."),
        line: z.number().int().min(0).max(311).optional().describe("VIC raster line (for kind=raster)."),
        edge: z.enum(["atn-fall", "atn-rise", "clk-fall", "clk-rise", "data-fall", "data-rise"]).optional().describe("IEC line edge (for kind=iec)."),
        frames_stable: z.number().int().min(1).optional().describe("Frames-stable threshold (for kind=stable_screen). Default 3."),
      }).optional().describe("Named stop condition. If set, runs until satisfied (or budget exhausted) instead of max_instructions."),
    },
    // Spec 806 step 2: `breakpoints` was only ever honoured by the removed in-process
    // branch — the daemon run has always ignored it (use runtime_monitor `bp` / the
    // `until` route once 744.4c slice 2 lands). Schema left as-is; the input surface is
    // a separate decision.
    safeHandler("runtime_session_run", async ({ session_id, max_instructions, cycle_budget, until }) => {
      // Spec 744.4c — bounded run against the shared Runtime Daemon session.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      if (until) throw new Error("runtime_session_run with `until` conditions is not yet routed through the Runtime Daemon (744.4c slice 2). Use cycle_budget / max_instructions.");
      const cycles = cycle_budget ?? Math.max(1, (max_instructions ?? 100_000) * 2);
      // Spec 767 slice 2 — when a stream pump is attached (--stream, the shared UI
      // session), advance via the LIVE capped run so the UI keeps RUNNING (every rendered
      // frame is streamed) instead of freezing on the blocking session/run; it auto-pauses
      // at the cap. Headless daemons (no pump) fall back to the blocking bounded run.
      const s0 = await runtimeDaemon.state(session_id);
      const after = s0.streamPump
        ? await runtimeDaemon.runCapped(session_id, cycles, "warp")
        : (await runtimeDaemon.run(session_id, cycles), await runtimeDaemon.state(session_id));
      const { c64Cycles, cpu } = after;
      return { content: [{ type: "text" as const, text: `Ran up to ~${cycles} cycles (Runtime Daemon${s0.streamPump ? ", live-streamed" : ""}). cycles=${c64Cycles} pc=${formatHexWord(cpu.pc)}` }] };
    },
));

  // Spec 726 — trace marks + finalize (default capture-workflow tools).
  server.tool(
    "runtime_mark",
    "Stamp a named phase marker into the active trace at the current cycle (e.g. 'boot', 'title', 'gameplay'). Requires an active streaming trace — start one with runtime_session_start(trace_out=...). Use to scope later trace queries by phase (between mark cycles). Not for querying marks (use trace_store_anchor_list / trace_store_query). Inputs: session_id, label. Returns: trace status.",
    {
      session_id: z.string(),
      label: z.string().describe("Phase label, e.g. boot-complete / title / scene-1."),
    },
    safeHandler("runtime_mark", async ({ session_id, label }) => {
      // BUG-028 — mark the SHARED daemon session's active trace.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const s = await runtimeDaemon.mark(session_id, label) as { runId: string; eventCount: number; marks: number };
      return { content: [{ type: "text" as const, text: `Marked "${label}" — run ${s.runId}, ${s.eventCount} events, ${s.marks} marks.` }] };
    },
));

  // Spec 746.2 — start a streaming trace on an ALREADY-RUNNING session (the shared
  // daemon session the human drives). This is the gap BUG/charter closes: before,
  // tracing could ONLY be enabled at runtime_session_start(trace_out=...). Now the
  // LLM can trace the live Wasteland session after the fact, by domain. The default
  // daemon session is built producers-on (Spec 746.1) so iec/drive/memory have data.
  server.tool(
    "runtime_trace_start",
    "Start a streaming trace on a RUNNING session (no need to pre-declare trace_out at session_start). Use to begin capturing the live shared session's execution into a .c64retrace binary timeline (the authority) + a queryable trace.duckdb index. Pick domains (default c64-cpu+memory; add drive8-cpu/iec/vic for the full picture). Then drive with runtime_session_run, stamp phases with runtime_mark, finalize with runtime_trace_finalize, and read the swimlane/offline-stepping with runtime_swimlane_slice / query with trace_store_*. Not for a one-shot scenario (use runtime_session_start trace_out=). DISCIPLINE: a broad trace CONFIRMS a hypothesis you formed by READING the code — it is not a way to find structure. You MUST pass `hypothesis` (a concrete $address + what you read that points there) or the call is refused. Inputs: session_id, hypothesis, optional domains, optional output path. Returns: runId + store path + domains. Spec 827: with no `output` the capture goes to the per-user trace directory (%LOCALAPPDATA%/Application Support/XDG, override C64RE_TRACE_DIR), NOT into the project — a trace is gigabytes of continuously rewritten binary and a synced project directory is the worst place for it; `<project>/runtime/traces.json` records where each capture went.",
    {
      session_id: z.string(),
      hypothesis: z.string().optional().describe("REQUIRED (read-before-trace gate): the read-derived reason for this trace — a concrete $address you are investigating + what you READ that points there (a routine, annotation, or finding). E.g. \"$C000 should hold the manual-check result; input routine at $B800 stores the typed word there\". Fishing (no address / no rationale) is refused — read the code first (disasm_prg / inspect_address_range / project_search), form the hypothesis, THEN trace to confirm it."),
      domains: z.array(z.enum(["c64-cpu", "drive8-cpu", "iec", "vic", "sid", "memory", "drive-mechanism", "cart-read"])).optional()
        .describe("Trace domains. Default ['c64-cpu','memory']. The CPU firehose is the swimlane truth; add drive8-cpu/iec for IEC-bus + drive stepping, vic for raster. Two ARMED-ONLY read-set lanes, both produced by the runtime rather than in-process: 'drive-mechanism' arms the 1541 head + block-read (track/sector) lane for a loader-lens capture — read it with runtime_loader_lens; 'cart-read' arms the cartridge bank residency lane (Spec 785) — feed it to validate_extraction to diff a manifest's cart slot spans. Neither belongs in a parity trace."),
      output: z.string().optional().describe("Path (abs or under the project) for the trace store. Omit it: the default is the per-user trace directory outside the project (Spec 827). A path inside a OneDrive/Dropbox/iCloud folder is obeyed but warned about."),
    },
    safeHandler("runtime_trace_start", async ({ session_id, hypothesis, domains, output }) => {
      // Read-before-trace discipline gate: refuse a fished trace (no read-derived
      // hypothesis). Runtime confirms a hypothesis; it does not find one.
      const { checkTraceDiscipline } = await import("./discipline-gate.js");
      const gate = checkTraceDiscipline(hypothesis);
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const doms = domains ?? ["c64-cpu", "memory"];
      // Tier 2 substrate gate — the drive-mechanism lane arms a loader-lens capture
      // (payload-extraction-from-medium). Gate it like loader_lens itself: standard-GCR =>
      // the payload is a static depack, so don't capture a landing-map trace for it.
      if (doms.includes("drive-mechanism")) {
        // Spec 834 — not one of the six (its own path parameter is `output`, which the
        // portability walk does not read as a path name), but it is the same helper and
        // the same rule: hand it the path the call carries. With no `output` — the Spec
        // 827 default, where the capture goes to the per-user trace directory — this
        // call genuinely has no path, and it resolves as it did before.
        const proj = (() => { try { return resolveHeadlessProjectDir(context, output); } catch { return undefined; } })();
        const { checkSubstrateDiscipline } = await import("./substrate-gate.js");
        const sub = await checkSubstrateDiscipline(proj, { tool: "runtime_trace_start (drive-mechanism / loader-lens capture)" });
        if (!sub.allowed) return { content: [{ type: "text" as const, text: sub.refusal! }] };
      }
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const proj = (() => { try { return resolveHeadlessProjectDir(context, output); } catch { return undefined; } })();
      // Spec 827 — a capture defaults OUTSIDE the project: 20 GB of index and log
      // in one project measured on 2026-09-06, in the very tree a user syncs. An
      // explicit `output` is still obeyed exactly as before; it only gets a warning
      // when it lands in a sync client's folder.
      const { defaultTraceOut, recordTracePointer, syncWarning } = await import("../trace/trace-location.js");
      let absOut: string | undefined = output;
      if (output) {
        const { resolveTraceOut } = await import("./runtime-trace-sink.js");
        absOut = resolveTraceOut(output, proj);
      } else if (proj) {
        absOut = defaultTraceOut(proj);
      }
      const r = await runtimeDaemon.traceStartDomains<{ run: { runId: string }; outputPath: string; domains: string[] }>(session_id, doms, absOut);
      const storePath = r.outputPath ?? absOut;
      const pointer = proj && storePath
        ? recordTracePointer(proj, {
            runId: r.run?.runId,
            duckdbPath: storePath,
            retracePath: storePath.endsWith(".duckdb") ? `${storePath.slice(0, -".duckdb".length)}.c64retrace` : undefined,
            startedAt: new Date().toISOString(),
            domains: r.domains,
          })
        : undefined;
      const warning = storePath ? syncWarning(storePath) : undefined;
      return { content: [{ type: "text" as const, text: [
        `Trace started (Runtime Daemon) — run ${r.run.runId}`,
        `Domains: ${r.domains.join(", ")}`,
        `Store: ${r.outputPath}`,
        ...(pointer ? [`Recorded in: ${pointer}`] : []),
        ...(warning ? [warning] : []),
        `Drive the session (runtime_session_run / runtime_until), stamp phases with runtime_mark, then runtime_trace_finalize. Read it with runtime_swimlane_slice / trace_store_*.`,
      ].join("\n") }] };
    },
));

  server.tool(
    "runtime_trace_finalize",
    "Finalize the active streaming trace: drain remaining events + write the trace_run header, then close the trace.duckdb. Requires an active trace (runtime_trace_start, or runtime_session_start trace_out=...). Call once capture is complete; the store is then queryable any time via trace_store_query / trace_store_top_pcs / trace_store_bus_find / runtime_query_events (pass the trace.duckdb path). Not for marking (use runtime_mark) or progress polling (use runtime_trace_status). Inputs: session_id. Returns: run summary (runId, event/byte counts, mark list, store path).",
    { session_id: z.string() },
    safeHandler("runtime_trace_finalize", async ({ session_id }) => {
      // Spec 746.3 — route to the shared daemon (BUG-028 class: was getRuntimeController-only).
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      // wait_index=true: stop + await the background DuckDB index so the store is
      // queryable on return (the LLM queries next); the UI's instant button omits it.
      // Spec 806 — the store paths come from the runtime's `index` block, NOT from a
      // `run.evidenceRef` field: that name belonged to the deleted in-process trace
      // record and the runtime never had it, so reading it printed "Store: undefined"
      // the moment the in-process branch went. The runtime reports BOTH paths and they
      // are two real files: `retracePath` is the binary timeline (the authority),
      // `duckdbPath` is the queryable index — and the trace_store_* tools want the
      // latter. Report both so the next call can be made without guessing.
      const stopped = await runtimeDaemon.traceStop<{
        run: { runId: string; eventCount: number; bytesWritten: number; marks: unknown[]; cycleStart: number; cycleEnd: number } | null;
        index?: { duckdbPath?: string; retracePath?: string; eventsIndexed?: number };
      }>(session_id, true);
      const run = stopped.run;
      // The clean refusal used to live in the in-process branch; without it a finalize
      // with no active trace threw a raw TypeError on `.runId` at the caller.
      if (!run) throw new Error(
        "No active trace to finalize. Start one with runtime_trace_start (or runtime_session_start trace_out=...) first.",
      );
      const duckdbPath = stopped.index?.duckdbPath;
      const retracePath = stopped.index?.retracePath;
      // Spec 753 — auto-write the page memory map sidecar if mem-row was captured.
      // Fully soft-fail: a failure here (incl. the dynamic import) must NEVER turn
      // a successful finalize into an error envelope.
      let mm: string | null = null;
      try {
        const { writeTraceMemoryMapSidecar } = await import("./trace-store.js");
        if (retracePath) mm = await writeTraceMemoryMapSidecar(retracePath, context, run.runId);
      } catch { /* soft-fail — finalize already succeeded */ }
      return { content: [{ type: "text" as const, text: [
        `Trace finalized (Runtime Daemon) — run ${run.runId}`,
        `Events: ${run.eventCount}  bytes: ${run.bytesWritten}  marks: ${run.marks.length}`,
        `Cycles: ${run.cycleStart}..${run.cycleEnd}`,
        ...(retracePath ? [`Timeline: ${retracePath}`] : []),
        duckdbPath
          ? `Store (duckdb_path): ${duckdbPath}`
          : `Store: not indexed — re-run finalize, or index it with trace_store_info on the .c64retrace.`,
        ...(mm ? [mm] : []),
        `Query it with trace_store_query / trace_store_top_pcs / runtime_swimlane_slice — pass the Store path above as duckdb_path.`,
      ].join("\n") }] };
    },
));

  server.tool(
    "runtime_trace_status",
    "Report the active streaming trace's status — runId, output path, captured event/mark counts, backpressure flag. Requires an active trace started via runtime_session_start(trace_out=...). Use to watch capture progress and decide when to call runtime_trace_finalize. Not for the run's machine state (use runtime_session_status) or offline store queries (use trace_store_info). Inputs: session_id. Returns: trace status JSON.",
    { session_id: z.string() },
    safeHandler("runtime_trace_status", async ({ session_id }) => {
      // Spec 746.3 — route to the shared daemon (BUG-028 class).
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const s = await runtimeDaemon.traceStatus(session_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }] };
    },
));

  server.tool(
    "runtime_loader_lens",
    "Use to read a loader-lens capture's landing map: which medium block each transferred payload came FROM and where it came to rest in C64 RAM. Point it at a .c64retrace captured with the drive-mechanism lane armed (runtime_trace_start domains=['memory','drive8-cpu','drive-mechanism'] on the daemon, then drive + finalize). Option A rebuild: a run counts as a disk-landing only if transfer reads ($DD00) occurred in its window (memory-copy / relocation runs have none → dropped), and its source block is FIFO-matched to the BLOCK_READ read-set by read time (not head-at-write-time). Returns per landed run {source, c64Dest, len, sha256, transferReads}, where source is tagged by medium — {medium:'disk',track,sector,halftrack} or {medium:'cart',bank,slot,offLo,offHi} — or null. The read-set (what validate_extraction diffs against) is the authority; this map is the DEST-side human view. WHAT IT PROVES: everything here is a fact about THE ONE RUN you captured. A block that does not appear was not read IN THAT RUN — that is not evidence it is unused, and a run that never reached level 90 says nothing about level 90's blocks. Report it as 'read in run X' / 'not seen in run X', never as 'used' / 'unused'. Reads a finalized .c64retrace; not a live capture (use runtime_trace_start to capture one first). DISCIPLINE: the landing map CONFIRMS a payload you already located by READING — it is not how you discover one. If the medium is standard-GCR (KERNAL/DOS-readable), the payload is a static depack (sandbox_depack), not a runtime job. You MUST pass `hypothesis` (a concrete $address + what you read that points there) or the call is refused.",
    {
      capture_path: z.string().describe("Path (abs or under the project) to the .c64retrace binary capture."),
      hypothesis: z.string().optional().describe("REQUIRED (read-before-runtime gate): the read-derived reason — a concrete $address (the payload/routine you already located by reading the drivecode disasm / an entity / a finding) + what pointed you there. Fishing (no address / no rationale) is refused. If the disk is standard-GCR the payload is a static depack — read + sandbox_depack, not the loader-lens."),
      min_run_len: z.number().int().positive().optional().describe("Min contiguous RAM-write run counted as a payload landing (default 16 — filters scratch)."),
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from capture_path to knowledge/phase-plan.json."),
    },
    safeHandler("runtime_loader_lens", async ({ capture_path, hypothesis, min_run_len, project_dir }) => {
      const { checkRuntimeDiscipline } = await import("./discipline-gate.js");
      const gate = checkRuntimeDiscipline(hypothesis, { tool: "runtime_loader_lens", act: "reading a loader-lens landing map (which block a payload came from)" });
      if (!gate.allowed) return { content: [{ type: "text" as const, text: gate.refusal! }] };
      const { landingMapFromCaptureFile } = await import("../trace/loader-lens.js");
      // Spec 834 D1 — the hint is the capture this call is about to read. D3 — the
      // catch is gone; it mattered most here, because the substrate gate two lines
      // down is handed this root and with `undefined` it had no medium to check.
      const proj = resolveHeadlessProjectDir(context, project_dir ?? capture_path);
      // Tier 2 substrate gate — the landing map is payload-extraction-from-medium: if the
      // medium is standard-GCR the payload is a static depack, not a runtime job (the Cybernoid block).
      const { checkSubstrateDiscipline } = await import("./substrate-gate.js");
      const sub = await checkSubstrateDiscipline(proj, { tool: "runtime_loader_lens" });
      if (!sub.allowed) return { content: [{ type: "text" as const, text: sub.refusal! }] };
      const abs = isAbsolute(capture_path) ? capture_path : resolve(proj, capture_path);
      const { basename } = await import("node:path");
      // BUG-052 — folding a multi-GB capture takes longer than the host's per-tool
      // stall limit, and a call declared "stalled" costs the whole stdio connection.
      // Same shape as BUG-039: settle inside the grace window and answer exactly as
      // before, else hand back a job_id and keep folding.
      const { startAnalysisJob, waitForJob } = await import("./analysis-jobs.js");
      const render = (map: Awaited<ReturnType<typeof landingMapFromCaptureFile>>) => {
        const lines = [
          // Spec 785 C3 — a read-set result is a fact about ONE run; name it, and say
          // what silence means, so nothing here reads as "used" / "unused".
          `Loader-lens landing map — ${map.length} landed run(s) in run ${basename(abs)}`,
          `Capture: ${abs}`,
          `Every line below is what run ${basename(abs)} did. A block absent here was not read IN THIS RUN — that is not evidence it is unused.`,
          ...map.slice(0, 200).map((e) => {
            // Spec 785 C2 — `source` is a tagged union now (disk block / cart bank window).
            const sr = e.source;
            const src = sr === null
              ? `T?/S? (no medium read)`
              : sr.medium === "disk"
                ? `T${sr.track}/S${sr.sector} (ht${sr.halftrack})`
                : `bank ${sr.bank} ${sr.slotName} $${sr.offLo.toString(16).padStart(4, "0")}-$${sr.offHi.toString(16).padStart(4, "0")}`;
            return `  ${src} → $${e.c64Dest.toString(16).padStart(4, "0")} len ${e.len} rd ${e.transferReads} sha ${e.sha256.slice(0, 12)}`;
          }),
          ...(map.length > 200 ? [`  … +${map.length - 200} more`] : []),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      };
      // BUG-052 — folding a multi-GB capture takes longer than the host's per-tool
      // stall limit, and a call declared "stalled" costs the whole stdio connection.
      // Same shape as BUG-039: settle inside the grace window and answer exactly as
      // before, else hand back a job_id and keep folding.
      const job = startAnalysisJob("runtime_loader_lens", abs, async () =>
        render(landingMapFromCaptureFile(abs, min_run_len ? { minRunLen: min_run_len } : {})));
      const settled = await waitForJob(job, LOADER_LENS_JOB_GRACE_MS);
      if (!settled) {
        const { statSync } = await import("node:fs");
        const gb = (statSync(abs).size / 1024 ** 3).toFixed(2);
        return { content: [{ type: "text" as const, text: [
          `runtime_loader_lens is still folding ${basename(abs)} (${gb} GB) — switched to background job mode.`,
          `job_id: ${job.id}`,
          `Poll with analysis_job_status { job_id } every ~30s. Do NOT re-run runtime_loader_lens for this capture.`,
          `A capture this size is a firehose: if the map comes back as noise, re-capture a narrower window.`,
        ].join("\n") }] };
      }
      if (job.state === "failed") throw new Error(job.error ?? "runtime_loader_lens failed");
      return job.result as { content: { type: "text"; text: string }[] };
    },
));

  // Spec 806 step 3 — `runtime_session_snapshot` RETIRED. It returned a STRUCTURED
  // JSON state object built by the TS emulator's `snapshot()`; the daemon's
  // `snapshot/dump` writes a `.c64re` FILE. Different product, not a missing route.
  // Customers use the checkpoint ring + `runtime_component_diff` for state; it had
  // already been demoted to ADVANCED for exactly this reason. (Spec 806 §7.1)

  server.tool(
    "runtime_session_status",
    "Snapshot a running session's machine state — both CPUs, IEC bus, drive, cycle counts. Use to check where execution is. Not for the agent-API surface report (use runtime_status, advanced). Inputs: session_id. Returns: CPU/IEC/drive snapshot.",
    { session_id: z.string() },
    safeHandler("runtime_session_status", async ({ session_id }) => {
      // Spec 744.4c — read the session from the shared Runtime Daemon (the same
      // machine the UI drives), not a private MCP-process session.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const { c64Cycles, mode, cpu } = await runtimeDaemon.state(session_id);
      return { content: [{ type: "text" as const, text: [
        `Runtime session status (Runtime Daemon) — ${session_id}`,
        ``,
        `C64 CPU: PC=${formatHexWord(cpu.pc)} A=${formatHexByte(cpu.a)} X=${formatHexByte(cpu.x)} Y=${formatHexByte(cpu.y)} SP=${formatHexByte(cpu.sp)} P=${formatHexByte(cpu.flags)}`,
        `         cycles=${c64Cycles}`,
        `Mode: ${mode}`,
      ].join("\n") }] };
    },
));

  server.tool(
    "runtime_session_close",
    "Close a runtime session and release its resources. Use when finished with a session started by runtime_session_start: it stops the RuntimeController loop (which otherwise keeps ticking the session and pegs a CPU core ~100% after you are done), finalizes any active streaming trace, and removes the session from the registry — the clean alternative to killing the process. Not for pausing to inspect then resuming (keep the session and use runtime_session_run) or for finalizing only a trace (use runtime_trace_finalize). NOTE: in the one-machine-per-process runtime, closing a session does NOT hand the process-global VIC/drive state back to another session — if you ever ran a second in-process session, the first stays corrupted until a process restart. Inputs: session_id. Returns: what was released. Idempotent (closing an unknown/already-closed session is a no-op success).",
    { session_id: z.string() },
    safeHandler("runtime_session_close", async ({ session_id }) => {
      // Spec 744.4c — close the session in the shared Runtime Daemon.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const { existed, released } = await runtimeDaemon.closeSession(session_id);
      return {
        content: [{
          type: "text" as const,
          text: existed || released.length
            ? `Session ${session_id} closed. Released: ${released.join(", ") || "(nothing pending)"}.`
            : `Session ${session_id} was not open (already closed). No-op.`,
        }],
      };
    },
));

  server.tool(
    "runtime_load_prg",
    "Inject a PRG into a session's RAM as if KERNAL LOAD placed it. Use to load a program without a disk. Not for disk LOAD (mount + runtime_type a LOAD line) or static analysis (use analyze_prg). Inputs: session_id, prg_path, optional load_address. Returns: load range.",
    {
      session_id: z.string(),
      prg_path: z.string(),
      load_address: z.string().optional().describe("Override load address (hex). Default = PRG header."),
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
    },
    safeHandler("runtime_load_prg", async ({ session_id, prg_path, load_address, project_dir }) => {
      const addr = load_address ? parseHexWord(load_address) : undefined;
      // BUG-028 — inject into the SHARED daemon session. The path is resolved
      // absolute against the MCP's project (the project-agnostic daemon, localhost,
      // reads the caller's file — same rule as session_start's disk_path).
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      // Spec 834 D1/D3 — the hint is the PRG this call is about to inject, and a
      // project that cannot be found is reported instead of being replaced by the
      // process cwd (which is how one relative prg_path could reach two different files).
      const mcpProject = resolveHeadlessProjectDir(context, project_dir ?? prg_path);
      const absPrg = resolve(mcpProject, prg_path);
      const r = await runtimeDaemon.loadPrg<{ loadAddress: number; endAddress: number; bytesLoaded: number }>(session_id, absPrg, addr);
      return { content: [{ type: "text" as const, text: [
        `PRG loaded into RAM (Runtime Daemon).`,
        `Path: ${absPrg}`,
        `Load address: ${formatHexWord(r.loadAddress)}`,
        `End address: ${formatHexWord(r.endAddress)}`,
        `Bytes: ${r.bytesLoaded}`,
      ].join("\n") }] };
    },
));

  // Spec 769 — load + AUTOSTART a .prg in one call (a monitor macro). BASIC
  // ($0801) → RUN; machine-code → `g <entry>` (default entry = load address, or
  // pass `run` for an explicit "g $1000").
  server.tool(
    "runtime_run_prg",
    "Load AND start a .prg in one shot (the macro that was missing). Loads the PRG into the shared session, then autostarts: a BASIC program (load address $0801) → types RUN; machine code → `g <entry>` (continue at the entry; default = the load address, or pass `run` for an explicit entry like a SYS target). Use to just-run a .prg without disk/monitor steps; not for loading without starting (use runtime_load_prg). Inputs: session_id, prg_path, optional run (hex entry address for machine code). Returns: load address + the autostart action taken.",
    {
      session_id: z.string(),
      prg_path: z.string(),
      run: z.string().optional().describe("Machine-code entry (hex, e.g. '1000' or '$1000'). Omit for BASIC autostart / default load-address entry."),
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from prg_path to knowledge/phase-plan.json."),
    },
    safeHandler("runtime_run_prg", async ({ session_id, prg_path, run, project_dir }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const entry = run ? parseHexWord(run) : undefined;
      // Spec 834 D1/D3 — same as runtime_load_prg: hint from prg_path, failure visible.
      const mcpProject = resolveHeadlessProjectDir(context, project_dir ?? prg_path);
      const abs = resolve(mcpProject, prg_path);
      // The shared backend macro (runtime/run_prg) — same path the UI .prg-drop
      // uses: loadPrgBytes (sets BASIC VARTAB) + autostart (BASIC RUN / g entry).
      const { loadAddress, action } = await runtimeDaemon.runPrg<{ loadAddress: number; action: string }>(session_id, abs, entry);
      return { content: [{ type: "text" as const, text: `Loaded ${prg_path} @ ${formatHexWord(loadAddress)} → started: ${action}` }] };
    },
));

  // Sprint 93.1: queue text typing through CIA1 keyboard matrix. Issue #6 (same
  // shape as the joystick) — the queue can be played out in MACHINE time.
  server.tool(
    "runtime_type",
    "Queue text into a session's keyboard buffer (CIA1 matrix), as if typed. Use to enter BASIC commands / LOAD lines. Not for joystick (use runtime_joystick). Without `settle` the text is only QUEUED: the daemon plays it out as the machine runs, and since the live session free-runs in real time between calls, your next tool call can land in the middle of the typing and read a half-typed line. With `settle: true` the tool pauses the machine, advances exactly the machine time the queue needs, and restores whether it was running — when the call returns, the text HAS been typed. Use settle whenever the next thing you do depends on the typing having finished (a LOAD, a RUN, a menu entry). Inputs: session_id, text, optional timing, optional settle/extra_frames. Returns: queued confirmation, and for a settle the cycle window it covered.",
    {
      session_id: z.string(),
      text: z.string().describe("Text to type. Use \\r or \\n for RETURN."),
      hold_cycles: z.number().int().min(1000).max(2_000_000).optional(),
      gap_cycles: z.number().int().min(0).max(2_000_000).optional(),
      settle: z.boolean().optional().describe("Play the whole queue out before returning: the machine is paused and advanced by exactly the cycles the queue needs, so the text is typed when the call returns. Default false (queue and return)."),
      extra_frames: z.number().int().min(0).max(300).optional().describe("With settle: extra frames after the last key, for the target to act on it (default 2). A BASIC line needs a few; a game menu may want more."),
    },
    safeHandler("runtime_type", async ({ session_id, text, hold_cycles, gap_cycles, settle, extra_frames }) => {
      const decoded = text.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      const hold = hold_cycles ?? 33000;
      const gap = gap_cycles ?? 33000;
      // BUG-028 — type into the SHARED daemon session (the machine the human drives),
      // not a private in-process session. Read tools were routed; this write tool
      // was not, so the LLM could see but not type. Now uniform.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");

      if (!settle) {
        await runtimeDaemon.typeText(session_id, decoded, hold, gap);
        return { content: [{ type: "text" as const, text: [
          `Queued ${decoded.length} chars on session ${session_id} (Runtime Daemon).`,
          `Hold cycles: ${hold}  Gap cycles: ${gap}`,
          `Queued only. The machine free-runs between calls, so your next call may read a half-typed line —`,
          `pass settle: true when what you do next depends on the typing having finished.`,
        ].join("\n") }] };
      }

      // Issue #6 — the same fix as the frame-locked joystick, for keys: the queue is
      // played out with the machine STOPPED around it, so "typed" is a fact when this
      // returns rather than a race against the caller's next request.
      const { PAL_CYCLES_PER_FRAME } = await import("../project-knowledge/scenario-gherkin.js");
      const extra = extra_frames ?? 2;
      const need = decoded.length * (hold + gap) + extra * PAL_CYCLES_PER_FRAME;
      const before = await runtimeDaemon.state(session_id) as { runState?: string; c64Cycles?: number };
      const wasRunning = before?.runState === "running";
      await runtimeDaemon.pause(session_id);
      const from = (await runtimeDaemon.state(session_id) as { c64Cycles?: number })?.c64Cycles ?? 0;
      await runtimeDaemon.typeText(session_id, decoded, hold, gap);
      let remaining = need;
      while (remaining > 0) {
        const step = Math.min(PAL_CYCLES_PER_FRAME * 50, remaining);
        await runtimeDaemon.run(session_id, step);
        remaining -= step;
      }
      const to = (await runtimeDaemon.state(session_id) as { c64Cycles?: number })?.c64Cycles ?? 0;
      // Leave the machine as it was found — the human co-drives this session.
      if (wasRunning) await runtimeDaemon.resume(session_id);
      return { content: [{ type: "text" as const, text: [
        `Typed ${decoded.length} chars on session ${session_id} and played the queue out.`,
        `Hold cycles: ${hold}  Gap cycles: ${gap}  Extra frames: ${extra}`,
        `cycles ${from} → ${to} (${to - from}), machine paused for the typing and ${wasRunning ? "resumed" : "left paused"} after it`,
        `The text is typed now — this is not a queue you have to wait for.`,
      ].join("\n") }] };
    },
));

  // Sprint 93.1: joystick backend. Issue #6 — a press can be held for a stated
  // number of FRAMES, measured in machine time rather than wall-clock time.
  server.tool(
    "runtime_joystick",
    "Set or HOLD joystick state on a session. Use to drive game input. Not for keyboard (use runtime_type). Two modes. Without `hold_frames` it sets the port state and returns immediately — the machine keeps free-running in real time, so a press lasts as long as it takes you to make the next call, which is a moment you do not control. With `hold_frames` the press is FRAME-LOCKED: the tool pauses the machine, applies the state, advances exactly that many frames, releases, and restores whether the machine was running. That is the same thing runtime_scene_reel does, and it is what you want against a title that debounces its own $DC00/$DC01 poll behind a raster-frame wait — a menu that samples once per frame will step once per press instead of zero or five times at random. Reach for hold_frames FIRST for any menu or in-game input; the bare set mode is for holding a direction across several other calls on purpose. Inputs: session_id, direction/fire flags, optional port (1 or 2, default 2), optional hold_frames. Returns: applied state, and for a hold the cycle window it covered.",
    {
      session_id: z.string(),
      up: z.boolean().optional(),
      down: z.boolean().optional(),
      left: z.boolean().optional(),
      right: z.boolean().optional(),
      fire: z.boolean().optional(),
      port: z.number().int().min(1).max(2).optional().describe("Joystick port (1 or 2). Default 2."),
      hold_frames: z.number().int().positive().max(3000).optional().describe("Hold the stated state for exactly this many PAL frames, then release — the machine is paused around it, so the press lands in machine time, not wall-clock time. A tap is 2-4 frames; a menu repeat wants ~15-30. Omit to set the state and return immediately."),
    },
    safeHandler("runtime_joystick", async ({ session_id, up, down, left, right, fire, port, hold_frames }) => {
      // BUG-028 — joystick on the SHARED daemon session.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const p = port ?? 2;
      const state = { up, down, left, right, fire };
      const pressed = Object.entries(state).filter(([, v]) => v).map(([k]) => k).join("+") || "nothing";

      if (!hold_frames) {
        await runtimeDaemon.joystickSet(session_id, p, state);
        return { content: [{ type: "text" as const, text: [
          `Joystick port ${p} — session ${session_id} (Runtime Daemon)`,
          `up=${!!up} down=${!!down} left=${!!left} right=${!!right} fire=${!!fire}`,
          `Set and returned. The machine free-runs between calls, so this press lasts until your next call —`,
          `if the title samples its port behind a frame wait, pass hold_frames instead and the press is measured in frames.`,
        ].join("\n") }] };
      }

      // Issue #6 — FRAME-LOCKED press. The live session free-runs in wall-clock time
      // between two tool calls, so set → run → clear as three calls cannot land a press
      // inside a poll routine's sampling window, and no cycle_budget from the caller
      // side fixes that. Here the machine is stopped for the whole press: it advances
      // exactly hold_frames worth of cycles with the state applied, and not one more.
      const { PAL_CYCLES_PER_FRAME } = await import("../project-knowledge/scenario-gherkin.js");
      const before = await runtimeDaemon.state(session_id) as { runState?: string; cycle?: number };
      const wasRunning = before?.runState === "running";
      await runtimeDaemon.pause(session_id);
      const from = (await runtimeDaemon.state(session_id) as { cycle?: number })?.cycle ?? 0;
      try {
        await runtimeDaemon.joystickSet(session_id, p, state);
        // Chunked so one long hold is still a sequence of bounded daemon calls.
        let left_ = hold_frames * PAL_CYCLES_PER_FRAME;
        while (left_ > 0) {
          const step = Math.min(PAL_CYCLES_PER_FRAME * 50, left_);
          await runtimeDaemon.run(session_id, step);
          left_ -= step;
        }
      } finally {
        // Release even if the advance threw — a stuck direction is worse than a
        // failed call, and the human shares this machine.
        await runtimeDaemon.joystickClear(session_id, p);
      }
      const after = (await runtimeDaemon.state(session_id) as { cycle?: number })?.cycle ?? 0;
      // Leave the machine as it was found: the human co-drives this session and did
      // not ask for it to stop.
      if (wasRunning) await runtimeDaemon.resume(session_id);
      return { content: [{ type: "text" as const, text: [
        `Joystick port ${p} — session ${session_id}: held ${pressed} for ${hold_frames} frame(s), then released`,
        `cycles ${from} → ${after} (${after - from}), machine paused for the press and ${wasRunning ? "resumed" : "left paused"} after it`,
        `The press was measured in machine time, so it lands the same way every run — the same guarantee runtime_scene_reel gives.`,
        `If the title still misses it, the hold is shorter than its poll interval: raise hold_frames.`,
      ].join("\n") }] };
    },
));

  // Spec 806 step 3 — `runtime_diagnose_mm` RETIRED. A per-title (Maniac Mansion)
  // one-shot diagnostic whose whole body was an in-process TS machine: it started
  // an IntegratedSession in `debug-vice-compare` mode, cold-reset it, ran
  // `diagnostic-mm` over the live IEC/drive trace channels and closed it again.
  // There is no daemon method for any of that, and inventing one would be a new
  // feature wearing an old tool's name. It was ADVANCED-only. (Spec 806 §7)

  server.tool(
    "runtime_render_screen",
    "Render a session's current VIC output to a PNG. Use to see the live screen state. Not for a saved scenario (use the advanced scenario export). Inputs: session_id, out_path. Returns: PNG path + dimensions.",
    {
      session_id: z.string(),
      path: z.string().describe("Output PNG path"),
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json."),
    },
    safeHandler("runtime_render_screen", async ({ session_id, path, project_dir }) => {
      // Spec 834 D1 — this tool resolved no project at all: the PNG is written by the
      // MCP process, so a relative `path` landed wherever that process happened to be
      // standing. The hint is the output path itself (or the project the caller named),
      // and the PNG is written under the resolved root. D3 — no catch: an unfindable
      // project is reported rather than replaced by the cwd.
      const proj = resolveHeadlessProjectDir(context, project_dir ?? path);
      const outPath = isAbsolute(path) ? path : resolve(proj, path);
      // Spec 744.4c — render the shared Runtime Daemon session's screen. The daemon
      // returns a base64 PNG (same frame the UI sees); write it to the requested path.
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const shot = await runtimeDaemon.screenshot(session_id);
      const dataUrl = shot.dataUrl ?? "";
      const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      const buf = Buffer.from(b64, "base64");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outPath, buf);
      return { content: [{ type: "text" as const, text: [
        `runtime_render_screen — session ${session_id} (Runtime Daemon)`,
        `Output: ${outPath}`,
        `Dimensions: ${shot.width ?? "?"}×${shot.height ?? "?"}`,
        `Bytes: ${buf.length}`,
      ].join("\n") }] };
    },
));

  // Spec 746.4 — checkpoint ring (scrub / rewind) on the SHARED session. The ring
  // auto-captures a full RuntimeCheckpoint every 25 frames while the session runs
  // (128 MiB bytes-budget, evict-oldest, pinned-exempt). These tools let the LLM
  // list/capture/pin/restore the SAME keyframes the human scrubs in the UI — the
  // basis for "rewind to interesting state, pin as evidence, branch". All route to
  // the daemon — the ring lives there. (Spec 806 step 2: the `cpInProc` in-process
  // fallback that built a RuntimeController over an IntegratedSession is gone.)

  server.tool(
    "runtime_checkpoint_list",
    "List the session's checkpoint-ring keyframes (id, frame, cycles, pinned) + ring stats (count, bytes, budget). The ring auto-captures a full machine snapshot every ~0.5s while the session runs, for rewind/scrub. Use to see what points you can restore to. Not for the trace timeline (use trace_store_*). Inputs: session_id. Returns: checkpoint refs + stats.",
    { session_id: z.string() },
    safeHandler("runtime_checkpoint_list", async ({ session_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.checkpointList(session_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_capture",
    "Capture a checkpoint NOW (a full restorable snapshot of the shared session at the current instruction boundary) and add it to the ring. Use to mark an interesting live moment before it scrolls out of the auto-capture window. Not for a durable file (use snapshot_dump via runtime_session_status's ref, or the runtime's own .c64re dump). Inputs: session_id. Returns: the new checkpoint ref + ring stats.",
    { session_id: z.string() },
    safeHandler("runtime_checkpoint_capture", async ({ session_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.checkpointCapture(session_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_pin",
    "Pin a checkpoint so the ring never evicts it (the durability primitive — pinned keyframes survive past the ~2.6 min window). Use to retain an interesting state as evidence / a branch base. Not for a file dump (use the runtime's .c64re snapshot dump). Inputs: session_id, checkpoint id. Returns: ref + stats.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_checkpoint_pin", async ({ session_id, id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.checkpointPin(session_id, id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_unpin",
    "Unpin a checkpoint (let the ring reclaim it under the byte budget again). Use to release a retained state you no longer need; not for pinning one (use runtime_checkpoint_pin). Inputs: session_id, checkpoint id. Returns: ref + stats.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_checkpoint_unpin", async ({ session_id, id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.checkpointUnpin(session_id, id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_checkpoint_restore",
    "Restore the shared session to a checkpoint (REWIND/scrub): the machine jumps back to that full keyframe state and pauses. The human watching the UI sees the same jump (one shared session). Use to rewind to an interesting moment. Not for forward replay of recorded events (that's the branch/scenario path). Inputs: session_id, checkpoint id. Returns: restored ref + new machine state.",
    { session_id: z.string(), id: z.string() },
    safeHandler("runtime_checkpoint_restore", async ({ session_id, id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.checkpointRestore(session_id, id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_recorder_status",
    "The shared-memory recorder's status: anchor count, oldest/newest cycle, scrub depth, medium generations, dropped count. The recorder is the off-thread streaming capture (separate from the checkpoint ring) that holds minutes of cheap scrub history. Use to see how much history is retained; not for the anchor list (use runtime_recorder_list). Inputs: session_id. Returns: recorder stats.",
    { session_id: z.string() },
    safeHandler("runtime_recorder_status", async ({ session_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.recorderStatus(session_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_recorder_list",
    "List the recorder's stored anchors (seq, cycle, wallMs, disk/cart generation). Each is a restorable scrub point in the off-thread history. Use to pick a seq to dump (use runtime_recorder_dump). Inputs: session_id. Returns: anchor list.",
    { session_id: z.string() },
    safeHandler("runtime_recorder_list", async ({ session_id }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.recorderList(session_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_recorder_dump",
    "Dump a recorder anchor (a past scrub point, by seq from runtime_recorder_list) to a durable .c64re snapshot file. The recorder's unique value: persist a point from MINUTES of cheap history, then undump it (runtime_session_undump) and replay it with tracing on. Not for the live moment (use the checkpoint/dump path). Inputs: session_id, seq, path. Returns: dump result (file bytes, embedded media, cycle/pc).",
    {
      session_id: z.string(),
      seq: z.number(),
      path: z.string(),
      project_dir: z.string().optional().describe("Project root directory. When omitted, resolved by walking up from path to knowledge/phase-plan.json."),
    },
    safeHandler("runtime_recorder_dump", async ({ session_id, seq, path, project_dir }) => {
      // Spec 834 D1 — this tool resolved no project either, and it hands the path to
      // the DAEMON: a project-agnostic host that may serve several projects at once, so
      // a relative path landed against ITS working directory rather than the caller's
      // project. Same rule runtime_session_start states for its medium — the MCP
      // resolves against its own project and hands the daemon an absolute path. D3 — a
      // project that cannot be found is reported, not silently substituted.
      const proj = resolveHeadlessProjectDir(context, project_dir ?? path);
      const outPath = isAbsolute(path) ? path : resolve(proj, path);
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.recorderDump(session_id, seq, outPath);
      return { content: [{ type: "text" as const, text: `${JSON.stringify(r, null, 2)}\nDump path: ${outPath}` }] };
    },
));

  server.tool(
    "runtime_rewind",
    "Time-travel: rewind the shared session to a past checkpoint, optionally continue from there. Seek by `cycle` (nearest checkpoint at/before it) or explicit `id`; default = the most recent. `then`: pause (land + inspect, default) | run (continue forward from there) | keep. Use to jump to a past machine state for inspection, or to re-run from a known point (e.g. the code-overlay debug loop: rewind → patch RAM via runtime_monitor → run → observe → repeat). Not for a plain forward run (use runtime_session_run). The human at the UI sees the same jump (one shared session). Inputs: session_id, optional cycle, optional id, optional then. Returns: the restored checkpoint ref + machine state.",
    { session_id: z.string(), cycle: z.number().optional(), id: z.string().optional(), then: z.enum(["pause", "run", "keep"]).optional() },
    safeHandler("runtime_rewind", async ({ session_id, cycle, id, then }) => {
      const pick = (cps: Array<{ id: string; cycles: number }>): string | undefined => {
        if (id) return id;
        if (!cps.length) return undefined;
        if (cycle === undefined) return cps[cps.length - 1]!.id; // most recent
        let atBefore: { id: string; cycles: number } | undefined;
        let best = cps[0]!, bestD = Infinity;
        for (const c of cps) {
          if (c.cycles <= cycle && (!atBefore || c.cycles > atBefore.cycles)) atBefore = c;
          const d = Math.abs(c.cycles - cycle); if (d < bestD) { bestD = d; best = c; }
        }
        return (atBefore ?? best).id;
      };
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const list = await runtimeDaemon.checkpointList<{ checkpoints: Array<{ id: string; cycles: number }> }>(session_id);
      const target = pick(list.checkpoints ?? []);
      if (!target) throw new Error("runtime_rewind: no checkpoints to rewind to");
      const r = await runtimeDaemon.checkpointRestore(session_id, target, then);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_overlay_run",
    "Use for the code-overlay debug loop (the fast runtime what-if): rewind to a past checkpoint (anchor by `cycle` nearest-at/before, or `id`, or most recent), apply a RAM patch (the `patches` overlay), run forward, and return the observed state — repeatable. Each call restores fresh, so the prior patch is rolled back; iterate a candidate fix from a FIXED point without rebuild/reboot. patches: [{addr, bytes:[..], read?, space?, bank?}]; run with run_cycles (+ optional until_pc breakpoint). Pre-assemble asm→bytes (assemble_source) for the fast loop. `space` targets RAM (default) or a cart bank: space:\"roml\"|\"romh\" + `bank` + `addr`=the CPU window address ($8000-$9FFF / $A000-$BFFF) overlays code into an EasyFlash bank, ephemeral like the RAM patch (rolled back next restore). Cart overlay needs the runtime daemon. Not for a persistent change (use runtime_monitor to poke and keep it). Leaves the machine paused. Inputs: session_id, anchor, patches, run_cycles, until_pc. Returns: applied patches, registers, read-backs, hitPc.",
    {
      session_id: z.string(),
      anchor_cycle: z.number().optional(),
      anchor_id: z.string().optional(),
      patches: z.array(z.object({
        addr: z.number(),
        bytes: z.array(z.number()).optional(),
        read: z.boolean().optional(),
        // Spec 795 — target space: "ram" (default) or a cart bank. For roml/romh give
        // `bank` and `addr` as the CPU window address ($8000-$9FFF / $A000-$BFFF).
        space: z.enum(["ram", "roml", "romh"]).optional(),
        bank: z.number().optional(),
      })),
      run_cycles: z.number().optional(),
      until_pc: z.number().optional(),
    },
    safeHandler("runtime_overlay_run", async ({ session_id, anchor_cycle, anchor_id, patches, run_cycles, until_pc }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.overlayRun(session_id, { anchor_cycle, anchor_id, patches, run_cycles, until_pc });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
));

  server.tool(
    "runtime_monitor",
    "Remote-control the interactive runtime monitor: run ANY monitor command string against the shared session and get its text output back. Use it for any monitor-style interaction — this is the WHOLE monitor REPL in ONE tool. Commands include: m/d (memory hex / disasm), r (registers), bp/del/enable (breakpoints), obs (observers — incl `obs <n> when exec|load|store <lo..hi> do break|log|trace` for non-halting scoped capture; `obs <n> del`), trace, `dump <path>` (= `snapshot <path>` — writes a .c64re state snapshot; our snapshot IS the dump) / `undump <path>` (= `restore`/`loadsnapshot` — loads one), n/z/step/g (run control), sym/inspect/xref, df (flow disasm), label/note, device c64|drive8, sidefx, bank. Run `help` for the verb list or `<verb> help` for one verb's syntax. The session is the shared live machine (human + LLM co-drive the same one); not for silent scripted batch runs on the live session (use a separate backend). Inputs: session_id, command (e.g. \"m 0400 042f\", \"obs t when exec ab01 do trace c64-cpu memory\", \"r\"). Returns: the monitor's text output (or its error string).",
    { session_id: z.string(), command: z.string() },
    safeHandler("runtime_monitor", async ({ session_id, command }) => {
      const { runtimeDaemon } = await import("../runtime/daemon-client.js");
      const r = await runtimeDaemon.monitorExec<{ output?: string; error?: string }>(session_id, command);
      const text = r.error ? `error: ${r.error}` : (r.output ?? "");
      return { content: [{ type: "text" as const, text }] };
    },
));


}
