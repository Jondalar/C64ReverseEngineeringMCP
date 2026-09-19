// Spec 863 — which C64 the live session is, for every part of the Live tab that counts in
// frames, cycles or pixels.
//
// The runtime says it three ways and this hook listens to all of them: `session/state`
// (the identity fields) when the tab opens or the socket reconnects, `session/models` for
// the rows the selector offers, and the `av/hello` notification the runtime sends on every
// model change — a switch, or a rewind to a checkpoint taken on the other model. Nothing
// here knows a frame length or a canvas size of its own.

import { useCallback, useEffect, useState } from "react";
import { getClient } from "./ws-client.js";
import { machineIdentity, type MachineIdentity, type ModelRow } from "../../../src/runtime/machine-model.js";

export interface MachineModelState {
  /** The machine as the runtime last described it; null until it has. */
  machine: MachineIdentity | null;
  /** Every model the runtime knows, runnable or not. */
  rows: ModelRow[];
  /** Why the machine could not be read (an older runtime, a closed socket). */
  error: string | null;
  refresh: () => void;
}

export function useMachineModel(sessionId: string | null | undefined): MachineModelState {
  const [machine, setMachine] = useState<MachineIdentity | null>(null);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    const client = getClient();
    let alive = true;
    const load = async (): Promise<void> => {
      if (client.getState() !== "open") return;
      try {
        const st = await client.call("session/state", { session_id: sessionId });
        if (alive) { setMachine(machineIdentity(st)); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
      try {
        const m = await client.call<{ models?: ModelRow[] }>("session/models", { session_id: sessionId });
        if (alive) setRows(m?.models ?? []);
      } catch { /* an older runtime has no model table — the selector stays empty */ }
    };
    void load();
    // One machine per runtime process, so every hello is about the machine on screen.
    const offHello = client.onNotification("av/hello", (p: unknown) => {
      try { setMachine(machineIdentity(p)); setError(null); } catch { void load(); }
    });
    const offState = client.onState((s) => { if (s === "open") void load(); });
    return () => { alive = false; offHello(); offState(); };
  }, [sessionId, nonce]);

  return { machine, rows, error, refresh };
}
