// The candidate loop: from a named anchor, several variants at once, the one that works into the build.
//
// A candidate lives in the project (knowledge/candidates/<id>.json), not in the daemon. One run is ONE
// sandbox/runMany — the baseline without a patch plus every variant, each on a clone of its own with the
// same inputs and budget — so the shared machine the human watches is never moved. The chosen variant
// becomes a delta on disk, and runtime_candidate_verify_build checks the project's build really holds it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";
import type { Candidate } from "../candidates/store.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const PATCH_SPACE = z.enum(["ram", "roml", "romh"]);

const TARGET = z.object({
  addr: z.number().describe("CPU-space address; for roml/romh the window address ($8000-$9FFF / $A000-$BFFF)"),
  space: PATCH_SPACE.optional().describe("ram (default) or a cartridge window"),
  bank: z.number().optional().describe("cartridge bank, for roml/romh"),
  source_path: z.string().optional().describe("an .asm/.tas file in the project; assembled here, and its own org must equal addr"),
  source: z.string().optional().describe("source text (with its own `* = $addr`); assembled here"),
  assembler: z.enum(["kickassembler", "64tass"]).optional(),
  bytes: z.array(z.number()).optional().describe("bytes already assembled"),
});

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
      g.recordCandidate(projectDir, { id: c.id, title: c.title, anchor: c.anchor, chosen: c.chosen, deltaArtifactIds: c.delta?.artifactIds, variants: c.variants.length },
        { name: c.anchor, anchorId: c.anchorId, cycle: c.anchorCycle, frame: c.anchorFrame });
      return "";
    } catch (e) { return `\n(not linked in the project graph: ${e instanceof Error ? e.message : String(e)})`; }
  };

  server.tool(
    "runtime_candidate_create",
    "Start a candidate: one iteration from a named anchor — the input script to play, the cycle budget, and (next) the variants of code to try. Saved in the project (knowledge/candidates), linked to the anchor in the graph, and still there after a daemon restart. "
    + "Does not run anything and does not touch the machine. Use after runtime_anchor_set, when you have several fixes to try from the same instant. "
    + "Not a single quick try (use runtime_overlay_run). Inputs: anchor (an anchor name, or a checkpoint id), cycle_budget, inputs? ([{atCycle, kind: keyboard|joystick1|joystick2|model, payload}], atCycle relative to the anchor), title?, id?, project_dir?. Returns: the candidate id and what to do next.",
    {
      anchor: z.string().min(1).describe("Anchor name (runtime_anchor_set) or a checkpoint id"),
      cycle_budget: z.number().int().positive().describe("Cycles each run goes on for, counted from the anchor"),
      inputs: z.array(z.record(z.string(), z.unknown())).optional().describe("Input script: [{atCycle, kind, payload}] — joystick payload {fire:true,…}, keyboard payload \"TEXT\\r\""),
      title: z.string().optional(),
      id: z.string().optional().describe("Default cand-N"),
      project_dir: z.string().optional(),
    },
    safeHandler("runtime_candidate_create", async ({ anchor, cycle_budget, inputs, title, id, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const cid = id ?? s.nextCandidateId(projectDir);
      if (s.loadCandidate(projectDir, cid)) throw new Error(`candidate ${cid} already exists — pick another id or runtime_candidate_delete it`);
      const d = await daemon();
      const marks = (await d.call("mark/list", {})) as { marks?: Array<{ name: string; anchorId: string; cycle: number; frame?: number }> };
      const m = marks.marks?.find((x) => x.name === anchor);
      let cand: Candidate = { id: cid, title, anchor, inputs: inputs ?? [], cycleBudget: cycle_budget, variants: [], createdAt: new Date().toISOString(), updatedAt: "" };
      if (m) { cand.anchorId = m.anchorId; cand.anchorCycle = m.cycle; cand.anchorFrame = m.frame ?? undefined; }
      else {
        const { resolveFrom } = await import("../candidates/run.js");
        await resolveFrom((method, params) => d.call(method, params), cand); // throws, naming the missing anchor
        const cps = (await d.call("checkpoint/list", {})) as { checkpoints?: Array<{ id: string; cycles: number; frame: number }> };
        const cp = cps.checkpoints?.find((x) => x.id === anchor);
        if (cp) { cand.anchorId = cp.id; cand.anchorCycle = cp.cycles; cand.anchorFrame = cp.frame; }
      }
      cand = s.saveCandidate(projectDir, cand);
      const note = await sync(projectDir, cand);
      return text(`Candidate ${cid} created from anchor "${anchor}"${cand.anchorCycle !== undefined ? ` (cycle ${cand.anchorCycle})` : ""}: ${cycle_budget} cycles per run, ${cand.inputs.length} input(s). Saved in knowledge/candidates/${cid}.json.\nNext: runtime_candidate_variant to add the variants, then runtime_candidate_run.${note}`);
    }),
  );

  server.tool(
    "runtime_candidate_variant",
    "Add, replace or remove one variant of a candidate: a name and, per target, the code it puts in the machine — source (a file or inline text, assembled here with the project's assembler, its own org equal to the target) or bytes. "
    + "Setting a variant replaces its whole target set and clears its last verdict; the bytes are kept in the candidate. "
    + "Use to try another fix from the same anchor. Not for running (use runtime_candidate_run) and not for bytes from a file (runtime_inject_range). "
    + "Inputs: id, name, targets? ([{addr, space?, bank?, source_path?|source?|bytes?}]), remove? (true removes the variant), project_dir?. Returns: the variant as stored.",
    {
      id: z.string(), name: z.string().min(1),
      targets: z.array(TARGET).optional(),
      remove: z.boolean().optional(),
      project_dir: z.string().optional(),
    },
    safeHandler("runtime_candidate_variant", async ({ id, name, targets, remove, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const cand = await need(projectDir, id);
      if (remove) {
        if (!cand.variants.some((v) => v.name === name)) throw new Error(`candidate ${id} has no variant "${name}"`);
        cand.variants = cand.variants.filter((v) => v.name !== name);
        if (cand.chosen === name) cand.chosen = undefined;
        s.saveCandidate(projectDir, cand);
        return text(`Variant "${name}" removed from ${id}; ${cand.variants.length} left.${await sync(projectDir, cand)}`);
      }
      if (!targets || targets.length === 0) throw new Error("give the variant's targets (or remove:true)");
      // A patch ALLOCATES: the slot gate that guarded runtime_candidate_patch guards this door.
      const slotGate = await (await import("../slots/gate.js")).checkSlotGate("runtime_candidate_variant", projectDir);
      if (!slotGate.allowed) return text(slotGate.refusal!);
      const { assembleTarget, setVariant } = await import("../candidates/variant.js");
      const assembled = [];
      for (let i = 0; i < targets.length; i++) assembled.push(await assembleTarget(projectDir, id, name, i, targets[i]!));
      cand.variants = setVariant(cand.variants, name, assembled);
      if (cand.chosen === name) cand.build = undefined;
      s.saveCandidate(projectDir, cand);
      const lines = assembled.map((t) => `  ${t.space === "ram" ? "ram" : `${t.space} bank ${t.bank ?? 0}`} ${hx(t.addr)}  ${t.bytes.length} byte(s)${t.sourcePath ? `  from ${t.sourcePath}` : t.source ? "  from inline source" : "  from bytes"}`);
      return text(`Variant "${name}" of ${id} set (${cand.variants.length} variant(s)):\n${lines.join("\n")}${await sync(projectDir, cand)}`);
    }),
  );

  server.tool(
    "runtime_candidate_run",
    "Run a candidate: ONE parallel batch — the baseline without a patch plus every variant, each on a clone of the anchor's machine with the same inputs and the same cycle budget — then judge each variant's end state against the baseline (whole-machine diff, volatile lanes masked). "
    + "The shared machine the human watches is not moved, paused or changed; only a snapshot of the anchor is taken. Verdicts are saved in the candidate. "
    + "Use after adding or changing variants. Not for stepping a patch on the shared machine (use runtime_overlay_run, which moves it). "
    + "Inputs: id, project_dir?. Returns: a table — variant, cycles, final PC, verdict, what changed.",
    { id: z.string(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_run", async ({ id, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const cand = await need(projectDir, id);
      const d = await daemon();
      const { runCandidateOnce, renderRun } = await import("../candidates/run.js");
      let r;
      try { r = await runCandidateOnce((m, p) => d.call(m, p), cand); } catch (e) { return text(`runtime_candidate_run: ${e instanceof Error ? e.message : String(e)}`); }
      cand.baseline = r.baseline;
      for (const v of r.variants) { const t = cand.variants.find((x) => x.name === v.name); if (t) t.verdict = v.verdict; }
      s.saveCandidate(projectDir, cand);
      return text(renderRun(cand, r));
    }),
  );

  server.tool(
    "runtime_candidate_list",
    "List the project's candidates, or show one in full: anchor, inputs, budget, each variant's targets and last verdict, the chosen variant, the delta written and the last build check. Reads the project's files, so it answers the same after a daemon restart. "
    + "Use to see what has been tried and what it did. Not for running (use runtime_candidate_run). Inputs: id?, project_dir?. Returns: the candidate(s).",
    { id: z.string().optional(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_list", async ({ id, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      if (!id) {
        const all = s.listCandidates(projectDir);
        if (all.length === 0) return text("No candidates in this project. runtime_candidate_create starts one from an anchor.");
        return text(all.map((c) => `${c.id}  anchor "${c.anchor}"  ${c.variants.length} variant(s)  ${c.cycleBudget} cycles  chosen: ${c.chosen ?? "—"}${c.build ? `  build: ${c.build.ok ? "green" : "RED"}` : ""}`).join("\n"));
      }
      const c = await need(projectDir, id);
      const lines = [`Candidate ${c.id}${c.title ? ` — ${c.title}` : ""}`, `anchor "${c.anchor}"${c.anchorCycle !== undefined ? ` (cycle ${c.anchorCycle}, frame ${c.anchorFrame ?? "?"})` : ""}; ${c.cycleBudget} cycles; ${c.inputs.length} input(s): ${JSON.stringify(c.inputs)}`];
      if (c.baseline) lines.push(`baseline: ${c.baseline.cycles} cycles, PC ${hx(c.baseline.registers?.pc)} (run ${c.baseline.ranAt})`);
      for (const v of c.variants) {
        const x = v.verdict;
        lines.push(`variant "${v.name}"${c.chosen === v.name ? "  <- chosen" : ""}: ${v.targets.map((t) => `${t.space === "ram" ? "ram" : `${t.space}/${t.bank ?? 0}`} ${hx(t.addr)} ${t.bytes.length}B`).join(", ")}`);
        lines.push(`  last verdict: ${!x ? "not run yet" : x.state === "failed" ? `FAILED ${x.message ?? ""}` : x.identical ? "same as baseline" : `DIFFERS — ${(x.changes ?? []).join("; ") || (x.differing ?? []).join(", ")}`}${x ? ` (${x.cycles} cycles, PC ${hx(x.registers?.pc)}, run ${x.ranAt})` : ""}`);
      }
      if (c.delta) lines.push(`delta: ${c.delta.outDir} (${c.delta.files.join(", ")})`);
      if (c.build) lines.push(`last build check: ${c.build.ok ? "GREEN" : `RED at ${hx(c.build.firstDiff?.addr)}`} on ${c.build.image} (${c.build.checkedAt})`);
      return text(lines.join("\n"));
    }),
  );

  server.tool(
    "runtime_candidate_choose",
    "Mark one variant of a candidate as the solution — the one runtime_candidate_derive_delta writes and runtime_candidate_verify_build checks. The verdicts say what each variant changed; which change is right is your call. "
    + "Use once a run shows the variant doing what you want. Not for running anything. Inputs: id, variant (or clear:true to un-choose), project_dir?. Returns: the choice.",
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
            description: `Delta of variant "${cand.chosen}" of candidate ${id}, from anchor "${cand.anchor}".`,
          });
          artifactIds.push(a.id);
        }
      } catch (e) { notes.push(`Not registered as artifacts: ${e instanceof Error ? e.message : String(e)}`); }
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
    + "Use when the iteration is finished with. Not for dropping one variant (use runtime_candidate_variant with remove:true). Inputs: id, project_dir?. Returns: what was deleted.",
    { id: z.string(), project_dir: z.string().optional() },
    safeHandler("runtime_candidate_delete", async ({ id, project_dir }) => {
      const projectDir = project(project_dir);
      const s = await import("../candidates/store.js");
      const had = s.deleteCandidate(projectDir, id);
      if (had) (await import("../anchors/graph.js")).forgetCandidateNode(projectDir, id);
      return text(had ? `Candidate ${id} deleted.` : `No candidate ${id} in this project.`);
    }),
  );

  // The three doors that folded into runtime_candidate_variant / _list. Each answers in one line and
  // does nothing: their daemon half is gone, and a silent no-op would look like a result.
  const alias = (name: string, successor: string, why: string) =>
    server.tool(
      name,
      `Retired name, kept for one release: now ${successor} — ${why} Use ${successor}. Not for new work; this name does nothing but point there. Inputs: any. Returns: one line naming ${successor}.`,
      {},
      safeHandler(name, async () => text(`${name} is now ${successor} — ${why} Nothing was done.`)),
    );
  alias("runtime_candidate_patch", "runtime_candidate_variant", "variants hold the patches now, per name.");
  alias("runtime_candidate_remove_patch", "runtime_candidate_variant", "remove a variant with remove:true, or set it again with the targets you want.");
  alias("runtime_candidate_export", "runtime_candidate_list", "it shows each variant's targets and bytes; the build-ready files come from runtime_candidate_derive_delta.");
}
