#!/usr/bin/env node
// A real extract_disk leaves a project with 0 unregistered files, and a registered
// document answers a document demand by its title. Synthetic disk, no game bytes.
//
// Exit 0 = pass, 1 = fail.   npm run smoke:s6-extract-and-docs
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Harness, load, loopPrg, makeChecker } from "./lib/e2e-906-harness.mjs";
import { d64WithPrg } from "./lib/d64-fixture.mjs";

const C = makeChecker("extract + documents");
const H = new Harness("s6-extract-docs-");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

try {
  C.head("1. extract_disk leaves nothing unregistered");
  const { ProjectKnowledgeService } = await load("project-knowledge/service.js");
  const dir = join(H.dir, "s6");
  mkdirSync(dir, { recursive: true });
  new ProjectKnowledgeService(dir).initProject({ name: "s6", preferredAssembler: "kickass" });
  mkdirSync(join(dir, "input"), { recursive: true });
  const image = join(dir, "input", "T.d64");
  writeFileSync(image, d64WithPrg("LOOP", loopPrg()));
  const mcp = await H.mcp(dir);
  const out = await mcp.call("extract_disk", { image_path: image });
  const files = walk(dir);
  C.check(files.some((f) => f.endsWith("_rebuild_check.prg")), "the pipeline wrote a rebuild-check PRG", out.slice(-700));
  C.check(files.some((f) => f.endsWith("_disasm.sym")), "the pipeline wrote a symbol file");
  const { scanRegistrationDelta } = await load("lib/registration-delta.js");
  const d = scanRegistrationDelta(dir, 10);
  C.check(!d.unregistered.some((f) => /_rebuild_check\.prg$|_disasm\.sym$/.test(f)), "right after extract_disk the rebuild by-products are not unregistered debt", d.unregistered.join(", "));
  const arts = new ProjectKnowledgeService(dir).listArtifacts();
  C.check(!arts.some((a) => /_rebuild_check\.prg$/.test(a.relativePath) && !a.internal), "no rebuild-check PRG is a non-internal artifact");
  const sync = await mcp.call("project_inventory_sync", {});
  C.check(!/rebuild_check|_disasm\.sym/.test(sync), "inventory_sync does not suggest the rebuild by-products", sync.slice(0, 600));
  C.check(scanRegistrationDelta(dir, 10).unregisteredCount === 0, "after the sync: 0 unregistered files", scanRegistrationDelta(dir, 10).unregistered.join(", "));
  C.check(!new ProjectKnowledgeService(dir).listArtifacts().some((a) => /_rebuild_check\.prg$/.test(a.relativePath)), "…and no rebuild-check PRG was registered by the sync");

  C.head("2. a document answers a demand by its title");
  const { resolveDocumentDemand, demandSatisfiedBy, documentDemandBlocker } = await load("contract/documents.js");
  const demand = resolveDocumentDemand("loader and boot chain", { boundaries: [], artifacts: [] });
  const doc = (title, file = "docs/x.md", covers = []) => ({ covers, title, file });
  C.check(demandSatisfiedBy(demand, [doc("Loader and boot chain", "docs/x.md", [{ kind: "range", start: 0x326, end: 0x476 }])]), "title equal (case-insensitive) meets the demand");
  C.check(!demandSatisfiedBy(demand, [doc("Loader and boot chain, extended")]), "a title that merely extends it does not");
  C.check(!demandSatisfiedBy(demand, [doc("The loader")]), "a different title does not");
  C.check(demandSatisfiedBy(demand, [doc("x", "docs/loader-and-boot-chain.md")]), "the file name slug meets it too");
  C.check(/title/.test(documentDemandBlocker(demand)), "the refusal says a title answers", documentDemandBlocker(demand));

  C.head("3. the same, through the contract");
  const { saveContract } = await load("contract/contract.js");
  const { contractPromises } = await load("contract/promises.js");
  const cdir = join(H.dir, "s6doc");
  mkdirSync(join(cdir, "docs"), { recursive: true });
  new ProjectKnowledgeService(cdir).initProject({ name: "s6doc", preferredAssembler: "kickass" });
  saveContract(cdir, { goal: "port the loader and its boot chain", deliver: { slots: ["context"], documents: [{ covers: "loader and boot chain" }] } });
  const owed = async () => (await contractPromises(cdir)).find((p) => p.id === "document:loader and boot chain");
  const before = await owed();
  C.check(before !== undefined && /titled exactly "loader and boot chain"/.test(before.blocker), "no document: owed, and the refusal says how a document answers", before?.blocker);
  writeFileSync(join(cdir, "docs", "boot.md"), ["---", "title: Loader and boot chain", "kind: reference", "covers:", "  - $0326-$0476", "status: current", "---", "", "Body.", ""].join("\n"));
  C.check(await owed() === undefined, "a document titled 'Loader and boot chain' meets the demand with no boundary of that name");
} finally {
  H.stopMcps();
  H.cleanup();
}
process.exit(C.done());
