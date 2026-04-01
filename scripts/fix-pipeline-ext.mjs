/**
 * Rename all .js files in dist/pipeline/ to .cjs so Node doesn't treat them
 * as ESM (the parent package.json has "type": "module").
 * Also patches require() calls to use .cjs extensions.
 */
import { readdirSync, renameSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "dist/pipeline";

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith(".js")) {
      // Patch require("./foo") → require("./foo.cjs")
      let content = readFileSync(full, "utf8");
      content = content.replace(/require\("(\.[^"]+)"\)/g, (match, p1) => {
        if (p1.endsWith(".js") || p1.endsWith(".cjs") || p1.endsWith(".json")) return match;
        return `require("${p1}.cjs")`;
      });
      // Also patch require("./foo.js") → require("./foo.cjs")
      content = content.replace(/require\("(\.[^"]+)\.js"\)/g, 'require("$1.cjs")');
      writeFileSync(full, content, "utf8");

      // Rename .js → .cjs
      const cjsPath = full.replace(/\.js$/, ".cjs");
      renameSync(full, cjsPath);
    }
  }
}

walk(root);
console.log("Pipeline .js → .cjs conversion done.");
