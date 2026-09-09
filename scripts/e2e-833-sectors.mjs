#!/usr/bin/env node
// Spec 833 D4 — "a filename may not carry a verdict it cannot express".
//
// The defect: `extract_g64_sectors` named every sector file
// `t<tt>s<ss>${dataValid ? "" : ".invalid"}.bin`. `dataValid` is the DATA
// CHECKSUM, and on a custom-CRC disk it fails for EVERY real sector — The
// Pawn's 683, Impossible Mission II's 631 — so a caller who skipped `.invalid`
// skipped exactly the bytes it came for. Spec 832 then removed the one case the
// suffix could honestly have marked: a sector with no data block now yields no
// bytes and no file at all, so every file that gets written holds real bytes off
// the disk.
//
// The rule this gate pins down:
//
//   NAME    every extracted sector is `t<tt>s<ss>.bin`. No suffix, no verdict.
//           A reader already globbing that pattern GAINS the custom-CRC sectors
//           it was silently missing and loses nothing.
//   TRUTH   `dataStatus` in track-metadata.json (ok / checksum_error /
//           gcr_error / no_data_block) says what happened, and the tool's own
//           text output counts the non-`ok` ones so nobody has to open the JSON.
//   COLLISION  widening the name makes two pairs claiming the same (track,
//           sector) compete for one filename where two names used to keep them
//           apart. Decided before anything is written, never last-write-wins:
//           a pair with no bytes never competes; otherwise the best dataStatus
//           owns the name (ok > checksum_error > gcr_error); ties go to the pair
//           the ring walk met first. The loser is never written, and says so in
//           the metadata with `duplicateOf` naming the file that won.
//
// Hermetic: the track bitstream is synthesised here from the repo's own GCR
// encoder, in the shape `scripts/e2e-832-gcr.mjs` established. No project image
// is touched.
//
// Run: npm run e2e:833-sectors

import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, msg, detail = "") => {
  if (cond) pass += 1; else fail += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const NOTE = (msg) => console.log(`  NOTE  ${msg}`);

console.log("Spec 833 D4 — the sector filename carries no verdict, and one id owns one file\n");

const distGcr = join(ROOT, "dist/disk/gcr.js");
if (!existsSync(distGcr)) {
  console.error("dist/disk/gcr.js missing — run `npm run build:mcp` first");
  process.exit(2);
}

const { decodeGCRTrackDetailed } = await import(distGcr);
const { encodeGCRBytes, buildSectorHeaderRaw, buildSectorDataRaw } = await import(join(ROOT, "dist/disk/gcr-encode.js"));
const { G64Parser } = await import(join(ROOT, "dist/disk/g64-parser.js"));
const { registerDiskG64Tools } = await import(join(ROOT, "dist/server-tools/disk-g64.js"));

// ---------------------------------------------------------------- fixture ---

const TRACK = 32;
const SECTORS = 13;             // a partial track: 16 pairs still fit speed zone 0
const ID1 = 0x53, ID2 = 0x31;   // 'S','1'

const SYNC = 5, HDR_GAP = 8, TAIL_GAP = 4;

const BROKEN_DATA_CHECKSUM = 11;   // real bytes, failing CRC — one pair only
const NO_DATA_BLOCK = 12;          // block id is not $07 — no bytes, no file

// The three collision cases, one per branch of the rule.
const DUP_STATUS_OVER_POSITION = 3;  // broken copy comes FIRST, clean one second
const DUP_AGAINST_LAST_WRITE = 5;    // clean copy first, broken one LAST
const DUP_TIE_ON_ORDER = 7;          // two clean copies, different bytes

const chunks = [];
const push = (bytes) => chunks.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
const fill = (n, byte) => new Uint8Array(n).fill(byte);
const sync = () => fill(SYNC, 0xff);
const gap = (n) => fill(n, 0x55);

// Two tellable payloads per sector, so "which copy won the filename" is a
// question the bytes on disk can answer.
function payloadFor(sector) {
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) data[i] = (sector * 7 + i) & 0xff;
  return data;
}
function otherPayloadFor(sector) {
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) data[i] = (sector * 7 + i * 3 + 0x80) & 0xff;
  return data;
}
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && [...a].every((byte, i) => byte === b[i]);

function pushPair(sector, payload, { breakChecksum = false, noDataBlock = false } = {}) {
  push(sync());
  push(encodeGCRBytes(buildSectorHeaderRaw(TRACK, sector, ID1, ID2)));
  push(gap(HDR_GAP));
  push(sync());
  const raw = buildSectorDataRaw(payload);
  if (breakChecksum) raw[257] = (raw[257] ^ 0x5a) & 0xff;
  if (noDataBlock) raw[0] = 0x09;
  push(encodeGCRBytes(raw));
  push(gap(TAIL_GAP));
}

