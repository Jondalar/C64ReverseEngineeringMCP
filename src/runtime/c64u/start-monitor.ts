// Spec 889 §3a — starting trxmon on a device over its REST API.
//
// One function for both callers: the bridge's own `startMonitor` (the select-time start) and the
// "Start monitor" action of a C64RE process that has no bridge yet (a device listing offers it
// before anything is selected). REST only — the app's one RPC connection is the bridge's.

import { UltimateRest, UltimateRestError } from "./rest.js";
import type { UltimateIdent } from "./discovery.js";

/** Where trxmon is installed on a device, when nothing else says (T21 §8.1: the manifest's own
 *  example and the REST `run_file` documentation both name `/Flash/apps/trxmon.u2a`). */
export const DEFAULT_TRXMON_PATH = "/Flash/apps/trxmon.u2a";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start trxmon over REST. `via: "run_file"` (default, works on every build) passes the device
 * path of trxmon.u2a; `via: "app"` uses the registered app and needs app 5b605bb0 or later
 * installed (an older install answers 403 until reinstalled). 423 = already running. With
 * `wait` (default) the ident is polled for up to 8 s until it names the app's port.
 */
export async function startTrxmon(
  rest: UltimateRest,
  o: { via?: "run_file" | "app"; path?: string; wait?: boolean; rpcPortOverride?: number } = {},
): Promise<{ started: boolean; note: string; rpcPort?: number }> {
  const via = o.via ?? "run_file";
  const path = o.path ?? DEFAULT_TRXMON_PATH;
  let started = true;
  let note: string;
  try {
    if (via === "app") {
      await rest.request({ method: "PUT", path: "/v1/apps/trxmon:run", query: { action: "serve" } });
      note = "started trxmon (PUT /v1/apps/trxmon:run action=serve)";
    } else {
      await rest.request({ method: "PUT", path: "/v1/apps:run_file", query: { app: path, action: "serve" } });
      note = `started trxmon from ${path} (PUT /v1/apps:run_file action=serve)`;
    }
  } catch (e) {
    if (e instanceof UltimateRestError && e.status === 423) {
      started = false;
      note = "trxmon is already running on the device (423: an app is resident) — probing it";
    } else if (e instanceof UltimateRestError && e.status === 403 && via === "app") {
      throw new Error(`${e.message}. The installed trxmon manifest has no REST action (an older install): reinstall the app, or start it with via=run_file and its path (default ${DEFAULT_TRXMON_PATH}).`);
    } else if (e instanceof UltimateRestError && e.status === 404) {
      throw new Error(`${e.message}. trxmon.u2a was not found at ${path} on the device — give its full device path (the path parameter).`);
    } else throw e;
  }
  let rpcPort: number | undefined;
  if (o.wait !== false) {
    // The RPC port appears in the ident only while trxmon runs.
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const info = (await rest.info()) as UltimateIdent;
        const rpc = info.trx64?.rpc;
        if (typeof rpc === "number") { rpcPort = o.rpcPortOverride ?? rpc; break; }
      } catch { /* keep polling until the deadline */ }
      if (Date.now() > deadline) { note += "; the ident did not name an app port within 8 s"; break; }
      await sleep(200);
    }
  }
  return { started, note, rpcPort };
}
