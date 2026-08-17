// Spec 812 — `runtime_scene_reel`: a written capture scenario, run on a private
// machine, assembled into a release reel.
//
// The split this file sits on: the machine emulates; a human or C64RE drives it.
// So the schedule, the notation, the frame assembly and the decision about which
// screens tell the story all live on this side. The runtime is asked only for
// things a machine can answer — run N cycles, present these keys, hold this stick,
// what is on the screen, where is the raster.
//
// The notation is Gherkin, in the same `.feature` files and the same parser as
// scenario goals (Spec 810). Not a second dialect: a scenario that boots a title
// to its menu and a scenario that checks a byte are the same kind of document said
// at different lengths, and a repo with two notations for one idea ends up with
// two of everything.
//
// Every step that lasts carries its own duration, and that is the whole point. A
// press with no stated end is held until some later call happens to clear it, and
// a menu that samples once per frame scrolls through the entire list — which is
// how "the same recipe" produced three different outcomes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

const EXAMPLE = [
  "Scenario: the release reel",
  '  Given the disk "side1.g64"',
  "  When I wait 170 frames",
  '  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"',
  "  And I wait until the drive is idle within 8000 frames",
  "  And I wait 60 frames",
  '  And I capture "title"',
  "  And I hold joystick 2 down for 3 frames",
  "  And I wait 20 frames",
  "  And I hold joystick 2 fire for 3 frames",
  "  And I wait until the screen is still for 90 frames within 2000 frames",
  '  And I capture "menu"',
  "  Then the reel has at least 5 screens",
].join("\n");