// 1. the SECOND copy of sector 3, written first on the track and carrying a
//    failed data checksum: position must not beat status.
pushPair(DUP_STATUS_OVER_POSITION, otherPayloadFor(DUP_STATUS_OVER_POSITION), { breakChecksum: true });

// 2. the track proper.
for (let sector = 0; sector < SECTORS; sector += 1) {
  pushPair(sector, payloadFor(sector), {
    breakChecksum: sector === BROKEN_DATA_CHECKSUM,
    noDataBlock: sector === NO_DATA_BLOCK,
  });
}

// 3. a failing-CRC second copy of sector 5, LAST on the track: the clean copy
//    written earlier must survive it. This is the assertion that "last write
//    wins" would fail.
pushPair(DUP_AGAINST_LAST_WRITE, otherPayloadFor(DUP_AGAINST_LAST_WRITE), { breakChecksum: true });

// 4. a second CLEAN copy of sector 7 with different bytes: same status, so the
//    tie falls to the copy the ring walk met first.
pushPair(DUP_TIE_ON_ORDER, otherPayloadFor(DUP_TIE_ON_ORDER));

// No trailing sync: the last pair's tail gap runs straight into the leading
// sync when the ring wraps. (A trailing sync followed by gap bytes gives the
// walk one all-$0F header candidate to refuse — harmless, and 832's fixture
// carries it, but this gate is about what gets WRITTEN, so the fixture stays
// free of noise it does not need.)

const trackBytes = new Uint8Array(chunks.reduce((total, c) => total + c.length, 0));
{
  let at = 0;
  for (const c of chunks) { trackBytes.set(c, at); at += c.length; }
}
const PAIRS = SECTORS + 3;
NOTE(`synthetic track ${TRACK}: ${trackBytes.length} bytes, ${SECTORS} sector ids in ${PAIRS} header/data pairs`);
ok(trackBytes.length <= 6250, "fixture fits a speed-zone-0 track", `${trackBytes.length} <= 6250`);

// ------------------------------------------------- the fixture decodes so ---

const walk = decodeGCRTrackDetailed(trackBytes);
ok(walk.sectors.length === PAIRS, `the ring walk sees all ${PAIRS} pairs, duplicates included`, `${walk.sectors.length}`);
ok(walk.rejected.length === 0, "and refuses none of them — every header here is real", `${walk.rejected.length} refused`);

const claiming = (sector) => walk.sectors.filter((s) => s.sector === sector);
ok(claiming(DUP_STATUS_OVER_POSITION).length === 2, "sector 3 is claimed twice", `${claiming(DUP_STATUS_OVER_POSITION).length}`);
ok(claiming(DUP_AGAINST_LAST_WRITE).length === 2, "sector 5 is claimed twice");
ok(claiming(DUP_TIE_ON_ORDER).length === 2, "sector 7 is claimed twice");
ok(
  claiming(DUP_STATUS_OVER_POSITION)[0]?.dataStatus === "checksum_error"
  && claiming(DUP_STATUS_OVER_POSITION)[1]?.dataStatus === "ok",
  "…and on sector 3 the BROKEN copy is the one the walk meets first",
  claiming(DUP_STATUS_OVER_POSITION).map((s) => s.dataStatus).join(","),
);
ok(
  claiming(DUP_AGAINST_LAST_WRITE)[0]?.dataStatus === "ok"
  && claiming(DUP_AGAINST_LAST_WRITE)[1]?.dataStatus === "checksum_error",
  "…and on sector 5 the broken copy is the one written LAST",
  claiming(DUP_AGAINST_LAST_WRITE).map((s) => s.dataStatus).join(","),
);

// ------------------------------------------------------- through the tool ---

const projectDir = mkdtempSync(join(tmpdir(), "c64re-833-sectors-"));
const imagePath = join(projectDir, "synthetic-833.g64");
writeFileSync(imagePath, buildG64(TRACK, trackBytes));

{
  const parser = new G64Parser(new Uint8Array(readFileSync(imagePath)));
  const roundTrip = parser.getRawTrackBytes(TRACK);
  ok(!!roundTrip && roundTrip.length === trackBytes.length, "the G64 container round-trips the crafted track", `${roundTrip?.length}`);
}

