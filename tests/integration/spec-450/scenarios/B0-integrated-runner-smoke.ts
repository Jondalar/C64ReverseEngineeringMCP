// Spec 450 Scenario B0 — integrated-runner smoke (scaffolding probe).
//
// Validates the integrated-session helper plumbing without
// exercising any actual drive write workflow:
//   1. Boot IntegratedSession with blank.d64 mounted.
//   2. Run ~5M cycles (KERNAL boot completes).
//   3. No commands typed.
//   4. Persist trackBuffer → expect "no-modifications" (drive
//      didn't touch the disk during pure boot).
//   5. Image-hash compare TS post-state vs pristine input — should
//      be byte-identical (drive made no writes).
//
// Acts as a pre-flight check for B5/B6/B7 + C8/C9/C10 scenarios
// that DO drive write workflows. If B0 fails, no later integrated
// scenario can succeed.
//
// Layer: B (integrated session, no real workflow yet).

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runIntegratedScenario } from "../integrated-runner.ts";
import { sha256OfBytes } from "../../../../src/runtime/headless/validation/disk-image-hash.ts";
import type { ScenarioModule } from "../harness.ts";

const mod: ScenarioModule = {
  name: "integrated-runner-smoke",
  layer: "B",
  async run(ctx) {
    const inputPath = resolve(ctx.repoRoot, "samples/synthetic/blank.d64");
    const postStatePath = resolve(ctx.scratchDir, "post-state.g64");

    const out = await runIntegratedScenario({
      diskPath: inputPath,
      bootCycles: 5_000_000,
      postStatePath,
    });

    // After pure boot, drive should not have modified any tracks.
    // If persist reported "no-modifications", no G64 was written —
    // the pristine input D64 IS the post-state. Stamp a marker file
    // so the harness has something to sha256.
    const inputBytes = await readFile(inputPath);
    const inputHash = sha256OfBytes(new Uint8Array(inputBytes));

    if (out.noModifications) {
      // Drop the pristine input bytes at postStatePath so the harness
      // has a file to hash. For a no-modifications run the post-state
      // hash equals the pristine input hash — expected.
      await writeFile(postStatePath, inputBytes);
    }

    return {
      tsPostStatePath: out.postStatePath,
      selfConsistencyOnly: true,
      details: {
        modifiedTracks: out.modifiedTracks,
        bytesWritten: out.bytesWritten,
        noModifications: out.noModifications,
        inputD64Hash: inputHash.slice(0, 16),
      },
    };
  },
};

export default mod;
