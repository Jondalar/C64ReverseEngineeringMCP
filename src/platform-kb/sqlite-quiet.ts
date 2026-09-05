// Spec 817 — node:sqlite without the ExperimentalWarning on stderr.
//
// Node 22 prints "SQLite is an experimental feature" the first time the module
// loads. The MCP server speaks JSON over stdio and the pipeline is a spawned
// child whose stderr callers read, so that line must not leak into tool output.
// A static `import` is hoisted above any statement in the importing module, so
// the listener has to be installed HERE, before a dynamic require — that order
// is guaranteed inside one module and nowhere else.

import { createRequire } from "node:module";

function installWarningFilter(): void {
  const key = "__c64rePlatformKbWarningFilter";
  const proc = process as unknown as Record<string, unknown>;
  if (proc[key]) return;
  proc[key] = true;
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
    console.error(`${warning.name}: ${warning.message}`);
  });
}

installWarningFilter();

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite = require("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import("node:sqlite").DatabaseSync;
export type StatementSync = import("node:sqlite").StatementSync;
