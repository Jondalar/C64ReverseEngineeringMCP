// Spec 889 §3 — finding a C64 Ultimate and probing what it runs.
//
// Two doors, both read-only and neither ever a surprise on a network the caller did not name:
//   - the Ultimate Ident Service: a UDP datagram `json<nonce>` to port 64, answered with the
//     device's JSON (the stock firmware's own protocol, `socket_dma.cc` identThread);
//   - `GET /v1/info` on a host the caller already has, the same JSON over REST.
// The broadcast address, the port and the host list are all PARAMETERS. Nothing here picks a
// network by itself: a caller that passes no target discovers nothing, and a test binds
// 127.0.0.1 and names it.

import { createSocket, type Socket } from "node:dgram";

/** What an Ultimate answers with (ident datagram and `/v1/info` carry the same fields). */
export interface UltimateIdent {
  product?: string;
  firmware_version?: string;
  fpga_version?: string;
  core_version?: string;
  hostname?: string;
  menu_header?: string;
  your_string?: string;
  password_protected?: boolean;
  unique_id?: string;
  git_commit_hash?: string;
  /** Our firmware only: on a U64-class board with the TRX64 IO block present. */
  trx64?: { core?: string; caps?: string; board?: string; rpc?: number; build?: string };
  [k: string]: unknown;
}

/**
 * The three outcomes of the ident (spec §3). "stock" is a device that is not ours; the next
 * two are our core, and only `monitor` has an RPC port to ask. The ping decides "offered".
 */
export type IdentOutcome =
  | { outcome: "stock"; reason: string }
  | { outcome: "core-no-monitor"; reason: string; core: string }
  | { outcome: "monitor"; reason: string; core: string; rpc: number };

/** Classify an ident / `/v1/info` answer. Pure. */
export function classifyIdent(ident: UltimateIdent): IdentOutcome {
  const t = ident.trx64;
  if (!t || typeof t !== "object") {
    return { outcome: "stock", reason: "C64 Ultimate — stock core (its ident names no runtime core)" };
  }
  if (t.core !== "TRX2") {
    return { outcome: "stock", reason: `its ident names core ${JSON.stringify(t.core ?? null)}, not "TRX2" — not a core C64RE knows` };
  }
  if (typeof t.rpc === "number" && t.rpc > 0) {
    return { outcome: "monitor", reason: `our core (TRX2), trxmon serving on port ${t.rpc}`, core: t.core, rpc: t.rpc };
  }
  return { outcome: "core-no-monitor", reason: "our core (TRX2), trxmon is not running — start it", core: t.core };
}

export interface DiscoverTarget {
  /** Where the ident datagram goes: a broadcast address, or one host. */
  address: string;
  /** Default 64 (the Ultimate Ident Service). */
  port?: number;
  /** Set for a broadcast address. */
  broadcast?: boolean;
}

export interface DiscoverOptions {
  targets: readonly DiscoverTarget[];
  /** How long to listen after the last send (default 1200 ms). */
  timeoutMs?: number;
  /** Test seam: a socket factory. Default `dgram.createSocket("udp4")`. */
  socketFactory?: () => Socket;
}

export interface FoundDevice {
  /** The source address the answer came from. */
  address: string;
  port: number;
  ident: UltimateIdent;
}

/**
 * Send `json<nonce>` to each target and collect every answer that echoes the nonce back in
 * `your_string`. Answers from the same address are listed once. Never throws for a target
 * that does not answer — a silent network is an empty list.
 */
export async function discoverUltimates(opts: DiscoverOptions): Promise<FoundDevice[]> {
  if (opts.targets.length === 0) return [];
  const nonce = `c64re${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  const sock = (opts.socketFactory ?? (() => createSocket("udp4")))();
  const found = new Map<string, FoundDevice>();
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, opts.timeoutMs ?? 1200);
    timer.unref?.();
    sock.on("message", (msg, rinfo) => {
      let j: UltimateIdent;
      try { j = JSON.parse(msg.toString("utf8")) as UltimateIdent; } catch { return; }
      if (!j || typeof j !== "object" || j.your_string !== nonce) return; // someone else's answer
      if (!found.has(rinfo.address)) found.set(rinfo.address, { address: rinfo.address, port: rinfo.port, ident: j });
    });
    sock.on("error", () => { clearTimeout(timer); resolve(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { sock.once("error", reject); sock.bind(0, () => { sock.removeListener("error", reject); resolve(); }); });
    if (opts.targets.some((t) => t.broadcast)) { try { sock.setBroadcast(true); } catch { /* a send will report it */ } }
    const payload = Buffer.from(`json${nonce}`);
    for (const t of opts.targets) {
      await new Promise<void>((resolve) => sock.send(payload, t.port ?? 64, t.address, () => resolve()));
    }
    await done;
  } catch {
    /* an unbindable socket discovers nothing */
  } finally {
    try { sock.close(); } catch { /* already closed */ }
  }
  return [...found.values()];
}
