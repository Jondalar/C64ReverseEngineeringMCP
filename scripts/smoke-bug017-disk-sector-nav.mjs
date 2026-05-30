// BUG-017 — raw track/sector navigation in the Disk geometry.
//  Frontend: every sector in the SVG is clickable → opens the 256-byte hex view
//  of that sector (via /api/disk/sector-bytes) + a raw-sector detail line, so
//  occupied non-directory data (orphan/drive-code/raw) is navigable.
//  Backend: /api/disk/sector-bytes returns the raw 256 bytes for a track/sector.
// This smoke proves the data path end-to-end (real D64 over the HTTP API) and
// asserts the UI wiring at the source level (no DOM runner in this repo).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-017 — disk raw track/sector navigation\n");

// ---- source-level UI wiring assertions ----
const src = readFileSync(join(ROOT, "ui/src/components/workspace-panels.tsx"), "utf8");
ok(/function inspectSector\(/.test(src), "1 DiskPanel has an inspectSector(track, sector) helper", "");
ok(/onClick=\{\(\) => inspectSector\(sector\.track, sector\.sector\)\}/.test(src), "2 every SVG sector is clickable → inspectSector", "");
ok(/sector-selected/.test(src) && /selectedSector/.test(src), "3 raw-sector selection state + highlight class", "");
ok(/\/api\/disk\/sector-bytes\?/.test(src), "4 click opens the 256-byte hex via /api/disk/sector-bytes", "");
ok(/disk-sector-detail/.test(src), "5 raw-sector detail line (track/sector/category/hint/file)", "");

// BUG-017 (track grid restore) — a clickable track strip above the geometry,
// for ALL formats (not D64-gated), with whole-track show + track highlight.
ok(/function showTrack\(/.test(src) && /onClick=\{\(\) => showTrack\(track\)\}/.test(src), "5a track strip buttons call showTrack(track)", "");
const stripBlock = src.slice(src.indexOf("disk-track-strip"), src.indexOf("disk-geometry-wrap"));
ok(!/if \(!isD64\) return null/.test(stripBlock), "5b track strip is NOT D64-gated (shows for G64 etc.)", "");
ok(/selectedTrack/.test(src) && /track-selected/.test(src), "5c selected track highlights its sectors in the geometry", "");
ok(/inspectSector\(track, firstSectorOfTrack\(track\)\)/.test(src), "5d non-D64 track click shows the track's first sector (format-agnostic)", "");

// ---- backend data-path E2E: real D64 over the HTTP API ----
const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug017-"));
mkdirSync(join(projectDir, "input", "disk"), { recursive: true });
// a blank but valid-size .d64 (35 tracks = 683 sectors * 256). getSector reads
// raw offsets, so even zero-filled data yields a 256-byte sector.
const d64 = Buffer.alloc(174848);
// D64Parser.isD64 validates the BAM at T18/S0: byte0 must be the dir track (18),
// byte1 the dir sector (0..18). Stamp a valid BAM so the image is recognized;
// byte0 (=18) doubles as the read-back marker for T18/S0.
const t18s0Offset = 357 * 256; // d64 offset of track 18 sector 0
d64[t18s0Offset] = 18;     // dir track
d64[t18s0Offset + 1] = 1;  // dir sector
writeFileSync(join(projectDir, "input", "disk", "test.d64"), d64);

const PORT = 4328;
const srv = spawn("node", [join(ROOT, "dist/workspace-ui/server.js"), "--project", projectDir, "--port", String(PORT)],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (b) => log += b); srv.stderr.on("data", (b) => log += b);
const tcpUp = (port, ms = 800) => new Promise((r) => { const s = createConnection({ host: "127.0.0.1", port }); const d = (v) => { try { s.destroy(); } catch {} r(v); }; const t = setTimeout(() => d(false), ms); s.once("connect", () => { clearTimeout(t); d(true); }); s.once("error", () => { clearTimeout(t); d(false); }); });
const waitTcp = async (port, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await tcpUp(port)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

try {
  ok(await waitTcp(PORT), "6 HTTP server up", `:${PORT}`);
  const url = (t, s) => `http://127.0.0.1:${PORT}/api/disk/sector-bytes?path=${encodeURIComponent("input/disk/test.d64")}&track=${t}&sector=${s}`;
  const r1 = await fetch(url(18, 0));
  const buf = Buffer.from(await r1.arrayBuffer());
  ok(r1.status === 200 && buf.length === 256, "7 sector-bytes returns 256 raw bytes for T18/S0", `status=${r1.status} len=${buf.length}`);
  ok(buf[0] === 18 && buf[1] === 1, "8 returned bytes are the correct sector (T18/S0 BAM marker)", `byte0=${buf[0]} byte1=${buf[1]}`);
  const r2 = await fetch(url(99, 0));
  ok(r2.status === 404, "9 out-of-range track → 404 (no silent garbage)", `status=${r2.status}`);

  console.log(`\n--- report ---`);
  console.log(`UI: clickable SVG sectors → inspectSector → /api/disk/sector-bytes hex + raw-sector detail`);
  console.log(`API: /api/disk/sector-bytes returns 256 raw bytes per track/sector`);
} catch (e) {
  ok(false, "harness", e.message + (log ? " | " + log.slice(-160) : ""));
} finally {
  try { srv.kill("SIGINT"); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { srv.kill("SIGKILL"); } catch {}
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug017: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
