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
import type { Check } from "../project-knowledge/scenario-gherkin.js";

const STEP_EXAMPLE = [
  'I wait 170 frames',
  'I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"',
  'I wait until the drive is idle within 8000 frames',
  'I hold joystick 2 fire for 3 frames',
  'I start holding joystick 2 right',
  'I hold the key "SPACE" for 2 frames',
  'I release joystick 2',
  'I wait until the screen shows "PRESS FIRE" within 2000 frames',
  'I wait until the CPU reaches $0810 within 4000 frames',
  'I read the series "$D01C:1@io", "$D029@io" every frame for 600 frames',
].join("\n");

/** Spec 900 — the check notation, as the refusal names it. */
const CHECK_EXAMPLE = [
  "Then $8EF2 is $01",
  "Then $40 is $26 $40 $26 $40 $26 $55",
  "Then $B0 is not $00",
  "Then $8EF2 is one of $01, $02",
  "Then $8EF2@ram is $01",
  "Then the CPU is at $0812",
  'Then the screen shows "READY."',
  "Then $D01C@io is $04 throughout the next 600 frames",
  "Then $D01C@io is $04 at every frame for 600 frames at raster line 250",
].join("\n");

/** Well under the MCP host's ~180 s stall limit, so a sandbox ends itself before
 *  the call it belongs to is abandoned — an orphan daemon is exactly what the
 *  budget exists to prevent. */
const DEFAULT_BUDGET_SECONDS = 120;
const MAX_BUDGET_SECONDS = 600;

