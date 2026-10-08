// Spec 889 §11 — the C64RE side of the bridge: "the C64U is selected" is a runtime endpoint.
//
// `RuntimeDaemonClient` connects to the bridge as to any daemon (same wire, same handshake). What
// differs is only the policy: the endpoint is the bridge's, bringing it up is `ensureBridge`
// (attach to the running one, or start one detached), and nothing is ever killed or replaced behind
// the owner's back.

import { RuntimeDaemonClient, type DaemonPolicy } from "../daemon-client.js";
import type { BackendIdentity } from "../runtime-methods.js";
import { bridgeConfigFor, ensureBridge, pingBridge } from "./launch.js";
import { pidAlive, writeSelection, type SelectionRecord } from "./state.js";

export interface BridgeTarget {
  host: string;
  restPort: number;
  /** The bridge's WS endpoint; empty until the first start (a selection by environment starts it lazily). */
  endpoint: string;
  bridgePid?: number;
  config?: { rpcPort?: number; trxmonPath?: string; paused?: boolean; startMonitor?: boolean };
}

export class BridgeClient extends RuntimeDaemonClient {
  readonly target: BridgeTarget;

  constructor(target: BridgeTarget, onStarted?: (rec: SelectionRecord) => void) {
    const t = target;
    const policy: DaemonPolicy = {
      kind: "c64u",
      endpoint: () => t.endpoint,
      async start(projectDir) {
        // C64RE_RUNTIME_AUTOSTART=0 means "start nothing behind my back": a select is explicit and
        // does not come through here; a call that finds the bridge gone does.
        if (process.env.C64RE_RUNTIME_AUTOSTART === "0") {
          throw new Error(`the C64U bridge for ${t.host} is not running and C64RE_RUNTIME_AUTOSTART=0 forbids starting one — select the device again with runtime_backend, or start it: c64re c64u-bridge --device ${t.host}${t.restPort !== 80 ? `:${t.restPort}` : ""}`);
        }
        // The bridge ended (idle exit) or was never started by this process: attach to a running one,
        // else start one. The password, if the device has one, is this process's memory (launch.ts).
        const handle = await ensureBridge(bridgeConfigFor(t.host, t.restPort, {
          rpcPort: t.config?.rpcPort, trxmonPath: t.config?.trxmonPath, paused: t.config?.paused,
          startMonitor: t.config?.startMonitor, projectDir,
        }));
        t.endpoint = handle.endpoint;
        t.bridgePid = handle.pid;
        const rec = writeSelection({
          kind: "c64u", by: `${process.env.C64RE_PROCESS_ROLE ?? "c64re"}:${process.pid}`,
          device: { host: t.host, restPort: t.restPort }, endpoint: handle.endpoint, bridgePid: handle.pid,
          config: { rpcPort: t.config?.rpcPort, trxmonPath: t.config?.trxmonPath, paused: t.config?.paused },
        });
        onStarted?.(rec);
        return !handle.attached;
      },
      killStalled: false,
      unreachable: (endpoint, spawned) =>
        `the C64 Ultimate bridge for ${t.host} is not reachable at ${endpoint || "(not started)"}${spawned ? " (it was started but did not come up in time)" : ""} — ` +
        "select the runtime again with runtime_backend, or select the emulator",
      respawnNotice: () =>
        `NOTE: the C64U bridge for ${t.host} had ended — it ends itself after being idle — so this call started a new one. ` +
        "The device kept its state; the bridge's picture and sound viewers and its project binding start again (project/set).",
      label: () => `C64 Ultimate ${t.host}`,
    };
    super(policy);
    this.target = t;
  }

  /** The identity the bridge reports (device, firmware, trxmon, capability gaps, streams) — a short ping, never a start. */
  override async describe(): Promise<BackendIdentity> {
    const base = { kind: "c64u" as const, label: `C64 Ultimate ${this.target.host}`, endpoint: this.target.endpoint || undefined };
    if (!this.target.endpoint || (this.target.bridgePid !== undefined && !pidAlive(this.target.bridgePid))) return { ...base, version: undefined };
    const p = await pingBridge(this.target.endpoint, 2500);
    if (!p) return base;
    return {
      ...base,
      label: typeof p.label === "string" ? p.label : base.label,
      version: typeof p.version === "string" ? p.version : undefined,
      device: p.device as BackendIdentity["device"],
    };
  }
}
