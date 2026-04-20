#!/usr/bin/env node
import { startStdioServer } from "./server.js";

// Keep the MCP stdio server alive across unhandled errors so a bug inside
// one tool handler doesn't take the whole server down and disconnect the
// client. Errors are logged to stderr (which is outside the JSON-RPC
// channel on stdout) so the host can surface them.
process.on("uncaughtException", (error) => {
  console.error("[c64-re mcp] uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[c64-re mcp] unhandledRejection:", reason);
});

startStdioServer().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
