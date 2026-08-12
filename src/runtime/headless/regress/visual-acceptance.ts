// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// Spec 121 (M4.5) — visual acceptance fixtures.
//
// Compares current screen state against a stored fixture
// (state-hash + text-snippet primary; PNG similarity secondary).
// Fixtures live under samples/visual-acceptance/<game>/<phase>.json
// and .png. M1.5 regress matrix can declare expected visual states
// per fixture.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { IntegratedSession } from "../integrated-session.js";
import { captureScreenState, screenStateHash } from "../c64/screen-state.js";

export interface VisualFixture {
  game: string;
  phase: "ready" | "loading" | "title" | "gameplay";
  stateHash: string;
  textSnippet?: string;     // expected substring in textGrid joined
  vicMode?: string;
  pngPath?: string;
}

export interface VisualAcceptanceResult {
  pass: boolean;
  reason?: string;
  observedHash: string;
  expectedHash: string;
  textSnippetMatched?: boolean;
}

export function loadVisualFixture(game: string, phase: VisualFixture["phase"]): VisualFixture | null {
  const jsonPath = resolvePath("samples/visual-acceptance", game, `${phase}.json`);
  if (!existsSync(jsonPath)) return null;
  const obj = JSON.parse(readFileSync(jsonPath, "utf8")) as VisualFixture;
  return obj;
}

export function assertVisualState(session: IntegratedSession, fixture: VisualFixture): VisualAcceptanceResult {
  const state = captureScreenState(session);
  const observedHash = screenStateHash(state);
  if (fixture.stateHash && fixture.stateHash !== observedHash) {
    let textSnippetMatched: boolean | undefined;
    if (fixture.textSnippet) {
      const flat = state.textGrid.join("\n");
      textSnippetMatched = flat.includes(fixture.textSnippet);
    }
    return {
      pass: textSnippetMatched === true,
      reason: textSnippetMatched === true
        ? "stateHash mismatch but textSnippet matched (soft-pass)"
        : `stateHash mismatch: expected=${fixture.stateHash} observed=${observedHash}`,
      observedHash,
      expectedHash: fixture.stateHash,
      textSnippetMatched,
    };
  }
  return {
    pass: true,
    observedHash,
    expectedHash: fixture.stateHash,
  };
}
