// Spec 450 Scenario C8 — BASIC SAVE / LOAD roundtrip.
//
// KERNAL-level write workflow:
//   1. Mount blank.d64 (writable scratch copy).
//   2. Boot C64 + drive.
//   3. typeText enters a BASIC program: 10 PRINT "HELLO"
//   4. typeText SAVE "X",8 — KERNAL writes program to disk.
//   5. Run 50M cycles for SAVE workflow.
//   6. Persist trackBuffer.
//   7. Assert drive wrote tracks (modifiedTracks non-empty).
//
// Layer: C (KERNAL-level SAVE through full IEC bus + drive ROM).
//
// Result expectation: same root-cause family as B5 — the
// integrated-session SAVE/FORMAT path is currently not engaging
// the drive write side. redAsExpected=true; debug deferred.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runIntegratedScenario } from "../integrated-runner.ts";
import { sha256OfBytes } from "../../../../src/runtime/headless/validation/disk-image-hash.ts";
import type { ScenarioModule } from "../harness.ts";

const mod: ScenarioModule = {
  name: "basic-save-load",
  layer: "C",
  redAsExpected: true,
  async run(ctx) {
    const inputD64 = await ctx.prepareWritableCopy(
      "samples/synthetic/blank.d64",
      "pre-state.d64",
    );
    const postStatePath = resolve(ctx.scratchDir, "post-state.g64");

    const out = await runIntegratedScenario({
      diskPath: inputD64,
      bootCycles: 5_000_000,
      command: '10 PRINT "HELLO"\r',
      postCommandCycles: 5_000_000,
      postRunCommand: 'SAVE "X",8\r',
      postRunCycles: 50_000_000,
      postStatePath,
    });

    if (out.noModifications) {
      throw new Error("SAVE workflow ran but drive reported no track modifications — same root-cause family as B5");
    }

    const inputBytes = await readFile(inputD64);
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
        note: "bilateral VICE compare deferred — first need to root-cause drive write path",
      },
    };
  },
};

export default mod;
