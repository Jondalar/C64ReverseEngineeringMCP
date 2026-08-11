// Spec 785 A4 — cartridge identity on the layout.
//
// A project can carry a manifest describing a DIFFERENT image than the finding
// that imported it names. Measured on a real project: `analysis/crt/manifest.json`
// described a hw 19 / 124 bank / 1017856 B cartridge while the artifact record
// that produced it pointed at the hw 86 / 128 bank / 1050688 B image. Two
// cartridges, one project, extracted to the same path — the second run
// overwrote the first, and both registrations then read as the same cartridge.
// The manifest is not wrong; its label is.
//
// So the layout persists what the image IS — hash, hardware type, bank count,
// image size — and compares it against the cartridge-image artifact the
// manifest was derived from. The comparison is cheap and definitive: the .crt
// header carries the hardware type and the name at fixed offsets, and the file
// size is on disk.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export interface CartridgeIdentitySource {
  id: string;
  path: string;
  title?: string;
  relativePath?: string;
  role?: string;
  sourceArtifactIds?: string[];
}

export interface CartridgeIdentity {
  manifestArtifactId: string;
  hardwareType?: number;
  bankCount: number;
  chipCount: number;
  romBytes: number;
  /** Image size as the manifest header records it. */
  imageSizeBytes?: number;
  imageArtifactId?: string;
  imageFileName?: string;
  /** Image size as it actually is on disk. */
  imageBytes?: number;
  imageSha256?: string;
  /** Hardware type / name read back out of the .crt header. */
  imageHardwareType?: number;
  imageName?: string;
  mismatches: string[];
}

const CRT_MAGIC = "C64 CARTRIDGE   ";

interface HashEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

// View builds run often and a cartridge image is up to a megabyte; re-hash only
// when the file itself changed.
const hashCache = new Map<string, HashEntry>();

function sha256OfFile(path: string): string | undefined {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  const cached = hashCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha256;
  try {
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    hashCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    return sha256;
  } catch {
    return undefined;
  }
}

/** Hardware type + name straight out of the .crt header (VICE CRT format:
 *  16-byte magic, BE32 header length, BE16 version, BE16 hardware type, EXROM,
 *  GAME, 6 reserved bytes, then a 32-byte NUL-padded name). */
function readCrtHeader(path: string): { hardwareType?: number; name?: string } {
  let head: Buffer;
  try {
    head = readFileSync(path).subarray(0, 0x40);
  } catch {
    return {};
  }
  if (head.length < 0x40) return {};
  if (head.subarray(0, 16).toString("latin1") !== CRT_MAGIC) return {};
  const name = head.subarray(0x20, 0x40).toString("latin1").replace(/\0+$/, "").trim();
  return { hardwareType: head.readUInt16BE(0x16), name: name || undefined };
}

export interface DeriveCartridgeIdentityArgs {
  manifestArtifact: CartridgeIdentitySource;
  /** Every artifact in the project — used to resolve the linked cartridge image
   *  and to spot several manifests registered at one path. */
  artifacts: CartridgeIdentitySource[];
  header: { hardwareType?: number; name?: string; imageSize?: number };
  chipCount: number;
  bankCount: number;
  romBytes: number;
}

export function deriveCartridgeIdentity(args: DeriveCartridgeIdentityArgs): CartridgeIdentity {
  const { manifestArtifact, artifacts, header, chipCount, bankCount, romBytes } = args;
  const identity: CartridgeIdentity = {
    manifestArtifactId: manifestArtifact.id,
    hardwareType: header.hardwareType,
    bankCount,
    chipCount,
    romBytes,
    imageSizeBytes: header.imageSize,
    mismatches: [],
  };

  // Several crt-manifests registered at ONE path: every extract after the first
  // overwrote the file, so all but the newest record describe bytes that are no
  // longer there. This is the shape that hid the double registration.
  const sharingPath = artifacts.filter(
    (candidate) =>
      candidate.role === "crt-manifest" &&
      candidate.path === manifestArtifact.path,
  );
  if (sharingPath.length > 1) {
    identity.mismatches.push(
      `${sharingPath.length} cartridge manifests are registered at the same path (${manifestArtifact.relativePath ?? manifestArtifact.path}); only the most recent extraction describes the file on disk`,
    );
  }

  const image = artifacts.find((candidate) => (manifestArtifact.sourceArtifactIds ?? []).includes(candidate.id));
  if (!image) return identity;

  identity.imageArtifactId = image.id;
  identity.imageFileName = image.title ?? image.relativePath;
  if (!existsSync(image.path)) {
    identity.mismatches.push(`linked cartridge image ${identity.imageFileName ?? image.id} is missing on disk`);
    return identity;
  }

  try {
    identity.imageBytes = statSync(image.path).size;
  } catch {
    /* size stays unknown */
  }
  identity.imageSha256 = sha256OfFile(image.path);
  const crtHeader = readCrtHeader(image.path);
  identity.imageHardwareType = crtHeader.hardwareType;
  identity.imageName = crtHeader.name;

  const label = identity.imageFileName ?? image.id;
  if (
    identity.imageSizeBytes !== undefined &&
    identity.imageBytes !== undefined &&
    identity.imageSizeBytes !== identity.imageBytes
  ) {
    identity.mismatches.push(
      `manifest describes a ${identity.imageSizeBytes} B image, but the linked cartridge image ${label} is ${identity.imageBytes} B`,
    );
  }
  if (
    identity.hardwareType !== undefined &&
    identity.imageHardwareType !== undefined &&
    identity.hardwareType !== identity.imageHardwareType
  ) {
    identity.mismatches.push(
      `manifest hardware type ${identity.hardwareType}, but ${label} declares hardware type ${identity.imageHardwareType}`,
    );
  }
  if (header.name && identity.imageName && header.name !== identity.imageName) {
    identity.mismatches.push(
      `manifest cartridge name "${header.name}", but ${label} declares "${identity.imageName}"`,
    );
  }
  return identity;
}

interface CartridgeManifestShape {
  header?: { hardwareType?: number; name?: string; imageSize?: number };
  chips?: Array<{ size?: number }>;
  banks?: Record<string, unknown>;
}

/** Same derivation, reading the manifest JSON itself — for callers (the project
 *  audit) that do not already have the parsed manifest in hand. */
export function deriveCartridgeIdentityFromManifest(
  manifestArtifact: CartridgeIdentitySource,
  artifacts: CartridgeIdentitySource[],
): CartridgeIdentity | undefined {
  let manifest: CartridgeManifestShape;
  try {
    manifest = JSON.parse(readFileSync(manifestArtifact.path, "utf8")) as CartridgeManifestShape;
  } catch {
    return undefined;
  }
  if (!manifest?.header || !Array.isArray(manifest.chips) || !manifest.banks) return undefined;
  return deriveCartridgeIdentity({
    manifestArtifact,
    artifacts,
    header: manifest.header,
    chipCount: manifest.chips.length,
    bankCount: Object.keys(manifest.banks).length,
    romBytes: manifest.chips.reduce((sum, chip) => sum + (chip.size ?? 0), 0),
  });
}
