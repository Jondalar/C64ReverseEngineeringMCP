#!/usr/bin/env node
// Spec 847 — documents declare themselves. Every case able to fail.
//
// The frontmatter under test is not invented: it is what Ultima VI's A_overlay_model.md
// already writes in its first paragraph — coverage, sources, and the evidence standard
// ("the binary wins; every 'all stores to X' claim is an exhaustive opcode scan, not a
// grep"). The test uses that document's real shape.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseFrontmatter, renderFrontmatter, template, parseCoverage } = await import("../dist/docs/frontmatter.js");
const { scanDocs, lintDocs, formatDocLint, findDocsDirs } = await import("../dist/docs/scan.js");
const { registerDoc, listDocNodes, renderWikiIndex, DocRegisterError } = await import("../dist/docs/register.js");
const { critique } = await import("../dist/critic/run.js");
const { DEFAULT_TOOLS } = await import("../dist/server-tools/tier-tools.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "testgame";
function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "c64re-847-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  mkdirSync(join(dir, "docs", "model"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  return dir;
}

const REAL = `---
title: The engine's overlay / resource model
kind: synthesis
covers:
  - $0200-$437E
  - artifact:07_game.prg
sources: [07_game.asm, u6_ovl_c000_t3.prg]
method: >
  Static analysis only; where listing and binary disagree the binary wins.
  Every "all stores to X" claim is an exhaustive opcode scan, not a grep.
amends: [A_overlay_model.md]
status: current
---

# A — the overlay model

Body text.
`;

