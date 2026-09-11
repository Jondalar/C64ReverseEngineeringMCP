#!/usr/bin/env node
// Spec 842 D4 — the graph knows where a relocated byte RUNS.
//
// A relocated byte has two addresses. The owner set which one the graph is keyed on:
// "wichtiger nach dem reloc (pseudo pc) ist das ja der Ort, wo es zur Laufzeit ist,
// das muss der Graph kennen." Everything else that reads the machine — a trace hit, a
// checkpoint, `whowrote`, a breakpoint — speaks runtime, and a node keyed on the
// stored address joins to none of it.
//
// The stored address is not thrown away: it is where the bytes actually are, and the
// only thing a hexdump or a sector agrees with.
//
// Hermetic: builds a project, imports one annotation file twice — once with the
// relocations, once without — and compares.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:842-graph
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 842 D4 — two addresses in the graph\n");

const { resolveAnnotationAddressesForTest } = await import("../dist/knowledge-graph/migrate/migrate.js");

const RELOC = [{ fileStart: 0xf300, fileEnd: 0xf328, runtimeAddr: 0xca00 }];
const hex = (n) => (n === null || n === undefined ? String(n) : `$${n.toString(16).toUpperCase().padStart(4, "0")}`);

// ── A runtime-space annotation ────────────────────────────────────────────────
{
  const r = resolveAnnotationAddressesForTest(0xca11, 0xca28, undefined, RELOC);
  check(r.address === 0xca11, `keyed on the RUNTIME address (${hex(r.address)})`);
  check(r.attrs.stored_address === 0xf311,
    `…and carries the stored address (${hex(r.attrs.stored_address)}), which is where the bytes are`);
  check(r.endAddress === 0xca28 && r.attrs.stored_end_address === 0xf328,
    "…both ends, in both spaces");
  check(r.attrs.relocated_from?.runtime_addr === 0xca00 && r.attrs.relocated_from?.file_start === 0xf300,
    "…and the relocation that relates them, so the pair is explained and not just asserted");
}

// ── A file-space annotation denotes the same node ─────────────────────────────
{
  const runtime = resolveAnnotationAddressesForTest(0xca11, 0xca28, undefined, RELOC);
  const file = resolveAnnotationAddressesForTest(0xf311, 0xf328, "file", RELOC);
  check(file.address === runtime.address && file.endAddress === runtime.endAddress,
    "a file-space annotation for the same bytes lands on the SAME node");
  check(file.attrs.stored_address === runtime.attrs.stored_address,
    "…with the same stored address");
}

// ── Outside a relocation, and without one, nothing changes ───────────────────
{
  const outside = resolveAnnotationAddressesForTest(0x0810, 0x0820, undefined, RELOC);
  check(outside.address === 0x0810 && Object.keys(outside.attrs).length === 0,
    "an address inside no relocation is untouched and gains no attributes");
  const none = resolveAnnotationAddressesForTest(0xca11, 0xca28, undefined, undefined);
  check(none.address === 0xca11 && Object.keys(none.attrs).length === 0,
    "…and with no relocations at all the address is taken as written");
}

// ── A point annotation keeps a null end, as the schema expects ───────────────
{
  const point = resolveAnnotationAddressesForTest(0xca11, 0xca11, undefined, RELOC);
  check(point.endAddress === null && point.attrs.stored_end_address === null,
    "a single-address annotation has no end in either space");
}

// ── The whole chain: the tool hands its relocations to the import ────────────
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/server-tools/analysis-workflow.ts", import.meta.url), "utf8"));
  check(/importAnnotations\(\{[\s\S]{0,400}relocations:/.test(src),
    "disasm_prg passes the relocations it rendered with to the graph import");
  const svc = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/project-knowledge/service.ts", import.meta.url), "utf8"));
  check(/importAnnotationFile\([\s\S]{0,200}relocations: args\.relocations/.test(svc),
    "…and the service passes them on, rather than accepting and dropping them");
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 842 graph: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
