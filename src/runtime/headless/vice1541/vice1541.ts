// Spec 611 phase 611.1 — VICE1541 stub.
//
// Every method (and the constructor itself) throws a clear "not
// implemented" error citing Spec 611.1. Real implementation lands
// incrementally in phases 611.2–611.8 per
// `specs/611-new-vice1541-side-by-side.md` §5.
//
// Until then, instantiating Vice1541 MUST fail — the factory wiring
// is the only thing under test in 611.1.

import type {
  Drive1541,
  Drive1541DebugProbe,
  Drive1541IecInput,
  Drive1541IecSample,
  Drive1541Media,
} from "../drive1541/drive1541.js";

const STUB_ERROR =
  "[VICE1541] not implemented yet (Spec 611 phase 611.1 scaffold). " +
  "Real implementation lands incrementally in phases 611.2–611.8. " +
  "Use drive1541: \"legacy\" until VICE1541 passes the runtime proof gates.";

export class Vice1541 implements Drive1541 {
  constructor() {
    throw new Error(STUB_ERROR);
  }

  iecLineSample(): Drive1541IecSample {
    throw new Error(STUB_ERROR);
  }

  iecLineDrive(_c64Side: Drive1541IecInput): void {
    throw new Error(STUB_ERROR);
  }

  catchUpTo(_c64Clock: number): number {
    throw new Error(STUB_ERROR);
  }

  flush(): void {
    throw new Error(STUB_ERROR);
  }

  attachDisk(_media: Drive1541Media): void {
    throw new Error(STUB_ERROR);
  }

  detachDisk(): void {
    throw new Error(STUB_ERROR);
  }

  setWriteProtect(_on: boolean): void {
    throw new Error(STUB_ERROR);
  }

  reset(_kind: "cold" | "warm"): void {
    throw new Error(STUB_ERROR);
  }

  snapshot(): Uint8Array {
    throw new Error(STUB_ERROR);
  }

  restore(_blob: Uint8Array): void {
    throw new Error(STUB_ERROR);
  }

  debugProbe(): Drive1541DebugProbe {
    throw new Error(STUB_ERROR);
  }
}
