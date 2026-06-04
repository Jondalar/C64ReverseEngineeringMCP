// Spec 709 §3 / 724.2e — UI drag&drop closure smoke. Static check that the
// Media tab implements a real browser drop that routes BYTES to the backend
// media/ingress service, with the right per-type kind/reset semantics, and no
// second browser-side loader / repo-samples fallback.
//
// No headless boot — asserts the wiring contract in source + that the backend
// media/ingress route exists.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 709/724.2e — UI media drag&drop closure\n");

const mediaTsx = join(ROOT, "ui/src/workbench/tabs/Media.tsx");
ok(existsSync(mediaTsx), "0 Media.tsx exists", mediaTsx);
const src = readFileSync(mediaTsx, "utf8");

// 1. a real browser drop handler (onDrop + dataTransfer.files + FileReader/arrayBuffer).
ok(/onDrop=/.test(src) && /dataTransfer\??\.files/.test(src), "1 has a browser onDrop handler reading dataTransfer.files", "");
ok(/arrayBuffer\(\)/.test(src) && /btoa\(/.test(src), "2 reads file bytes + base64-encodes them", "");

// 3. it calls the backend media/ingress service with bytes_b64 (not a second loader).
ok(/client\.call[^\n]*"media\/ingress"[\s\S]{0,200}bytes_b64/.test(src) || /"media\/ingress"[\s\S]{0,300}bytes_b64/.test(src),
  "3 drop routes bytes to backend media/ingress (bytes_b64)", "");

// 4. per-type behavior: disk→disk kind, crt→power-cycle, prg→inject-run.
ok(/d64[\s\S]{0,40}kind:\s*"disk"|"disk"[\s\S]{0,60}d64/.test(src) || /(d64|g64)[\s\S]{0,80}kind:\s*"disk"/.test(src),
  "4a .d64/.g64 → kind disk (drive 8)", "");
ok(/crt[\s\S]{0,80}kind:\s*"crt"[\s\S]{0,80}resetPolicy:\s*"power-cycle"|kind:\s*"crt",\s*resetPolicy:\s*"power-cycle"/.test(src),
  "4b .crt → kind crt + power-cycle (cold boot)", "");
ok(/prg[\s\S]{0,80}kind:\s*"prg"[\s\S]{0,60}mode:\s*"inject-run"|kind:\s*"prg",\s*mode:\s*"inject-run"/.test(src),
  "4c .prg → kind prg + inject-run (RUN)", "");

// 5. .c64re is NOT treated as media (routed to snapshot/undump).
ok(/c64re[\s\S]{0,120}snapshot|snapshot[\s\S]{0,40}\.c64re/i.test(src),
  "5 .c64re drop is rejected toward snapshot/undump, not media", "");

// 6. no second browser media loader: the file bytes are not parsed/mounted in
//    the browser; the only media action is the backend call.
const browserParse = /new\s+D64|parseD64|parseG64|parseCrt|mountInBrowser/.test(src);
ok(!browserParse, "6 no browser-side media parser/loader (backend is the authority)", browserParse ? "found" : "none");

// 7. no repo-samples fallback in the drop path.
ok(!/samples\//.test(src), "7 no repo-samples reference in the Media tab", /samples\//.test(src) ? "found" : "none");

// 8. the backend media/ingress route exists + accepts bytes_b64.
const wsSrv = readFileSync(join(ROOT, "src/workspace-ui/ws-server.ts"), "utf8");
ok(/this\.on\("media\/ingress"/.test(wsSrv) && /bytes_b64/.test(wsSrv),
  "8 backend media/ingress route exists + accepts bytes_b64", "");

console.log(`\n--- report ---`);
console.log(`Media tab drag&drop → backend media/ingress (disk→drive8, crt→cold boot, prg→load+RUN); no second loader; no repo-samples.`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} UI media drag&drop: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
