// Spec 450 Scenario C9 — SAVE on G64 with extended tracks (motm.g64).
//
// Regression guard for the [[project_motm_via1_ca1]] fix family
// (commit d927a1a — head-position stepInward off-by-one at G64
// extended-track boundary). Workflow:
//   1. Mount writable copy of motm.g64 (has tracks past 35).
//   2. Boot C64 + drive.
//   3. typeText a small BASIC program.
//   4. SAVE "M",8 — KERNAL routes write through drive ROM.
//   5. Run 60M cycles.
//   6. Persist + assert drive wrote tracks.
//
// Result expectation: same root-cause family as B5/C8 — SAVE
// path not engaging the drive write side. redAsExpected=true.
// Once root-caused, this scenario also exercises the extended-
// track write path (regression guard for motm head-position cap).
//
// Layer: C (KERNAL SAVE on G64 extended-track image).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runIntegratedScenario } from "../integrated-runner.ts";
import { sha256OfBytes } from "../../../../src/runtime/headless/validation/disk-image-hash.ts";
import type { ScenarioModule } from "../harness.ts";

const mod: ScenarioModule = {
  name: "g64-extended-tracks-save",
  layer: "C",
  redAsExpected: true,
  async run(ctx) {
    const inputG64 = await ctx.prepareWritableCopy(
      "samples/motm.g64",
      "pre-state.g64",
    );
    const postStatePath = resolve(ctx.scratchDir, "post-state.g64");

    const out = await runIntegratedScenario({
      diskPath: inputG64,
      bootCycles: 5_000_000,
      command: '10 PRINT "M"\r',
      postCommandCycles: 5_000_000,
      postRunCommand: 'SAVE "M",8\r',
      postRunCycles: 60_000_000,
      postStatePath,
    });

    if (out.noModifications) {
      throw new Error("G64 SAVE workflow ran but drive reported no track modifications — same root-cause family as B5/C8");
    }

    const inputBytes = await readFile(inputG64);
    const postBytes = await readFile(out.postStatePath);
    const inputHash = sha256OfBytes(new Uint8Array(inputBytes));
    const postHash = sha256OfBytes(new Uint8Array(postBytes));
    if (inputHash === postHash) {
      throw new Error("post-state hash equals pristine input — SAVE produced no observable changes");
    }

    return {
      tsPostStatePath: out.postStatePath,
      selfConsistencyOnly: true,
      details: {
        modifiedTracks: out.modifiedTracks,
        bytesWritten: out.bytesWritten,
        inputHashShort: inputHash.slice(0, 16),
        postHashShort: postHash.slice(0, 16),
        note: "regression guard for project_motm_via1_ca1 head-position cap fix once root-caused",
      },
    };
  },
};

export default mod;
