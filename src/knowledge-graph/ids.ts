// Spec 818 D1 — the id grammar. Nothing assigns an id; every id is derived from
// what the row is, and the store asserts deriveId(columns) === id on write, so
// there is no second key to drift.
//
//   platform-id   = platform ":" pkind ":" addr           c64:io:d018   c64:rom:ffd2   c64:zp:0031
//   project-id    = slug ":" ctx ":" kind ":" addr        wasteland:ram/block2_engine_0200:routine:1dd2
//   subsystem-id  = slug ":sub:" name                     wasteland:sub:disk-loader        (Spec 822)
//   cartridge-id  = slug ":crt/" cart ":cartridge"        wasteland:crt/gmod2-orig:cartridge   (Spec 909 — the cartridge itself)
//   ctx           = "ram" [ "/" owner ] | "crt/" cart "/" bank | "drv" [ "/" owner ]
//                   (Spec 909: a bank lives inside a cartridge; `crt/<bank>` without one is refused, `crt-needs-cart`)
//
// pkind is Spec 817's four kinds (zp | ram | io | rom) — 818's first draft had
// reg/rom/mem; zp and io are hardware distinctions the renderer keys on.

import { formatAddr4, PLATFORM_TAGS, platformKindForAddress, type PlatformNodeKind, type PlatformTag } from "../platform-kb/schema.js";

export type Space = "ram" | "crt" | "drv";
export type ProjectKind = "routine" | "label" | "addr";