const dirs = [];
try {
  // ------------------------------------------------------------------- the parser
  {
    const p = parseFrontmatter(REAL);
    check("the real-shaped block parses", !!p.frontmatter && !p.error, p.error);
    const fm = p.frontmatter;
    check("covers carries a range AND an artifact",
      fm?.covers.length === 2 && fm.covers[0].kind === "range" && fm.covers[0].start === 0x0200
      && fm.covers[0].end === 0x437e && fm.covers[1].kind === "artifact",
      JSON.stringify(fm?.covers));
    check("the folded `method` block survives as one string",
      (fm?.method ?? "").includes("binary wins") && (fm?.method ?? "").includes("exhaustive opcode scan"),
      fm?.method?.slice(0, 60));
    check("sources and amends parse as lists",
      fm?.sources.length === 2 && fm?.amends?.[0] === "A_overlay_model.md");
    check("the body is returned without the block", p.body.startsWith("# A — the overlay model"), p.body.slice(0, 30));

    check("no block at all = absent, not malformed",
      parseFrontmatter("# Just a doc\n").absent === true);
    const bad = parseFrontmatter("---\ntitle: x\nkind: nonsense\n---\nbody\n");
    check("an unknown kind is REFUSED with the reason", !!bad.error && /kind/.test(bad.error), bad.error);
    const unclosed = parseFrontmatter("---\ntitle: x\n");
    check("an unclosed block is refused", !!unclosed.error, unclosed.error);
    const noTitle = parseFrontmatter("---\nkind: synthesis\n---\nbody\n");
    check("a missing title is refused", !!noTitle.error, noTitle.error);

    check("a trailing comment does not end up in the value",
      parseFrontmatter("---\ntitle: x\nkind: synthesis  # a note\n---\n").frontmatter?.kind === "synthesis");
    check("$XXXX alone is a one-byte range",
      JSON.stringify(parseCoverage("$d020")) === JSON.stringify({ kind: "range", start: 0xd020, end: 0xd020 }));
    check("a nonsense covers entry is rejected", parseCoverage("the loader") === undefined);

    const round = parseFrontmatter(renderFrontmatter(p.frontmatter));
    check("render -> parse round-trips", round.frontmatter?.title === fm?.title
      && round.frontmatter?.covers.length === 2 && !!round.frontmatter?.method, round.error);
    // The template's placeholders are unparseable ON PURPOSE: if `$XXXX-$YYYY` parsed, a
    // pasted-but-unedited template would silently declare a wrong range, which is a false
    // declaration and exactly what this arc exists to stop.
    const tmpl = parseFrontmatter(template("synthesis", "X"));
    check("the template refuses until its placeholders are replaced",
      !!tmpl.error && /placeholder/.test(tmpl.error), tmpl.error);
    const filled = template("synthesis", "X")
      .replace("$XXXX-$YYYY", "$0801-$0fff")
      .replace("artifact:something.prg", "artifact:loader.prg");
    check("and parses the moment they are", !!parseFrontmatter(filled).frontmatter,
      parseFrontmatter(filled).error);
  }

  // ------------------------------------------------- nested docs/ dirs are found
  {
    const d = newProject(); dirs.push(d);
    mkdirSync(join(d, "cart_EF", "docs", "engine"), { recursive: true });
    mkdirSync(join(d, "editor", "docs"), { recursive: true });
    writeFileSync(join(d, "docs", "top.md"), "# top\n");
    writeFileSync(join(d, "docs", "model", "A.md"), REAL);
    writeFileSync(join(d, "cart_EF", "docs", "engine", "deep.md"), "# deep\n");
    writeFileSync(join(d, "editor", "docs", "ed.md"), "# ed\n");
    writeFileSync(join(d, "notes-not-in-docs.md"), "# stray\n");

    const found = findDocsDirs(d);
    check("every nested docs/ directory is found", found.length === 3,
      `${found.length}: Wasteland_EF's 108 "outside docs/" files are all in nested ones`);
    const docs = scanDocs(d);
    check("markdown outside any docs/ is NOT scanned",
      docs.length === 4 && !docs.some((x) => x.path.includes("notes-not-in-docs")),
      docs.map((x) => x.path).join(", "));
    check("declared vs undeclared is separated",
      docs.filter((x) => x.declared).length === 1 && docs.filter((x) => !x.declared).length === 3);
  }

  // ------------------------------------------------------------ lint + dangling
  {
    const d = newProject(); dirs.push(d);
    writeFileSync(join(d, "docs", "model", "B.md"), REAL); // amends A_overlay_model.md — absent
    writeFileSync(join(d, "docs", "broken.md"), "---\ntitle: x\nkind: bogus\n---\n");
    writeFileSync(join(d, "docs", "plain.md"), "# no block\n");

    const r = lintDocs(d);
    check("the lint separates undeclared from malformed",
      r.undeclared.length === 1 && r.malformed.length === 1,
      `undeclared=${r.undeclared.length} malformed=${r.malformed.length}`);
    check("D5: a citation to a document that is not here is dangling",
      r.dangling.length === 1 && r.dangling[0].names[0] === "A_overlay_model.md",
      JSON.stringify(r.dangling));

    const text = formatDocLint(r);
    check("the report calls the undeclared list a BACKLOG, not a failure",
      /backlog, not a failure/.test(text),
      "no project in the corpus had frontmatter before this — a wall of errors would be routed around");

    writeFileSync(join(d, "docs", "model", "A_overlay_model.md"), REAL.replace("amends: [A_overlay_model.md]\n", ""));
    check("adding the cited document settles the dangling citation",
      lintDocs(d).dangling.length === 0);
  }

  // ------------------------------------------------- register: refuse, then accept
  {
    const d = newProject(); dirs.push(d);
    writeFileSync(join(d, "docs", "plain.md"), "# no block\n");
    let err;
    try { await registerDoc(d, "docs/plain.md"); } catch (e) { err = e; }
    check("D7 shape: registering an undeclared document REFUSES",
      err instanceof DocRegisterError, err?.message?.split("\n")[0]);
    check("and it hands back the template rather than only saying no",
      /^---$/m.test(err?.message ?? "") && /covers:/.test(err?.message ?? ""),
      "a gate that only forbids is one people route around — which is what happened to Spec 740's wiki");

    writeFileSync(join(d, "docs", "model", "A.md"), REAL);
    const reg = await registerDoc(d, "docs/model/A.md");
    check("a declared document becomes a node", reg.covers === 2 && reg.kind === "synthesis", reg.id);

    const nodes = await listDocNodes(d);
    const real = nodes.filter((n) => !n.placeholder);
    const placeholder = nodes.filter((n) => n.placeholder);
    check("D3: the document is in the GRAPH, not a second store", real.length === 1, real[0]?.id);
    check("the cited-but-absent document becomes a placeholder node, so the citation resolves",
      placeholder.length === 1 && placeholder[0].title === "A_overlay_model.md",
      placeholder[0]?.id);
    check("the evidence standard survives onto the node",
      (real[0]?.method ?? "").includes("binary wins"), real[0]?.method?.slice(0, 50));
  }

  // ------------------------------------------------------------ D6: derived index
  {
    const d = newProject(); dirs.push(d);
    let idx = await renderWikiIndex(d);
    check("an empty project's index says so instead of pretending",
      /No document declares itself yet/.test(idx));

    writeFileSync(join(d, "docs", "model", "A.md"), REAL);
    writeFileSync(join(d, "docs", "big.md"), "# undeclared and large\n" + "x".repeat(5000));
    await registerDoc(d, "docs/model/A.md");
    idx = await renderWikiIndex(d);
    check("D6: the index renders the declaration, with its coverage",
      /## synthesis/.test(idx) && /\$0200-\$437e/.test(idx) && /docs\/model\/A\.md/.test(idx),
      idx.split("\n").find((l) => l.includes("covers:")));
    check("D6: the index also names what is still undeclared",
      /## Undeclared \(1\)/.test(idx) && /big\.md/.test(idx),
      "Spec 740's index sat at 7-of-7 empty for four months; this one cannot");
  }

  // ---------------------------------------------- D4: a stale render is detectable
  {
    const d = newProject(); dirs.push(d);
    const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "one", addressRange: { start: 0x1000, end: 0x1010 } });

    // A render that claims 19 findings while the graph holds 1 — Ultima VI's defect.
    writeFileSync(join(d, "docs", "FINDINGS.md"),
      "---\ntitle: Findings\nkind: generated\nstatus: current\ngenerated:\n  at: 2026-09-09T10:00:00Z\n  findings: 19\n---\n\n# Findings\n");
    const r = await critique(d);
    const stale = r.findings.filter((f) => f.check === "stale-render");
    check("D4: the stale render is found, with both numbers",
      stale.length === 1 && /rendered 19, now 1/.test(stale[0].proof), stale[0]?.proof);
    check("the checks that ran are listed, including the two new ones",
      r.ran.includes("dangling-citation") && r.ran.includes("stale-render"), r.ran.join(","));
  }

  // -------------------------------------------------------- render_docs stamps it
  {
    const d = newProject(); dirs.push(d);
    const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
    const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
    new KnowledgeRecords(d).saveFinding({ kind: "observation", title: "x", addressRange: { start: 1, end: 2 } });
    const svc = new ProjectKnowledgeService(d);
    svc.renderDocs("findings");
    const text = readFileSync(join(d, "docs", "FINDINGS.md"), "utf8");
    const fm = parseFrontmatter(text).frontmatter;
    check("render_docs stamps its own provenance", fm?.kind === "generated" && !!fm.generated?.at,
      JSON.stringify(fm?.generated));
    check("and a fresh render is NOT reported as stale",
      (await critique(d)).findings.filter((f) => f.check === "stale-render").length === 0);
  }

  // ------------------------------- the import gets the path that was FOUND
  {
    // Spec 833 §5c made the wrapper look in the same five places as the renderer, so both
    // agree that annotations exist — and then handed the import candidate 1 anyway. With
    // the file beside the PRG rather than beside the output ASM, the listing rendered
    // every name while the graph import early-returned "0 routines". This asserts the two
    // halves resolve the SAME file.
    const src = readFileSync(new URL("../src/server-tools/analysis-workflow.ts", import.meta.url), "utf8");
    check("disasm_prg imports the annotations path it actually found",
      /annotationsPath:\s*foundAnnotationsPath \?\? annotationsPath/.test(src),
      "the renderer and the importer must not resolve different files");
  }

  // --------------------------------------------------------------- the surface
  {
    check("the document tools are on the DEFAULT surface",
      ["doc_register", "doc_lint", "doc_template", "wiki_index"].every((t) => DEFAULT_TOOLS.has(t)));
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\ndocuments declare themselves" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
