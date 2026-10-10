// Spec 898 D8 — the project's machine, said at the start.
//
// Nothing here infers a platform from bytes: a load address cannot tell the VIC-20 from the
// C16 ($1001 is both), and a signature names the machine whose KERNAL checks it, not the one
// the project is about. What this does is state what the project has recorded (the default
// in knowledge/project.json) and, when there is none, point at registered files that look
// foreign and name the one call that settles it.

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { cartridgeSignatureOf, CARTRIDGE_SIGNATURE_HEAD, MACHINE_NAMES, projectDefaultPlatform } from "./platform-default.js";
import type { ProjectKnowledgeService } from "./service.js";

const FOREIGN_BASIC_STARTS = [0x1001, 0x0401, 0x1201];
const SCAN_LIMIT = 400;
const hex16 = (v: number) => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;

interface Hit { path: string; what: string }

function head(path: string): Buffer | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(CARTRIDGE_SIGNATURE_HEAD);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n);
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

/** Registered PRG / raw files that look like another machine's: a foreign BASIC start or a cartridge signature. */
function foreignLooking(service: ProjectKnowledgeService): { hits: Hit[]; scanned: number } {
  const hits: Hit[] = [];
  let scanned = 0;
  let artifacts: ReturnType<ProjectKnowledgeService["listArtifacts"]> = [];
  try { artifacts = service.listArtifacts(); } catch { return { hits, scanned }; }
  for (const a of artifacts) {
    if (a.kind !== "prg" && a.kind !== "raw") continue;
    if (a.status && a.status !== "active") continue;
    if (scanned >= SCAN_LIMIT) break;
    const bytes = head(a.path);
    if (!bytes || bytes.length < 2) continue;
    scanned++;
    const sig = cartridgeSignatureOf(bytes);
    if (sig) { hits.push({ path: a.relativePath, what: `cartridge signature ${sig.name} at offset ${sig.offset} (a ${MACHINE_NAMES[sig.platform]} KERNAL checks it)` }); continue; }
    const load = bytes.readUInt16LE(0);
    if (a.kind === "prg" && FOREIGN_BASIC_STARTS.includes(load)) hits.push({ path: a.relativePath, what: `load address ${hex16(load)}, a BASIC start of the VIC-20 / C16 / Plus/4` });
  }
  return { hits, scanned };
}

/** The lines `agent_onboard` and `project_status` print for the machine. */
export function machineLines(projectRoot: string, service: ProjectKnowledgeService): string[] {
  const platform = projectDefaultPlatform(projectRoot);
  if (platform) {
    return [`Machine: ${MACHINE_NAMES[platform]} (${platform}) — the project default (project_init platform); every render and lookup uses it unless a file or a call names another.`];
  }
  const lines = [`Machine: Commodore 64 (c64) — no machine recorded for this project, so every render assumes it.`];
  const { hits } = foreignLooking(service);
  if (hits.length > 0) {
    lines.push(`  ${hits.length} registered file(s) look like another machine's, and nothing here decides that from bytes ($1001 is the unexpanded VIC-20 and the C16 alike):`);
    for (const h of hits.slice(0, 5)) lines.push(`  - ${h.path}: ${h.what}`);
    if (hits.length > 5) lines.push(`  - … ${hits.length - 5} more`);
    lines.push(`  Ask the human which machine this is. If it is not the C64, settle it once with project_init (platform: "vic20" or "plus4") on this directory — it records the default and touches nothing else.`);
  }
  return lines;
}
