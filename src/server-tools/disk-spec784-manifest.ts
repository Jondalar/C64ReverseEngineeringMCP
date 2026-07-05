// Spec 784 (GAP 2) — emit a Spec-784 loader manifest for the stock-DOS layer.
//
// extract_disk already imports each CBM-DOS file as a `disk-file` entity WITH its full
// sector-chain medium spans (manifest-import.ts). This module ADDS the Spec-784 manifest
// shape — the same the per-project custom-loader extractor emits — so:
//   (1) validate_extraction can diff the DOS layer against the loader-lens read-set, and
//   (2) the DOS files carry an explicit `kernal-directory` LoaderModel + `derivedBy`.
//
// The DOS layer IS a loader (the KERNAL directory + sector-linked chains) and its initial
// load routinely sets CIA / zeropage / vectors later stages depend on — so it belongs in
// the payload process, not as an untracked pre-step. This does NOT re-register the files
// (they are already entities); it writes the manifest FILE next to the extracted blobs.

import { writeFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { ExtractedDiskManifest } from "../disk-extractor.js";
import { validateManifest, type LoaderManifest } from "./loader-manifest.js";

const KERNAL_DIRECTORY_MODEL = "kernal-directory";
const CUSTOM_LUT_MODEL = "custom-lut";

/** Build a Spec-784 manifest from an extract_disk result. `projectRoot` anchors each
 *  payload's `bytesPath` (register_payloads_from_manifest resolves it relative to the
 *  project). Returns null when no file yields a registerable span. */
export function buildDiskSpec784Manifest(
  extracted: ExtractedDiskManifest,
  projectRoot: string,
): LoaderManifest | null {
  const payloads: LoaderManifest["payloads"] = [];

  for (let i = 0; i < extracted.files.length; i++) {
    const file = extracted.files[i];
    // Full traversed chain → one span per sector (exact data bytes, never start-only —
    // the Pawn 168/1329 bug). Fall back to the directory start T/S if the chain is empty.
    const spans =
      file.sectorChain && file.sectorChain.length > 0
        ? file.sectorChain.map((c) => ({ kind: "sector" as const, track: c.track, sector: c.sector, length: c.bytesUsed }))
        : file.track !== undefined && file.sector !== undefined
          ? [{ kind: "sector" as const, track: file.track, sector: file.sector, length: 254 }]
          : [];
    if (spans.length === 0) continue; // nothing registerable for this entry

    const name = (typeof file.name === "string" && file.name.trim().length > 0)
      ? file.name
      : (file.relativePath || `dos_file_${i + 1}`);

    payloads.push({
      name,
      derivedBy: file.origin === "custom" ? CUSTOM_LUT_MODEL : KERNAL_DIRECTORY_MODEL,
      loadAddress: file.loadAddress ?? null,
      format: file.type === "PRG" ? "prg" : "raw",
      contentHash: file.md5 ?? null,
      length: file.sizeBytes,
      bytesPath: relative(projectRoot, join(extracted.outputDir, file.relativePath)),
      spans,
    });
  }

  if (payloads.length === 0) return null;

  // Only the models actually referenced (a stock disk is all kernal-directory; a custom
  // extract may mix in custom-lut entries).
  const referenced = new Set(payloads.map((p) => p.derivedBy));
  const loaderModels: LoaderManifest["loaderModels"] = [];
  if (referenced.has(KERNAL_DIRECTORY_MODEL)) {
    loaderModels.push({
      id: KERNAL_DIRECTORY_MODEL,
      kind: "dos",
      indexLocation: "track 18 (BAM + directory)",
      notes: "Stock CBM-DOS directory + sector-linked files (KERNAL-loadable). Auto-emitted by extract_disk.",
    });
  }
  if (referenced.has(CUSTOM_LUT_MODEL)) {
    loaderModels.push({
      id: CUSTOM_LUT_MODEL,
      kind: "custom-lut",
      notes: "On-disk look-up-table entries surfaced by extract_disk (non-directory).",
    });
  }

  return {
    manifestVersion: 1,
    extractor: "extract_disk",
    sourceImage: basename(extracted.sourceImage),
    loaderModels,
    payloads,
  };
}

export interface DiskSpec784Result {
  path: string;
  payloadCount: number;
  modelCount: number;
}

/** Build + validate + write `manifest.spec784.json` next to the legacy manifest.
 *  Returns null when there is nothing to register; throws if the built manifest fails
 *  its own Spec-784 self-check (a bug in this builder, surfaced loudly). */
export function writeDiskSpec784Manifest(
  extracted: ExtractedDiskManifest,
  projectRoot: string,
): DiskSpec784Result | null {
  const manifest = buildDiskSpec784Manifest(extracted, projectRoot);
  if (!manifest) return null;

  const check = validateManifest(manifest);
  if (!check.ok) {
    throw new Error(`extract_disk built an invalid Spec-784 manifest:\n- ${check.errors.join("\n- ")}`);
  }

  const path = join(extracted.outputDir, "manifest.spec784.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, payloadCount: manifest.payloads.length, modelCount: manifest.loaderModels.length };
}
