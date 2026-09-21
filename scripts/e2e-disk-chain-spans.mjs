// Gate: extract_disk's Spec-784 manifest spans ARE the block chain — and a chain that
// does not terminate cleanly says so.
//
// The Pawn 168/1329 bug, once more: a manifest row that claims a payload occupies ONE
// sector when it occupies 254. The existing GAP-4 coverage warning
// (chainCoverageWarning) only fires when the extracted BLOB is bigger than the declared
// spans. It is blind to the case that actually bit the Neuromancer run: the walk itself
// stops early — a link loops back, a link points at a sector the image cannot deliver,
// or the "last" sector carries a byte count no CBM last sector carries — so the blob is
// truncated in exactly the same way the spans are, coverage matches, and the manifest
// declares a one-sector payload with total confidence and total silence. The agent then
// re-walked the directory link chains by hand in Python because the tool's own manifest
// was unusable for the one thing manifests are for.
//
// Everything here is built in-process from a synthetic 35-track D64 (src/disk/d64-builder)
// whose link bytes are then patched, so the gate owns its fixtures. The real Neuromancer
// G64 sides are checked READ-ONLY when present and SKIPped when not.
//
// Run after `npm run build:mcp`.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildD64 } = await import(join(ROOT, "dist/disk/d64-builder.js"));
const { extractDiskImage } = await import(join(ROOT, "dist/disk-extractor.js"));
const { buildDiskSpec784Manifest, writeDiskSpec784Manifest } = await import(join(ROOT, "dist/server-tools/disk-spec784-manifest.js"));
const { validateManifest } = await import(join(ROOT, "dist/server-tools/loader-manifest.js"));
const { createDiskParser } = await import(join(ROOT, "dist/disk/index.js"));

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const skip = (m) => console.log(`  SKIP  ${m}`);

console.log("disk-chain-spans — the manifest span list IS the walked block chain\n");

// ── An independent chain walker ──────────────────────────────────────────────
// Deliberately NOT the repo's: it re-derives the truth from the raw D64 bytes with
// its own geometry table, the way the Neuromancer agent's Python did. If this and
// the manifest disagree, the manifest is wrong.
const SPT = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
function rawOffset(track, sector) {
  if (track < 1 || track > 35) return -1;
  if (sector < 0 || sector >= SPT(track)) return -1;
  let off = 0;
  for (let t = 1; t < track; t++) off += SPT(t) * 256;
  return off + sector * 256;
}
function walkRaw(img, startTrack, startSector) {
  const cells = [];
  const seen = new Set();
  let t = startTrack, s = startSector;
  while (t !== 0) {
    const key = `${t}/${s}`;
    if (seen.has(key)) return { cells, status: "cyclic", at: key };
    seen.add(key);
    const off = rawOffset(t, s);
    if (off < 0 || off + 256 > img.length) return { cells, status: "unreadable", at: key };
    const nt = img[off], ns = img[off + 1];
    if (nt === 0) {
      cells.push({ track: t, sector: s, length: ns > 0 ? ns - 1 : 254 });
      return { cells, status: ns > 0 ? "complete" : "malformed-terminator", at: key };
    }
    cells.push({ track: t, sector: s, length: 254 });
    t = nt; s = ns;
  }
  return { cells, status: "empty" };
}

// ── The fixture: one clean file and three broken chains ──────────────────────
const payload = (n, seed) => {
  const a = new Uint8Array(n);
  a[0] = 0x01; a[1] = 0x08; // $0801
  for (let i = 2; i < n; i++) a[i] = (seed + i) & 0xff;
  return a;
};

const FILES = [
  { name: "clean",  payload: payload(700, 0x10),  startTrack: 17, startSector: 0 }, // 3 sectors
  { name: "loop",   payload: payload(1000, 0x20), startTrack: 19, startSector: 0 }, // 4 sectors
  { name: "dead",   payload: payload(1000, 0x30), startTrack: 20, startSector: 0 }, // 4 sectors
  { name: "zeroend", payload: payload(700, 0x40), startTrack: 21, startSector: 0 }, // 3 sectors
];

const img = buildD64({ diskName: "CHAINGATE", diskId: "CG", files: FILES });

// loop: the FIRST sector links back to itself → the walk sees exactly one sector of a
// file the directory declares as 4 blocks. Start-only, and nothing says so.
{ const o = rawOffset(19, 0); img[o] = 19; img[o + 1] = 0; }
// dead: the 2nd sector links at track 40, which a 35-track image cannot deliver.
{ const o = rawOffset(20, 1); img[o] = 40; img[o + 1] = 0; }
// zeroend: the last sector's link is 00/00 — track 0 says "last", but byte 1 is the
// index of the last used byte and can never be 0 (data starts at offset 2). The real
// Neuromancer side 2 directory entries terminate exactly like this.
{ const o = rawOffset(21, 2); img[o] = 0; img[o + 1] = 0; }

