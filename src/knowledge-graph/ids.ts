// Spec 818 D1 — the id grammar. Nothing assigns an id; every id is derived from
// what the row is, and the store asserts deriveId(columns) === id on write, so
// there is no second key to drift.
//
//   platform-id   = platform ":" pkind ":" addr           c64:io:d018   c64:rom:ffd2   c64:zp:0031
//   project-id    = slug ":" ctx ":" kind ":" addr        wasteland:ram/block2_engine_0200:routine:1dd2
//   subsystem-id  = slug ":sub:" name                     wasteland:sub:disk-loader        (Spec 822)
//   ctx           = "ram" [ "/" owner ] | "crt/" bank | "drv" [ "/" owner ]
//
// pkind is Spec 817's four kinds (zp | ram | io | rom) — 818's first draft had
// reg/rom/mem; zp and io are hardware distinctions the renderer keys on.

import { formatAddr4, platformKindForAddress, type PlatformNodeKind, type PlatformTag } from "../platform-kb/schema.js";

export type Space = "ram" | "crt" | "drv";
export type ProjectKind = "routine" | "label" | "addr";

export interface Ctx {
  space: Space;
  owner?: string;
  bank?: number;
}

export interface ProjectIdParts {
  slug: string;
  ctx: Ctx;
  kind: ProjectKind | string;
  address: number;
}

export type ParsedId =
  | { form: "platform"; platform: PlatformTag; kind: PlatformNodeKind; address: number }
  | { form: "project"; slug: string; ctx: Ctx; kind: string; address: number }
  | { form: "subsystem"; slug: string; name: string };

const PLATFORMS: ReadonlySet<string> = new Set(["c64", "c1541"]);
const PKINDS: ReadonlySet<string> = new Set(["zp", "ram", "io", "rom"]);
const OWNER = /^[a-z0-9_.\-]+$/u;
const SLUG = /^[a-z0-9][a-z0-9\-]*$/u;
const ADDR = /^[0-9a-f]{4}$/u;
const BANK = /^[0-9a-f]{2,4}$/u;

export class IdRuleError extends Error {
  constructor(readonly rule: string, detail: string) {
    super(`${rule}: ${detail}`);
    this.name = "IdRuleError";
  }
}

export function ctxToken(ctx: Ctx): string {
  switch (ctx.space) {
    case "crt": {
      if (ctx.bank === undefined) throw new IdRuleError("crt-needs-bank", "a cartridge context always carries its bank");
      if (ctx.owner !== undefined) throw new IdRuleError("crt-no-owner", "a cartridge context is identified by bank, not owner");
      return `crt/${ctx.bank.toString(16).padStart(2, "0")}`;
    }
    case "ram":
    case "drv": {
      if (ctx.bank !== undefined) throw new IdRuleError(`${ctx.space}-no-bank`, "only crt contexts carry a bank");
      if (ctx.owner === undefined) return ctx.space;
      if (!OWNER.test(ctx.owner)) throw new IdRuleError("owner-charset", `owner "${ctx.owner}" must be lowercase [a-z0-9_.-]`);
      return `${ctx.space}/${ctx.owner}`;
    }
    default:
      throw new IdRuleError("space", `unknown space "${String((ctx as Ctx).space)}"`);
  }
}

export function parseCtx(token: string): Ctx {
  const m = token.match(/^(ram|crt|drv)(?:\/(.+))?$/u);
  if (!m) throw new IdRuleError("ctx", `"${token}" is not ram[/owner] | crt/bank | drv[/owner]`);
  const space = m[1] as Space;
  const rest = m[2];
  if (space === "crt") {
    if (!rest || !BANK.test(rest)) throw new IdRuleError("crt-needs-bank", `"${token}" needs a 2–4 hex digit bank`);
    return { space, bank: parseInt(rest, 16) };
  }
  if (rest !== undefined && !OWNER.test(rest)) throw new IdRuleError("owner-charset", `owner "${rest}" must be lowercase [a-z0-9_.-]`);
  return rest === undefined ? { space } : { space, owner: rest };
}

