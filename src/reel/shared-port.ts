// Where the SHARED machine lives, and the one refusal that keeps a sandbox from answering as it.
//
// Read from the environment rather than from `src/runtime/daemon-client.ts`, so the sandbox side has no edge into
// the shared client at all — the import itself is what a reviewer would have to trust. `sharedRuntimePort` names
// the shared port only in order to refuse it.

export function sharedRuntimePort(env: NodeJS.ProcessEnv = process.env): number {
  const ep = env.C64RE_RUNTIME_ENDPOINT?.trim() || "ws://127.0.0.1:4312";
  const m = /:(\d+)\s*\/?$/.exec(ep);
  return m ? Number(m[1]) : 4312;
}

/** Refuse to be the shared machine. `freePort()` asks the OS for a port nobody
 *  holds, so the shared port comes back only when NOTHING is listening on it —
 *  and a sandbox squatting there would answer the next `runtime_session_start`
 *  as if it were the co-driven session. Loud, not clever. */
export function assertNotShared(port: number): void {
  const shared = sharedRuntimePort();
  if (port !== shared) return;
  throw new Error(
    `the OS handed out port ${port}, which is where the SHARED machine lives — so this ` +
      `sandbox would answer as the session the human co-drives. Nothing was run. Retry: ` +
      `the port is picked fresh each time.`,
  );
}
