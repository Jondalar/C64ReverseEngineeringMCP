#!/usr/bin/env node
// A smoke that does exactly what D5 forbids: it starts a runtime daemon (through the product's own
// start, so it is in the ledger as a smoke's) and exits without ending it. It is NOT in the gate; the
// leak step's own test (scripts/e2e-902-leak.mjs) runs it to prove the step fails and names it.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { startRuntimeDaemon } = await import(pathToFileURL(join(ROOT, "dist/runtime/daemon-client.js")).href);
const port = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const r = await startRuntimeDaemon({ projectDir: process.argv[2], endpoint: `ws://127.0.0.1:${port}`, startedBy: "mcp" });
console.log(JSON.stringify({ started: r, port }));
// …and no finally that ends it.