export interface Ctx {
  space: Space;
  owner?: string;
  /** Spec 909 — for `space: "crt"`: the cartridge token (`[a-z0-9-]{1,24}`, unique in the project) the bank lives in. */
  cart?: string;
  bank?: number;
  /**
   * The machine the context belongs to, where `space` alone cannot say (a vic20 owner lives in
   * `ram` like a c64 one). Not part of the id token: project ids read the same on every machine,
   * only the platform ids a context points at (`vic20:io:9005`) differ. Absent = by `space`.
   */
  platform?: PlatformTag;
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
  | { form: "subsystem"; slug: string; name: string }
  /** Spec 909 — `<slug>:crt/<cart>:cartridge`. `kind` and `address` are fixed so a reader that wants only those need not branch. */
  | { form: "cartridge"; slug: string; cart: string; kind: "cartridge"; address: 0 };

const PLATFORMS: ReadonlySet<string> = new Set<string>(PLATFORM_TAGS);
const PKINDS: ReadonlySet<string> = new Set(["zp", "ram", "io", "rom"]);
const OWNER = /^[a-z0-9_.\-]+$/u;
const SLUG = /^[a-z0-9][a-z0-9\-]*$/u;
const ADDR = /^[0-9a-f]{4}$/u;
const BANK = /^[0-9a-f]{2,4}$/u;
/** Spec 909 D1 — a cartridge token. */
export const CART = /^[a-z0-9][a-z0-9-]{0,23}$/u;
/** The cartridge token the migration files what it cannot place under (Spec 909 D6). */
export const UNPLACED_CART = "unplaced";

export class IdRuleError extends Error {
  constructor(readonly rule: string, detail: string) {
    super(`${rule}: ${detail}`);
    this.name = "IdRuleError";
  }
}

export function assertCart(cart: string): void {
  if (!CART.test(cart)) throw new IdRuleError("cart-charset", `cartridge "${cart}" must be 1-24 characters of [a-z0-9-], starting with a letter or digit`);
}

export function ctxToken(ctx: Ctx): string {
  switch (ctx.space) {
    case "crt": {
      if (ctx.cart === undefined) throw new IdRuleError("crt-needs-cart", "a cartridge bank lives inside a cartridge: crt/<cart>/<bank>");
      assertCart(ctx.cart);
      if (ctx.bank === undefined) throw new IdRuleError("crt-needs-bank", "a cartridge context always carries its bank");
      if (ctx.owner !== undefined) throw new IdRuleError("crt-no-owner", "a cartridge context is identified by cartridge and bank, not owner");
      return `crt/${ctx.cart}/${ctx.bank.toString(16).padStart(2, "0")}`;
    }
    case "ram":
    case "drv": {
      if (ctx.bank !== undefined) throw new IdRuleError(`${ctx.space}-no-bank`, "only crt contexts carry a bank");
      if (ctx.cart !== undefined) throw new IdRuleError(`${ctx.space}-no-cart`, "only crt contexts carry a cartridge");
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
  if (!m) throw new IdRuleError("ctx", `"${token}" is not ram[/owner] | crt/cart/bank | drv[/owner]`);
  const space = m[1] as Space;
  const rest = m[2];
  if (space === "crt") {
    const [cart, bank, ...extra] = (rest ?? "").split("/");
    // `crt/<bank>` — the form before Spec 909. It names no cartridge, so it names no place.
    if (cart !== undefined && bank === undefined && BANK.test(cart)) throw new IdRuleError("crt-needs-cart", `"${token}" names a bank but no cartridge — a bank lives inside a cartridge: crt/<cart>/<bank>`);
    if (!cart || !CART.test(cart) || extra.length > 0) throw new IdRuleError("crt-needs-cart", `"${token}" is not crt/<cart>/<bank>`);
    if (!bank || !BANK.test(bank)) throw new IdRuleError("crt-needs-bank", `"${token}" needs a 2–4 hex digit bank`);
    return { space, cart, bank: parseInt(bank, 16) };
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
  // An `addr` node is "an address, whoever is there" (ownerless) — except where a runtime
  // run SAW which payload was in the window at that address: then the id names it
  // (`ram/<owner>:addr:3200`), one node per resident payload. A crt space names its
  // bank, never an owner (`crt-no-owner`, in ctxToken).
  return `${parts.slug}:${ctxToken(ctx)}:${parts.kind}:${formatAddr4(parts.address)}`;
}

/**
 * The context an `addr` node of a run is filed under: the space of the run, and for a cartridge the cartridge and bank
 * too — "an address is an address, whoever is there" holds inside one bank of one cartridge, not across them.
 */
export function addrCtx(ctx: Ctx): Ctx {
  return ctx.space === "crt" ? { space: "crt", ...(ctx.cart !== undefined ? { cart: ctx.cart } : {}), ...(ctx.bank !== undefined ? { bank: ctx.bank } : {}) } : { space: ctx.space };
}

/** Spec 909 D2 — the id of the cartridge itself. */
export function deriveCartridgeId(slug: string, cart: string): string {
  assertSlug(slug);
  assertCart(cart);
  return `${slug}:crt/${cart}:cartridge`;
}

/** A project id written before Spec 909: `<slug>:crt/<bank>:<kind>:<addr>`. The migration's input, never a valid id. */
export function parseLegacyCrtId(id: string): { slug: string; bank: number; kind: string; address: number } | undefined {
  const parts = id.split(":");
  if (parts.length !== 4) return undefined;
  const m = parts[1]!.match(/^crt\/([0-9a-f]{2,4})$/u);
  if (!m || !ADDR.test(parts[3]!)) return undefined;
  return { slug: parts[0]!, bank: parseInt(m[1]!, 16), kind: parts[2]!, address: parseInt(parts[3]!, 16) };
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
  if (parts.length === 3 && parts[2] === "cartridge" && parts[1]!.startsWith("crt/")) {
    assertSlug(parts[0]!);
    const cart = parts[1]!.slice(4);
    assertCart(cart);
    return { form: "cartridge", slug: parts[0]!, cart, kind: "cartridge", address: 0 };
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

/** The platform a project context belongs to: the one it names, else drv → c1541, everything else → c64. */
export function platformForCtx(ctx: Ctx): PlatformTag {
  return ctx.platform ?? (ctx.space === "drv" ? "c1541" : "c64");
}

/** The `space` column for indexing: the ctx's space, or the platform kind's lens. */
export function spaceForParsed(parsed: ParsedId): string {
  if (parsed.form === "project") return parsed.ctx.space;
  if (parsed.form === "cartridge") return "crt";
  if (parsed.form === "platform") return parsed.kind === "io" ? "io" : parsed.kind === "rom" ? "rom" : "ram";
  return "sub";
}
