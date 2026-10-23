// The candidate: the project's record of a feature file's runs. `runtime_feature_run` (or `c64re scenario run`)
// runs the file and keeps the record; the tools here read it and take the winner into the build.
//
// A candidate lives in the project (knowledge/candidates/<id>.json), not in the daemon. The chosen variant
// becomes a delta on disk, and runtime_candidate_verify_build checks the project's build really holds it.
// Records written before the feature file existed (an input script and a cycle budget instead of a feature)
// are read, chosen, derived and verified the same way.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";
import type { Candidate } from "../candidates/store.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const hx = (n: number | undefined) => (n === undefined ? "?" : `$${n.toString(16).padStart(4, "0")}`);

async function daemon() {
  const { runtimeDaemon } = await import("../runtime/backend.js");
  return runtimeDaemon;
}

export function registerCandidateTools(server: McpServer, context: ServerToolContext): void {
  const project = (project_dir?: string) => context.projectDir(project_dir ? { projectDir: project_dir } : undefined, true);
  const need = async (projectDir: string, id: string): Promise<Candidate> => {
    const { loadCandidate } = await import("../candidates/store.js");
    const c = loadCandidate(projectDir, id);
    if (!c) throw new Error(`no candidate "${id}" in ${projectDir} — runtime_candidate_list shows what exists`);
    return c;
  };
  /** Keep the graph's record of the candidate in step; the file is the authority, the graph the link. */
  const sync = async (projectDir: string, c: Candidate): Promise<string> => {
    try {
      const g = await import("../anchors/graph.js");
      if (!g.projectHoldsGraph(projectDir)) return "";
      g.recordCandidate(projectDir, {
        id: c.id, title: c.title, anchor: c.anchor, chosen: c.chosen, deltaArtifactIds: c.delta?.artifactIds, variants: c.variants.length,
        ...(c.feature ? { feature: { path: c.feature.path, scenario: c.feature.scenario, line: c.feature.line } } : {}),
      }, c.anchor ? { name: c.anchor, anchorId: c.anchorId, cycle: c.anchorCycle, frame: c.anchorFrame } : undefined);
      return "";
    } catch (e) { return `\n(not linked in the project graph: ${e instanceof Error ? e.message : String(e)})`; }
  };

  server.tool(
    "runtime_feature_run",
    "Run a .feature file and judge it, with no stepping and no waiting on your side: the same function `c64re scenario run` calls, so a script and you get the same answer. "
    + "A scenario starts from a mark (`Given the mark \"name\"` — the file runtime_anchor_set wrote into knowledge/anchors), a snapshot or medium (`Given the snapshot \"state.c64re\"`, `Given the disk|cart \"x\"`) or a bare machine, plays its steps (joystick, keys, `I wait until … within N frames`) and decides its `Then` lines. "
    + "TWO USES. (1) TEST A BUILD, after every build: start from a snapshot or mark, put the build's bytes in with `And variant \"build\" loads \"build/trainer.prg\"` (a PRG: its own address; `… loads \"build/x.prg\" at $0900` places it elsewhere; a headerless file needs `at`: `… loads \"build/patch.bin\" at $47A5` or `… at roml bank 3 $8000`; no address is ever guessed), play fixed inputs, state the facts as `Then` lines, and add `Then the baseline fails` (the start state's own code must NOT show the facts) or `Then the baseline passes`. A scenario with such a line is a test: PASS only when EVERY variant passes all its Then lines AND the baseline does what the line says; no candidate is kept; JSON `mode` is `test`. Run the WHOLE folder of tests after every build (feature_path = the folder); a change is proved by that, never by a hand-driven sandbox session. "
    + "(2) TRY A FIX: variant lines `And variant \"fix1\" assembles \"fixes/fix1.tas\" at $0A20` (RAM) or `… at roml bank 3 $9100` (a cartridge bank); say the name again for a second place. Without a baseline line the scenario is a trial: PASS when any variant passes, `mode` `trial`, kept as the project's candidate (runtime_candidate_list, then runtime_candidate_choose, runtime_candidate_derive_delta, runtime_candidate_verify_build). "
    + "The run without a fix (baseline) always runs beside the variants, each on a private machine of its own, up to 4 at once; the shared machine is not touched. The Then lines alone decide PASS/FAIL per run; the memory a variant changed besides is listed as a side effect and decides nothing. "
    + "`And I set the anchor \"name\"` writes the machine as it stands to knowledge/anchors/name.c64re (an existing anchor is replaced only with replace_anchors); make the start state of a suite with a scenario that ends in it. "
    + "Never build your own stepper or boot loop for this. Not a capture (use runtime_scene_reel) and not a one-off command (use runtime_sandbox_run). "
    + "Inputs: feature_path (a .feature file or a folder of them; relative to the project) or feature (the file's text), scenario? (only those whose name contains it), jobs? (machines at once, default min(4, CPUs)), replace_anchors?, json? (the document the command line prints with --json), project_dir?. Returns: one block per scenario — a PASS/FAIL/ERROR line per run, the side effects, the candidate id.",
    {
      feature_path: z.string().optional().describe("A .feature file or a folder, relative to the project or absolute"),
      feature: z.string().optional().describe("The feature file's text, instead of a path"),
      scenario: z.string().optional().describe("Only scenarios whose name contains this"),
      jobs: z.number().int().min(1).max(16).optional().describe("Machines at once; default min(4, CPUs)"),
      replace_anchors: z.boolean().optional().describe("Let `I set the anchor` overwrite an anchor that exists"),
      json: z.boolean().optional().describe("Return the JSON document instead of the lines"),
      project_dir: z.string().optional(),
    },
    safeHandler("runtime_feature_run", async ({ feature_path, feature, scenario, jobs, replace_anchors, json, project_dir }) => {
      if ((feature_path === undefined) === (feature === undefined)) throw new Error("give feature_path or feature, one of the two");
      const projectDir = project(project_dir);
      const { resolve, isAbsolute } = await import("node:path");
      const { existsSync, readFileSync, statSync } = await import("node:fs");
      const path = feature_path === undefined ? undefined : isAbsolute(feature_path) ? feature_path : existsSync(resolve(projectDir, feature_path)) ? resolve(projectDir, feature_path) : resolve(feature_path);
      // A fix ALLOCATES memory in the game: the slot gate that guards every door that does guards this one.
      // A test (`Then the baseline fails|passes`) is not a delivery: it checks bytes the build already placed.
      const { parseFeature } = await import("../project-knowledge/scenario-gherkin.js");
      const texts: string[] = [];
      if (feature !== undefined) texts.push(feature);
      else if (path && existsSync(path) && statSync(path).isFile()) texts.push(readFileSync(path, "utf8"));
      const withFixes = texts.some((t) => parseFeature(t).scenarios.some((sc) => sc.variants.length > 0 && !sc.baselineExpect && (!scenario || sc.name.toLowerCase().includes(scenario.toLowerCase()))));
      if (withFixes) {
        const gate = await (await import("../slots/gate.js")).checkSlotGate("runtime_feature_run", projectDir);
        if (!gate.allowed) return text(gate.refusal!);
      }
      const { runFeatures, renderFeatureRun, featureRunJson } = await import("../scenario/feature-run.js");
      const run = await runFeatures({
        ...(path !== undefined ? { paths: [path] } : { text: feature }),
        scenario, jobs, replaceAnchors: replace_anchors === true,
        project: project_dir ? projectDir : feature !== undefined ? projectDir : undefined,
      });
      return text(json ? JSON.stringify(featureRunJson(run), null, 2) : renderFeatureRun(run));
    }),
  );

  server.tool(
    "runtime_candidate_list",
    "List the project's candidates, or show one in full: the feature file and scenario it records, the anchor, each variant's targets and its last verdict with the places it changed besides what it was meant to, the history of runs, the chosen variant, the delta written and the last build check. Reads the project's files, so it answers the same after a daemon restart. "
    + "Use to see what has been tried and what it did. Not for running (use runtime_feature_run). Inputs: id?, project_dir?. Returns: the candidate(s).",
    { id: z.string().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_list", async ({ id, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const { describeSideEffects } = await import("../scenario/feature-run.js");
      const passed = (c: Candidate): string => {
        const done = c.variants.filter((v) => v.result);
        return done.length ? `${done.filter((v) => v.result!.verdict === "PASS").length}/${done.length} passed` : "not run yet";
      };
      if (!id) {
        const all = s.listCandidates(projectDir);
        if (all.length === 0) return text("No candidates in this project. A candidate is the record of a .feature file with variant lines: run one with runtime_feature_run.");
        return text(all.map((c) => c.feature
          ? `${c.id}  ${c.feature.path}:${c.feature.line}  ${c.anchor ? `anchor "${c.anchor}"  ` : ""}${c.variants.length} variant(s), ${passed(c)}  ${(c.history ?? []).length} run(s)  chosen: ${c.chosen ?? "—"}${c.build ? `  build: ${c.build.ok ? "green" : "RED"}` : ""}`
          : `${c.id}  anchor "${c.anchor}"  ${c.variants.length} variant(s)  ${c.cycleBudget ?? "?"} cycles  chosen: ${c.chosen ?? "—"}${c.build ? `  build: ${c.build.ok ? "green" : "RED"}` : ""}  (an older record: inputs and a cycle budget, no feature file)`).join("\n"));
      }
      const c = await need(projectDir, id);
      const lines = [`Candidate ${c.id}${c.title ? ` — ${c.title}` : ""}`];
      if (c.feature) lines.push(`records ${c.feature.path}:${c.feature.line} — "${c.feature.scenario}"; ${c.anchor ? `starts from anchor "${c.anchor}"` : "starts from a medium or a bare machine"}; ${(c.history ?? []).length} run(s)`);
      else lines.push(`anchor "${c.anchor}"${c.anchorCycle !== undefined ? ` (cycle ${c.anchorCycle}, frame ${c.anchorFrame ?? "?"})` : ""}; ${c.cycleBudget ?? "?"} cycles; ${(c.inputs ?? []).length} input(s): ${JSON.stringify(c.inputs ?? [])}`);
      if (c.baselineResult) lines.push(`baseline: ${c.baselineResult.verdict}${c.baselineResult.reason ? ` — ${c.baselineResult.reason}` : ""} (run ${c.baselineResult.ranAt})`);
      else if (c.baseline) lines.push(`baseline: ${c.baseline.cycles} cycles, PC ${hx(c.baseline.registers?.pc)} (run ${c.baseline.ranAt})`);
      for (const v of c.variants) {
        const x = v.verdict;
        const r = v.result;
        lines.push(`variant "${v.name}"${c.chosen === v.name ? "  <- chosen" : ""}: ${v.targets.map((t) => `${t.space === "ram" ? "ram" : `${t.space}/${t.bank ?? 0}`} ${hx(t.addr)} ${t.bytes.length}B${t.sourcePath ? ` from ${t.sourcePath}` : ""}${t.loaded ? ` loaded from ${t.loaded.path} (sha256 ${t.loaded.sha256.slice(0, 12)}…, no source)` : ""}`).join(", ")}`);
        if (r) {
          const bad = r.checks.filter((k) => !k.pass);
          lines.push(`  last run: ${r.verdict}${r.reason ? ` — ${r.reason}` : ""}${bad.length ? ` — ${bad.map((k) => `${k.text}: got ${k.actual}`).join(" | ")}` : ""}${r.sideEffects?.length ? `  (also changed: ${describeSideEffects(r.sideEffects)})` : ""} (${r.checks.length} checked, run ${r.ranAt})`);
        } else {
          lines.push(`  last verdict: ${!x ? "not run yet" : x.state === "failed" ? `FAILED ${x.message ?? ""}` : x.identical ? "same as baseline" : `DIFFERS — ${(x.changes ?? []).join("; ") || (x.differing ?? []).join(", ")}`}${x ? ` (${x.cycles} cycles, PC ${hx(x.registers?.pc)}, run ${x.ranAt})` : ""}`);
        }
      }
      const hist = (c.history ?? []).slice(-5);
      if (hist.length > 1) {
        lines.push("history (newest last):");
        for (const h of hist) lines.push(`  ${h.ranAt}  baseline ${h.baseline.verdict}; ${h.variants.map((v) => `${v.name} ${v.verdict}`).join(", ")}`);
      }
      if (c.delta) lines.push(`delta: ${c.delta.outDir} (${c.delta.files.join(", ")})`);
      if (c.build) lines.push(`last build check: ${c.build.ok ? "GREEN" : `RED at ${hx(c.build.firstDiff?.addr)}`} on ${c.build.image} (${c.build.checkedAt})`);
      return text(lines.join("\n"));
    }),
  );

  server.tool(
    "runtime_candidate_choose",
    "Mark one variant of a candidate as the solution — the one runtime_candidate_derive_delta writes and runtime_candidate_verify_build checks. The Then lines decided PASS or FAIL per variant and the run listed what else each one changed; which fix is right is your call. "
    + "Use once a run shows the variant doing what you want. Not for running anything (use runtime_feature_run). Inputs: id, variant (or clear:true to un-choose), project_dir?. Returns: the choice.",
    { id: z.string(), variant: z.string().optional(), clear: z.boolean().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_choose", async ({ id, variant, clear, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const cand = await need(projectDir, id);
      if (clear) { cand.chosen = undefined; cand.delta = undefined; cand.build = undefined; s.saveCandidate(projectDir, cand); return text(`${id}: no variant chosen.${await sync(projectDir, cand)}`); }
      if (!variant) throw new Error("name the variant, or pass clear:true");
      if (!cand.variants.some((v) => v.name === variant)) throw new Error(`candidate ${id} has no variant "${variant}" (it has: ${cand.variants.map((v) => v.name).join(", ") || "none"})`);
      if (cand.chosen !== variant) { cand.delta = undefined; cand.build = undefined; }
      cand.chosen = variant;
      s.saveCandidate(projectDir, cand);
      return text(`${id}: variant "${variant}" chosen.${await sync(projectDir, cand)}`);
    }),
  );

  server.tool(
    "runtime_candidate_derive_delta",
    "Write the CHOSEN variant as a build-ready delta: one .asm per target (each carries its own org) + delta-manifest.json + DELTA.md in <project>/delta-<id>, and register the files as artifacts linked to the candidate. "
    + "The delta is written beside the project's own source, never into it; wiring it into the build is the project's. "
    + "Use after runtime_candidate_choose; then runtime_candidate_verify_build proves the build holds it. Not for the raw patch set of a variant that has not been chosen. "
    + "Inputs: id, out_dir?, project_dir?. Returns: the folder, the files and the artifact ids.",
    { id: z.string(), out_dir: z.string().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_derive_delta", async ({ id, out_dir, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const cand = await need(projectDir, id);
      if (!cand.chosen) throw new Error(`candidate ${id} has no chosen variant — runtime_candidate_choose first`);
      const v = cand.variants.find((x) => x.name === cand.chosen)!;
      const { writeDelta } = await import("../candidate-delta.js");
      const { resolve, join, relative } = await import("node:path");
      const { safeSegment } = await import("../lib/id-path.js");
      const outDir = out_dir ? resolve(projectDir, out_dir) : resolve(projectDir, `delta-${safeSegment(id)}`);
      const loadedOnly = v.targets.filter((t) => t.loaded);
      const res = writeDelta({ id: cand.id, patches: v.targets.map((t) => ({ space: t.space, bank: t.bank ?? null, addr: t.addr, source: t.source, bytes: t.bytes })) }, outDir);
      const artifactIds: string[] = [];
      const notes: string[] = [];
      try {
        const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
        const svc = new ProjectKnowledgeService(projectDir);
        for (const f of res.files) {
          const kind = f.endsWith(".asm") ? "generated-source" : f.endsWith(".json") ? "manifest" : "report";
          const a = svc.saveArtifact({
            kind, scope: "generated", title: `Delta ${id}/${cand.chosen}: ${f}`, path: relative(projectDir, join(outDir, f)),
            role: "candidate-delta", producedByTool: "runtime_candidate_derive_delta", tags: ["candidate-delta", `candidate:${id}`, `variant:${cand.chosen}`],
            description: `Delta of variant "${cand.chosen}" of candidate ${id}${cand.anchor ? `, from anchor "${cand.anchor}"` : ""}${cand.feature ? `, tried in ${cand.feature.path}` : ""}.`,
          });
          artifactIds.push(a.id);
        }
      } catch (e) { notes.push(`Not registered as artifacts: ${e instanceof Error ? e.message : String(e)}`); }
      if (loadedOnly.length > 0) {
        notes.push(`${loadedOnly.length === v.targets.length ? "Every" : `${loadedOnly.length} of ${v.targets.length}`} target(s) of "${cand.chosen}" were loaded as built bytes, so there is no source to hand over: ${loadedOnly.map((t) => `${t.loaded!.path} (sha256 ${t.loaded!.sha256})`).join(", ")} — the .asm files hold those bytes as .byte lines under the target's org.`);
      }
      cand.delta = { outDir, files: res.files, artifactIds, derivedAt: new Date().toISOString() };
      cand.build = undefined;
      s.saveCandidate(projectDir, cand);
      notes.push((await sync(projectDir, cand)).trim());
      return text(`Delta of "${cand.chosen}" written to ${outDir}:\n${res.files.map((f) => `  ${f}`).join("\n")}\n${artifactIds.length} artifact(s) registered, linked to ${id}.${notes.filter(Boolean).map((n) => `\n${n}`).join("")}\nNext: put the .asm files into your build, then runtime_candidate_verify_build.`);
    }),
  );

  server.tool(
    "runtime_candidate_verify_build",
    "Prove the project's build contains the chosen variant: run the project's own build command (profile.build), read the image it built (a PRG with its load address, a cartridge image bank by bank, or raw bytes from an address you give) and compare the bytes at every delta target with the variant's. "
    + "Green names each target; red names the FIRST differing address. The build command is the project's own line and runs in the project folder. "
    + "Use after the delta is wired into the build. Not for running the built image (use runtime_run_prg / runtime_session_start). "
    + "Inputs: id, image? (default: the first of profile.build.outputs), format? (prg|crt|raw; default from content/extension), raw_load_address?, skip_build? (check an image already built), project_dir?. Returns: GREEN or RED with the addresses.",
    {
      id: z.string(),
      image: z.string().optional().describe("The built image, relative to the project or the build's cwd"),
      format: z.enum(["prg", "crt", "raw"]).optional(),
      raw_load_address: z.number().optional().describe("Where a raw image starts in memory"),
      skip_build: z.boolean().optional().describe("Do not run the build command; check the image as it is"),
      project_dir: z.string().optional(),
    },
    safeHandler("runtime_candidate_verify_build", async ({ id, image, format, raw_load_address, skip_build, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const cand = await need(projectDir, id);
      if (!cand.chosen) throw new Error(`candidate ${id} has no chosen variant — runtime_candidate_choose first`);
      const v = cand.variants.find((x) => x.name === cand.chosen)!;
      const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
      const svc = new ProjectKnowledgeService(projectDir);
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      let buildRan = false;
      let cwd = projectDir;
      let outputs: string[] = [];
      const build = svc.getProjectProfile()?.build;
      if (build) { cwd = build.cwd ? resolve(projectDir, build.cwd) : projectDir; outputs = build.outputs ?? []; }
      if (!skip_build) {
        if (!build) return text(`runtime_candidate_verify_build: the project profile has no build command (profile.build), so there is nothing to run. Save one in the project profile, or pass skip_build:true with image: to check an image you built yourself.`);
        const b = svc.runProfileBuild();
        buildRan = true;
        if (b.exitCode !== 0) return text(`BUILD FAILED (exit ${b.exitCode}) — \`${b.command}\` in ${b.cwd}\n${(b.stderrTail || b.stdoutTail).trim()}\nThe image was not checked.`);
      }
      const imageRel = image ?? outputs[0];
      if (!imageRel) return text("runtime_candidate_verify_build: no image to check — pass image:, or list the build's outputs in profile.build.outputs.");
      const imagePath = [resolve(cwd, imageRel), resolve(projectDir, imageRel)].find((p) => existsSync(p));
      if (!imagePath) return text(`runtime_candidate_verify_build: the image ${imageRel} does not exist (looked in ${cwd} and ${projectDir})${buildRan ? " although the build exited 0" : ""}.`);
      const { compareImage, renderCheck } = await import("../candidates/verify.js");
      const check = compareImage({ variant: v, imagePath, format, rawLoadAddress: raw_load_address, buildRan });
      cand.build = check;
      s.saveCandidate(projectDir, cand);
      return text(renderCheck(id, v.name, check));
    }),
  );

  server.tool(
    "runtime_candidate_delete",
    "Delete a candidate from the project: its file, its scratch folder and its graph node. The delta files already written stay where they are. "
    + "Use when the iteration is finished with. Not for dropping one variant (take its line out of the .feature file and run it again). Inputs: id, project_dir?. Returns: what was deleted.",
    { id: z.string(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_delete", async ({ id, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const had = s.deleteCandidate(projectDir, id);
      if (had) (await import("../anchors/graph.js")).forgetCandidateNode(projectDir, id);
      return text(had ? `Candidate ${id} deleted.` : `No candidate ${id} in this project.`);
    }),
  );

  // The retired name that pointed at the list: it does nothing but say where its answer went.
  server.tool(
    "runtime_candidate_export",
    "Retired name, kept for one release: now runtime_candidate_list, which shows each variant's targets and bytes; the build-ready files come from runtime_candidate_derive_delta. Use those. Not for new work; this name does nothing but point there. Inputs: any. Returns: one line naming runtime_candidate_list.",
    {},
    safeHandler("runtime_candidate_export", async () => text("runtime_candidate_export is now runtime_candidate_list — it shows each variant's targets and bytes; the build-ready files come from runtime_candidate_derive_delta. Nothing was done.")),
  );
}
