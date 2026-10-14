// Spec 906 — the doors of a sandbox SESSION: start one for a purpose, list this process's, end one.
//
// `runtime_sandbox_run` is one call and the machine is gone before the answer is read. These three
// are the other shape: a daemon of the LLM's own that stays, so that every `runtime_*` tool that takes
// a `session_id` can drive it, call after call — stepping, breakpoints, the monitor, a trace, rewind.
// It is not a second shared machine: it has a stated purpose and a budget, the human's UI never shows
// it, no other MCP process can call it, and it ends on reached / failed / budget / idle / owner gone.

import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";
import {
  DEFAULT_IDLE_MINUTES, MAX_BUDGET_MINUTES, MAX_LIVE_SESSIONS,
  endSandboxSession, listSandboxSessions, startSandboxSession,
} from "../runtime/sandbox-sessions.js";
import { isSandboxId } from "../runtime/sandbox-parity.js";

const text = (s: string): { content: Array<{ type: "text"; text: string }> } => ({ content: [{ type: "text" as const, text: s }] });

export function registerRuntimeSandboxSessionTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_sandbox_start",
    "Start a machine of your OWN for a stated purpose and keep it: a private daemon on its own port, born with a budget, " +
      "named by a session id `sb-<slug>-<n>`. Use it when your work needs the interactive runtime — mount a medium, run to a point, " +
      "set a breakpoint, step, read the monitor, capture a trace, inspect the VIC, rewind, try a poke, compare two states — and " +
      "the shared machine is the human's or another project's. Pass the returned session_id to every runtime_* tool that takes a " +
      "session_id (runtime_session_run, runtime_until, runtime_monitor, runtime_type, runtime_trace_start, runtime_trace_finalize, " +
      "runtime_checkpoint_*, runtime_rewind, runtime_anchor_*, runtime_candidate_*, …): they work on it exactly as on the shared " +
      "session. The tools that serve a human's UI (runtime_session_start, runtime_session_close, runtime_keep_alive, " +
      "runtime_backend, runtime_down, runtime_input_*, runtime_session_export_audio) refuse a sandbox id by name and say why. " +
      "ISOLATION: it is invisible to the workbench UI and to every other C64RE process (another MCP process calling your id is " +
      "refused 'not yours'), it never reaches the shared session and the shared session never reaches it, and it is always the " +
      "emulator — also while a C64 Ultimate is the selected backend. It is born headless and stands at the BASIC prompt at the " +
      "cycle the answer names, PAUSED: it advances only when a tool runs it, so the same calls replay to the same bytes. A medium " +
      "you pass is mounted as a COPY in the sandbox's scratch (the runtime writes a mounted disk or cartridge back on exit; the " +
      "project's image is never changed). Captures (runtime_trace_start) land in the project's trace root and are KEPT when the " +
      "sandbox ends; everything else the machine held — scratch, the medium's copy, checkpoints in memory — is gone. " +
      "ENDING: call runtime_sandbox_end with outcome reached or failed and a summary when the purpose is done; it also ends " +
      "ITSELF when the budget runs out, when no call reaches it for the idle limit, or when this MCP process dies — a trace " +
      "in progress is finished, not lost, and a later call with the id answers 'ended: <reason> at <time>'. The outcome " +
      "(purpose, outcome, summary, duration, artefacts) goes into the project's step log. Not a one-call run that answers and is " +
      "gone (use runtime_sandbox_run), not a documentation reel (use runtime_scene_reel), not the shared session the human " +
      "co-drives (use runtime_session_start). Inputs: purpose, budget_minutes, media_path, model, drive_type, run, idle_minutes, " +
      `project_dir. Returns: the session id, its port, the machine it booted, the deadline. At most ${MAX_LIVE_SESSIONS} live ` +
      "sandbox sessions per MCP process.",
    {
      purpose: z.string().optional().describe(
        "REQUIRED. What this machine is for, in a sentence — \"validate IM II extraction against a drive-mechanism capture\". It is what " +
        "runtime_sandbox_list shows, what a refusal names when the limit is hit, and what the project's step log records when the sandbox ends."),
      budget_minutes: z.number().optional().describe(
        `REQUIRED. How long the sandbox may live, in minutes (above 0, at most ${MAX_BUDGET_MINUTES}; 30 is a working session). At this age it ends ITSELF, ` +
        "whether or not anyone is still using it — that, with the idle limit and the owner check, is what makes starting one safe."),
      media_path: z.string().optional().describe(
        "The medium to put in — .crt / .d64 / .g64 / .d81 / .prg / .c64re, identified by CONTENT. Absolute, or relative to the project. " +
        "A cartridge is inserted, a disk mounted, a snapshot REPLACES the machine, a PRG is loaded (and RUN when it loads at $0801 behind a BASIC line, " +
        "or started at `run`). Mounted as a COPY; omit it for a bare C64 at the BASIC prompt."),
      model: z.string().optional().describe(
        "Which C64 this machine is — c64-pal, c64-ntsc, c64-paln. Omitted: the project's model (project_init machine_model), else PAL. Chosen before switch-on."),
      drive_type: z.enum(["1541", "1581"]).optional().describe(
        "Drive 8's board. Omitted: a 1541, and a medium that only fits the other one (a .d81) gets that one by itself."),
      run: z.string().optional().describe(
        "For a PRG: start it at this address after the load instead of typing RUN — \"$0840\", \"0x0840\" or \"0840\"."),
      idle_minutes: z.number().optional().describe(
        `The sandbox ends itself when no tool call has reached it for this long (default ${DEFAULT_IDLE_MINUTES}). A call in flight counts as activity.`),
      project_dir: z.string().optional().describe(
        "Project root, used to resolve media_path, to bind the captures (they go to this project's trace root) and to record the outcome. " +
        "When omitted: resolved from media_path, else the MCP's project."),
    },
    safeHandler("runtime_sandbox_start", async ({ purpose, budget_minutes, media_path, model, drive_type, run, idle_minutes, project_dir }) => {
      const why = purpose?.trim();
      if (!why) {
        return text("runtime_sandbox_start: refused — `purpose` is required. Say what this machine is for (one sentence): it is what the step log records when the sandbox ends and what the list shows. Nothing was started.");
      }
      if (budget_minutes === undefined || !Number.isFinite(budget_minutes)) {
        return text(`runtime_sandbox_start: refused — \`budget_minutes\` is required (above 0, at most ${MAX_BUDGET_MINUTES}; 30 is a working session). A machine without a budget is the one that gets forgotten. Nothing was started.`);
      }
      if (budget_minutes <= 0 || budget_minutes > MAX_BUDGET_MINUTES) {
        return text(`runtime_sandbox_start: refused — budget_minutes must be above 0 and at most ${MAX_BUDGET_MINUTES} (asked for ${budget_minutes}). Nothing was started.`);
      }
      if (idle_minutes !== undefined && (!Number.isFinite(idle_minutes) || idle_minutes <= 0)) {
        return text("runtime_sandbox_start: refused — idle_minutes must be above 0. Nothing was started.");
      }

      const projectDir = context.projectDir({ projectDir: project_dir, fileHint: media_path }, true);
      const absMedia = media_path ? (isAbsolute(media_path) ? media_path : resolvePath(projectDir, media_path)) : undefined;
      if (absMedia && !existsSync(absMedia)) return text(`runtime_sandbox_start: no such medium: ${absMedia}. Nothing was started.`);

      let runEntry: number | undefined;
      if (run != null) {
        const m = /^(?:\$|0x)?([0-9a-f]{1,4})$/i.exec(run.trim());
        if (!m) return text(`runtime_sandbox_start: run must be an address like "$0840", got ${JSON.stringify(run)}. Nothing was started.`);
        runEntry = parseInt(m[1], 16);
      }

      const { projectMachineModel } = await import("../project-knowledge/machine-model.js");
      const chosenModel = model?.trim() || projectMachineModel(projectDir);

      let s;
      try {
        s = await startSandboxSession({
          purpose: why, budgetMinutes: budget_minutes, projectDir, mediaPath: absMedia, model: chosenModel,
          driveType: drive_type, run: runEntry, idleMinutes: idle_minutes,
        });
      } catch (e) {
        return text(`${(e as Error).message.startsWith("runtime_sandbox_start") ? "" : "runtime_sandbox_start: "}${(e as Error).message}`);
      }

      const lines = [
        `SANDBOX SESSION ${s.id} — a machine of your own, on port ${s.port}.`,
        `session_id: ${s.id}   (pass it to every runtime_* tool that takes a session_id)`,
        `purpose: ${why}`,
        `machine: ${s.machine}${model ? "" : chosenModel ? " — the project's model" : " — the default; pass `model` for another"}`,
        `deadline: ${s.deadline} at the latest (budget ${budget_minutes} min); ends itself after ${s.idleMinutes} min without a call, or when this MCP process dies`,
        `now: cycle ${s.cycle} · PC $${s.pc.toString(16).padStart(4, "0").toUpperCase()} · PAUSED — it moves only when a tool runs it`,
        `project: ${s.projectDir} — captures (runtime_trace_start) land in its trace root and are kept; the outcome goes into its step log`,
        ...(s.mediaCopy ? [`medium: a copy of ${absMedia} is mounted; writes stay in the sandbox`] : []),
        "",
        ...s.log.map((l) => `  ${l}`),
        "",
        "The shared session was not touched, and nothing here is visible in the workbench UI.",
        `End it with runtime_sandbox_end { session_id: "${s.id}", outcome: "reached" | "failed", summary } when the purpose is done.`,
      ];
      return text(lines.join("\n"));
    }),
  );

  server.tool(
    "runtime_sandbox_end",
    "End a sandbox session you started: the purpose was reached, or it failed. Use when the work in the machine is done — a trace in " +
      "progress is finished (its .c64retrace is kept; the index is built on the first read), the daemon is shut down, its port is free, " +
      "its scratch and the medium's copy are removed. What it wrote to the project (captures, snapshots) is KEPT and listed in the answer. " +
      "The outcome — purpose, outcome, your summary, duration, artefacts — is recorded in the project's step log. Not for a sandbox that " +
      "has already ended on its own (the answer then says why and when), not for the shared session (runtime_session_close; the " +
      "shared machine is the human's). Inputs: session_id, outcome (reached | failed), summary. Returns: the end reason, duration, " +
      "the artefacts that were kept, and whether the step log has the outcome.",
    {
      session_id: z.string().describe("The sandbox session to end — `sb-…`, from runtime_sandbox_start."),
      outcome: z.enum(["reached", "failed"]).describe("Whether the purpose it was started for was reached or failed."),
      summary: z.string().describe("What happened, in a sentence or two — \"manifest matches 624/624\", \"the loader never reads track 18 after the title\". It is recorded in the step log."),
    },
    safeHandler("runtime_sandbox_end", async ({ session_id, outcome, summary }) => {
      if (!isSandboxId(session_id)) {
        return text(`runtime_sandbox_end: ${JSON.stringify(session_id)} is not a sandbox session id (they look like sb-<slug>-<n>). The shared session is ended by its owner, not by this tool. Nothing was done.`);
      }
      if (!summary.trim()) return text("runtime_sandbox_end: refused — `summary` is required: what happened, for the step log. The sandbox is still running.");
      try {
        const i = await endSandboxSession(session_id, outcome, summary.trim());
        const lines = [
          `SANDBOX SESSION ${i.id} ended: ${i.outcome} at ${i.endedAt} after ${i.durationSec}s.`,
          `purpose: ${i.purpose}`,
          ...(i.summary ? [`summary: ${i.summary}`] : []),
          "The daemon is gone, its port is free, its scratch is removed.",
          i.artefacts.length
            ? `kept in the project (${i.artefacts.length}):\n${i.artefacts.map((a) => `  ${a}`).join("\n")}`
            : "nothing was written to the project.",
          `outcome ${i.recorded}.`,
        ];
        return text(lines.join("\n"));
      } catch (e) {
        return text(`runtime_sandbox_end: ${(e as Error).message}`);
      }
    }),
  );

  server.tool(
    "runtime_sandbox_list",
    "List the sandbox sessions THIS MCP process holds: id, purpose, port, deadline, how long each has been idle. Use to see what you still have running " +
      "(and what to end) before starting another — at most " + MAX_LIVE_SESSIONS + " per process. Other processes' sandboxes are not listed: a sandbox is private " +
      "to the process that started it. Not for the shared session (runtime_session_status). Returns: one row per live session, and the ones " +
      "that ended in this process with their reason.",
    {},
    safeHandler("runtime_sandbox_list", async () => {
      const { endedSandboxes } = await import("../runtime/sandbox-sessions.js");
      const rows = listSandboxSessions();
      const done = endedSandboxes();
      const lines = [`${rows.length} of ${MAX_LIVE_SESSIONS} sandbox sessions live in this MCP process.`];
      for (const r of rows) {
        lines.push(`  ${r.id}  port ${r.port}  until ${r.deadline}  idle ${r.idleSeconds}s of ${r.idleLimitMinutes} min  — ${r.purpose}  (${r.projectDir})`);
      }
      if (rows.length === 0) lines.push("  (none)");
      if (done.length) {
        lines.push("", "ended in this process:");
        for (const d of done) lines.push(`  ${d.id}  ended: ${d.reason} at ${d.endedAt}  — ${d.purpose}`);
      }
      return text(lines.join("\n"));
    }),
  );
}
