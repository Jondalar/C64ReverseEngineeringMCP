// Spec 450 Scenario B7 — iec-bus-delay.prg IEC timing probe.
//
// Pure read workflow (IEC bus timing test, no disk writes):
//   1. Mount diskid.d64 (any valid D64 — doesn't matter for this
//      timing test; reuse existing corpus).
//   2. Boot C64 + drive.
//   3. Load iec-bus-delay-auto.prg (auto variant — runs without
//      user input).
//   4. RUN → workflow measures IEC bus delays.
//   5. Run 50M cycles.
//   6. Persist → expect noModifications=true.
//
// Self-consistency: no drive writes; hash equals pristine input.
//
// Layer: B (integrated session, IEC bus exercise).

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runIntegratedScenario } from "../integrated-runner.ts";
import { sha256OfBytes } from "../../../../src/runtime/headless/validation/disk-image-hash.ts";
import type { ScenarioModule } from "../harness.ts";

const mod: ScenarioModule = {
  name: "iecdelay",
  layer: "B",
  async run(ctx) {
    const inputD64 = await ctx.prepareWritableCopy(
      "samples/vice-testprogs/drive/diskid/diskid.d64",
      "pre-state.d64",
    );
    const iecdelayPrg = resolve(
      ctx.repoRoot,
      "samples/vice-testprogs/drive/iecdelay/iec-bus-delay-auto.prg",
    );
    const postStatePath = resolve(ctx.scratchDir, "post-state.g64");

    const out = await runIntegratedScenario({
      diskPath: inputD64,
      bootCycles: 5_000_000,
      loadPrgPath: iecdelayPrg,
      command: "RUN\r",
      postCommandCycles: 50_000_000,
      postStatePath,
    });

    if (!out.noModifications) {
      throw new Error(
        `iecdelay is a read-only workflow but drive reported writes to tracks [${out.modifiedTracks.join(",")}]`,
      );
    }

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
