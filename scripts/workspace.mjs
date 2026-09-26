#!/usr/bin/env node
// The workbench, from a checkout: the HTTP knowledge API + UI on :4310 and the runtime
// daemon on :4312.
//
// Usage: npm run workspace -- --project <dir> [--dev-samples] [--port <http>]
//
// The orchestration itself lives in src/workspace-ui/launch.ts and is compiled into
// dist/, because `scripts/` is not in the npm tarball and the launchers an installed
// package writes have to reach the same code. This file is the checkout's way in; the
// installed package's way in is `c64re ui`. One implementation, two doors.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const { launchWorkspace } = await import(
  pathToFileURL(`${repoRoot}/dist/workspace-ui/launch.js`).href
);

await launchWorkspace(process.argv.slice(2), process.env);
process.exit(0);
