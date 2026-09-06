#!/usr/bin/env node
// Spec 750.2 — the addressing overlay: a table described well enough to resolve its rows.
//
// The model's own test (§1.1): a description that cannot express the CBM directory is a
// format, not a model. So this gate resolves BOTH layouts — a `packed` directory-shaped
// table and a `columns` cartridge-shaped one — through the same resolver, and then
// pushes on the four semantics that cannot be read off the bytes and are silently wrong
// for every row when guessed:
//
//   deref        destination is a POINTER into the medium, not the destination
//   polarity     codec: value | flag | inverted — and `inverted` means 0 = PACKED
//   lengthBias   the stored figure was pre-biased by whoever wrote it
//   headerOffset the offset cell points PAST a codec header the loader skips
//
// Each of those is checked by asserting the WRONG reading differs from the right one —
// a test that only checks the right answer would pass against a resolver that ignores
// the flag entirely.

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dist = (p) => join(ROOT, "dist", p);
if (!existsSync(dist("project-knowledge/lut-resolver.js"))) {
  console.error("build:mcp first"); process.exit(2);
}
const { resolveLutRows, checkDescriptor, formatLutProbe } = await import(dist("project-knowledge/lut-resolver.js"));

let pass = 0; const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

// A medium as a flat map: bank → address → byte. Undefined = outside the image, which
// is what the resolver must report rather than read as zero.
const mkReader = (banks) => ({
  readByte(bank, address) {
    const b = banks[bank ?? 0];
    return b ? b[address] : undefined;
  },
});

const now = "2026-08-12T00:00:00.000Z";
const base = { id: "lut_t", name: "t", evidence: [], tags: [], createdAt: now, updatedAt: now };

