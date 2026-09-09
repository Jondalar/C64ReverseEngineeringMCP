#!/usr/bin/env node
// Spec 832 D4 — "tolerant is not the same as inventing".
//
// The defect: `decodeGCRTrack` accepted a header/data pair on `header.gcrValid`
// alone — the 5-bit nibbles decode — and then emitted a sector taking
// `header.track` / `header.sector` at face value. Gap noise that happens to
// GCR-decode therefore became a sector (the Ultima VI dungeon track 32 grew an
// eighteenth sector announcing itself as track 240 / sector 240, beside the 17
// headers `scan_g64_headers` finds), and an unreadable data block was handed
// back as 256 bytes that were never on the disk.
//
// The line this gate pins down — and it is NOT "be strict":
//
//   HEADER  a sector id is an ASSERTION about where bytes live. It is minted
//           only from a real header: nibbles decode, block id $08, checksum
//           matches. Everything else is REPORTED as a refused candidate.
//   DATA    tolerance lives here and stays. A data block whose checksum fails,
//           or whose GCR is partly undecodable, is still the plaintext the
//           loader wrote — extracted, flagged. Only when there is no data block
//           at all ($07 missing) are there no bytes, because there were none.
//
// Hermetic: the track bitstream is synthesised here from the repo's own GCR
// encoder. No project image is touched.
//
// Run: npm run e2e:832-gcr

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

console.log("Spec 832 D4 — extract_g64_sectors must not invent sectors or bytes\n");

const distGcr = join(ROOT, "dist/disk/gcr.js");
if (!existsSync(distGcr)) {
  console.error("dist/disk/gcr.js missing — run `npm run build:mcp` first");
  process.exit(2);
}

const { decodeGCRTrackDetailed, inspectGCRTrack, scanSectorHeadersLikeVice } = await import(distGcr);
const { encodeGCRBytes, buildSectorHeaderRaw, buildSectorDataRaw } = await import(join(ROOT, "dist/disk/gcr-encode.js"));
const { G64Parser } = await import(join(ROOT, "dist/disk/g64-parser.js"));
const { registerDiskG64Tools } = await import(join(ROOT, "dist/server-tools/disk-g64.js"));

// ---------------------------------------------------------------- fixture ---

const TRACK = 32;          // a real 17-sector track, and the one that reported
const SECTORS = 17;
const ID1 = 0x53, ID2 = 0x31;   // 'S','1'

const SYNC = 5, HDR_GAP = 8, TAIL_GAP = 4;

const chunks = [];
const push = (bytes) => chunks.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
const fill = (n, byte) => new Uint8Array(n).fill(byte);
const sync = () => fill(SYNC, 0xff);
const gap = (n) => fill(n, 0x55);

function payloadFor(sector) {
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) data[i] = (sector * 7 + i) & 0xff;
  return data;
}

// The sectors this track really carries.
const BROKEN_DATA_CHECKSUM = 14;   // real bytes, wrong CRC  -> must stay extractable
const NO_DATA_BLOCK = 15;          // block id is not $07     -> must yield NO bytes

for (let sector = 0; sector < SECTORS; sector += 1) {
  push(sync());
  push(encodeGCRBytes(buildSectorHeaderRaw(TRACK, sector, ID1, ID2)));
  push(gap(HDR_GAP));
  push(sync());
  const raw = buildSectorDataRaw(payloadFor(sector));
  if (sector === BROKEN_DATA_CHECKSUM) raw[257] = (raw[257] ^ 0x5a) & 0xff;  // custom / failing CRC
  if (sector === NO_DATA_BLOCK) raw[0] = 0x09;                               // no data block here
  push(encodeGCRBytes(raw));
  push(gap(TAIL_GAP));
}

// Gap noise that GCR-decodes cleanly but is not a header: block id $13
// announcing track 240 / sector 240 — the exact shape the reporter saw.
push(sync());
push(encodeGCRBytes(Uint8Array.from([0x13, 0x00, 0xf0, 0xf0, ID2, ID1, 0x0f, 0x0f])));
push(gap(TAIL_GAP));
push(sync());
push(gap(20));

