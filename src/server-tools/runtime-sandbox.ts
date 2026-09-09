// Spec 836 D3 — `runtime_sandbox_run`: the private machine, without a .feature file.
//
// The private machine has existed since Spec 812 and had exactly one door: write
// a capture scenario and get a GIF back. Everything else — a boot to look at, a
// cartridge you want to try, a byte you want to read after a load — had to go
// through the SHARED session a human is co-driving, which is how a project
// session ended up mounting its own .crt into somebody else's Wasteland.
//
// This is that machine for one command. The scope decision is stated in
// `../reel/run-sandbox.ts` and repeated in the tool description, because the
// place a caller reads is the description: a call may express anything COMPLETE
// IN ITSELF, and nothing that needs a later call. So there is no session id, and
// the tool says so rather than letting someone find out.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

const STEP_EXAMPLE = [
  'I wait 170 frames',
  'I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"',
  'I wait until the drive is idle within 8000 frames',
  'I hold joystick 2 fire for 3 frames',
  'I wait until the screen shows "PRESS FIRE" within 2000 frames',
  'I wait until the CPU reaches $0810 within 4000 frames',
].join("\n");

/** Well under the MCP host's ~180 s stall limit, so a sandbox ends itself before
 *  the call it belongs to is abandoned — an orphan daemon is exactly what the
 *  budget exists to prevent. */
const DEFAULT_BUDGET_SECONDS = 120;
const MAX_BUDGET_SECONDS = 600;

