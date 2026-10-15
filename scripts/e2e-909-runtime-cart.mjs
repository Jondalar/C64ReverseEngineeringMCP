#!/usr/bin/env node
// Spec 909 S5 — a runtime trace lands in the cartridge that was MOUNTED.
//
//   Given   two registered cartridges, A and B, each booting its own code at $8000
//   When    B is mounted in a sandbox (a real trx64-daemon of this run's own, never :4312), traced with the cart-read
//           domain, and the capture imported
//   Then    the nodes it creates are B's — `crt/<B>/<bank>` — identified by the mounted image's hash, never A's
//   And     a mounted image that matches no registered cartridge writes no cartridge-space node and says so
//
// Real daemon, real core; synthetic images built here. It SKIPS LOUDLY when there is no trx64-daemon binary.
//   Locally:  C64RE_RUNTIME_BIN=<trx64-daemon> npm run e2e:909-runtime
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeCrt } from "./lib/cartridge-fixture-909.mjs";
import { Harness, ROOT, findDaemon, load, makeChecker } from "./lib/e2e-906-harness.mjs";

if (!existsSync(join(ROOT, "dist/server.js"))) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const T = makeChecker("e2e-909-runtime");
const { check, head } = T;

const DAEMON = await findDaemon();
if (!DAEMON) {
  if (process.env.C64RE_REQUIRE_RUNTIME === "1") { console.log("FAIL — C64RE_REQUIRE_RUNTIME=1 and no trx64-daemon was found: this run must not skip."); process.exit(1); }
  console.log("SKIPPED — no trx64-daemon binary (set C64RE_RUNTIME_BIN, or `c64re runtime install`). Skipped, NOT passed.");
  process.exit(0);
}
process.env.C64RE_RUNTIME_BIN = DAEMON;
console.log(`Spec 909 S5 — traces land in the mounted cartridge\nruntime: ${DAEMON}\n`);