// A real header block ($08) whose CHECKSUM is wrong. The firmware-style scanner
// counts it (it searches on the block id); the ring walk must refuse to mint a
// sector from it. That disagreement is what part (c) makes visible.
const badChecksumHeader = buildSectorHeaderRaw(TRACK, 3, ID1, ID2);
badChecksumHeader[1] = (badChecksumHeader[1] ^ 0x3c) & 0xff;
push(sync());
push(encodeGCRBytes(badChecksumHeader));
push(gap(TAIL_GAP));
push(sync());
push(gap(20));

const trackBytes = new Uint8Array(chunks.reduce((total, c) => total + c.length, 0));
{
  let at = 0;
  for (const c of chunks) { trackBytes.set(c, at); at += c.length; }
}
NOTE(`synthetic track 32: ${trackBytes.length} bytes, ${SECTORS} real sectors + 2 crafted non-sector pairs`);
ok(trackBytes.length <= 6250, "fixture fits a speed-zone-0 track", `${trackBytes.length} <= 6250`);

// ------------------------------------------------------- decoder behaviour ---

const inspected = inspectGCRTrack(trackBytes);
const oldRuleCount = inspected.pairs.filter((pair) => pair.header.gcrValid).length;
const walk = decodeGCRTrackDetailed(trackBytes);
const viceHeaders = scanSectorHeadersLikeVice(trackBytes);

NOTE(`before (accept on header.gcrValid): ${oldRuleCount} sectors — after (accept on a real header): ${walk.sectors.length}`);

ok(oldRuleCount > SECTORS, "the old rule really did over-count on this track", `old=${oldRuleCount}`);
ok(walk.sectors.length === SECTORS, "17 good headers plus noise decode to 17 sectors, not 18", `got ${walk.sectors.length}`);

const phantom = walk.sectors.find((s) => s.track === 240 || s.sector === 240);
ok(!phantom, "no sector is minted from gap noise", phantom ? `${phantom.track}/${phantom.sector}` : "none");

const notAHeader = walk.rejected.filter((r) => r.reason === "not_a_header");
ok(notAHeader.length === 1, "the noise pair is REPORTED as a refused header candidate", `${notAHeader.length} refused`);
ok(
  notAHeader[0]?.header.track === 240 && notAHeader[0]?.header.sector === 240 && notAHeader[0]?.header.headerId === 0x13,
  "the refusal carries what the noise claimed, so a human can see it",
  notAHeader[0] ? `id=$${notAHeader[0].header.headerId.toString(16)} claims ${notAHeader[0].header.track}/${notAHeader[0].header.sector}` : "missing",
);

const badHeaderChk = walk.rejected.filter((r) => r.reason === "header_checksum_error");
ok(badHeaderChk.length === 1, "a failed HEADER checksum produces no extracted sector", `${badHeaderChk.length} refused`);
ok(
  !walk.sectors.some((s) => s.sector === 3 && s.dataStatus === "no_data_block") && walk.sectors.filter((s) => s.sector === 3).length === 1,
  "the bad-checksum header does not become a duplicate of the real sector 3",
);

// (b) — an unreadable data block yields NO bytes, and the entry says why.
const noBlock = walk.sectors.find((s) => s.sector === NO_DATA_BLOCK);
ok(!!noBlock, "a sector whose data block is absent is still listed (its header was real)");
ok(noBlock?.data.length === 0, "an unreadable data block produces no bytes, not 256 zeroes", `${noBlock?.data.length} bytes`);
ok(noBlock?.dataStatus === "no_data_block", "the entry says WHY it is empty", noBlock?.dataStatus);

// (a)'s counterweight — the tolerant workbench must still read a custom CRC.
const badCrc = walk.sectors.find((s) => s.sector === BROKEN_DATA_CHECKSUM);
ok(badCrc?.data.length === 256, "a sector whose DATA checksum fails is still extracted", `${badCrc?.data.length} bytes`);
ok(badCrc?.dataValid === false && badCrc?.dataStatus === "checksum_error", "…and it is flagged, not silently passed off as clean", badCrc?.dataStatus);
{
  const expected = payloadFor(BROKEN_DATA_CHECKSUM);
  const identical = badCrc && badCrc.data.length === 256 && expected.every((byte, i) => byte === badCrc.data[i]);
  ok(identical, "…and the bytes handed back are the bytes that were on the disk");
}

