// Spec 707 — native C64RE runtime-snapshot persistence (.c64re).
//
// Serializes the EXISTING 705.A native RuntimeCheckpoint (the MachineSnapshot
// payload produced by kernel.snapshot()) — it does NOT define a second snapshot
// model (Spec 707 §2.2). The VICE1541 drive payload stays the opaque,
// VICE-shaped Uint8Array from 705.A; this codec never interprets it.
//
// Container layout (§3 "binary container"):
//   bytes  0..7  MAGIC  "C64RESNP" (ascii)
//   byte   8     formatVersion (u8)              — rejectably incompatible
//   bytes  9..40 sha256(gzBody) (32 bytes)       — integrity over the payload
//   bytes 41..   gzBody = gzip(JSON.stringify(doc))
//
// doc = { manifest, checkpoint, mediaPayloads }:
//   - manifest:  NativeSnapshotManifest (version, machine, checkpoint summary,
//                media refs by sha256 — NO absolute host path as the only id).
//   - checkpoint: the RuntimeCheckpoint payload, typed arrays encoded by a
//                tagged base64 codec (RAM / VIC framebuffers / drive blob /
//                reSID state survive 1:1; the opaque drive blob is passed through
//                untouched).
//   - mediaPayloads: { [ref]: base64 } embedded media bytes (Spec 707 media
//                policy v1 = embed clean media; see snapshot-media.ts).
//
// VSF is never the internal format (§2.1 / Spec 623 §7); a labelled VSF
// import/export is a possible later, explicit boundary.

import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { MachineSnapshot } from "./machine-kernel.js";

export const NATIVE_SNAPSHOT_MAGIC = "C64RESNP";
export const NATIVE_SNAPSHOT_FORMAT_VERSION = 1;
const HEADER_LEN = 8 + 1 + 32;

export interface SnapshotMediaRef {
  role: "drive8" | "drive9" | "cartridge" | "injected-prg";
  format: string;
  sha256: string;
  sourceName?: string;
  /** Key into mediaPayloads when bytes are embedded (Spec 707 v1 default). */
  embeddedPayloadRef?: string;
  /** Reserved for a later versioned writable-media delta type (not built in v1). */
  writableDeltaRef?: string;
}

export interface NativeSnapshotManifest {
  kind: "c64re-runtime-snapshot";
  version: number; // checkpoint schema version (MachineSnapshot.schemaVersion)
  createdAt: string;
  machine: { model: "c64-pal" | "c64-ntsc"; runtimeVersion: string };
  checkpoint: { encoding: string; payloadRef: string; cycle: number; pc: number };
  media: SnapshotMediaRef[];
  provenance?: { experimentId?: string; checkpointId?: string; note?: string };
}

/** A media entry to embed (bytes) or reference. */
export interface NativeSnapshotMediaInput {
  role: SnapshotMediaRef["role"];
  format: string;
  sourceName?: string;
  /** Embedded bytes (v1 default). sha256 is computed if not given. */
  bytes?: Uint8Array;
  sha256?: string;
}

export interface WriteNativeSnapshotArgs {
  snapshot: MachineSnapshot;
  media: NativeSnapshotMediaInput[];
  runtimeVersion: string;
  machineModel?: "c64-pal" | "c64-ntsc";
  provenance?: NativeSnapshotManifest["provenance"];
}

export interface ReadNativeSnapshotResult {
  manifest: NativeSnapshotManifest;
  snapshot: MachineSnapshot;
  /** Media with embedded bytes resolved (bytes present when embeddedPayloadRef set). */
  media: { ref: SnapshotMediaRef; bytes?: Uint8Array }[];
}

// ---- typed-array-aware value codec ----------------------------------------
// Tags an ArrayBuffer view as { $ta: <ctorName>, b64 }. Everything else is
// plain JSON. Round-trips RAM/framebuffers/drive blob/reSID state exactly.

const TA_CTORS: Record<string, new (buf: ArrayBufferLike) => ArrayBufferView> = {
  Uint8Array, Int8Array, Uint8ClampedArray,
  Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array,
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function encodeValue(v: unknown): unknown {
  if (v == null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const ctor = (v as object).constructor.name;
    const view = v as ArrayBufferView;
    const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { $ta: ctor, b64: b64(u8) };
  }
  if (Array.isArray(v)) return v.map(encodeValue);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = encodeValue(val);
    return out;
  }
  throw new Error(`native-snapshot: cannot encode value of type ${typeof v}`);
}

function decodeValue(v: unknown): unknown {
  if (v == null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj["$ta"] === "string" && typeof obj["b64"] === "string") {
      const ctorName = obj["$ta"] as string;
      const Ctor = TA_CTORS[ctorName];
      if (!Ctor) throw new Error(`native-snapshot: unknown typed-array ctor ${ctorName}`);
      const bytes = unb64(obj["b64"] as string);
      // reinterpret the raw bytes through the declared view ctor
      return new (Ctor as unknown as { new (buf: ArrayBufferLike): ArrayBufferView })(bytes.buffer);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) out[k] = decodeValue(val);
    return out;
  }
  throw new Error(`native-snapshot: cannot decode value of type ${typeof v}`);
}

