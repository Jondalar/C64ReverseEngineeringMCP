// Spec 909 D2 — registering the cartridges a project's extracts describe.
//
// Every `crt-manifest` artifact says which image it was extracted from (sourceArtifactIds). The image is what makes a
// cartridge; the manifest says what it holds. This turns each into a `cartridge` node — the first time a lineage is
// seen it mints the token, every time after it refreshes what the node knows. Idempotent: a call that finds nothing
// new writes nothing.
//
// The files are not required. A project whose extract was made in a temp directory, or whose image has been moved,
// still HAS the artifact records, and the records are what tie a chip to its image. What the files would add (the
// hardware type from the header, the hash, the bank count) is left out and filled in the first time they are there.
//
// The importers call it before they resolve a single chip, so the cartridge a chip belongs to exists by the time its id
// is derived — whoever extracted it, whichever path brought the manifest in.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { readCartridges, registerCartridge, type RegisterCartridgeResult } from "../knowledge-graph/cartridges.js";
import type { GraphStore } from "../knowledge-graph/store.js";
import { deriveCartridgeIdentityFromManifest, readCrtHeader, sha256OfFile, type CartridgeIdentitySource } from "./cartridge-identity.js";
import type { ArtifactRecord } from "./types.js";

export interface SyncCartridgesOptions {
  /** the token the cartridge of THIS image (artifact id) takes or joins — an extract that says which cartridge it is a rebuild of */
  named?: { imageArtifactId: string; cart: string };
  /** only these manifests; default every crt-manifest */
  manifestIds?: string[];
}

const isImage = (a: Pick<ArtifactRecord, "kind" | "role">): boolean => a.role === "cartridge-image" || a.kind === "crt";

export function syncCartridges(store: GraphStore, slug: string, artifacts: ArtifactRecord[], options: SyncCartridgesOptions = {}): RegisterCartridgeResult[] {
  const out: RegisterCartridgeResult[] = [];
  const sources: CartridgeIdentitySource[] = artifacts.map((a) => ({ id: a.id, path: a.path, title: a.title, relativePath: a.relativePath, role: a.role, sourceArtifactIds: a.sourceArtifactIds }));
  for (const manifest of artifacts) {
    if (manifest.role !== "crt-manifest") continue;
    if (options.manifestIds && !options.manifestIds.includes(manifest.id)) continue;
    const image = artifacts.find((a) => (manifest.sourceArtifactIds ?? []).includes(a.id) && isImage(a));
    if (!image) continue;
    const identity = existsSync(manifest.path)
      ? deriveCartridgeIdentityFromManifest({ id: manifest.id, path: manifest.path, title: manifest.title, relativePath: manifest.relativePath, role: manifest.role, sourceArtifactIds: manifest.sourceArtifactIds }, sources)
      : undefined;
    const imageThere = existsSync(image.path);
    const sha256 = identity?.imageSha256 ?? (imageThere ? sha256OfFile(image.path) : undefined);
    const header = imageThere ? readCrtHeader(image.path) : {};
    const hardwareType = header.hardwareType ?? identity?.imageHardwareType ?? identity?.hardwareType;
    const named = options.named?.imageArtifactId === image.id ? options.named.cart : undefined;
    // nothing new → nothing written
    const known = readCartridges(store.db).find((c) => c.manifestArtifactIds.includes(manifest.id) && c.imageArtifactIds.includes(image.id));
    if (known && named === undefined
      && (sha256 === undefined || known.imageShas.includes(sha256))
      && (hardwareType === undefined || known.hardwareType === hardwareType)
      && (identity === undefined || known.bankCount === identity.bankCount)
      && known.extractDirs.includes(dirname(manifest.path))) continue;
    out.push(registerCartridge(store, slug, {
      image: { id: image.id, path: image.path, title: image.title, lineageRoot: image.lineageRoot },
      manifest: { id: manifest.id, path: manifest.path },
      ...(named !== undefined ? { cart: named } : {}),
      hardwareType,
      bankCount: identity?.bankCount,
      imageName: identity?.imageName ?? header.name,
      imageSha256: sha256,
      extractDir: dirname(manifest.path),
    }));
  }
  return out;
}
