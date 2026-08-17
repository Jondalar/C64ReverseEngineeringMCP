// Spec 812 — `runtime_scene_reel`: a capture scenario, run in an isolated
// machine, assembled into a release reel.
//
// The split this file sits on: the runtime EXECUTES the schedule and encodes the
// GIF (a capability); C64RE decides WHICH screens tell the story of a release,
// in what order, and where the scenario lives in the project (meaning). So this
// module writes a scenario file, hands it to the runtime binary, and registers
// the result — it never emulates anything and never opens a session.
//
// Why the whole schedule goes over in one file instead of a call per step: every
// round trip between here and the machine is wall-clock time the machine would
// otherwise be free-running through. A schedule that is one artifact replays to
// the same bytes; a schedule made of separate calls lands somewhere new each run.
// That was the actual defect behind "the same recipe boots differently every
// time", and it is the reason the waypoints below carry their own durations.

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

// A waypoint, as the caller writes it. One of the five shapes; the runtime
// refuses anything else, and refuses a press or a predicate that does not state
// how long it lasts.
const waypointSchema = z
  .object({
    wait: z
      .object({ frames: z.number().optional(), cycles: z.number().optional() })
      .optional()
      .describe("Advance the machine. `frames` (PAL, 19656 cycles each) or `cycles` — one, not both."),
    type: z
      .object({ text: z.string() })
      .optional()
      .describe('Keys into the keyboard buffer. \\r = RETURN, e.g. {"text": "LOAD\\"*\\",8,1\\r"}.'),
    joy: z
      .object({
        port: z.number().optional().describe("1 or 2 (default 2)"),
        up: z.boolean().optional(),
        down: z.boolean().optional(),
        left: z.boolean().optional(),
        right: z.boolean().optional(),
        fire: z.boolean().optional(),
        frames: z.number().describe("REQUIRED. How long the press is HELD, in frames; it is released afterwards inside this same step. A menu samples the stick once per frame, so 2-3 frames is a tap and 100 frames scrolls the whole list."),
      })
      .optional(),
    waitUntil: z
      .object({
        pc: z.union([z.string(), z.number()]).optional().describe("Run until the CPU reaches this address ($C001 / 0xC001 / 49153)."),
        screenStable: z.object({ frames: z.number() }).optional().describe("Run until the picture has not changed for N frames. NOT usable at a BASIC prompt — the cursor blinks about every 20 frames, so the screen genuinely never settles there."),
        driveIdle: z.boolean().optional().describe("Run until the floppy has WORKED and then STOPPED. Right after a LOAD the drive has not spun up yet, so this waits for the busy→idle edge, not for 'idle now'."),
        timeoutFrames: z.number().describe("REQUIRED. A predicate that never fires fails loudly rather than hanging the capture."),
      })
      .optional(),
    shot: z
      .object({ label: z.string().optional() })
      .optional()
      .describe("Capture a frame. Always lands on a frame boundary, so it is never a half-drawn picture."),
  })
  .describe("One waypoint: exactly one of wait / type / joy / waitUntil / shot.");

interface ReelReport {
  ok?: boolean;
  name?: string;
  gif?: string;
  bytes?: number;
  maxBytes?: number;
  width?: number;
  height?: number;
  frames?: number;
  delayCentiseconds?: number;
  paletteEntries?: number;
  captured?: number;
  dropped?: Array<{ index: number; label: string }>;
  shots?: Array<{ label: string; cycle: number; rasterLine: number }>;
  log?: string[];
}

