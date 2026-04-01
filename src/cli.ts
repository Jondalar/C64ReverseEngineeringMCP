#!/usr/bin/env node
import { startStdioServer } from "./server.js";

startStdioServer().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