export function registerRuntimeSandboxTool(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_sandbox_run",
    "Run a medium on a MACHINE OF YOUR OWN — a private daemon on its own port, started as a child of this call, born with a budget and ending itself when the budget runs out. It never reaches the SHARED session the human co-drives: nothing is mounted into that machine, nothing power-cycles it, and nothing you do here is visible in the human's UI. Use it to boot a cartridge, disk, PRG or snapshot of your own and find out what it does — give it the medium, an optional schedule of steps, and say what you want read back. Steps use the capture-scenario notation, one per line: `I wait 170 frames` / `I type \"LOAD{QUOTE}*{QUOTE},8,1{RETURN}\"` / `I wait until the drive is idle within 8000 frames` / `I hold joystick 2 fire for 3 frames` / `I wait until the CPU reaches $0810 within 4000 frames`. Every step that lasts carries its own duration and the machine is stopped between steps, so the same list replays to the same bytes. WHAT IT CANNOT DO, deliberately: it returns NO session id. The machine is gone before you read the answer, so nothing can attach to it, step it, breakpoint it, open the monitor on it, rewind it or read its memory a second time — a sandbox you could come back to would be a second shared machine, and there is only one of those. Ask for everything you want in THIS call. For an interactive debug loop — stepping, breakpoints, the monitor, rewind, a session that stays — use runtime_session_start and the shared machine. Not for a documentation reel out of a .feature file (use runtime_scene_reel), and not for a picture of the session you are already debugging in (use runtime_render_screen). Inputs: media_path, steps, read_memory, frame_path, screen, budget_seconds. Returns: the private port, a line per step, the end cycle + PC + registers, the text screen, and the memory you asked for.",
    {
      media_path: z
        .string()
        .optional()
        .describe(
          "The medium for YOUR machine — .crt / .d64 / .g64 / .d81 / .prg / .c64re, identified by CONTENT not by extension. A cartridge is inserted, a disk mounted, a snapshot REPLACES the machine, a PRG is loaded (and RUN when it loads at $0801 behind a valid BASIC line). Absolute, or relative to the project dir. Omit it for a bare C64 at the BASIC prompt.",
        ),
      steps: z
        .array(z.string())
        .optional()
        .describe(
          `What to do, one step per entry, in the capture-scenario notation. Omit it and the machine simply runs \`run_frames\`. Example:\n${STEP_EXAMPLE}\nA capture step is refused here — this tool reports, it does not assemble a reel.`,
        ),
      run_frames: z
        .number()
        .optional()
        .describe(
          "How many PAL frames to run when `steps` is omitted (default 300, about six seconds of C64 time). Ignored when `steps` is given — say `I wait N frames` there instead.",
        ),
      read_memory: z
        .array(z.string())
        .optional()
        .describe(
          'Memory to dump once the steps are done, as ADDRESS:LENGTH with an optional lens — "$0400:1000", "$d020:2@io", "$a000:16@ram". The lens is which view of the bus to read through: `cpu` (default) is what the program sees, `ram` the bytes under ROM and the I/O window, then `io`, `rom`, `cart`. This is the ONLY way to see this machine\'s memory: there is no session to read it from afterwards.',
        ),
      screen: z
        .boolean()
        .optional()
        .describe(
          "Include the 40x25 text screen in the report (default true). Says so instead when the VIC is in a bitmap mode and there is no character matrix to read — use frame_path for a picture then.",
        ),
      frame_path: z
        .string()
        .optional()
        .describe(
          "Also write the final frame as a single-frame GIF here (absolute, or relative to the project dir). The only artifact that outlives the machine, and the answer for a title that draws in a bitmap mode.",
        ),
      budget_seconds: z
        .number()
        .optional()
        .describe(
          `How long the private machine may live before it ends ITSELF, whether or not this call is still listening (default ${DEFAULT_BUDGET_SECONDS}, max ${MAX_BUDGET_SECONDS}). This is what makes starting one safe: nothing is left running behind you.`,
        ),
      project_dir: z
        .string()
        .optional()
        .describe(
          "Project root directory, used to resolve relative paths and to register the frame. When omitted, resolved by walking up from media_path, else frame_path. The sandbox itself never writes into the project — it keeps its scratch in a temp dir that is removed when it ends.",
        ),
    },
    safeHandler("runtime_sandbox_run", async (args) => {
      const { media_path, steps, run_frames, read_memory, screen, frame_path, budget_seconds, project_dir } = args;

      // The hint order is by what each path IS: `media_path` is an INPUT that must
      // already exist, `frame_path` an OUTPUT whose directory may not exist yet.
      // Never hintless — that is the cwd coupling no default tool may have.
      const projectDir = context.projectDir(project_dir ?? media_path ?? frame_path);
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      const { parseStep } = await import("../project-knowledge/scenario-gherkin.js");
      const { runSandbox, parseMemoryRead, hexDump } = await import("../reel/run-sandbox.js");

      // ── everything that can be refused BEFORE a daemon starts ────────────────
      const absMedia = media_path ? abs(media_path) : undefined;
      if (absMedia && !existsSync(absMedia)) {
        return text(`runtime_sandbox_run: no such medium: ${absMedia}`);
      }

      const parsedSteps = [];
      const stepErrors: string[] = [];
      for (const line of steps ?? []) {
        const r = parseStep(line);
        if (!r) {
          stepErrors.push(`"${line}": not a step. The vocabulary is:\n${STEP_EXAMPLE}`);
          continue;
        }
        if (r.error) stepErrors.push(r.error);
        else if (r.step?.kind === "capture") {
          stepErrors.push(
            `"${line}": a sandbox run reports, it does not assemble a reel. Use runtime_scene_reel ` +
              `for a GIF of a playthrough, or frame_path for one picture of this run.`,
          );
        } else if (r.step) parsedSteps.push(r.step);
      }
      if (stepErrors.length) {
        return text(`runtime_sandbox_run: the schedule does not parse.\n\n  ${stepErrors.join("\n  ")}`);
      }

      const reads = [];
      const readErrors: string[] = [];
      for (const spec of read_memory ?? []) {
        const r = parseMemoryRead(spec);
        if (r.error) readErrors.push(r.error);
        else if (r.read) reads.push(r.read);
      }
      if (readErrors.length) {
        return text(`runtime_sandbox_run: read_memory does not parse.\n\n  ${readErrors.join("\n  ")}`);
      }

      const budget = Math.min(Math.max(budget_seconds ?? DEFAULT_BUDGET_SECONDS, 1), MAX_BUDGET_SECONDS);
      if (budget_seconds !== undefined && budget_seconds > MAX_BUDGET_SECONDS) {
        return text(
          `runtime_sandbox_run: budget_seconds is capped at ${MAX_BUDGET_SECONDS} (asked for ${budget_seconds}). ` +
            `A private machine that can outlive the call it belongs to is the thing the budget exists to prevent.`,
        );
      }

      // No steps at all is the common case — "boot this and show me".
      if (parsedSteps.length === 0) {
        const frames = Math.max(1, Math.round(run_frames ?? 300));
        const r = parseStep(`I wait ${frames} frames`);
        if (r?.step) parsedSteps.push(r.step);
      }

      const framePath = frame_path ? abs(frame_path) : undefined;

      let run;
      try {
        run = await runSandbox({
          budgetMs: budget * 1000,
          mediaPath: absMedia,
          steps: parsedSteps,
          reads,
          screen: screen !== false,
          wantFrame: !!framePath,
          // A medium named mid-run resolves next to the one this call started
          // from, then in the project dir — the same rule the reel uses.
          resolveMedium: (named) => {
            if (isAbsolute(named)) return named;
            if (absMedia) {
              const beside = resolvePath(dirname(absMedia), named);
              if (existsSync(beside)) return beside;
            }
            return resolvePath(projectDir, named);
          },
        });
      } catch (e) {
        const msg = (e as Error).message;
        // DOCTRINE rule 1 — a missing runtime says so and carries the recipe. It
        // arrives already carrying it from the sandbox session; anything else is
        // a failure of THIS run and the machine is already gone.
        return text(
          `runtime_sandbox_run: ${msg}\n\n` +
            (/runtime is not available|no runtime binary/i.test(msg)
              ? ""
              : `The private machine has been shut down. Nothing was left running, and the ` +
                `shared session was not touched. Edit the step it stopped on and run it again.`),
        );
      }

      const lines: string[] = [];
      lines.push(`SANDBOX RUN — a machine of your own, on port ${run.port}.`);
      lines.push(
        `It was started and ENDED by this call: there is no session to attach to, the shared ` +
          `machine was never reached, and nothing is still running.`,
      );
      lines.push(
        `budget ${budget}s · ran ${(run.elapsedMs / 1000).toFixed(1)}s` +
          (run.endedBecause ? ` · ENDED EARLY: ${run.endedBecause}` : ""),
      );
      lines.push("");
      lines.push("what it did:");
      for (const l of run.log) lines.push(`  ${l}`);

      if (run.waits.length) {
        lines.push("");
        lines.push("waits (each fired on its own state, at this cycle):");
        for (const w of run.waits) {
          lines.push(`  cycle ${String(w.cycle).padEnd(12)} ${w.text} — after ${w.frames} of ${w.budget} frames`);
        }
      }

      if (run.coreOnly) {
        // Loud, above the report, because everything under it means less than it
        // looks like it does.
        lines.push("");
        lines.push(`NOT A WHOLE MACHINE: ${run.coreOnly}`);
      }

      lines.push("");
      lines.push(
        `end: cycle ${run.endCycle} · PC $${hex4(run.pc)} · A $${hex2(run.cpu.a)} X $${hex2(run.cpu.x)} ` +
          `Y $${hex2(run.cpu.y)} SP $${hex2(run.cpu.sp)} P $${hex2(run.cpu.flags)}` +
          (run.runState ? ` · ${run.runState}` : ""),
      );

      if (run.screenRows) {
        lines.push("");
        lines.push("screen:");
        for (const r of run.screenRows) lines.push(`  |${r}|`);
      } else if (run.screenUnreadable) {
        lines.push("");
        lines.push(`screen: ${run.screenUnreadable}`);
      }

      for (const { read, bytes } of run.reads) {
        lines.push("");
        lines.push(`memory ${read.label} (${bytes.length} bytes, ${read.lens} lens):`);
        lines.push(...hexDump(read.addr, bytes));
      }

      if (framePath && run.frame) {
        mkdirSync(dirname(framePath), { recursive: true });
        writeFileSync(framePath, run.frame.bytes);
        lines.push("");
        lines.push(`frame: ${framePath} (${run.frame.width}x${run.frame.height}, ${run.frame.bytes.length} bytes, GIF)`);
        try {
          const reg = context.tryRegisterKnowledgeArtifacts(projectDir, {
            toolName: "runtime_sandbox_run",
            title: `Sandbox run: ${absMedia ?? "bare machine"}`,
            parameters: { port: run.port, endCycle: run.endCycle, budgetSeconds: budget },
            outputs: [
              {
                path: framePath, kind: "preview", scope: "generated", format: "gif",
                role: "sandbox-frame", producedByTool: "runtime_sandbox_run",
              },
            ],
          });
          if (reg.message) lines.push(reg.message);
        } catch {
          /* registration is a convenience; the frame exists either way */
        }
      }

      return text(lines.join("\n"));
    }),
  );
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, "0").toUpperCase();
}
function hex4(v: number): string {
  return v.toString(16).padStart(4, "0").toUpperCase();
}
function text(s: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: s }] };
}