export function registerSceneReelTool(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_scene_reel",
    "Build an animated release reel (CSDb format: GIF89a, 384x272 including border, hard cuts, uniform delay, <=512000 bytes) from a capture scenario. Use it when a release, a crack or a trainer needs documentation screenshots in playthrough order — title, menu, in-game — produced the same way twice. Boots the medium in its OWN throwaway machine and runs a schedule of waypoints where every step carries its own duration: `wait` frames/cycles, `type` keys, `joy` with a REQUIRED hold length, `waitUntil` a predicate with a REQUIRED timeout, and `shot` to capture. Because the schedule is absolute machine cycles rather than 'send a command and hope', the same scenario replays to the same bytes. Frames come straight from the video chip's own 16-colour indices, so nothing is re-quantized. Not for driving the session you are debugging in, and not for one picture of the machine you are already looking at — use runtime_render_screen instead. Inputs: media, waypoints, out_path. Returns: the reel's path, frame count, byte size, and the cycle each shot landed on.",
    {
      media: z
        .string()
        .describe("Disk/cart to boot (.d64/.g64/.crt). Omit only for a scenario that needs a bare machine."),
      waypoints: z.array(waypointSchema).describe("The schedule, in order. Needs at least one `shot`."),
      out_path: z.string().describe("Where to write the GIF (absolute, or relative to the project dir)."),
      name: z.string().optional().describe("Reel name, recorded in the manifest."),
      delay_ms: z
        .number()
        .optional()
        .describe("Frame delay in milliseconds, uniform across the reel (default 700). Must be at least 10."),
      max_bytes: z
        .number()
        .optional()
        .describe("Hard byte ceiling (default 512000, the CSDb limit). Over budget, whole frames are dropped from the middle outwards and named in the report — never a silent re-encode."),
      scenario_path: z
        .string()
        .optional()
        .describe("Also keep the scenario as a JSON file here, so the reel can be rebuilt or diffed later. Recommended: a scenario is the only reproducible record of how a screen was reached."),
      frames_dir: z
        .string()
        .optional()
        .describe("Also write each captured frame's raw colour indices here (one byte per pixel)."),
    },
    safeHandler("runtime_scene_reel", async ({ media, waypoints, out_path, name, delay_ms, max_bytes, scenario_path, frames_dir }) => {
      const projectDir = context.projectDir();
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      if (media && !existsSync(media)) {
        return text(`runtime_scene_reel: medium not found: ${media}`);
      }
      const shots = waypoints.filter((w) => w.shot).length;
      if (shots === 0) {
        return text(
          "runtime_scene_reel: the schedule has no `shot` waypoint, so it would produce an empty reel.",
        );
      }

      // Only the keys the caller actually set travel to the runtime; an empty
      // sibling object would read as a second step shape and be refused.
      const steps = waypoints.map((w) => {
        const out: Record<string, unknown> = {};
        for (const k of ["wait", "type", "joy", "waitUntil", "shot"] as const) {
          if (w[k] !== undefined) out[k] = w[k];
        }
        return out;
      });

      const scenario = {
        name: name ?? "reel",
        ...(media ? { media } : {}),
        cyclesPerFrame: 19656,
        reel: { delayMs: delay_ms ?? 700, maxBytes: max_bytes ?? 512_000 },
        steps,
      };

      const gifPath = abs(out_path);
      mkdirSync(dirname(gifPath), { recursive: true });

      // The scenario file is the reproducible record; when the caller does not
      // ask to keep it, it still has to exist for the run, so it lands beside
      // the reel rather than in a temp dir nobody will find.
      const scenarioFile = scenario_path ? abs(scenario_path) : `${gifPath}.scenario.json`;
      mkdirSync(dirname(scenarioFile), { recursive: true });
      writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2), "utf8");

      const manifestFile = `${gifPath}.manifest.json`;
      const { resolveTrx64Cli, runTrx64CliJson } = await import("../sandbox/trx64cli.js");
      const cli = resolveTrx64Cli();
      const args = ["reel", "--scenario", scenarioFile, "--out", gifPath, "--manifest", manifestFile, "--json"];
      if (frames_dir) args.push("--frames-dir", abs(frames_dir));

      let report: ReelReport;
      try {
        report = runTrx64CliJson(cli, args) as ReelReport;
      } catch (e) {
        return text(
          `runtime_scene_reel: ${(e as Error).message}\n\n` +
            `The scenario that was attempted is kept at ${scenarioFile} — edit it and retry, ` +
            `or adjust the waypoints. A predicate that timed out names how far it got.`,
        );
      }

      const size = existsSync(gifPath) ? statSync(gifPath).size : 0;
      const lines: string[] = [];
      lines.push(`REEL ${report.name ?? scenario.name} → ${gifPath}`);
      lines.push(
        `${report.frames ?? 0} frames · ${report.width ?? 0}x${report.height ?? 0} · ` +
          `${size} bytes of ${report.maxBytes ?? max_bytes ?? 512_000} · ` +
          `${report.delayCentiseconds ?? 0} cs per frame · ${report.paletteEntries ?? 0} colours`,
      );
      lines.push("");
      lines.push("shots (the cycle each one landed on — a reel is re-derivable from these):");
      for (const s of report.shots ?? []) {
        lines.push(`  ${s.label.padEnd(24)} cycle ${s.cycle}`);
      }
      if (report.dropped?.length) {
        lines.push("");
        lines.push(
          `DROPPED to fit the byte ceiling: ${report.dropped.map((d) => d.label).join(", ")}. ` +
            `Nothing was re-encoded — whole frames went. Raise max_bytes or capture fewer screens.`,
        );
      }
      if ((report.frames ?? 0) < 5) {
        lines.push("");
        lines.push(
          `NOTE: a scene release reel is expected to show at least 5 significantly different ` +
            `screens; this one has ${report.frames ?? 0}.`,
        );
      }
      lines.push("");
      lines.push(`scenario: ${scenarioFile}`);
      lines.push(`manifest: ${manifestFile}`);
      lines.push("");
      lines.push("Rebuild it byte-for-byte by running the same scenario again.");

      // Register the reel + its scenario as project artifacts. A reel nobody can
      // find later is a file, not a deliverable — and the scenario is the only
      // record of how those screens were reached.
      try {
        const reg = context.tryRegisterKnowledgeArtifacts(projectDir, {
          toolName: "runtime_scene_reel",
          title: `Release reel: ${report.name ?? scenario.name}`,
          parameters: {
            media: media ?? null,
            frames: report.frames ?? 0,
            bytes: size,
            delayMs: delay_ms ?? 700,
          },
          inputs: media ? [{ path: media, scope: "input" }] : [],
          outputs: [
            { path: gifPath, kind: "preview", scope: "generated", format: "gif", role: "release-reel", producedByTool: "runtime_scene_reel" },
            { path: scenarioFile, kind: "manifest", scope: "generated", format: "json", role: "capture-scenario", producedByTool: "runtime_scene_reel" },
          ],
        });
        if (reg.message) lines.push(reg.message);
      } catch {
        /* registration is a convenience; the reel exists either way */
      }

      return text(lines.join("\n"));
    }),
  );
}

function text(s: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: s }] };
}