const goodOnes = walk.sectors.filter((s) => s.dataStatus === "ok");
ok(goodOnes.length === SECTORS - 2, "the untouched sectors decode clean", `${goodOnes.length} of ${SECTORS - 2}`);

// (c) — the two readers, and their disagreement.
ok(viceHeaders.length === SECTORS + 1, "the firmware-style scanner counts the bad-checksum header too", `${viceHeaders.length}`);
ok(walk.viceHeaderCount === viceHeaders.length, "the walk carries the other reader's count", `${walk.viceHeaderCount}`);

// ------------------------------------------------------- through the tool ---

const projectDir = mkdtempSync(join(tmpdir(), "c64re-832-gcr-"));
const imagePath = join(projectDir, "synthetic-832.g64");
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

const metadataPath = join(outDir, "track-metadata.json");
ok(existsSync(metadataPath), "track-metadata.json is written");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));

ok(metadata.decodedCount === SECTORS, "the metadata's sector count is 17, not 18", `${metadata.decodedCount}`);
ok(
  metadata.readers?.gcrRingWalk?.sectorsDecoded === SECTORS,
  "the metadata records the GCR ring walk's count",
  `${metadata.readers?.gcrRingWalk?.sectorsDecoded}`,
);
ok(
  metadata.readers?.viceStyleScanner?.headersFound === SECTORS + 1,
  "the metadata records the firmware-style scanner's count beside it",
  `${metadata.readers?.viceStyleScanner?.headersFound}`,
);
ok(metadata.readers?.agree === false, "…so the two readers disagreeing is visible in the artifact, not only in a human's memory");
ok(
  Array.isArray(metadata.rejectedHeaders) && metadata.rejectedHeaders.length === 2,
  "the refused header candidates are named in the artifact",
  `${metadata.rejectedHeaders?.length}`,
);

const emptyEntry = metadata.files.find((f) => f.sector === NO_DATA_BLOCK);
ok(emptyEntry?.bytes === 0 && emptyEntry?.path === null, "no .bin is written for a sector that had no data block", `bytes=${emptyEntry?.bytes}`);
ok(emptyEntry?.dataStatus === "no_data_block", "the metadata entry says why", emptyEntry?.dataStatus);

const flaggedEntry = metadata.files.find((f) => f.sector === BROKEN_DATA_CHECKSUM);
ok(flaggedEntry?.bytes === 256 && flaggedEntry?.dataStatus === "checksum_error", "the custom-CRC sector is written and flagged", `${flaggedEntry?.bytes} bytes / ${flaggedEntry?.dataStatus}`);

const bins = readdirSync(outDir).filter((name) => name.endsWith(".bin"));
ok(bins.length === SECTORS - 1, "one .bin per sector that actually had bytes", `${bins.length} files`);
// Spec 833 D4 retired the `.invalid` suffix: the DATA CHECKSUM is not a
// property a filename can express (on a custom-CRC disk it fails for every real
// sector), so the flag lives in track-metadata.json — asserted just above — and
// the file is plain `t<tt>s<ss>.bin`. e2e:833-sectors owns that rule now.
ok(
  bins.includes(`t${TRACK}s${String(BROKEN_DATA_CHECKSUM).padStart(2, "0")}.bin`),
  "the failing-CRC sector is written under the plain name, its verdict in the metadata (833 D4)",
  bins.filter((n) => n.includes(`s${BROKEN_DATA_CHECKSUM}`)).join(","),
);
ok(!bins.some((name) => /t240|s240/.test(name)), "no phantom sector file was written");
ok(bins.every((name) => readFileSync(join(outDir, name)).length === 256), "every written sector file is 256 real bytes");

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// ------------------------------------------------------------- G64 writer ---

// Minimal single-track G64 container (mirrors src/disk/g64-builder.ts's layout)
// so the fixture stays under this script's control.
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
