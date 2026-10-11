// Preloaded into a CHILD process (node --import) by the replay-determinism e2e: before the first call
// a private machine answers to, wait a random wall-clock time. A machine whose start state depends on
// how long the caller took to speak (a daemon that runs on by itself until it is paused) shows it here.
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { SandboxSession } = await import(pathToFileURL(join(root, "dist/reel/sandbox-session.js")).href);
const max = Number(process.env.REPLAY_HOSTILE_DELAY_MS || 0);
const orig = SandboxSession.prototype.call;
const seen = new WeakSet();
SandboxSession.prototype.call = async function (method, ...rest) {
  if (max > 0 && method !== "ping" && !seen.has(this)) {
    seen.add(this);
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * max)));
  }
  return orig.call(this, method, ...rest);
};