const dir = mkdtempSync(join(tmpdir(), "chain-spans-"));
try {
  const imagePath = join(dir, "chaingate.d64");
  writeFileSync(imagePath, img);
  const outDir = join(dir, "analysis", "disk", "chaingate");

  const started = Date.now();
  const extracted = extractDiskImage(imagePath, outDir);
  ok(Date.now() - started < 10000, "a cyclic chain terminates the walk (no hang)", `${Date.now() - started} ms`);

  const s784 = writeDiskSpec784Manifest(extracted, dir);
  ok(!!s784, "extract_disk emits a Spec-784 manifest for the fixture");
  const onDisk = JSON.parse(readFileSync(s784.path, "utf8"));
  ok(validateManifest(onDisk).ok, "the emitted manifest validates", (validateManifest(onDisk).errors ?? []).join("; "));

  const payloadOf = (n) => onDisk.payloads.find((p) => p.name === n);
  const fileOf = (n) => extracted.files.find((f) => f.name === n);
  const spanKeys = (p) => (p?.spans ?? []).map((s) => `${s.track}/${s.sector}:${s.length}`).join(" ");
  const rawKeys = (w) => w.cells.map((c) => `${c.track}/${c.sector}:${c.length}`).join(" ");

  // ── 1. CLEAN — the control. This must be green before and after the fix. ────
  {
    const p = payloadOf("clean");
    const w = walkRaw(img, 17, 0);
    ok(w.status === "complete" && w.cells.length === 3, "fixture control: clean file walks 3 sectors", `${w.status}/${w.cells.length}`);
    ok(spanKeys(p) === rawKeys(w), "clean: manifest spans ARE the independently walked chain, in order", `${spanKeys(p)} vs ${rawKeys(w)}`);
    const cov = p.spans.reduce((a, s) => a + s.length, 0);
    ok(cov === fileOf("clean").sizeBytes, "clean: span coverage == extracted blob bytes", `${cov} vs ${fileOf("clean").sizeBytes}`);
    ok(p.chainNote === undefined, "clean: no chain diagnostic on a chain that terminated cleanly", String(p.chainNote));
  }

  // ── 2. CYCLE — the Pawn shape: 4 declared blocks, 1 span, silence. ──────────
  {
    const p = payloadOf("loop");
    const f = fileOf("loop");
    const w = walkRaw(img, 19, 0);
    ok(w.status === "cyclic", "fixture control: the loop chain is cyclic", w.status);
    ok(spanKeys(p) === rawKeys(w), "cycle: spans match the walkable prefix", `${spanKeys(p)} vs ${rawKeys(w)}`);
    ok(f.sizeSectors === 4 && p.spans.length === 1,
      "cycle: the directory declares 4 blocks and only 1 sector is reachable — a start-only row",
      `declared=${f.sizeSectors} spans=${p.spans.length}`);
    ok(typeof p.chainNote === "string" && p.chainNote.length > 0,
      "cycle: the manifest row SAYS the chain did not terminate cleanly", String(p.chainNote));
    ok(/cycl|loop/i.test(p.chainNote ?? ""), "cycle: …and names it as a cycle", String(p.chainNote));
    ok((p.chainNote ?? "").includes("19/0"), "cycle: …and names the track/sector where it closed", String(p.chainNote));
    ok(f.chainStatus === "cyclic", "cycle: manifest.json carries the same verdict per file", String(f.chainStatus));
  }

  // ── 3. UNREADABLE LINK — the walk stops mid-file, silently. ─────────────────
  {
    const p = payloadOf("dead");
    const f = fileOf("dead");
    const w = walkRaw(img, 20, 0);
    ok(w.status === "unreadable", "fixture control: the dead chain hits an unreadable sector", w.status);
    ok(spanKeys(p) === rawKeys(w), "dead link: spans match the walkable prefix", `${spanKeys(p)} vs ${rawKeys(w)}`);
    ok(typeof p.chainNote === "string" && /unread|could not be read|missing/i.test(p.chainNote ?? ""),
      "dead link: the manifest row SAYS a sector of the chain could not be read", String(p.chainNote));
    ok((p.chainNote ?? "").includes("40/0"), "dead link: …and names the track/sector it could not deliver", String(p.chainNote));
    ok(f.chainStatus === "unreadable", "dead link: manifest.json carries the same verdict per file", String(f.chainStatus));
  }

  // ── 4. MALFORMED TERMINATOR — link 00/00 is not a CBM last sector. ──────────
  {
    const p = payloadOf("zeroend");
    const f = fileOf("zeroend");
    const w = walkRaw(img, 21, 0);
    ok(w.status === "malformed-terminator", "fixture control: the zeroend chain ends on 00/00", w.status);
    ok(spanKeys(p) === rawKeys(w), "zero terminator: spans match the walked chain", `${spanKeys(p)} vs ${rawKeys(w)}`);
    ok(typeof p.chainNote === "string" && p.chainNote.length > 0,
      "zero terminator: the manifest row SAYS the last sector's byte count is not a valid terminator", String(p.chainNote));
    ok((p.chainNote ?? "").includes("21/2"), "zero terminator: …and names the sector", String(p.chainNote));
    ok(f.chainStatus === "malformed-terminator", "zero terminator: manifest.json carries the same verdict per file", String(f.chainStatus));
  }

  // ── 5. NO CHAIN AT ALL — the builder's own start-only fallback. ─────────────
  // buildDiskSpec784Manifest falls back to a single span at the directory's start T/S
  // with an invented length of 254 when it is handed a file record with no walked
  // chain. That row is a guess; it must not read as a measured extent.
  {
    const built = buildDiskSpec784Manifest({
      sourceImage: imagePath, format: "d64", diskName: "CHAINGATE", diskId: "CG",
      outputDir: outDir, manifestPath: join(outDir, "manifest.json"),
      files: [{
        index: 0, origin: "kernal", name: "nochain", type: "PRG",
        sizeSectors: 52, sizeBytes: 13000, track: 17, sector: 0,
        format: "raw", relativePath: "01_nochain.prg", sectorChain: [],
      }],
    }, dir);
    const p = built?.payloads?.[0];
    ok(p?.spans?.length === 1, "no-chain fallback: still registers one row", `${p?.spans?.length}`);
    ok(typeof p?.chainNote === "string" && p.chainNote.length > 0,
      "no-chain fallback: the row SAYS the span is the directory start only, not a walked extent", String(p?.chainNote));
  }

  // ── 6. The real Neuromancer sides, read-only. ───────────────────────────────
  const NEURO = "/Users/alex/Development/C64/Cracking/Neuromancer_Test2/input/disk";
  const side1 = join(NEURO, "neuromancer_s1[interplay_1988](alt2).g64");
  const side2 = join(NEURO, "neuromancer_s2[interplay_1988](alt2).g64");
  if (existsSync(side1)) {
    const d = join(dir, "neuro1");
    const ex = extractDiskImage(side1, join(d, "analysis", "disk", "s1"));
    const m = buildDiskSpec784Manifest(ex, d);
    // Re-walk each chain through the parser (a G64 has no flat byte offsets to walk
    // independently) and require the manifest to agree cell for cell.
    const parser = createDiskParser(new Uint8Array(readFileSync(side1)));
    let mismatched = 0, startOnly = 0;
    for (const p of m.payloads) {
      const f = ex.files.find((x) => x.name === p.name);
      const cells = [];
      const seen = new Set();
      let t = f.track, s = f.sector;
      while (t !== 0 && !seen.has(`${t}/${s}`)) {
        seen.add(`${t}/${s}`);
        const sec = parser.getSector(t, s);
        if (!sec) break;
        const nt = sec[0], ns = sec[1];
        cells.push(`${t}/${s}:${nt === 0 ? (ns > 0 ? ns - 1 : 254) : 254}`);
        if (nt === 0) break;
        t = nt; s = ns;
      }
      if (cells.join(" ") !== p.spans.map((x) => `${x.track}/${x.sector}:${x.length}`).join(" ")) mismatched++;
      if (p.spans.length === 1 && f.sizeSectors > 1) startOnly++;
    }
    ok(mismatched === 0, "Neuromancer side 1: every payload's spans are its full walked chain", `${mismatched} mismatched of ${m.payloads.length}`);
    ok(startOnly === 0, "Neuromancer side 1: no multi-block file is declared as a single sector", `${startOnly}`);
  } else {
    skip("Neuromancer side 1 (media absent)");
  }
  if (existsSync(side2)) {
    const d = join(dir, "neuro2");
    const ex = extractDiskImage(side2, join(d, "analysis", "disk", "s2"));
    const m = buildDiskSpec784Manifest(ex, d);
    // Side 2's two directory entries are GCR noise: their first sector links onward to a
    // track/sector the image cannot deliver (149/72, 210/3), so the walk ends after ONE
    // sector and the old manifest declared a clean 254-byte single-sector payload. This
    // is the real defect from the run — a start-only row, in silence.
    const bad = (m?.payloads ?? []).filter((p) => p.spans.length === 1 && p.spans[0].length === 254);
    ok(bad.length > 0, "fixture control: side 2 still yields truncated single-sector rows", `${bad.length}`);
    ok(bad.every((p) => typeof p.chainNote === "string" && p.chainNote.length > 0),
      "Neuromancer side 2: a truncated row is flagged, not presented as a clean payload",
      bad.map((p) => `${p.name}=${p.chainNote}`).join(" | "));
  } else {
    skip("Neuromancer side 2 (media absent)");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  disk-chain-spans: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
