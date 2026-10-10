// Spec 902 D3 — down stays down.
//
// `c64re down` writes <state dir>/hold.json first. While it exists none of the four automatic
// triggers starts anything: the MCP server's eager start, the lazy start on the first runtime tool
// call, the UI dev server, and a C64U bridge restart by a process that had used the device. An
// explicit start clears it: `c64re up`, `c64re ui`, runtime_session_start, selecting a C64U.
// A sandbox (runtime_sandbox_run) is not blocked: it is born with a budget and ends itself.

import { join } from "node:path";
import { readJson, removeFile, stateDir, writeJsonAtomic } from "./state-dir.js";

export interface Hold {
  v: 1;
  /** ISO time `down` wrote it. */
  at: string;
  /** Who: "c64re down", "runtime_down (the assistant, at the owner's request)", … */
  by: string;
}

export function holdFile(): string { return join(stateDir(), "hold.json"); }

export function readHold(): Hold | undefined {
  const h = readJson<Hold>(holdFile());
  return h && typeof h.at === "string" ? h : undefined;
}

export function writeHold(by: string): Hold {
  const h: Hold = { v: 1, at: new Date().toISOString(), by };
  writeJsonAtomic(holdFile(), h);
  return h;
}

/** Remove the hold; returns whether there was one. */
export function clearHold(): boolean {
  const had = readHold() !== undefined;
  removeFile(holdFile());
  return had;
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The sentence a runtime tool answers with while the hold stands. */
export function holdMessage(h: Hold): string {
  return `C64RE is shut down (since ${clock(h.at)}, by ${h.by}) — \`c64re up\` or runtime_session_start starts it again`;
}

/** The hold message when a hold stands, else undefined. What every automatic trigger asks first. */
export function heldMessage(): string | undefined {
  const h = readHold();
  return h ? holdMessage(h) : undefined;
}
