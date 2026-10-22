#!/usr/bin/env node
// toPosixRelative (pipeline/src/lib/fs-utils.ts): the paths the pipeline writes
// into its manifests (CRT chips and banks, boot payloads, menu payload exports)
// are relative to their base and use "/".
//
// The paths are built with the platform's own join(), the way the pipeline
// builds them, so on Windows they carry "\" and a drive letter. A prefix strip
// of `${base}/` never matches there: the manifest kept the absolute path, and
// disasm_menu's join(workspaceRoot, file) then doubled it (ENOENT).
//
// Exit 0 = pass, 1 = fail.   npm run e2e:pipeline-posix-relative

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const MODULE_PATH = join(ROOT, "dist/pipeline/lib/fs-utils.cjs");
if (!existsSync(MODULE_PATH)) {
  console.error("dist/pipeline/lib/fs-utils.cjs missing - run `npm run build` first");
  process.exit(2);
}
const { toPosixRelative } = createRequire(import.meta.url)(MODULE_PATH);

let pass = 0;
let fail = 0;
const check = (got, want, msg) => {
  const ok = got === want;
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const root = join(testTmpDir("c64re-posix-relative-"), "project");
const analysis = join(root, "analysis");
const menuFile = join(analysis, "cart", "menu_payload_exports", "0-intro", "0-1-intro-code_$2000-$3fff.bin");

check(toPosixRelative(root, menuFile), "analysis/cart/menu_payload_exports/0-intro/0-1-intro-code_$2000-$3fff.bin",
  "a file under the base: relative, with \"/\" (menu payload export)");
check(toPosixRelative(analysis, join(analysis, "payloads", "payload_00.bin")), "payloads/payload_00.bin",
  "one level down (boot payload output_file)");
// crt.ts builds `${chipsDir}/bank_00_8000.bin` on top of a join()ed directory.
check(toPosixRelative(analysis, `${join(analysis, "extracted", "chips")}/bank_00_8000.bin`), "extracted/chips/bank_00_8000.bin",
  "mixed separators (CRT chip file)");
check(toPosixRelative(join(root, "analysis"), join(root, "analysis2", "x.bin")), join(root, "analysis2", "x.bin").replaceAll("\\", "/"),
  "a sibling that only shares the prefix string keeps its full path");
check(toPosixRelative(analysis, join(root, "other", "x.bin")), join(root, "other", "x.bin").replaceAll("\\", "/"),
  "a file outside the base keeps its full path");
check(toPosixRelative("analysis", "analysis/cart/x.bin"), "cart/x.bin",
  "relative inputs still work");

console.log(`\n${fail ? "RED" : "GREEN"}  pipeline toPosixRelative: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
