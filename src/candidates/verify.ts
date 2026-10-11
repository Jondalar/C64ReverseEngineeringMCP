// Does the built image hold the chosen variant's bytes? Read the image the project's build
// produced (a PRG with its load address, a cartridge image bank by bank, or raw bytes from an
// address you name) and compare, target by target. Green names each target; red names the first
// address that differs or is missing.

import { readFileSync } from "node:fs";
import { crtReader } from "../project-knowledge/lut-medium.js";
import type { BuildCheck, Variant } from "./store.js";

export type ImageFormat = "prg" | "crt" | "raw";

export function detectFormat(path: string, bytes: Buffer, forced?: ImageFormat): ImageFormat {
  if (forced) return forced;
  if (bytes.length >= 16 && bytes.subarray(0, 16).toString("ascii") === "C64 CARTRIDGE   ") return "crt";
  if (/\.prg$/iu.test(path)) return "prg";
  return "raw";
}

/** Reads one byte of the image at a target address; undefined when the image does not cover it. */
type ByteAt = (space: string, bank: number | undefined, addr: number) => { byte?: number; why?: string };

function prgReader(bytes: Buffer): ByteAt {
  const load = bytes.length >= 2 ? bytes[0]! | (bytes[1]! << 8) : 0;
  const end = load + Math.max(0, bytes.length - 2);
  return (space, _bank, addr) => {
    if (space !== "ram") return { why: `a PRG image holds RAM only; this target is ${space}` };
    const off = addr - load + 2;
    if (off < 2 || off >= bytes.length) return { why: `the PRG covers $${load.toString(16).padStart(4, "0")}-$${Math.max(load, end - 1).toString(16).padStart(4, "0")}; this address is outside it` };
    return { byte: bytes[off]! };
  };
}

function rawReader(bytes: Buffer, base: number): ByteAt {
  return (space, _bank, addr) => {
    if (space !== "ram") return { why: `a raw image holds RAM only; this target is ${space}` };
    const off = addr - base;
    if (off < 0 || off >= bytes.length) return { why: `the raw image covers $${base.toString(16).padStart(4, "0")}-$${(base + bytes.length - 1).toString(16).padStart(4, "0")}; this address is outside it` };
    return { byte: bytes[off]! };
  };
}

export function compareImage(opts: {
  variant: Variant;
  imagePath: string;
  format?: ImageFormat;
  rawLoadAddress?: number;
  buildRan: boolean;
}): BuildCheck {
  const raw = readFileSync(opts.imagePath);
  const format = detectFormat(opts.imagePath, raw, opts.format);
  let at: ByteAt;
  if (format === "prg") at = prgReader(raw);
  else if (format === "raw") {
    if (opts.rawLoadAddress === undefined) throw new Error(`${opts.imagePath} is read as raw bytes, which need an address to start from — pass raw_load_address (or name the image as a .prg / .crt)`);
    at = rawReader(raw, opts.rawLoadAddress);
  } else {
    const { reader } = crtReader(opts.imagePath);
    at = (space, bank, addr) => {
      if (space === "ram") return { why: "this target is RAM; a cartridge image holds ROM banks" };
      const b = reader.readByte(bank ?? 0, addr);
      return b === undefined ? { why: `bank ${bank ?? 0} has no chip covering $${addr.toString(16).padStart(4, "0")}` } : { byte: b };
    };
  }
  const check: BuildCheck = { ok: true, checkedAt: new Date().toISOString(), image: opts.imagePath, format, buildRan: opts.buildRan, targets: [] };
  for (const t of opts.variant.targets) {
    let ok = true;
    for (let i = 0; i < t.bytes.length; i++) {
      const addr = (t.addr + i) & 0xffff;
      const got = at(t.space, t.bank, addr);
      if (got.byte === t.bytes[i]) continue;
      ok = false;
      if (!check.firstDiff) {
        check.firstDiff = { addr, space: t.space, bank: t.bank, built: got.byte, expected: t.bytes[i]!, reason: got.byte === undefined ? got.why ?? "not in the image" : "the built byte differs" };
      }
      break;
    }
    check.targets.push({ space: t.space, bank: t.bank, addr: t.addr, length: t.bytes.length, ok });
    if (!ok) check.ok = false;
  }
  return check;
}

const h2 = (n: number) => `$${n.toString(16).padStart(2, "0")}`;
const h4 = (n: number) => `$${n.toString(16).padStart(4, "0")}`;

export function renderCheck(candId: string, variant: string, c: BuildCheck): string {
  const where = (t: { space: string; bank?: number; addr: number }) => (t.space === "ram" ? `ram ${h4(t.addr)}` : `${t.space} bank ${t.bank ?? 0} ${h4(t.addr)}`);
  const lines: string[] = [];
  if (c.ok) {
    lines.push(`GREEN — the built image (${c.image}, ${c.format}${c.buildRan ? ", built just now" : ", not rebuilt"}) contains variant "${variant}" of ${candId} at every target:`);
    for (const t of c.targets) lines.push(`  ${where(t)}  ${t.length} byte(s)  ok`);
  } else {
    const f = c.firstDiff!;
    lines.push(`RED — the built image (${c.image}, ${c.format}${c.buildRan ? ", built just now" : ", not rebuilt"}) does NOT contain variant "${variant}" of ${candId}.`);
    lines.push(`First differing address: ${f.space === "ram" ? "" : `${f.space} bank ${f.bank ?? 0} `}${h4(f.addr)} — ${f.built === undefined ? `${f.reason}` : `built ${h2(f.built)}, the variant has ${h2(f.expected)}`}${f.built === undefined ? ` (the variant has ${h2(f.expected)})` : ""}`);
    for (const t of c.targets) lines.push(`  ${where(t)}  ${t.length} byte(s)  ${t.ok ? "ok" : "DIFFERS"}`);
  }
  return lines.join("\n");
}
