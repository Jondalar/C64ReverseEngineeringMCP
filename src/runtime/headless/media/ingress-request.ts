// Spec 744.4c slice 2b — the abstract media operation contract, shared by every
// client of the runtime media authority.
//
// Spec 709 already made `ingestMedia(ctrl, MediaIngressRequest)` the SINGLE media
// authority (bytes/hash/event based; mountMedia is only a legacy path→bytes
// adapter). The client brings the MEDIUM (a server-resolvable `path`, or raw
// `bytes_b64`) + the ACTION (`kind`); this builder turns that wire-shaped input
// into a typed MediaIngressRequest. It lived inline in v3-ws-server; extracted
// here so the daemon WS route AND the in-process MCP tools build byte-identical
// requests — one operation, one shape, whichever side runs it.

import { readFileSync } from "node:fs";
import type { MediaIngressRequest } from "./ingress.js";

/** Wire-shaped media input: a medium (path | bytes_b64) + an action (kind). */
export interface MediaIngressInput {
  kind?: "disk" | "prg" | "crt" | "eject";
  /** Server-resolvable host path (absolute — the CALLER resolves it against its
   *  own project before sending; the runtime authority does NOT re-resolve). */
  path?: string;
  /** Base64 medium bytes — used when the medium is shipped directly (no shared
   *  filesystem). Takes precedence over `path`. */
  bytes_b64?: string;
  /** Display/format name; defaults to the path basename. */
  name?: string;
  /** PRG only: load vs inject-run. */
  mode?: "load" | "inject-run";
  /** PRG only: entry address. */
  entry?: number;
  /** CRT only: reset policy. */
  resetPolicy?: "reset" | "power-cycle";
  /** eject only: which device. */
  role?: "drive8" | "cartridge";
}

/** Infer the media kind from a path extension (disk is the default). */
export function kindFromExt(path: string): "disk" | "prg" | "crt" | "vsf" | "c64re" {
  const e = path.toLowerCase().split(".").pop();
  if (e === "prg") return "prg";
  if (e === "crt") return "crt";
  if (e === "c64re") return "c64re";
  if (e === "vsf") return "vsf";
  return "disk";
}

/**
 * Build a typed MediaIngressRequest from wire input. Reads `path` bytes here when
 * no `bytes_b64` is given (the path must be reachable by THIS process — the daemon
 * for a daemon route, the MCP process for an in-process route). For a disk/crt a
 * server-resolvable `path` is preserved as `backingPath` so writable media write
 * through to the host file (Spec 742); uploaded bytes (no path) stay RAM-only.
 */
export function buildIngressRequest(p: MediaIngressInput): MediaIngressRequest {
  const name = String(p.name ?? (p.path ? String(p.path).split("/").pop() : "media"));
  const bytes: Uint8Array | undefined = p.bytes_b64
    ? new Uint8Array(Buffer.from(String(p.bytes_b64), "base64"))
    : p.path ? new Uint8Array(readFileSync(String(p.path))) : undefined;
  if (p.kind === "eject") return { kind: "eject", role: p.role === "cartridge" ? "cartridge" : "drive8" };
  if (!bytes) throw new Error("media-ingress: bytes_b64 or path required");
  if (p.kind === "prg") return { kind: "prg", bytes, name, mode: p.mode === "inject-run" ? "inject-run" : "load", entry: p.entry };
  if (p.kind === "crt") return { kind: "crt", bytes, name, resetPolicy: p.resetPolicy === "reset" ? "reset" : "power-cycle", backingPath: p.path ? String(p.path) : undefined };
  return { kind: "disk", role: "drive8", bytes, name, backingPath: p.path ? String(p.path) : undefined };
}