const handlers = new Map();
const server = { tool: (name, _desc, _schema, handler) => handlers.set(name, handler) };
const context = {
  projectDir: () => projectDir,
  toolsDir: () => join(ROOT, "pipeline"),
  readTextFile: (path) => readFileSync(path, "utf8"),
  cliResultToContent: (result) => ({ content: [{ type: "text", text: `${result.stdout}${result.stderr}` }] }),
  tryRegisterKnowledgeArtifacts: () => ({}),
};
registerDiskG64Tools(server, context);

const extract = handlers.get("extract_g64_sectors");
ok(typeof extract === "function", "extract_g64_sectors is registered");
const outDir = join(projectDir, "out");
mkdirSync(outDir, { recursive: true });
const response = await extract({ project_dir: projectDir, image_path: imagePath, track: TRACK, output_dir: outDir });
const text = response?.content?.[0]?.text ?? "";
ok(!/Tool Error|not a G64/i.test(text), "the tool returns a structured result", text.split("\n")[0] ?? "");

const metadata = JSON.parse(readFileSync(join(outDir, "track-metadata.json"), "utf8"));
const bins = readdirSync(outDir).filter((name) => name.endsWith(".bin")).sort();
const bytesOf = (name) => new Uint8Array(readFileSync(join(outDir, name)));

// ------------------------------------------------------------- the NAME ----

ok(
  bins.every((name) => /^t\d{2}s\d{2}\.bin$/.test(name)),
  "every written sector file is t<tt>s<ss>.bin — no suffix, no verdict in the name",
  bins.filter((name) => !/^t\d{2}s\d{2}\.bin$/.test(name)).join(",") || bins.join(","),
);
ok(!bins.some((name) => name.includes(".invalid")), "no file carries the retired .invalid marker");

// The widening claim, stated as the caller experiences it: a glob of
// t<tt>s<ss>.bin now returns the custom-CRC sector it used to skip.
const globbed = bins.filter((name) => /^t\d{2}s\d{2}\.bin$/.test(name));
const failedCrcName = `t${TRACK}s${String(BROKEN_DATA_CHECKSUM).padStart(2, "0")}.bin`;
ok(globbed.includes(failedCrcName), "a caller globbing t<tt>s<ss>.bin now GETS the failed-checksum sector", failedCrcName);
ok(sameBytes(bytesOf(failedCrcName), payloadFor(BROKEN_DATA_CHECKSUM)), "…holding the bytes that were on the disk, all 256 of them");

// ------------------------------------------------------------ the TRUTH ----

const entryFor = (sector, index = 0) => metadata.files.filter((f) => f.sector === sector)[index];
const failedCrcEntry = entryFor(BROKEN_DATA_CHECKSUM);
ok(failedCrcEntry?.dataStatus === "checksum_error", "the metadata carries the verdict the filename dropped", failedCrcEntry?.dataStatus);
ok(failedCrcEntry?.path?.endsWith(failedCrcName), "…on the entry that names the file that was written", failedCrcEntry?.path ?? "null");
ok(failedCrcEntry?.dataValid === false, "…and it is not passed off as clean");

const emptyEntry = entryFor(NO_DATA_BLOCK);
ok(
  emptyEntry?.bytes === 0 && emptyEntry?.path === null && emptyEntry?.duplicateOf === null,
  "a sector with no data block still writes no file, and is not mistaken for a duplicate (832 D4b holds)",
  `bytes=${emptyEntry?.bytes} path=${emptyEntry?.path} duplicateOf=${emptyEntry?.duplicateOf}`,
);

ok(metadata.nonOkCount === 4, "the metadata counts the non-ok sectors", `${metadata.nonOkCount}`);
ok(
  metadata.dataStatusCounts?.ok === PAIRS - 4
  && metadata.dataStatusCounts?.checksum_error === 3
  && metadata.dataStatusCounts?.gcr_error === 0
  && metadata.dataStatusCounts?.no_data_block === 1,
  "…broken down by status",
  JSON.stringify(metadata.dataStatusCounts),
);

// The tool's own output says it, so nobody has to open the JSON.
ok(
  /Sectors with non-ok data status: 4 of 16 \(checksum_error 3, gcr_error 0, no_data_block 1\)/.test(text),
  "the tool's TEXT output reports the non-ok count and its breakdown",
  text.split("\n").find((line) => line.startsWith("Sectors with non-ok")) ?? "line absent",
);

// -------------------------------------------------------- the COLLISION ----

ok(bins.length === SECTORS - 1, "one file per sector id that had bytes — 13 ids, one of them empty", `${bins.length} files`);
ok(new Set(bins).size === bins.length, "…and no id was written twice");
ok(metadata.filesWritten === bins.length, "the metadata's file count matches what is on disk", `${metadata.filesWritten}`);