export function registerSceneReelTool(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "runtime_scene_reel",
    "Run a written capture scenario on a private throwaway machine and assemble an animated release reel (CSDb format: GIF89a, 384x272 including border, hard cuts, uniform delay, <=512000 bytes). Use it when a release, a crack or a trainer needs documentation screenshots in playthrough order — title, menu, in-game — produced the same way twice. The scenario is Gherkin, the same notation and the same .feature files as scenario goals: `Given the disk \"x.g64\"`, then `When I wait 170 frames` / `And I type \"LOAD{QUOTE}*{QUOTE},8,1{RETURN}\"` / `And I hold joystick 2 down for 3 frames` / `And I wait until the drive is idle within 8000 frames` / `And I capture \"title\"`, then `Then the reel has at least 5 screens`. Every step that lasts states its own duration, and the machine is stopped between steps, so the same text replays to the same bytes. Frames come straight from the video chip's 16-colour indices, so nothing is re-quantized. Not for driving the session you are debugging in, and not for one picture of the machine you are already looking at — use runtime_render_screen instead. Inputs: feature (text) or feature_path, out_path. Returns: the reel's path, frame count, byte size, and the cycle each capture landed on.",
    {
      feature: z
        .string()
        .optional()
        .describe(`The scenario, as Gherkin. Example:\n${EXAMPLE}`),
      feature_path: z
        .string()
        .optional()
        .describe("A .feature file to read instead of passing the text. Give one of feature / feature_path."),
      scenario: z
        .string()
        .optional()
        .describe("Which Scenario in the file to run, by name. Defaults to the first one that has driven steps."),
      out_path: z.string().describe("Where to write the GIF (absolute, or relative to the project dir)."),
      media_path: z
        .string()
        .optional()
        .describe("Resolve the medium named in `Given the disk \"...\"` to this path. Use when the feature names a file rather than a full path."),
      delay_ms: z
        .number()
        .optional()
        .describe("Frame delay in milliseconds, uniform across the reel (default 700). At least 10 — a zero GIF delay leaves the rate to whatever the viewer decides."),
      max_bytes: z
        .number()
        .optional()
        .describe("Hard byte ceiling (default 512000, the CSDb limit). Over budget, whole frames are dropped from the middle outwards and named in the report — never a silent re-encode."),
      save_feature_to: z
        .string()
        .optional()
        .describe("Also keep the scenario as a .feature file here. Recommended when the text was passed inline: the scenario is the only reproducible record of how those screens were reached."),
      budget_seconds: z
        .number()
        .optional()
        .describe("How long the private machine may live before it ends itself (default 600)."),
    },
    safeHandler("runtime_scene_reel", async (args) => {
      const {
        feature, feature_path, scenario: wanted, out_path, media_path,
        delay_ms, max_bytes, save_feature_to, budget_seconds,
      } = args;
      const projectDir = context.projectDir();
      const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(projectDir, p));

      if (!feature && !feature_path) return text("runtime_scene_reel: give `feature` (the Gherkin text) or `feature_path`.");
      if (feature && feature_path) return text("runtime_scene_reel: give `feature` OR `feature_path`, not both.");

      let source: string;
      let sourceFile: string | undefined;
      if (feature_path) {
        sourceFile = abs(feature_path);
        if (!existsSync(sourceFile)) return text(`runtime_scene_reel: no such feature file: ${sourceFile}`);
        source = readFileSync(sourceFile, "utf8");
      } else {
        source = feature!;
      }

      const { parseFeature } = await import("../project-knowledge/scenario-gherkin.js");
      const parsed = parseFeature(source, sourceFile);
      if (parsed.issues.length) {
        return text(
          `runtime_scene_reel: the scenario does not parse.\n\n` +
            parsed.issues.map((i) => `  line ${i.line}: ${i.message}`).join("\n") +
            `\n\nThe vocabulary is:\n${EXAMPLE}`,
        );
      }

      const driven = parsed.scenarios.filter((s) => s.steps.length > 0);
      if (driven.length === 0) {
        return text(
          "runtime_scene_reel: no scenario here drives a machine. A capture scenario starts " +
            "`Given the disk \"...\"` and its When/And lines are steps, not a branch run.",
        );
      }
      const chosen = wanted ? driven.find((s) => s.name === wanted) : driven[0];
      if (!chosen) {
        return text(
          `runtime_scene_reel: no scenario named "${wanted}". Present: ${driven.map((s) => s.name).join(", ")}`,
        );
      }

      const delayMs = delay_ms ?? 700;
      const delayCentis = Math.floor(delayMs / 10);
      if (delayCentis < 1) {
        return text(
          `runtime_scene_reel: delay_ms must be at least 10 (got ${delayMs}) — a zero GIF delay ` +
            `leaves the frame rate to whatever the viewer decides.`,
        );
      }
      const maxBytes = max_bytes ?? 512_000;

      const gifPath = abs(out_path);
      mkdirSync(dirname(gifPath), { recursive: true });

      const { runScenario, framesOf } = await import("../reel/run-scenario.js");
      const { encodeWithin, parseStructure } = await import("../reel/gif89a.js");

      let run;
      try {
        run = await runScenario(chosen, {
          budgetMs: (budget_seconds ?? 600) * 1000,
          // `media_path` names the medium the scenario STARTS from, and only
          // that one. It used to override every medium, so a mid-run
          // `I insert the disk "side2.d64"` re-inserted side ONE: the game kept
          // asking to turn the disk and every capture after the swap was a copy
          // of the prompt. A name in the feature resolves next to the feature
          // file first, then in the project dir.
          resolveMedium: (named, role) => {
            if (role === "origin" && media_path) return abs(media_path);
            if (isAbsolute(named)) return named;
            if (sourceFile) {
              const beside = resolvePath(dirname(sourceFile), named);
              if (existsSync(beside)) return beside;
            }
            const inProject = resolvePath(projectDir, named);
            if (!existsSync(inProject) && role === "insert") {
              throw new Error(
                `the scenario inserts "${named}", which is not next to the feature file ` +
                  `nor in the project dir. Mounting the wrong side leaves the game asking ` +
                  `to turn the disk, and every capture after it is the same prompt.`,
              );
            }
            return inProject;
          },
        });
      } catch (e) {
        return text(
          `runtime_scene_reel: ${(e as Error).message}\n\n` +
            `The scenario is unchanged — edit the step it stopped on and run it again.`,
        );
      }

      const encoded = encodeWithin(run.width, run.height, run.palette, framesOf(run), delayCentis, maxBytes);
      writeFileSync(gifPath, encoded.bytes);
      // Walk what was written as BLOCKS. Scanning for the `21 F9` marker
      // false-positives inside LZW pixel data, so it is not a frame count.
      const structure = parseStructure(encoded.bytes);

      const featureFile = save_feature_to ? abs(save_feature_to) : sourceFile;
      if (save_feature_to) {
        mkdirSync(dirname(featureFile!), { recursive: true });
        writeFileSync(featureFile!, source.endsWith("\n") ? source : `${source}\n`, "utf8");
      }

      const lines: string[] = [];
      lines.push(`REEL ${chosen.name} → ${gifPath}`);
      // Say which machine this ran on. A caller watching their own session while
      // a reel runs is watching a machine the reel never touched — that confusion
      // has already cost someone an evening.
      lines.push(
        `ran on a private machine (port ${run.port}), started and ended by this call. ` +
          `Your own session was not touched, and nothing you do to it — pause, warp, keys — ` +
          `reaches or disturbs this run.`,
      );
      lines.push(
        `${structure.frames} frames · ${structure.width}x${structure.height} · ` +
          `${encoded.bytes.length} bytes of ${maxBytes} · ${delayCentis} cs per frame · ` +
          `${structure.paletteEntries} colours`,
      );
      lines.push("");
      lines.push("captures (the cycle each one landed on — a reel is re-derivable from these):");
      for (const s of run.shots) lines.push(`  ${s.label.padEnd(24)} cycle ${s.cycle}`);

      if (encoded.dropped.length) {
        lines.push("");
        lines.push(
          `DROPPED to fit the byte ceiling: ${encoded.dropped.map((i) => run.shots[i].label).join(", ")}. ` +
            `Nothing was re-encoded — whole frames went. Raise max_bytes or capture fewer screens.`,
        );
      }

      // The `Then` lines this layer can check itself. The rest stay verbal, which
      // is not a failure: a human accepts them once and the acceptance turns them
      // into a diff.
      const verdicts: string[] = [];
      for (const c of chosen.criteria) {
        const atLeast = c.text.match(/reel has at least\s+(\d+)\s+(?:screens?|frames?)/i);
        if (atLeast) {
          const want = Number(atLeast[1]);
          verdicts.push(
            `  ${structure.frames >= want ? "PASS" : "FAIL"}  ${c.text}  (${structure.frames} captured)`,
          );
          continue;
        }
        const atMost = c.text.match(/reel is at most\s+([\d_]+)\s*bytes/i);
        if (atMost) {
          const want = Number(atMost[1].replace(/_/g, ""));
          verdicts.push(
            `  ${encoded.bytes.length <= want ? "PASS" : "FAIL"}  ${c.text}  (${encoded.bytes.length} bytes)`,
          );
          continue;
        }
        verdicts.push(`  ----  ${c.text}  (verbal — needs a human once)`);
      }
      if (verdicts.length) {
        lines.push("");
        lines.push("criteria:");
        lines.push(...verdicts);
      }

      if (featureFile) {
        lines.push("");
        lines.push(`scenario: ${featureFile}`);
      }
      lines.push("");
      lines.push("Run the same scenario again to rebuild it byte-for-byte.");

      try {
        const reg = context.tryRegisterKnowledgeArtifacts(projectDir, {
          toolName: "runtime_scene_reel",
          title: `Release reel: ${chosen.name}`,
          parameters: {
            frames: structure.frames,
            bytes: encoded.bytes.length,
            delayMs,
            captures: run.shots.map((s) => s.label),
          },
          outputs: [
            { path: gifPath, kind: "preview", scope: "generated", format: "gif", role: "release-reel", producedByTool: "runtime_scene_reel" },
            ...(featureFile
              ? [{ path: featureFile, kind: "manifest" as const, scope: "generated" as const, format: "feature", role: "capture-scenario", producedByTool: "runtime_scene_reel" }]
              : []),
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
