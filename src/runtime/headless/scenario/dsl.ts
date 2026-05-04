// Spec 125 (M5.4) v1 + Spec 126 (M5.5) v1 — scenario DSL + knowledge integration.
//
// JSON-shape (YAML loader is a thin add-on left for follow-up):
//
//   {
//     "version": 1,
//     "media":   { "disk": "..."?, "prg": "..."?, "crt": "..."? },
//     "resetProfile": "pal-default",
//     "mode": "true-drive",
//     "steps":  [ScenarioStep[]],
//     "expect": [ ExpectClause[] ]?,
//     "artifacts": [ ArtifactSpec[] ]?,
//     "knowledge": boolean,           // Spec 126: register artifacts in MCP knowledge
//     "findings": [ ... ]?,           // Spec 126
//     "tasks":    [ ... ]?,           // Spec 126
//   }
//
// Versioned (`version: 1`); future shape changes bump version.

import { readFileSync } from "node:fs";
import type { ScenarioStep } from "../input/scenario-player.js";

export interface ExpectClause {
  kind: "status90" | "pcInRange" | "memEquals";
  // status90 fields
  bit?: "EOI" | "TIMEOUT" | "OK";
  // pcInRange
  pcLow?: number; pcHigh?: number;
  // memEquals
  addr?: number; value?: number;
}

export interface ArtifactSpec {
  kind: "snapshot" | "screenPng" | "trace";
  path: string;
  channel?: string; // for trace
}

export interface Scenario {
  version: 1;
  media: { disk?: string; prg?: string; crt?: string };
  resetProfile?: string;
  mode?: string;
  steps: ScenarioStep[];
  expect?: ExpectClause[];
  artifacts?: ArtifactSpec[];
  knowledge?: boolean;
  findings?: { title: string; addressRange?: { start: number; end: number }; tags?: string[] }[];
  tasks?: { subject: string; description?: string }[];
}

export function parseScenario(text: string): Scenario {
  const parsed = JSON.parse(text) as Scenario;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported scenario version: ${parsed.version} (expected 1)`);
  }
  if (!parsed.media || !(parsed.media.disk || parsed.media.prg || parsed.media.crt)) {
    throw new Error(`Scenario media required (disk | prg | crt)`);
  }
  if (!Array.isArray(parsed.steps)) {
    throw new Error(`Scenario steps must be an array`);
  }
  return parsed;
}

export function loadScenario(path: string): Scenario {
  return parseScenario(readFileSync(path, "utf8"));
}