// ── 1. PACKED — the CBM directory shape ──────────────────────────────────────
// Three records of 4 bytes: track, sector, then a 2-byte length. Terminated by $00.
{
  const bank0 = {};
  const recs = [[17, 1, 0x00, 0x02], [17, 4, 0x54, 0x01], [18, 9, 0xfe, 0x00], [0, 0, 0, 0]];
  recs.forEach((r, i) => r.forEach((b, k) => { bank0[0x1000 + i * 4 + k] = b; }));

  const d = {
    ...base, layout: "packed", identity: { scheme: "index" },
    recordStride: 4, terminator: 0x00, rowCount: 16,
    columns: [
      { role: "track", at: 0x1000, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
      { role: "sector", at: 0x1001, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
      { role: "length", at: 0x1002, width: 2, deref: false, lengthBias: 0, headerOffset: 0 },
    ],
  };
  ok("1a packed descriptor is structurally sound", checkDescriptor(d).length === 0, checkDescriptor(d).join("; "));
  const { rows } = resolveLutRows(d, mkReader({ 0: bank0 }));
  ok("1b terminator ends the table", rows.length === 3, `${rows.length} rows`);
  ok("1c row 0 = T17/S1, 512 bytes", rows[0].track === 17 && rows[0].sector === 1 && rows[0].length === 0x0200,
    `T${rows[0].track}/S${rows[0].sector} len=${rows[0].length}`);
  ok("1d row 2 = T18/S9, 254 bytes", rows[2].track === 18 && rows[2].sector === 9 && rows[2].length === 0x00fe);
}

// ── 2. COLUMNS — parallel arrays, row n is cell n of each ────────────────────
// This is the layout a row has NO single address under, which is the whole reason
// `layout` is part of the model.
{
  const bank0 = {};
  const put = (base_, vals) => vals.forEach((v, i) => { bank0[base_ + i] = v; });
  put(0x8100, [0, 0, 1]);            // bank
  put(0x8110, [0x02, 0x02, 0x00]);   // srce lo
  put(0x8120, [0x80, 0x88, 0x80]);   // srce hi   → $8002, $8802, $8000
  put(0x8130, [0x00, 0x08, 0x00]);   // len  lo
  put(0x8140, [0x08, 0x10, 0x20]);   // len  hi   → 2048, 4104, 8192
  put(0x8150, [0x00, 0x10, 0x00]);   // dest lo
  put(0x8160, [0x08, 0x10, 0x20]);   // dest hi   → $0800, $1010, $2000
  put(0x8170, [0x01, 0x00, 0x01]);   // codec

  const cols = (extra = {}) => [
    { role: "bank", at: 0x8100, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
    { role: "offset", atLo: 0x8110, atHi: 0x8120, width: 2, deref: false, lengthBias: 0, headerOffset: extra.headerOffset ?? 0 },
    { role: "length", atLo: 0x8130, atHi: 0x8140, width: 2, deref: false, lengthBias: extra.lengthBias ?? 0, headerOffset: 0 },
    { role: "destination", atLo: 0x8150, atHi: 0x8160, width: 2, deref: extra.deref ?? false, lengthBias: 0, headerOffset: 0 },
    { role: "codec", at: 0x8170, width: 1, polarity: extra.polarity ?? "value", deref: false, lengthBias: 0, headerOffset: 0 },
  ];
  const mk = (extra) => ({ ...base, layout: "columns", identity: { scheme: "index" }, rowCount: 3, columns: cols(extra) });

  const reader = mkReader({ 0: bank0 });
  const { rows } = resolveLutRows(mk({}), reader);
  ok("2a columns: 3 rows", rows.length === 3);
  ok("2b row 1 reads across the parallel arrays", rows[1].bank === 0 && rows[1].offset === 0x8802 && rows[1].length === 0x1008 && rows[1].destination === 0x1010,
    `bank=${rows[1].bank} off=$${rows[1].offset.toString(16)} len=${rows[1].length} dest=$${rows[1].destination.toString(16)}`);
  ok("2c row 2 takes its bank from its own column", rows[2].bank === 1);

  // ── 3. polarity — the same byte, three meanings ──────────────────────────
  const pv = resolveLutRows(mk({ polarity: "value" }), reader).rows.map((r) => r.packed);
  const pi = resolveLutRows(mk({ polarity: "inverted" }), reader).rows.map((r) => r.packed);
  ok("3a value: codec 1 = packed, 0 = raw", pv[0] === true && pv[1] === false);
  ok("3b inverted: codec 0 = PACKED, 1 = raw", pi[0] === false && pi[1] === true);
  ok("3c the two readings are opposite — a guess is wrong for every row",
    pv.every((v, i) => v !== pi[i]), `${JSON.stringify(pv)} vs ${JSON.stringify(pi)}`);
  const pf = resolveLutRows(mk({ polarity: "flag", flagBit: 0 }), reader).rows.map((r) => r.packed);
  ok("3d flag bit 0 reads the low bit", pf[0] === true && pf[1] === false);
  const noPol = { ...base, layout: "columns", identity: { scheme: "index" }, rowCount: 1,
    columns: [{ role: "codec", at: 0x8170, width: 1, deref: false, lengthBias: 0, headerOffset: 0 }] };
  ok("3e codec without polarity is refused, not defaulted",
    checkDescriptor(noPol).some((p) => /polarity/.test(p)), checkDescriptor(noPol).join("; "));

  // ── 4. deref — destination is a pointer INTO the medium ──────────────────
  bank0[0x0800] = 0x34; bank0[0x0801] = 0x12;   // word at the row-0 pointer target
  const plain = resolveLutRows(mk({}), reader).rows[0];
  const dref = resolveLutRows(mk({ deref: true }), reader).rows[0];
  ok("4a without deref the cell IS the destination", plain.destination === 0x0800 && plain.destinationVia === undefined);
  ok("4b with deref the cell is followed", dref.destination === 0x1234 && dref.destinationVia === 0x0800,
    `dest=$${dref.destination?.toString(16)} via=$${dref.destinationVia?.toString(16)}`);
  ok("4c the two disagree — reading one as the other is silently wrong", plain.destination !== dref.destination);

  // ── 5. lengthBias + headerOffset ─────────────────────────────────────────
  const biased = resolveLutRows(mk({ lengthBias: 1 }), reader).rows[0];
  ok("5a lengthBias is added back", biased.length === 0x0801, `${biased.length}`);
  const hdr = resolveLutRows(mk({ headerOffset: 2 }), reader).rows[0];
  ok("5b headerOffset moves offset to the payload start", hdr.offset === 0x8000 && hdr.offsetRaw === 0x8002,
    `start=$${hdr.offset.toString(16)} cell=$${hdr.offsetRaw.toString(16)}`);
  ok("5c both forms are reported, so a manifest match cannot silently drift",
    hdr.offset !== hdr.offsetRaw);
}

// ── 6. outside the image is REPORTED, never read as zero ─────────────────────
{
  const d = { ...base, layout: "columns", identity: { scheme: "index" }, rowCount: 2,
    columns: [{ role: "bank", at: 0x9000, width: 1, deref: false, lengthBias: 0, headerOffset: 0 }] };
  const { rows } = resolveLutRows(d, mkReader({ 0: { 0x9000: 7 } }));
  ok("6a a present cell reads", rows[0].bank === 7);
  ok("6b an absent cell is a problem, not a 0", rows[1].bank === undefined && rows[1].problems.length > 0,
    rows[1].problems.join("; "));
}

// ── 7. structural refusals ───────────────────────────────────────────────────
{
  const noEnd = { ...base, layout: "columns", identity: { scheme: "index" },
    columns: [{ role: "bank", at: 0x8000, width: 1, deref: false, lengthBias: 0, headerOffset: 0 }] };
  ok("7a a table with no end is refused", checkDescriptor(noEnd).some((p) => /rowCount|terminator/.test(p)));
  const noStride = { ...base, layout: "packed", identity: { scheme: "index" }, rowCount: 2,
    columns: [{ role: "bank", at: 0x8000, width: 1, deref: false, lengthBias: 0, headerOffset: 0 }] };
  ok("7b packed without a stride is refused", checkDescriptor(noStride).some((p) => /recordStride/.test(p)));
  const dupe = { ...base, layout: "columns", identity: { scheme: "index" }, rowCount: 1,
    columns: [
      { role: "bank", at: 0x8000, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
      { role: "bank", at: 0x8010, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
    ] };
  ok("7c a duplicated role is refused", checkDescriptor(dupe).some((p) => /duplicate/.test(p)));
}

// ── 8. the probe is readable ─────────────────────────────────────────────────
{
  const bank0 = { 0x8100: 1, 0x8110: 0x02, 0x8120: 0x80 };
  const d = { ...base, layout: "columns", identity: { scheme: "index" }, rowCount: 1,
    columns: [
      { role: "bank", at: 0x8100, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
      { role: "offset", atLo: 0x8110, atHi: 0x8120, width: 2, deref: false, lengthBias: 0, headerOffset: 2 },
    ] };
  const { rows } = resolveLutRows(d, mkReader({ 0: bank0 }));
  const probe = formatLutProbe(d, rows);
  ok("8a the probe shows bank, the payload start AND the raw cell",
    /bank 1/.test(probe) && /\$8000/.test(probe) && /cell \$8002/.test(probe), probe.trim());
}

// ── 9. END TO END, over the MCP surface ──────────────────────────────────────
// The resolver being right is half of it. The half that was MISSING for months is the
// seam: tools an agent can actually reach, a claim that persists, and a steering rule
// that asks for any of it. `loader-entry-points` sat empty not because the store was
// broken but because nobody was ever told to fill it.
{
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const projectDir = mkdtempSync(join(tmpdir(), "c64re-750-"));
  const { ProjectKnowledgeService } = await import(dist("project-knowledge/service.js"));
  new ProjectKnowledgeService(projectDir).initProject({ name: "750 gate" });

  // A tiny .crt with one CHIP packet: a columns-layout table in bank 0's window.
  const chip = Buffer.alloc(0x2000, 0xff);
  const put = (addr, vals) => vals.forEach((v, i) => { chip[addr - 0x8000 + i] = v; });
  put(0x8100, [0, 0]);          // bank
  put(0x8110, [0x02, 0x02]);    // srce lo
  put(0x8120, [0x80, 0x88]);    // srce hi  → $8002, $8802
  put(0x8130, [0x00, 0x08]);    // len lo
  put(0x8140, [0x08, 0x10]);    // len hi   → 2048, 4104
  put(0x8150, [0x00, 0x10]);    // dest lo  → pointers $0800/$1010… but deref needs
  put(0x8160, [0x80, 0x80]);    //          → $8000/$8010 inside the window
  put(0x8000, [0x00, 0x20]);    // the word AT $8000 → $2000
  put(0x8010, [0x00, 0x40]);    // the word AT $8010 → $4000
  const header = Buffer.alloc(0x40); header.write("C64 CARTRIDGE   ", 0, "ascii");
  header.writeUInt32BE(0x40, 0x10); header.writeUInt16BE(0x20, 0x14);
  const ch = Buffer.alloc(0x10); ch.write("CHIP", 0, "ascii");
  ch.writeUInt32BE(0x10 + chip.length, 4); ch.writeUInt16BE(0, 10);
  ch.writeUInt16BE(0x8000, 12); ch.writeUInt16BE(chip.length, 14);
  const crtPath = join(projectDir, "gate.crt");
  writeFileSync(crtPath, Buffer.concat([header, ch, chip]));

  const proc = spawn(process.execPath, [join(ROOT, "dist/cli.js")], {
    cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = ""; const pending = new Map(); let id = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString(); let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params, t = 60000) => new Promise((res, rej) => {
    const i = id++; const timer = setTimeout(() => { pending.delete(i); rej(new Error("timeout " + method)); }, t);
    pending.set(i, (m) => { clearTimeout(timer); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return (r.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  };

  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e750", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const col = (role, extra = {}) => ({ role, ...extra });
    const declare = (extra = {}) => call("declare_lut_descriptor", {
      name: "A2", layout: "columns", identity_scheme: "index", row_count: 2,
      medium_path: crtPath,
      columns: [
        col("bank", { at: 0x8100 }),
        col("offset", { at_lo: 0x8110, at_hi: 0x8120, width: 2, header_offset: 2 }),
        col("length", { at_lo: 0x8130, at_hi: 0x8140, width: 2 }),
        col("destination", { at_lo: 0x8150, at_hi: 0x8160, width: 2, deref: true }),
      ],
      ...extra,
    });

    const out = await declare();
    ok("9a declare_lut_descriptor writes and answers with a probe", /PROBE/.test(out) && /Table described/.test(out));
    ok("9b the probe followed the pointer", /→ \$2000 via \$8000/.test(out), out.split("\n").find((l) => /via/.test(l)) ?? out);
    ok("9c the probe shows the payload start AND the raw cell", /\$8000 \(cell \$8002\)/.test(out));

    // The structural refusal reaches the agent as a refusal, not as a stored record.
    const bad = await call("declare_lut_descriptor", {
      name: "bad", layout: "packed", identity_scheme: "index", row_count: 2,
      columns: [col("bank", { at: 0x8100 })],
    }).catch((e) => e.message);
    ok("9d a shape that cannot resolve is REFUSED", /REFUSED/.test(bad) && /recordStride/.test(bad), bad.split("\n")[0]);

    const list = await call("list_lut_descriptors", {});
    ok("9e the table is listed, the refused one is not", /A2/.test(list) && !/"bad"/.test(list), list.split("\n")[0]);

    const idMatch = out.match(/ID: (\S+)/);
    const rows = await call("resolve_lut_rows", { descriptor_id: idMatch[1], medium_path: crtPath });
    ok("9f resolve_lut_rows derives live from the descriptor", /2 row\(s\) resolved/.test(rows), rows.split("\n")[0]);

    // The claim: a payload, then the row that claims it.
    const saved = await call("save_entity", { kind: "payload", name: "asset-0" });
    // Take the id from the write, not by pattern-matching a list: an id prefix is not
    // part of any contract, and guessing one is how a green test starts lying.
    const pid = (saved.match(/^ID:\s*(\S+)/m) ?? [])[1];
    ok("9g a payload exists to be claimed", Boolean(pid), saved.split("\n").slice(0, 2).join(" | "));
    if (pid) {
      const linked = await call("link_payload_to_lut_row", { payload_id: pid, descriptor_id: idMatch[1], row_index: 0 });
      ok("9h link_payload_to_lut_row records the claim", /claimed by A2 row 0/.test(linked), linked);
      const past = await call("link_payload_to_lut_row", { payload_id: pid, descriptor_id: idMatch[1], row_index: 99 })
        .catch((e) => e.message);
      ok("9i a row past the end of the table is refused", /past the end/.test(past), past.split("\n")[0]);
    }

    // The seam that was missing: does anyone get ASKED?
    const onboard = await call("agent_onboard", {});
    ok("9j the steering block asks for the ROW, not just the payload",
      /Record the ROW/.test(onboard) && /declare_lut_descriptor/.test(onboard) && /link_payload_to_lut_row/.test(onboard));
    ok("9k it names the two semantics that cannot be guessed",
      /pointer to it/.test(onboard) && /polarity/.test(onboard));
  } catch (e) {
    ok("9 end-to-end over MCP", false, e.message);
  } finally {
    try { proc.stdin.end(); proc.kill(); } catch { /* gone */ }
  }
}

// ── 10. the VIEW: a filled store has to render somewhere ─────────────────────
// The gap 750.2 measured was not the model — it was that a filled store rendered
// nowhere, so filling it changed nothing anyone could see. Two things must reach the
// cartridge view: the CLAIM on a payload span (so a span a table points at is
// distinguishable from one somebody asserted), and the table's OWN FOOTPRINT (until
// now an index's bytes counted as unclaimed — the map called the best-understood
// region on the medium "not yet understood").
{
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { ProjectKnowledgeService } = await import(dist("project-knowledge/service.js"));

  const projectDir = mkdtempSync(join(tmpdir(), "c64re-750v-"));
  const svc = new ProjectKnowledgeService(projectDir);
  svc.initProject({ name: "750 view gate" });

  // A crt-manifest artifact is what the cartridge view builds from.
  mkdirSync(join(projectDir, "analysis"), { recursive: true });
  const manifestPath = join(projectDir, "analysis", "gate.crt.json");
  writeFileSync(manifestPath, JSON.stringify({
    header: { name: "GATE", hardwareType: 32, exrom: 0, game: 1 },
    chips: [{ bank: 0, load_address: 0x8000, size: 0x2000, file: "b0.bin" }],
    banks: { "0": { slots: ["ROML"], file: "b0.bin" } },
  }));
  const art = svc.saveArtifact({ title: "gate.crt manifest", path: manifestPath, role: "crt-manifest", kind: "manifest", scope: "analysis" });

  const lut = svc.declareLutDescriptor({
    name: "A2", layout: "columns", identity: { scheme: "index" }, rowCount: 8,
    mediumRef: art.id,
    columns: [
      { role: "bank", at: 0x8100, width: 1, deref: false, lengthBias: 0, headerOffset: 0 },
      { role: "offset", atLo: 0x8110, atHi: 0x8120, width: 2, deref: false, lengthBias: 0, headerOffset: 0 },
    ],
    evidence: [], tags: [],
  });

  const pay = svc.saveEntity({
    kind: "payload", name: "claimed-asset",
    mediumSpans: [{ kind: "slot", slot: "ROML", bank: 0, offsetInBank: 0x400, length: 256, mediumRef: art.id }],
    payloadClaimedByLutId: lut.id, payloadClaimedByRow: 3,
  });
  ok("10a the claim persisted on the payload", pay.payloadClaimedByLutId === lut.id && pay.payloadClaimedByRow === 3);

  const { view } = svc.buildCartridgeLayoutView();
  const cart = view.cartridges?.[0];
  ok("10b the cartridge view built", Boolean(cart), cart ? cart.title : "no cartridge");

  const tables = cart?.lutTables ?? [];
  ok("10c the table appears on the image it was read off", tables.length === 1 && tables[0].name === "A2",
    `${tables.length} table(s)`);
  // 2 columns, one of them split lo/hi → three spans of 8 bytes each.
  const spans = tables[0]?.spans ?? [];
  ok("10d the table's OWN footprint is drawn — a split cell is two arrays, two spans",
    spans.length === 3 && spans.every((s) => s.length === 8),
    spans.map((s) => `${s.role}@$${(s.offsetInBank + 0x8000).toString(16)}+${s.length}`).join(" "));
  ok("10e the footprint is bank-relative, not an absolute address",
    spans[0]?.offsetInBank === 0x100, `${spans[0]?.offsetInBank}`);
  ok("10f the table knows how many payloads name it", tables[0]?.claimCount === 1, `${tables[0]?.claimCount}`);

  const chunk = (cart?.payloadChunks ?? []).find((c) => c.entityId === pay.id);
  ok("10g the payload span carries its claim, resolved to the table's NAME",
    chunk?.claimedByLutId === lut.id && chunk?.claimedByRow === 3 && chunk?.claimedByLutName === "A2",
    chunk ? `${chunk.claimedByLutName}#${chunk.claimedByRow}` : "no chunk");
  ok("10h and says so in the note a human reads",
    (chunk?.notes ?? []).some((n) => /claimed by A2 row 3/.test(n)), (chunk?.notes ?? []).join(" | "));
}

// ── 11. 750.3 — the loader / mutator edges ───────────────────────────────────
// The third overlay of §2, and the only one that changes what a span MEANS rather
// than where it is. A payload something writes at runtime is not the object sitting
// on the medium: patch the medium alone and the mutation may undo you, and a
// byte-identical rebuild will not say a word about it.
{
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { ProjectKnowledgeService } = await import(dist("project-knowledge/service.js"));

  const projectDir = mkdtempSync(join(tmpdir(), "c64re-750e-"));
  const svc = new ProjectKnowledgeService(projectDir);
  svc.initProject({ name: "750.3 gate" });
  mkdirSync(join(projectDir, "analysis"), { recursive: true });
  const manifestPath = join(projectDir, "analysis", "edges.crt.json");
  writeFileSync(manifestPath, JSON.stringify({
    header: { name: "EDGES", hardwareType: 32, exrom: 0, game: 1 },
    chips: [{ bank: 0, load_address: 0x8000, size: 0x2000, file: "b0.bin" }],
    banks: { "0": { slots: ["ROML"], file: "b0.bin" } },
  }));
  const art = svc.saveArtifact({ title: "edges manifest", path: manifestPath, role: "crt-manifest", kind: "manifest", scope: "analysis" });

  const span = (off) => [{ kind: "slot", slot: "ROML", bank: 0, offsetInBank: off, length: 128, mediumRef: art.id }];
  const quiet = svc.saveEntity({ kind: "payload", name: "quiet-asset", mediumSpans: span(0x100) });
  const mutated = svc.saveEntity({ kind: "payload", name: "mutated-asset", mediumSpans: span(0x400) });
  const loader = svc.saveEntity({ kind: "routine", name: "stage2-loader" });
  const patcher = svc.saveEntity({ kind: "routine", name: "self-patcher" });

  svc.linkEntities({ kind: "loads", title: "loader loads quiet", sourceEntityId: loader.id, targetEntityId: quiet.id });
  svc.linkEntities({ kind: "loads", title: "loader loads mutated", sourceEntityId: loader.id, targetEntityId: mutated.id });
  svc.linkEntities({ kind: "writes", title: "patcher writes mutated", sourceEntityId: patcher.id, targetEntityId: mutated.id });

  const { view } = svc.buildCartridgeLayoutView();
  const chunks = view.cartridges?.[0]?.payloadChunks ?? [];
  const q = chunks.find((c) => c.entityId === quiet.id);
  const m = chunks.find((c) => c.entityId === mutated.id);

  ok("11a both payload spans reached the view", Boolean(q && m), `${chunks.length} chunk(s)`);
  ok("11b the loader edge is resolved to a NAME, not an id",
    q?.loadedBy?.[0]?.name === "stage2-loader", JSON.stringify(q?.loadedBy));
  ok("11c a payload nothing writes has no mutator", (q?.writtenBy ?? []).length === 0);
  ok("11d the mutated payload names its mutator",
    m?.writtenBy?.[0]?.name === "self-patcher", JSON.stringify(m?.writtenBy));
  ok("11e the note WARNS rather than just reporting — the medium is not the whole truth",
    (m?.notes ?? []).some((n) => /MUTATED at runtime by self-patcher/.test(n) && /patching the medium alone/.test(n)),
    (m?.notes ?? []).join(" | "));
  ok("11f both payloads are still loaded by the same loader",
    q?.loadedBy?.length === 1 && m?.loadedBy?.length === 1);

  // The distinction has to survive into the disk view too — §1: one model, two surfaces.
  // A disk image for the second surface. §1 says disk and cartridge are the SAME
  // model — an assertion worth proving rather than repeating.
  // A disk is one per disk-IMAGE artifact (kind g64/d64), never one per manifest —
  // a custom-GCR image with no CBM directory still has to appear.
  const diskPath = join(projectDir, "input", "edges.d64");
  mkdirSync(join(projectDir, "input"), { recursive: true });
  writeFileSync(diskPath, Buffer.alloc(174848));
  const diskArt = svc.saveArtifact({ title: "edges.d64", path: diskPath, role: "disk-image", kind: "d64", scope: "input" });
  const diskEntity = svc.saveEntity({
    kind: "payload", name: "disk-mutated",
    mediumSpans: [{ kind: "sector", track: 17, sector: 1, length: 254, mediumRef: diskArt.id }],
  });
  svc.linkEntities({ kind: "writes", title: "patcher writes disk payload", sourceEntityId: patcher.id, targetEntityId: diskEntity.id });
  const { view: diskView } = svc.buildDiskLayoutView();
  const entry = (diskView.disks ?? []).flatMap((d) => d.files ?? []).find((e) => e.entityId === diskEntity.id);
  ok("11g the disk view carries the same warning", 
    entry ? (entry.notes ?? []).some((n) => /MUTATED at runtime/.test(n)) : false,
    entry ? (entry.notes ?? []).join(" | ") : `no disk file entry (${(diskView.disks ?? []).flatMap((d) => d.files ?? []).length} file(s) on ${(diskView.disks ?? []).length} disk(s))`);
}

// ── 12. 750.7 — SUGGEST a shape, never a semantic ────────────────────────────
// The transcription work taken off a human, with a hard line: structure is in the
// bytes and is checkable; meaning is only in the loader code. The important assertions
// here are the REFUSALS — a detector that helpfully defaults `polarity` produces
// exactly the silent, plausible-looking wrongness the rest of this spec is built
// against, and it would do it while looking like progress.
{
  const { detectTables, detectColumnsLayout, detectPackedLayout, formatProposals, SEMANTICS_FROM_CODE } =
    await import(dist("project-knowledge/lut-detect.js"));

  // A columns-layout table: pitch 64, 16 rows. lo half arbitrary, hi half all inside
  // the cart window — the lo/hi signature.
  const cols = new Uint8Array(64 * 5).fill(0x00);
  for (let i = 0; i < 16; i++) {
    cols[0 * 64 + i] = (i * 37) & 0xff;          // srce lo — spread
    cols[1 * 64 + i] = 0x80 + (i & 0x1f);        // srce hi — inside $8000-$BFFF
    cols[2 * 64 + i] = i % 3;                    // bank — small alphabet
    cols[3 * 64 + i] = (i * 91) & 0xff;          // len lo
  }
  const colProps = detectColumnsLayout({ bytes: cols, baseAddress: 0x8000, bank: 0 });
  ok("12a a lo/hi address pair is found", colProps.length > 0, `${colProps.length} candidate(s)`);
  const best = colProps[0];
  ok("12b it reports columns layout and the row count", best?.layout === "columns" && best?.rowCount === 16,
    `${best?.layout}/${best?.rowCount}`);
  ok("12c the split column carries BOTH halves", best?.columns?.[0]?.atLo === 0x8000 && best?.columns?.[0]?.atHi === 0x8040,
    `${best?.columns?.[0]?.atLo?.toString(16)}/${best?.columns?.[0]?.atHi?.toString(16)}`);
  ok("12d it says WHY, in terms a reader can check against the bytes",
    /distinct values/.test(best?.columns?.[0]?.evidence ?? "") && /\$8000-\$BFFF/.test(best?.columns?.[0]?.evidence ?? ""),
    best?.columns?.[0]?.evidence);

  // THE REFUSALS.
  ok("12e no proposal claims a polarity", colProps.every((p) => p.columns.every((c) => !("polarity" in c))));
  ok("12f no proposal claims a deref", colProps.every((p) => p.columns.every((c) => !("deref" in c))));
  ok("12g every proposal states what it cannot know",
    colProps.every((p) => p.needsFromCode.length >= 5));
  ok("12h and names polarity and deref among them",
    SEMANTICS_FROM_CODE.some((n) => /polarity/.test(n)) && SEMANTICS_FROM_CODE.some((n) => /deref/.test(n)));
  ok("12i confidence never reaches certainty — a shape is not a reading",
    colProps.every((p) => p.confidence < 1));

  // A packed table: 4-byte records, terminated.
  const packed = new Uint8Array(4 * 12);
  for (let r = 0; r < 8; r++) {
    packed[r * 4 + 0] = 17 + (r % 2);   // track — 2 distinct
    packed[r * 4 + 1] = r;              // sector — spread
    packed[r * 4 + 2] = (r * 13) & 0xff;
    packed[r * 4 + 3] = r % 3;          // small alphabet
  }
  for (let i = 8 * 4; i < packed.length; i++) packed[i] = 0x00;
  const packProps = detectPackedLayout({ bytes: packed, baseAddress: 0x1000 });
  ok("12j a packed record stride is found", packProps.length > 0, `${packProps.length} candidate(s)`);
  const bp = packProps.find((p) => p.recordStride === 4);
  ok("12k the right stride is among the candidates", Boolean(bp), packProps.map((p) => p.recordStride).join(","));
  ok("12l the terminator ends it at 8 rows", bp?.rowCount === 8 && bp?.terminator === 0x00, `${bp?.rowCount} rows, term=${bp?.terminator}`);

  // Arbitrary data must NOT produce a confident answer.
  const noise = new Uint8Array(512);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 167 + (i >> 3) * 31) & 0xff;
  const noiseProps = detectTables({ bytes: noise, baseAddress: 0x2000 });
  ok("12m high-entropy data yields no high-confidence table",
    noiseProps.every((p) => p.confidence < 0.6), noiseProps.map((p) => p.confidence.toFixed(2)).join(","));

  // Padding must not read as a table — two runs of $FF are not an address pair.
  const pad = new Uint8Array(256).fill(0xff);
  ok("12n a padded region is not proposed as a table",
    detectColumnsLayout({ bytes: pad, baseAddress: 0x8000 }).length === 0);

  const text = formatProposals(colProps);
  ok("12o the rendering leads with what it cannot know and says nothing was written",
    /NOT INFERRED/.test(text) && /Nothing above was written/.test(text));
  ok("12p an empty result explains itself rather than saying 'none'",
    /statement about the SHAPE only/.test(formatProposals([])));
}

// ── 13. the ANCHOR — start from the code, not from the bytes ─────────────────
// The byte-shape scan does not work on real cartridge content: two real images
// answered with roughly two false candidates per 8 KB window after six tightenings,
// because every shape signal is ordinary in game data. One of them showed exactly why
// — a screen-offset table (`00 01 02 03 …`) satisfies monotone, spread and dense
// perfectly while being the opposite of an addressing table.
//
// The anchor is the instruction. `LDA $8500,X` names a column base, and the analyser
// already resolved it. These checks assert the grounding, not a hit rate.
{
  const { indexedAccesses, anchorCandidates, formatAnchored } =
    await import(dist("project-knowledge/lut-detect.js"));

  const ins = [
    // One routine walking a four-column table at a pitch of 16.
    { address: 0x1000, mnemonic: "lda", addressingMode: "abs,x", targetAddress: 0x8500 },
    { address: 0x1003, mnemonic: "lda", addressingMode: "abs,x", targetAddress: 0x8510 },
    { address: 0x1006, mnemonic: "lda", addressingMode: "abs,x", targetAddress: 0x8520 },
    { address: 0x1009, mnemonic: "sta", addressingMode: "abs,x", targetAddress: 0x8530 },
    // ...and a SID register in the same breath, which must NOT join the table.
    { address: 0x100c, mnemonic: "sta", addressingMode: "abs,x", targetAddress: 0xd400 },
    // A different routine, far away in the code — a separate group.
    { address: 0x4000, mnemonic: "lda", addressingMode: "abs,y", targetAddress: 0x9000 },
    { address: 0x4003, mnemonic: "lda", addressingMode: "abs,y", targetAddress: 0x9040 },
    { address: 0x4006, mnemonic: "lda", addressingMode: "abs,y", targetAddress: 0x9080 },
    // Not indexed — must be ignored entirely.
    { address: 0x4009, mnemonic: "lda", addressingMode: "abs", targetAddress: 0x1234 },
    { address: 0x400c, mnemonic: "lda", addressingMode: "(zp),y", targetAddress: undefined },
  ];

  const acc = indexedAccesses(ins);
  ok("13a only INDEXED absolute accesses are anchors", acc.length === 8, `${acc.length}`);
  ok("13b a plain absolute load is not one", !acc.some((a) => a.base === 0x1234));

  const cands = anchorCandidates(acc, { minColumns: 3 });
  ok("13c accesses split into groups by CODE distance, not address distance",
    cands.length === 2, `${cands.length} group(s)`);

  const withPitch = cands.filter((c) => c.pitch);
  ok("13d both groups found a regular column pitch", withPitch.length === 2,
    cands.map((c) => c.pitch ?? "-").join(","));

  const first = cands.find((c) => c.bases.includes(0x8500));
  ok("13e the four table columns are kept at their pitch",
    first?.pitch === 0x10 && first.bases.length === 4, `pitch=${first?.pitch} bases=${first?.bases.length}`);
  ok("13f the SID register does NOT join the table — it is reported separately",
    !first?.bases.includes(0xd400) && (first?.others ?? []).includes(0xd400),
    `others=${(first?.others ?? []).map((b) => b.toString(16)).join(",")}`);

  const text = formatAnchored(cands);
  ok("13g every candidate quotes the instruction that reads it",
    /lda \$8500,X/.test(text) && /\$1000/.test(text), text.split("\n").find((l) => /8500/.test(l)));
  ok("13h and says the bases came from the CODE, not from a shape",
    /an address the CODE indexes/.test(text));
  ok("13i an empty result explains what it means, not just 'none'",
    /through a pointer/.test(formatAnchored([])));
}

// ── 14. 750.4 + 750.5 — the two addressing kinds that are not a table ────────
// §1 names three kinds. 750.7's anchor covers the LUT; these cover a position baked
// into the loader's own code, and a dispatch that lets an index steer control.
{
  const { detectSectorLoads, detectDispatch, formatEntryPoints } =
    await import(dist("project-knowledge/loader-entrypoint-detect.js"));

  // A load routine at $2000, called from four sites with four DIFFERENT positions —
  // plus one site that passes the same pair twice, which must not inflate the count.
  const calls = [];
  let at = 0x1000;
  for (const [t, sec] of [[17, 1], [17, 4], [18, 9], [3, 0], [3, 0]]) {
    calls.push(
      { address: at, mnemonic: "lda", addressingMode: "imm", operandValue: t },
      { address: at + 2, mnemonic: "ldx", addressingMode: "imm", operandValue: sec },
      { address: at + 4, mnemonic: "jsr", addressingMode: "abs", targetAddress: 0x2000 },
    );
    at += 0x20;
  }
  // Ordinary parameter passing: two constants and a call, once. Must NOT survive.
  calls.push(
    { address: 0x3000, mnemonic: "lda", addressingMode: "imm", operandValue: 5 },
    { address: 0x3002, mnemonic: "ldx", addressingMode: "imm", operandValue: 2 },
    { address: 0x3004, mnemonic: "jsr", addressingMode: "abs", targetAddress: 0x9999 },
    // A COMPARE is a test, not a position being set up.
    { address: 0x3010, mnemonic: "cmp", addressingMode: "imm", operandValue: 7 },
    { address: 0x3012, mnemonic: "cpx", addressingMode: "imm", operandValue: 3 },
    { address: 0x3014, mnemonic: "jsr", addressingMode: "abs", targetAddress: 0x8888 },
  );

  const sl = detectSectorLoads(calls, { minCallSites: 3 });
  ok("14a the routine called with many DIFFERENT positions is found",
    sl.length === 1 && sl[0].address === 0x2000, sl.map((p) => p.address.toString(16)).join(","));
  ok("14b a single call with two constants is NOT a loader",
    !sl.some((p) => p.address === 0x9999));
  ok("14c a compare is not a position — `cmp #$07` is a test",
    !sl.some((p) => p.address === 0x8888));
  ok("14d the repeated pair does not inflate the distinct count",
    /4 DISTINCT/.test(sl[0]?.evidence.join(" ") ?? ""), sl[0]?.evidence[0]);
  ok("14e confidence rises with distinct positions, and stops short of certainty",
    (sl[0]?.confidence ?? 0) > 0.5 && (sl[0]?.confidence ?? 1) < 0.85, `${sl[0]?.confidence}`);

  // Dispatch: an indirect jump, and the RTS trampoline.
  const disp = detectDispatch([
    { address: 0x5000, mnemonic: "jmp", addressingMode: "ind", targetAddress: 0x0314 },
    { address: 0x6000, mnemonic: "lda", addressingMode: "abs,x", targetAddress: 0x8100 },
    { address: 0x6003, mnemonic: "pha" },
    { address: 0x6004, mnemonic: "lda", addressingMode: "abs,x", targetAddress: 0x8120 },
    { address: 0x6007, mnemonic: "pha" },
    { address: 0x6008, mnemonic: "rts" },
    { address: 0x7000, mnemonic: "lda", addressingMode: "abs,x", targetAddress: 0x9000 },
    { address: 0x7003, mnemonic: "sta", addressingMode: "abs", targetAddress: 0x0400 },
  ]);
  ok("14f an indirect jump is a dispatch point", disp.some((p) => p.address === 0x5000));
  ok("14g the RTS trampoline is recognised", disp.some((p) => p.address === 0x6000),
    disp.map((p) => p.address.toString(16)).join(","));
  ok("14h an indexed load that just stores somewhere is NOT dispatch",
    !disp.some((p) => p.address === 0x7000));
  ok("14i the trampoline points at the table pair, which is a columns-layout table",
    /8100/.test(disp.find((p) => p.address === 0x6000)?.evidence.join(" ") ?? ""));

  const txt = formatEntryPoints([...disp, ...sl]);
  ok("14j the rendering says nothing was written and names the witnesses",
    /Nothing was written/.test(txt) && /open the witnesses/.test(txt));
}

console.log(`\n${fails.length ? "RED" : "GREEN"}  750 LUT: ${pass} pass, ${fails.length} fail.`);
process.exit(fails.length ? 1 : 0);