const nameOf = (sector) => `t${TRACK}s${String(sector).padStart(2, "0")}.bin`;

ok(
  sameBytes(bytesOf(nameOf(DUP_STATUS_OVER_POSITION)), payloadFor(DUP_STATUS_OVER_POSITION)),
  "collision rule: the ok copy owns the name even though the checksum_error copy came first",
  "status beats position",
);
ok(
  sameBytes(bytesOf(nameOf(DUP_AGAINST_LAST_WRITE)), payloadFor(DUP_AGAINST_LAST_WRITE)),
  "collision rule: the ok copy survives a checksum_error copy written LATER — not last-write-wins",
  "status beats position, both directions",
);
ok(
  sameBytes(bytesOf(nameOf(DUP_TIE_ON_ORDER)), payloadFor(DUP_TIE_ON_ORDER)),
  "collision rule: two ok copies tie, and the one the ring walk met first keeps the name",
  "tie -> ring-walk order",
);

const losers = metadata.files.filter((f) => f.duplicateOf !== null);
ok(losers.length === 3, "every losing copy is listed in the metadata, none silently dropped", `${losers.length}`);
ok(metadata.duplicateSectorIdCount === 3, "…and counted at the top of the artifact", `${metadata.duplicateSectorIdCount}`);
ok(
  losers.every((f) => f.path === null && f.bytes > 0 && f.duplicateOf === nameOf(f.sector)),
  "a loser writes no file, keeps its byte count, and names the file that won",
  losers.map((f) => `${f.sector}->${f.duplicateOf}`).join(" "),
);
ok(
  losers.map((f) => f.sector).sort((a, b) => a - b).join(",")
    === [DUP_STATUS_OVER_POSITION, DUP_AGAINST_LAST_WRITE, DUP_TIE_ON_ORDER].sort((a, b) => a - b).join(","),
  "…and the losers are exactly the three duplicate ids",
  losers.map((f) => f.sector).join(","),
);
ok(
  losers.every((f) => {
    const winner = metadata.files.find((other) => other.path?.endsWith(f.duplicateOf));
    return !!winner && (winner.dataStatus === f.dataStatus
      ? metadata.files.indexOf(winner) < metadata.files.indexOf(f)          // tie -> earlier pair
      : winner.dataStatus === "ok");                                        // else -> better status
  }),
  "…and each winner is the better-status copy, or the earlier one when the status is equal",
);
ok(
  /Duplicate sector ids \(one file per id, best data status wins\): 3/.test(text),
  "the tool's TEXT output says a collision happened, and how it was resolved",
  text.split("\n").find((line) => line.startsWith("Duplicate sector ids")) ?? "line absent",
);
ok(
  text.includes("duplicate id, not written"),
  "…and marks the losing pair in the per-sector listing",
);

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// ------------------------------------------------------------- G64 writer ---

// Minimal single-track G64 container (mirrors src/disk/g64-builder.ts's layout)
// so the fixture stays under this script's control. Same writer as
// e2e-832-gcr.mjs.
function buildG64(track, bytes) {
  const TRACK_COUNT = 84, MAX_TRACK_SIZE = 7928;
  const headerSize = 0x0c + TRACK_COUNT * 4 * 2;
  const out = new Uint8Array(headerSize + 2 + MAX_TRACK_SIZE);
  out.set([0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31], 0); // "GCR-1541"
  out[0x08] = 0;
  out[0x09] = TRACK_COUNT;
  out[0x0a] = MAX_TRACK_SIZE & 0xff;
  out[0x0b] = (MAX_TRACK_SIZE >> 8) & 0xff;
  const slotIndex = Math.round((track - 1) * 2);
  const writePos = headerSize;
  const offsetTablePos = 0x0c + slotIndex * 4;
  out[offsetTablePos + 0] = writePos & 0xff;
  out[offsetTablePos + 1] = (writePos >> 8) & 0xff;
  out[offsetTablePos + 2] = (writePos >> 16) & 0xff;
  out[offsetTablePos + 3] = (writePos >> 24) & 0xff;
  out[0x0c + TRACK_COUNT * 4 + slotIndex * 4] = 0; // speed zone 0 (tracks 31-35)
  out[writePos + 0] = bytes.length & 0xff;
  out[writePos + 1] = (bytes.length >> 8) & 0xff;
  out.set(bytes, writePos + 2);
  out.fill(0x55, writePos + 2 + bytes.length, writePos + 2 + MAX_TRACK_SIZE);
  return out;
}