export function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new IdRuleError("slug", `"${slug}" is not a lowercase slug`);
  if (PLATFORMS.has(slug)) throw new IdRuleError("slug-is-platform", `"${slug}" is a platform tag and cannot be a project slug`);
}

export function assertAddress(address: number): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new IdRuleError("addr", `${String(address)} is not a 16-bit address`);
  }
}

/** Project node id. Refuses what the grammar refuses, naming the rule. */
export function deriveProjectId(parts: ProjectIdParts): string {
  assertSlug(parts.slug);
  assertAddress(parts.address);
  const ctx = parts.ctx;
  const needsOwner = parts.kind === "routine" || parts.kind === "label";
  if (needsOwner && ctx.space !== "crt" && ctx.owner === undefined) {
    throw new IdRuleError("routine-needs-owner", `${parts.kind} under ${ctx.space} needs an owner`);
  }
  if (parts.kind === "addr" && ctx.owner !== undefined) {
    throw new IdRuleError("addr-no-owner", "an address is an address, whoever is there");
  }
  return `${parts.slug}:${ctxToken(ctx)}:${parts.kind}:${formatAddr4(parts.address)}`;
}

export function deriveSubsystemId(slug: string, name: string): string {
  assertSlug(slug);
  if (!OWNER.test(name)) throw new IdRuleError("subsystem-name", `"${name}" must be lowercase [a-z0-9_.-]`);
  return `${slug}:sub:${name}`;
}

export function derivePlatformId(platform: PlatformTag, address: number): string {
  assertAddress(address);
  return `${platform}:${platformKindForAddress(platform, address)}:${formatAddr4(address)}`;
}

export function parseId(id: string): ParsedId {
  const parts = id.split(":");
  if (parts.length === 3 && PLATFORMS.has(parts[0]!)) {
    const [platform, kind, addr] = parts as [PlatformTag, string, string];
    if (!PKINDS.has(kind)) throw new IdRuleError("pkind", `"${kind}" is not zp | ram | io | rom`);
    if (!ADDR.test(addr)) throw new IdRuleError("addr", `"${addr}" must be four lowercase hex digits`);
    return { form: "platform", platform, kind: kind as PlatformNodeKind, address: parseInt(addr, 16) };
  }
  if (parts.length === 3 && parts[1] === "sub") {
    assertSlug(parts[0]!);
    return { form: "subsystem", slug: parts[0]!, name: parts[2]! };
  }
  if (parts.length === 4) {
    const [slug, ctxTok, kind, addr] = parts as [string, string, string, string];
    assertSlug(slug);
    if (!ADDR.test(addr)) throw new IdRuleError("addr", `"${addr}" must be four lowercase hex digits (never a flattened cart offset)`);
    const ctx = parseCtx(ctxTok);
    const parsed = { form: "project" as const, slug, ctx, kind, address: parseInt(addr, 16) };
    // re-derive to enforce the owner rules
    deriveProjectId({ slug, ctx, kind, address: parsed.address });
    return parsed;
  }
  throw new IdRuleError("form", `"${id}" is neither a platform, project nor subsystem id`);
}

export function isPlatformId(id: string): boolean {
  const head = id.split(":")[0] ?? "";
  return PLATFORMS.has(head);
}

/** The platform a project context belongs to: drv → c1541, everything else → c64. */
export function platformForCtx(ctx: Ctx): PlatformTag {
  return ctx.space === "drv" ? "c1541" : "c64";
}

/** The `space` column for indexing: the ctx's space, or the platform kind's lens. */
export function spaceForParsed(parsed: ParsedId): string {
  if (parsed.form === "project") return parsed.ctx.space;
  if (parsed.form === "platform") return parsed.kind === "io" ? "io" : parsed.kind === "rom" ? "rom" : "ram";
  return "sub";
}
