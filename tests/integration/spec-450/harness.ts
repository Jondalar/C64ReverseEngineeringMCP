// Spec 450 — validation-harness scenario runner.
//
// Each scenario implements `ScenarioModule` and is invoked from
// `run-all.test.mjs`. The runner provides:
//   - sha256 image-compare assertion (primary gate)
//   - first-byte-divergence pinpointing (debug-escalation)
//   - per-scenario pass/fail tally with red-as-expected support
//
// Layering (per Spec 450 charter):
//   A — sector-level GCR roundtrip
//   B — drive-CPU microcode workflow
//   C — KERNAL-level SAVE/LOAD workflow
//
// All scenarios run through this harness so failure output is
// uniform + parseable for CI.

import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256OfFile, firstByteDivergence } from "../../../src/runtime/headless/validation/disk-image-hash.ts";

export type Layer = "A" | "B" | "C";

export interface ScenarioResult {
  name: string;
  layer: Layer;
  status: "PASS" | "FAIL" | "RED_EXPECTED";
  message?: string;
  /** sha256 of the post-state image produced by TS. */
  tsHash?: string;
  /** sha256 of the VICE-produced post-state baseline. */
  viceHash?: string;
  /** First divergence offset (only set if hashes differ). */
  divergence?: { offset: number; expected: number; actual: number; sizeA: number; sizeB: number };
  /** Free-form scenario-specific notes. */
  details?: Record<string, unknown>;
}

export interface ScenarioModule {
  readonly name: string;
  readonly layer: Layer;
  /** If true, image-compare failure is logged but counted as RED_EXPECTED. */
  readonly redAsExpected?: boolean;
  /** Run the workflow; harness handles hash + compare + result emit. */
  run(ctx: ScenarioContext): Promise<{
    /**
     * Path to the TS-produced post-state image. Optional for pure-
     * function self-consistency scenarios that don't produce a disk
     * image (e.g. error-code-only checks at gcr.ts level).
     */
    tsPostStatePath?: string;
    /** Path to the VICE-produced baseline (committed under samples/baselines/spec-450-write/). */
    viceBaselinePath?: string;
    /** If the scenario is purely self-consistency (no VICE compare), set this and skip baseline. */
    selfConsistencyOnly?: boolean;
    /** Free-form per-scenario notes captured into result. */
    details?: Record<string, unknown>;
  }>;
}

export interface ScenarioContext {
  /** Repo root (absolute path). */
  readonly repoRoot: string;
  /** Path for this scenario's scratch outputs — auto-created. */
  readonly scratchDir: string;
  /** Helper: copy a corpus file into scratchDir so the scenario can mutate. */
  prepareWritableCopy(srcRelPath: string, dstBasename: string): Promise<string>;
}

export async function runScenario(mod: ScenarioModule, repoRoot: string): Promise<ScenarioResult> {
  const scratchDir = resolve(repoRoot, "tmp/spec-450", `${mod.layer}-${mod.name}`);
  await mkdir(scratchDir, { recursive: true });

  const ctx: ScenarioContext = {
    repoRoot,
    scratchDir,
    async prepareWritableCopy(srcRelPath: string, dstBasename: string): Promise<string> {
      const src = resolve(repoRoot, srcRelPath);
      const dst = resolve(scratchDir, dstBasename);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      return dst;
    },
  };

  try {
    const out = await mod.run(ctx);

    if (out.selfConsistencyOnly) {
      const tsHash = out.tsPostStatePath ? await sha256OfFile(out.tsPostStatePath) : undefined;
      return { name: mod.name, layer: mod.layer, status: "PASS", tsHash, details: out.details };
    }

    if (!out.tsPostStatePath) {
      return {
        name: mod.name, layer: mod.layer, status: "FAIL",
        message: "bilateral scenario must produce a tsPostStatePath",
        details: out.details,
      };
    }
    const tsHash = await sha256OfFile(out.tsPostStatePath);

    if (!out.viceBaselinePath) {
      return {
        name: mod.name, layer: mod.layer, status: "FAIL",
        message: "scenario declared bilateral but viceBaselinePath missing",
        tsHash, details: out.details,
      };
    }
    const viceHash = await sha256OfFile(out.viceBaselinePath);

    if (tsHash === viceHash) {
      return { name: mod.name, layer: mod.layer, status: "PASS", tsHash, viceHash, details: out.details };
    }

    const divergence = await firstByteDivergence(out.tsPostStatePath, out.viceBaselinePath);
    const status = mod.redAsExpected ? "RED_EXPECTED" : "FAIL";
    return {
      name: mod.name, layer: mod.layer, status,
      message: `image-compare diverges (TS ${tsHash.slice(0, 12)}… vs VICE ${viceHash.slice(0, 12)}…)`,
      tsHash, viceHash,
      divergence: divergence ?? undefined,
      details: out.details,
    };
  } catch (e) {
    return {
      name: mod.name, layer: mod.layer,
      status: mod.redAsExpected ? "RED_EXPECTED" : "FAIL",
      message: (e as Error).message,
    };
  }
}

export function printResult(r: ScenarioResult): void {
  const tag = r.status === "PASS" ? "PASS" : r.status === "RED_EXPECTED" ? "RED_OK" : "FAIL";
  console.log(`  [${tag}] ${r.layer}/${r.name}${r.message ? `: ${r.message}` : ""}`);
  if (r.divergence) {
    const d = r.divergence;
    console.log(`         first byte diff @ offset 0x${d.offset.toString(16)}: TS=0x${d.actual.toString(16)} VICE=0x${d.expected.toString(16)} (size TS=${d.sizeA} VICE=${d.sizeB})`);
  }
}
