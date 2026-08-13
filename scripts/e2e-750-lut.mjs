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
    const pid = (saved.match(/\b(ent[-_][A-Za-z0-9-]+|[a-z]+-[a-z0-9-]{6,})\b/) ?? [])[1];
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

console.log(`\n${fails.length ? "RED" : "GREEN"}  750 LUT: ${pass} pass, ${fails.length} fail.`);
process.exit(fails.length ? 1 : 0);
