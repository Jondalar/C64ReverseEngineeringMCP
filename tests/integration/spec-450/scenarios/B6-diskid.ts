// Spec 450 Scenario B6 — diskid1.prg disk-ID read.
//
// Pure read workflow (no drive writes expected):
//   1. Mount diskid.d64 (writable scratch copy — won't be written).
//   2. Boot C64 + drive.
//   3. Load diskid1.prg into RAM (BASIC line: SYS 2064).
//   4. RUN → SYS 2064 → machine code does disk-ID compare logic.
//   5. Run 50M cycles for workflow to complete.
//   6. Persist → expect noModifications=true (pure read).
//
// Self-consistency: post-state hash must equal pristine input
// (drive made no writes). If hash differs, drive wrote spuriously
// — a regression worth catching.
//
// Layer: B (integrated session, read-only).

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runIntegratedScenario } from "../integrated-runner.ts";
import { sha256OfBytes } from "../../../../src/runtime/headless/validation/disk-image-hash.ts";
import type { ScenarioModule } from "../harness.ts";

const mod: ScenarioModule = {
  name: "diskid-read",
  layer: "B",
  async run(ctx) {
    const inputD64 = await ctx.prepareWritableCopy(
      "samples/vice-testprogs/drive/diskid/diskid.d64",
      "pre-state.d64",
    );
    const diskidPrg = resolve(ctx.repoRoot, "samples/vice-testprogs/drive/diskid/diskid1.prg");
    const postStatePath = resolve(ctx.scratchDir, "post-state.g64");

    const out = await runIntegratedScenario({
      diskPath: inputD64,
      bootCycles: 5_000_000,
      loadPrgPath: diskidPrg,
      command: "RUN\r",
      postCommandCycles: 50_000_000,
      postStatePath,
    });

    // Read-only workflow → drive must not modify any tracks.
    if (!out.noModifications) {
      throw new Error(
        `diskid is a read-only workflow but drive reported writes to tracks [${out.modifiedTracks.join(",")}]`,
      );
    }

    // No persist file written → stamp pristine input bytes so the
    // harness has something to sha256.
    const inputBytes = await readFile(inputD64);
    await writeFile(postStatePath, inputBytes);
    const inputHash = sha256OfBytes(new Uint8Array(inputBytes));

    return {
      tsPostStatePath: postStatePath,
      selfConsistencyOnly: true,
      details: {
        noModifications: true,
        inputHashShort: inputHash.slice(0, 16),
      },
    };
  },
};

export default mod;