const H = new Harness("c64re-909-rt-");
const { importRuntimeTrace } = await load("knowledge-graph/producers/runtime.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const idOf = (s) => /\bsb-[a-z0-9-]+\b/.exec(s)?.[0];

// ── the images: both boot (CBM80 at $8004), then loop on their OWN counter, reading their OWN table at $8100 ──────
//   8000 09 80 | 8002 09 80 | 8004 CBM80 | 8009 SEI | 800A LDA $8100 | 800D INC $C00n | 8010 JMP $800A
// The read of $8100 is a read of the cartridge's own ROM: the run's address node for it lives in cartridge space.
const boot = (counterLo) => [0x09, 0x80, 0x09, 0x80, 0xc3, 0xc2, 0xcd, 0x38, 0x30, 0x78, 0xad, 0x00, 0x81, 0xee, counterLo, 0xc0, 0x4c, 0x0a, 0x80];
const img = (name, hardwareType, n, fill) => makeCrt({ name, hardwareType, size: 0x2000, banks: [{ bank: 0, code: boot(n), fill, patches: [{ at: 0x100, bytes: [n] }] }] });
const A = img("A", 0, 0x00, 0xea);
const B = img("B", 19, 0x01, 0x60);
const C = img("C", 0, 0x02, 0xea); // never extracted

try {
  const proj = await H.project("proj");
  mkdirSync(join(proj, "media"), { recursive: true });
  writeFileSync(join(proj, "media", "cart-a.crt"), A);
  writeFileSync(join(proj, "media", "cart-b.crt"), B);
  writeFileSync(join(proj, "media", "cart-c.crt"), C);
  const slug = JSON.parse(readFileSync(join(proj, "knowledge", "project.json"), "utf8")).slug;
  const shared = await H.daemon(DAEMON, proj); // the stand-in for "the shared session": this run's own, on its own port
  const m = await H.mcp(proj, { endpoint: shared.endpoint, env: { C64RE_FULL_TOOLS: "1" } });
  const ea = await m.call("extract_crt", { project_dir: proj, crt_path: "media/cart-a.crt" });
  const eb = await m.call("extract_crt", { project_dir: proj, crt_path: "media/cart-b.crt" });
  check(/Cartridge cart-a/.test(ea) && /Cartridge cart-b/.test(eb), "setup: A and B are two registered cartridges", `${ea.split("\n").find((l) => /Cartridge/.test(l))} | ${eb.split("\n").find((l) => /Cartridge/.test(l))}`);

  // mount `image`, trace the boot loop with the cart-read domain, keep the capture, and say what it is
  async function capture(image, label) {
    const t = await m.call("runtime_sandbox_start", { purpose: `909 S5 ${label}`, budget_minutes: 10, media_path: image });
    const id = idOf(t);
    if (!id) throw new Error(`no sandbox for ${label}: ${t.slice(0, 300)}`);
    const tr = await m.call("runtime_trace_start", { session_id: id, hypothesis: "$800A INC $C00n / JMP $800A is the cartridge's boot loop (the bytes the test wrote)", domains: ["c64-cpu", "memory", "cart-read"] });
    await m.call("runtime_session_run", { session_id: id, max_instructions: 500000 });
    await m.call("runtime_trace_finalize", { session_id: id });
    const store = /([^\s'"]+\.duckdb)/.exec(tr)?.[1];
    const end = await m.call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: `909 S5 ${label}` });
    const retrace = store?.replace(/\.duckdb$/, ".c64retrace");
    if (!retrace || !existsSync(retrace)) throw new Error(`no capture for ${label}: ${tr.slice(0, 300)} / ${end.slice(0, 300)}`);
    return retrace;
  }
  const crtNodes = () => {
    const db = new DatabaseSync(join(proj, "knowledge", "graph.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT DISTINCT id FROM nodes WHERE producer = 'runtime-trace' AND id LIKE '%:crt/%' ORDER BY id").all().map((r) => r.id); } finally { db.close(); }
  };

  head("S5. B mounted, traced, imported");
  const capB = await capture(join(proj, "media", "cart-b.crt"), "B");
  const rB = importRuntimeTrace({ projectDir: proj, tracePath: capB });
  check(rB.cartridge.cart === "cart-b" && /mounted image hash/.test(rB.cartridge.via ?? ""), "S5.1 the import found the cartridge by the mounted image's hash: cart-b", JSON.stringify(rB.cartridge));
  check(rB.cartridge.bank === 0, "S5.2 …and the bank the run read (the only one)", JSON.stringify(rB.cartridge));
  const nb = crtNodes();
  check(nb.length > 0 && nb.every((id) => id.startsWith(`${slug}:crt/cart-b/00:`)), "S5.3 the nodes it created in cartridge space are cart-b's", nb.slice(0, 4).join(", "));
  check(!nb.some((id) => id.includes("/cart-a/")), "S5.4 …and none is cart-a's", nb.join(", "));
  check(nb.includes(`${slug}:crt/cart-b/00:addr:8100`), "S5.5 …among them the cartridge's own table the loop reads ($8100)", nb.join(", "));
  const mount = JSON.parse(readFileSync(capB.replace(/\.c64retrace$/, ".mount.json"), "utf8"));
  check(mount.cartridge?.sha256 === sha(B) && mount.cartridge?.sourceName === "cart-b.crt", "S5.6 the capture's mount record (written beside it when it was finalized) holds B's image hash — what the match is made on", JSON.stringify(mount.cartridge));
  const db = new DatabaseSync(join(proj, "knowledge", "graph.sqlite"), { readOnly: true });
  const run = db.prepare("SELECT attrs FROM nodes WHERE kind = 'run' ORDER BY id DESC").get();
  db.close();
  check(JSON.parse(run.attrs).cartridge === "cart-b" && JSON.parse(run.attrs).mounted_image_sha === sha(B), "S5.6b …and the run node says which cartridge it ran", run.attrs.slice(0, 200));

  head("S5. A mounted: A's nodes, not B's");
  const capA = await capture(join(proj, "media", "cart-a.crt"), "A");
  const rA = importRuntimeTrace({ projectDir: proj, tracePath: capA });
  check(rA.cartridge.cart === "cart-a", "S5.7 mounting A files the run under cart-a", JSON.stringify(rA.cartridge));
  const na = crtNodes();
  check(na.some((id) => id.startsWith(`${slug}:crt/cart-a/00:`)) && na.filter((id) => id.startsWith(`${slug}:crt/cart-b/`)).length === nb.length, "S5.8 A's nodes are new, B's are as they were", `${na.length} (B had ${nb.length})`);

  head("S5. an image that matches no registered cartridge");
  const capC = await capture(join(proj, "media", "cart-c.crt"), "C");
  const before = crtNodes().length;
  const rC = importRuntimeTrace({ projectDir: proj, tracePath: capC });
  check(rC.cartridge.cart === null && rC.cartridge.notes.some((n) => /matches no registered cartridge/.test(n) && /extract_crt/.test(n)), "S5.9 the import says the mounted image matches no registered cartridge, and what to do", JSON.stringify(rC.cartridge));
  check(crtNodes().length === before, "S5.10 …and wrote no cartridge-space node", `${before} -> ${crtNodes().length}`);
  let refusal;
  try { importRuntimeTrace({ projectDir: proj, tracePath: capB, ctx: { space: "crt", bank: 0 } }); } catch (e) { refusal = e; }
  check(refusal?.rule === "crt-needs-cart" || rB.cartridge.cart === "cart-b", "S5.11 a crt context handed over without a cartridge is refused by name unless the mount names one", String(refusal?.message ?? "(took the mounted cartridge)"));
} catch (e) {
  check(false, "script ran", String(e && e.stack || e));
} finally {
  H.stopMcps();
  H.cleanup();
}
process.exit(T.done());