// ---- writer ----------------------------------------------------------------

export function writeNativeSnapshot(args: WriteNativeSnapshotArgs): Uint8Array {
  const { snapshot, media, runtimeVersion } = args;
  const cp = snapshot.payload as { cpu?: { pc?: number; cycles?: number } } | null;
  const pc = cp?.cpu?.pc ?? 0;
  const cycle = cp?.cpu?.cycles ?? 0;

  const mediaPayloads: Record<string, string> = {};
  const mediaRefs: SnapshotMediaRef[] = media.map((m, i) => {
    const ref: SnapshotMediaRef = {
      role: m.role,
      format: m.format,
      sha256: m.sha256 ?? (m.bytes ? sha256Hex(m.bytes) : ""),
    };
    if (m.sourceName) ref.sourceName = m.sourceName;
    if (m.bytes) {
      const key = `media${i}`;
      mediaPayloads[key] = b64(m.bytes);
      ref.embeddedPayloadRef = key;
    }
    return ref;
  });

  const manifest: NativeSnapshotManifest = {
    kind: "c64re-runtime-snapshot",
    version: snapshot.schemaVersion,
    createdAt: new Date().toISOString(),
    machine: { model: args.machineModel ?? "c64-pal", runtimeVersion },
    checkpoint: { encoding: "ta-json-gz/1", payloadRef: "checkpoint", cycle, pc },
    media: mediaRefs,
  };
  if (args.provenance) manifest.provenance = args.provenance;

  const doc = { manifest, checkpoint: encodeValue(snapshot.payload), mediaPayloads };
  const gzBody = gzipSync(Buffer.from(JSON.stringify(doc), "utf8"));
  const digest = createHash("sha256").update(gzBody).digest();

  const out = new Uint8Array(HEADER_LEN + gzBody.length);
  out.set(Buffer.from(NATIVE_SNAPSHOT_MAGIC, "ascii"), 0);
  out[8] = NATIVE_SNAPSHOT_FORMAT_VERSION;
  out.set(digest, 9);
  out.set(gzBody, HEADER_LEN);
  return out;
}

// ---- reader (validates magic + format version + integrity) -----------------

export function readNativeSnapshot(bytes: Uint8Array): ReadNativeSnapshotResult {
  if (bytes.length < HEADER_LEN) throw new Error("native-snapshot: file too small / not a .c64re container");
  const magic = Buffer.from(bytes.buffer, bytes.byteOffset, 8).toString("ascii");
  if (magic !== NATIVE_SNAPSHOT_MAGIC) {
    throw new Error(`native-snapshot: bad magic "${magic}" (expected ${NATIVE_SNAPSHOT_MAGIC})`);
  }
  const formatVersion = bytes[8]!;
  if (formatVersion !== NATIVE_SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `native-snapshot: incompatible format version ${formatVersion} (this build writes/reads ${NATIVE_SNAPSHOT_FORMAT_VERSION})`,
    );
  }
  const storedDigest = Buffer.from(bytes.buffer, bytes.byteOffset + 9, 32);
  const gzBody = Buffer.from(bytes.buffer, bytes.byteOffset + HEADER_LEN, bytes.length - HEADER_LEN);
  const actualDigest = createHash("sha256").update(gzBody).digest();
  if (!storedDigest.equals(actualDigest)) {
    throw new Error("native-snapshot: integrity check failed (sha256 mismatch — file corrupt or tampered)");
  }

  const doc = JSON.parse(gunzipSync(gzBody).toString("utf8")) as {
    manifest: NativeSnapshotManifest; checkpoint: unknown; mediaPayloads: Record<string, string>;
  };
  const manifest = doc.manifest;
  if (manifest?.kind !== "c64re-runtime-snapshot") {
    throw new Error(`native-snapshot: not a c64re-runtime-snapshot (kind=${manifest?.kind})`);
  }

  const snapshot: MachineSnapshot = {
    schemaVersion: manifest.version,
    payload: decodeValue(doc.checkpoint),
  };

  // resolve + integrity-check embedded media payloads
  const media = manifest.media.map((ref) => {
    if (!ref.embeddedPayloadRef) return { ref };
    const enc = doc.mediaPayloads[ref.embeddedPayloadRef];
    if (enc == null) {
      throw new Error(`native-snapshot: media payload "${ref.embeddedPayloadRef}" missing from container`);
    }
    const bytes = unb64(enc);
    const sha = sha256Hex(bytes);
    if (ref.sha256 && sha !== ref.sha256) {
      throw new Error(`native-snapshot: embedded media sha256 mismatch for ${ref.role} (corrupt payload)`);
    }
    return { ref, bytes };
  });

  return { manifest, snapshot, media };
}

/** sha256 hex of arbitrary bytes — shared with the media dirty/identity checks. */
export function snapshotSha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