export function registerRuntimeSandboxTool(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_sandbox_run",
    "Run a medium on a MACHINE OF YOUR OWN — a private daemon on its own port, started as a child of this call, born with a budget and ending itself when the budget runs out. It never reaches the SHARED session the human co-drives: nothing is mounted into that machine, nothing power-cycles it, and nothing you do here is visible in the human's UI. Use it to boot a cartridge, disk, PRG or snapshot of your own and find out what it does — give it the medium, an optional schedule of steps, and say what you want read back. Steps use the capture-scenario notation, one per line: `I wait 170 frames` / `I type \"LOAD{QUOTE}*{QUOTE},8,1{RETURN}\"` / `I wait until the drive is idle within 8000 frames` / `I hold joystick 2 fire for 3 frames` / `I wait until the CPU reaches $0810 within 4000 frames`. `the CPU reaches $XXXX` is an execution breakpoint — it stops when the CPU FETCHES that address, however briefly (an IRQ handler, KERNAL ROM), not when the PC happens to be there at a frame boundary; `Then the CPU is at $XXXX` is the sample. Every step that lasts carries its own duration and the machine is stopped between steps, so the same list replays to the same bytes. WHAT IT CANNOT DO, deliberately: it returns NO session id. The machine is gone before you read the answer, so nothing can attach to it, step it, breakpoint it, open the monitor on it, rewind it or read its memory a second time — a sandbox you could come back to would be a second shared machine, and there is only one of those. Ask for everything you want in THIS call. For an interactive debug loop — stepping, breakpoints, the monitor, rewind, a session that stays — use runtime_session_start and the shared machine. Not for a documentation reel out of a .feature file (use runtime_scene_reel), and not for a picture of the session you are already debugging in (use runtime_render_screen). WHERE IN THE FRAME INPUT LANDS: every press used to arrive on a frame boundary, so a bug that depends on the beam position at that moment never showed. `input_offset_cycles: N` moves every input step N cycles into the frame, `jitter_seed: S` gives each input step its own seeded offset, and `sweep: K` runs the same steps K times (one private machine each) with the input spread evenly across one frame, returning PASS/FAIL per offset and the first failing offset to replay with `input_offset_cycles`. A `Then … throughout the next 600 frames` holds at every frame, not only where the step before it ended, and fails at the first frame and cycle it does not; `read_series` returns the changing rows of some addresses over a window of frames. All of these need a runtime with cycle-exact input and the frame probe, and are refused by name (never approximated) without it. The machine is the project's C64 model unless `model` names another — c64-ntsc for an NTSC release; a frame is that machine's frame. Inputs: media_path, steps, model, read_memory, read_series, input_offset_cycles, jitter_seed, sweep, frame_path, screen, budget_seconds. Returns: the private port, which C64 it was, a line per step, the offsets the inputs used, the checks, the series tables, the end cycle + PC + registers, the text screen, and the memory you asked for.",
    {
      media_path: z
        .string()
        .optional()
        .describe(
          "The medium for YOUR machine — .crt / .d64 / .g64 / .d81 / .prg / .c64re, identified by CONTENT not by extension. A cartridge is inserted, a disk mounted (a .d81 into a 1581 — drive 8 is fitted with one), a snapshot REPLACES the machine, a PRG is loaded (and RUN: typed when it loads at $0801 behind a valid BASIC line, or started at `run`). Absolute, or relative to the project dir. Omit it for a bare C64 at the BASIC prompt.",
        ),
      drive_type: z
        .enum(["1541", "1581"])
        .optional()
        .describe("Drive 8's board: \"1541\" or \"1581\". Omitted: a 1541 — and a medium that only fits the other one (a .d81) gets that one by itself, the runtime naming it. Set it when no medium says: an empty drive, or a D81 inserted by a later step."),
      run: z
        .string()
        .optional()
        .describe(
          "For a PRG: start it at this address after the load instead of typing RUN — \"$0840\", \"0x0840\" or \"0840\". The way to start machine code that has no BASIC line, or to skip one. Refused, not ignored, by a runtime too old to take it.",
        ),
      steps: z
        .array(z.string())
        .optional()
        .describe(
          `What to do, one step per entry, in the capture-scenario notation. Omit it and the machine simply runs \`run_frames\`. Example:\n${STEP_EXAMPLE}\nA capture step is refused here — this tool reports, it does not assemble a reel. A \`Then …\` entry is a CHECK, decided where it stands in the list and reported PASS/FAIL with what the machine had:\n${CHECK_EXAMPLE}\nThe same checks a .feature file runs through \`c64re scenario run\`.`,
        ),
      run_frames: z
        .number()
        .optional()
        .describe(
          "How many frames to run when `steps` is omitted (default 300 — about six seconds on PAL, five on NTSC). Ignored when `steps` is given — say `I wait N frames` there instead.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Which C64 this machine is — c64-pal, c64-ntsc, c64-paln (runtime_monitor `model` lists every model and what a missing one lacks). Omitted: the project's model (project_init machine_model), else PAL. It is chosen before the machine is switched on, so a release that detects the standard at boot sees this one. A model this runtime cannot run is refused by name.",
        ),
      read_memory: z
        .array(z.string())
        .optional()
        .describe(
          'Memory to dump once the steps are done, as ADDRESS:LENGTH with an optional lens — "$0400:1000", "$d020:2@io", "$a000:16@ram". The lens is which view of the bus to read through: `cpu` (default) is what the program sees, `ram` the bytes under ROM and the I/O window, then `io`, `rom`, `cart`. This is the ONLY way to see this machine\'s memory: there is no session to read it from afterwards.',
        ),
      read_series: z
        .array(z.string())
        .optional()
        .describe(
          'Addresses to watch over a window of frames, each ADDRESS[:LENGTH][@lens] — "$D01C:1@io", "$D029@io" (length in decimal, or $hex; at most 256 bytes in all). Read after the steps; the machine advances by the window. Returns a table of ONLY the rows where a value changed, each with its frame, cycle and raster line. Window: `series_frames` (default 600); sampling: `every_frames` (default 1) at `series_line` (default: the line after the visible area, so the sample sees the frame that was shown). In a .feature file the same thing is the step `I read the series "$D01C:1@io" every frame for 600 frames`.',
        ),
      every_frames: z
        .number()
        .optional()
        .describe("With read_series: sample every N-th frame instead of every frame (default 1)."),
      series_frames: z
        .number()
        .optional()
        .describe("With read_series: how many frames the window lasts (default 600, at most 50000)."),
      series_line: z
        .number()
        .optional()
        .describe("With read_series: the raster line each sample is taken at. Default: the line after the visible area (288 on PAL)."),
      input_offset_cycles: z
        .number()
        .optional()
        .describe("Press every input step (`I type`, `I hold …`, `I start holding …`, `I release …`) this many cycles past the point it would have pressed at, instead of exactly there. One frame is 19656 cycles on PAL, 17095 on NTSC. Omitted: nothing changes and the run replays to the same bytes as before. The offset each step used is in the result."),
      jitter_seed: z
        .number()
        .optional()
        .describe("Give each input step its own offset inside the frame, derived from this seed and the step's index — the same seed gives the same offsets. Not together with input_offset_cycles or sweep. The offsets used are in the result."),
      sweep: z
        .number()
        .optional()
        .describe("Run the same steps this many times (2 to 64), each on a private machine of its own, with the input offset spread evenly across one frame of the machine's model. Needs at least one `Then` to decide each run. Returns PASS/FAIL per offset and the first failing offset; replay it with input_offset_cycles. Not together with input_offset_cycles or jitter_seed."),
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
      const {
        media_path, run, drive_type, steps, run_frames, read_memory, screen, frame_path, budget_seconds, project_dir, model,
        read_series, every_frames, series_frames, series_line, input_offset_cycles, jitter_seed, sweep,
      } = args;

      // The hint order is by what each path IS: `media_path` is an INPUT that must
      // already exist, `frame_path` an OUTPUT whose directory may not exist yet.
      // Never hintless — that is the cwd coupling no default tool may have.
      const projectDir = context.projectDir({ projectDir: project_dir, fileHint: media_path ?? frame_path });
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      const { parseStep, parseCheck, holdIssues } = await import("../project-knowledge/scenario-gherkin.js");
      const { runSandbox, parseMemoryRead, hexDump } = await import("../reel/run-sandbox.js");

      // ── everything that can be refused BEFORE a daemon starts ────────────────
      const absMedia = media_path ? abs(media_path) : undefined;
      if (absMedia && !existsSync(absMedia)) {
        return text(`runtime_sandbox_run: no such medium: ${absMedia}`);
      }

      const parsedSteps = [];
      const stepErrors: string[] = [];
      // Spec 900 — a `Then …` entry is a check, decided where it stands in the list.
      const checks: { check: Check; afterSteps: number; text: string }[] = [];
      for (const line of steps ?? []) {
        const then = line.trim().match(/^(?:Then|And)\s+(.+)$/i);
        const asCheck = then ? parseCheck(then[1]) : undefined;
        if (then && !parseStep(then[1])) {
          if (!asCheck) {
            stepErrors.push(`"${line}": not a check — in a tool call a Then has to be decidable. The notation:\n${CHECK_EXAMPLE}`);
          } else if ("error" in asCheck) stepErrors.push(asCheck.error);
          else checks.push({ check: asCheck.check, afterSteps: parsedSteps.length, text: then[1].trim() });
          continue;
        }
        const r = parseStep(then ? then[1] : line);
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
      // A start without its release is a press with no end — refused like a bad line.
      if (!stepErrors.length) for (const h of holdIssues(parsedSteps)) stepErrors.push(h.message);
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

      // Spec 899 D4 — `read_series` is the step `I read the series …`, appended after the rest.
      if (read_series?.length) {
        const every = every_frames ?? 1;
        const frames = series_frames ?? 600;
        const quoted = read_series.map((r) => `"${r.replace(/"/g, "")}"`).join(", ");
        const line = series_line === undefined ? "" : ` at raster line ${series_line}`;
        const r = parseStep(`I read the series ${quoted} every ${every} frames for ${frames} frames${line}`);
        if (!r?.step) return text(`runtime_sandbox_run: read_series does not parse.\n\n  ${r?.error ?? "not a series"}`);
        if (r.error) return text(`runtime_sandbox_run: read_series does not parse.\n\n  ${r.error}`);
        parsedSteps.push(r.step);
      } else if (every_frames !== undefined || series_frames !== undefined || series_line !== undefined) {
        return text("runtime_sandbox_run: every_frames, series_frames and series_line belong to read_series — name the addresses with read_series.");
      }

      const { offsetRefusal, offsetsRequested } = await import("../reel/input-offset.js");
      const offsetOptions = { inputOffsetCycles: input_offset_cycles, jitterSeed: jitter_seed };
      const offsetWhy = offsetRefusal(offsetOptions);
      if (offsetWhy) return text(`runtime_sandbox_run: ${offsetWhy}. Nothing was run.`);
      if (sweep !== undefined && offsetsRequested(offsetOptions)) {
        return text("runtime_sandbox_run: a sweep chooses the offsets itself — give sweep, or input_offset_cycles, or jitter_seed. Nothing was run.");
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
      // Spec 863 — the machine is the caller's model, else the project's, else the default.
      const { projectMachineModel } = await import("../project-knowledge/machine-model.js");
      const { describeMachine } = await import("../runtime/machine-model.js");
      const chosenModel = model?.trim() || projectMachineModel(projectDir);

      let runEntry: number | undefined;
      if (run != null) {
        const m = /^(?:\$|0x)?([0-9a-f]{1,4})$/i.exec(run.trim());
        if (!m) return text(`runtime_sandbox_run: run must be an address like "$0840", got ${JSON.stringify(run)}. Nothing was run.`);
        runEntry = parseInt(m[1], 16);
      }

      const resolveMedium = (named: string): string => {
        if (isAbsolute(named)) return named;
        if (absMedia) {
          const beside = resolvePath(dirname(absMedia), named);
          if (existsSync(beside)) return beside;
        }
        return resolvePath(projectDir, named);
      };

      // Spec 899 D2 — a sweep is its own report: one line per offset.
      if (sweep !== undefined) {
        const { runSweep, sweepRefusal } = await import("../reel/sweep.js");
        const { formatSweep } = await import("../reel/probe-report.js");
        const sweepOpts = {
          budgetMs: budget * 1000, model: chosenModel, mediaPath: absMedia, run: runEntry, driveType: drive_type,
          steps: parsedSteps, checks, screen: false, resolveMedium,
        };
        const why = sweepRefusal(sweepOpts, sweep);
        if (why) return text(`runtime_sandbox_run: ${why}. Nothing was run.`);
        try {
          const w = await runSweep(sweepOpts, sweep);
          return text(formatSweep(w).join("\n"));
        } catch (e) {
          return text(`runtime_sandbox_run: ${(e as Error).message}\n\nEvery sweep machine has been shut down. Nothing was left running, and the shared session was not touched.`);
        }
      }

      let result;
      try {
        result = await runSandbox({
          budgetMs: budget * 1000,
          model: chosenModel,
          mediaPath: absMedia,
          run: runEntry,
          driveType: drive_type,
          steps: parsedSteps,
          checks,
          reads,
          ...offsetOptions,
          screen: screen !== false,
          wantFrame: !!framePath,
          // A medium named mid-run resolves next to the one this call started
          // from, then in the project dir — the same rule the reel uses.
          resolveMedium,
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
      lines.push(`SANDBOX RUN — a machine of your own, on port ${result.port}.`);
      lines.push(
        `It was started and ENDED by this call: there is no session to attach to, the shared ` +
          `machine was never reached, and nothing is still running.`,
      );
      lines.push(
        `machine: ${describeMachine(result.machine)}` +
          (model ? "" : chosenModel ? " — the project's model" : " — the default; pass `model` for another"),
      );
      lines.push(
        `budget ${budget}s · ran ${(result.elapsedMs / 1000).toFixed(1)}s` +
          (result.endedBecause ? ` · ENDED EARLY: ${result.endedBecause}` : ""),
      );
      lines.push("");
      lines.push("what it did:");
      for (const l of result.log) lines.push(`  ${l}`);

      if (result.waits.length) {
        lines.push("");
        lines.push("waits (each fired on its own state, at this cycle):");
        for (const w of result.waits) {
          lines.push(`  cycle ${String(w.cycle).padEnd(12)} ${w.text} — after ${w.frames} of ${w.budget} frames`);
        }
      }

      if (result.inputs.length) {
        const { formatInputs } = await import("../reel/probe-report.js");
        lines.push("");
        lines.push(...formatInputs(result.inputs));
      }
      if (result.series.length) {
        const { formatSeries } = await import("../reel/probe-report.js");
        for (const s of result.series) {
          lines.push("");
          lines.push(...formatSeries(s));
        }
      }

      if (result.checks.length) {
        const failed = result.checks.filter((c) => !c.pass && !c.stopped).length;
        const undecided = result.checks.filter((c) => c.stopped).length;
        lines.push("");
        lines.push(`checks: ${result.checks.length - failed - undecided} passed, ${failed} failed${undecided ? `, ${undecided} undecided` : ""}`);
        for (const c of result.checks) {
          lines.push(`  ${c.stopped ? "STOP" : c.pass ? "PASS" : "FAIL"}  ${c.text}${c.pass ? "" : ` — ${c.stopped ? "" : "got "}${c.actual}`}  (after step ${c.afterSteps}, cycle ${c.cycle})`);
        }
        // Spec 889 §4b — a green run (every Then held, at least one) is the emulator's yes for
        // the bytes it ran; the C64 Ultimate backend takes only media that have one.
        const { recordPassForRun } = await import("../runtime/emulator-pass.js");
        // A run with the input moved off its usual place is a probe, not the run of record.
        const passed = offsetsRequested(offsetOptions) ? { recorded: [] as { name: string; sha256: string }[], note: undefined } : recordPassForRun({
          projectDir, mediaPath: absMedia, steps: parsedSteps, checks: result.checks,
          resolveMedium,
        });
        if (passed.recorded.length) {
          lines.push(`green emulator run recorded for the C64 Ultimate gate: ${passed.recorded.map((r) => `${r.name} (sha256 ${r.sha256.slice(0, 8)}…)`).join(", ")}`);
        } else if (passed.note) lines.push(passed.note);
      }

      if (result.coreOnly) {
        // Loud, above the report, because everything under it means less than it
        // looks like it does.
        lines.push("");
        lines.push(`NOT A WHOLE MACHINE: ${result.coreOnly}`);
      }

      lines.push("");
      lines.push(
        `end: cycle ${result.endCycle} · PC $${hex4(result.pc)} · A $${hex2(result.cpu.a)} X $${hex2(result.cpu.x)} ` +
          `Y $${hex2(result.cpu.y)} SP $${hex2(result.cpu.sp)} P $${hex2(result.cpu.flags)}` +
          (result.runState ? ` · ${result.runState}` : ""),
      );

      if (result.screenRows) {
        lines.push("");
        lines.push("screen:");
        for (const r of result.screenRows) lines.push(`  |${r}|`);
      } else if (result.screenUnreadable) {
        lines.push("");
        lines.push(`screen: ${result.screenUnreadable}`);
      }

      for (const { read, bytes } of result.reads) {
        lines.push("");
        lines.push(`memory ${read.label} (${bytes.length} bytes, ${read.lens} lens):`);
        lines.push(...hexDump(read.addr, bytes));
      }

      if (framePath && result.frame) {
        mkdirSync(dirname(framePath), { recursive: true });
        writeFileSync(framePath, result.frame.bytes);
        lines.push("");
        lines.push(`frame: ${framePath} (${result.frame.width}x${result.frame.height}, ${result.frame.bytes.length} bytes, GIF)`);
        try {
          const reg = context.tryRegisterKnowledgeArtifacts(projectDir, {
            toolName: "runtime_sandbox_run",
            title: `Sandbox run: ${absMedia ?? "bare machine"}`,
            parameters: { port: result.port, endCycle: result.endCycle, budgetSeconds: budget },
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
