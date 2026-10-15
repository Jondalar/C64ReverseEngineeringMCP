// Spec 909 — a cartridge is a place of its own.
//
// A project can hold several cartridges: the original of a port and the one being built from it,
// two releases of one game, a rebuilt target beside the last one. Every cartridge-space node used to
// live in ONE `crt/<bank>` context, so the second image's bank 0 was the first image's bank 0.
//
// A cartridge is one LINEAGE of cartridge-image artifacts (Spec 025 `lineageRoot`). Its token is minted
// once, at the first `extract_crt` of that lineage, from the image's name, and stored on a
// `<slug>:crt/<cart>:cartridge` node. Two rows, because two kinds of fact:
//
//   generated  what the image IS (Spec 785 A4): hardware type from the .crt header, bank count, hash,
//              name, and which artifacts and directories belong to it. Rewritten on every extract.
//   human      the role the owner gave it in the project: source | target | other. Declared, never
//              inferred from the type or a file name; absent means "other".
//
// Everything that files a node in cartridge space asks `cartOfArtifact` for the token; nothing else
// decides which cartridge a byte belongs to.

import { basename, dirname, extname, resolve, sep } from "node:path";
import type { DatabaseSync } from "../platform-kb/sqlite-quiet.js";
import { cartridgeTypeName } from "../project-knowledge/cartridge-type.js";
import { assertCart, CART, deriveCartridgeId, UNPLACED_CART } from "./ids.js";
import type { GraphStore } from "./store.js";

export const CARTRIDGE_PRODUCER = "909";

export type CartRole = "source" | "target" | "other";
export const CART_ROLES: readonly CartRole[] = ["source", "target", "other"];

export interface CartridgeRecord {
  cart: string;
  id: string;
  role: CartRole;
  /** the owner said so (contract_set); false = the default "other" */
  roleDeclared: boolean;
  hardwareType?: number;
  typeName?: string;
  bankCount?: number;
  imageName?: string;
  imageFile?: string;
  imageSha256?: string;
  /** every hash the lineage has had, newest last — a rebuilt image keeps its cartridge */
  imageShas: string[];
  lineageRoots: string[];
  imageArtifactIds: string[];
  manifestArtifactIds: string[];
  /** absolute directories the cartridge was extracted into */
  extractDirs: string[];
}

interface GeneratedAttrs {
  cartridge?: {
    hardware_type?: number;
    bank_count?: number;
    image_name?: string;
    image_file?: string;
    image_sha256?: string;
    image_shas?: string[];
    lineage_roots?: string[];
    image_artifact_ids?: string[];
    manifest_artifact_ids?: string[];
    extract_dirs?: string[];
  };
}

const uniq = (xs: Array<string | undefined>): string[] => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0))];

const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };

/** Every cartridge the graph holds. Empty on a graph that has none (or that predates the registry). */
export function readCartridges(db: DatabaseSync): CartridgeRecord[] {
  let rows: Array<{ id: string; layer: string; attrs: string }>;
  try {
    rows = db.prepare("SELECT id, layer, attrs FROM nodes WHERE kind = 'cartridge' ORDER BY id").all() as Array<{ id: string; layer: string; attrs: string }>;
  } catch { return []; }
  const byId = new Map<string, { generated?: GeneratedAttrs; human?: Record<string, unknown> }>();
  for (const r of rows) {
    const slot = byId.get(r.id) ?? {};
    if (r.layer === "human") slot.human = parse(r.attrs); else slot.generated = parse(r.attrs) as GeneratedAttrs;
    byId.set(r.id, slot);
  }
  const out: CartridgeRecord[] = [];
  for (const [id, slot] of byId) {
    const cart = id.split(":")[1]?.slice(4);
    if (!cart) continue;
    const g = slot.generated?.cartridge ?? {};
    const declared = slot.human?.role;
    const role: CartRole = declared === "source" || declared === "target" || declared === "other" ? declared : "other";
    out.push({
      cart, id, role, roleDeclared: declared === "source" || declared === "target" || declared === "other",
      hardwareType: g.hardware_type, typeName: g.hardware_type !== undefined ? cartridgeTypeName(g.hardware_type) : undefined,
      bankCount: g.bank_count, imageName: g.image_name, imageFile: g.image_file, imageSha256: g.image_sha256,
      imageShas: g.image_shas ?? (g.image_sha256 ? [g.image_sha256] : []),
      lineageRoots: g.lineage_roots ?? [], imageArtifactIds: g.image_artifact_ids ?? [],
      manifestArtifactIds: g.manifest_artifact_ids ?? [], extractDirs: g.extract_dirs ?? [],
    });
  }
  return out.sort((a, b) => a.cart.localeCompare(b.cart));
}

/** `gmod2-orig.crt` -> `gmod2-orig`: the token a first extract mints. */
export function cartTokenFromName(name: string): string {
  const stem = basename(name, extname(name)).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  let token = stem || "cart";
  // Too long: drop whole words from the MIDDLE, where a file name carries version noise, and keep both ends, which
  // carry the game and what this image is of it — `yeti-mountain-v1-04-gmod2` -> `yeti-mountain-gmod2`, not a cut that
  // loses the `gmod2` that tells it from its sibling.
  const words = token.split("-");
  while (words.join("-").length > 24 && words.length > 2) words.splice(Math.floor(words.length / 2), 1);
  token = words.join("-");
  if (token.length > 24) token = token.slice(0, 24).replace(/-+$/u, "");
  return token || "cart";
}

/** The first free token for `name`, with a numeric suffix on a clash. `unplaced` is never minted. */
export function mintCartToken(taken: ReadonlySet<string>, name: string): string {
  const base = cartTokenFromName(name);
  const free = (t: string) => !taken.has(t) && t !== UNPLACED_CART && CART.test(t);
  if (free(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const t = `${base.slice(0, 24 - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (free(t)) return t;
  }
  throw new Error(`no free cartridge token for "${name}"`);
}

export interface RegisterCartridgeInput {
  /** the cartridge-image artifact (the .crt) */
  image: { id: string; path: string; title?: string; lineageRoot?: string };
  manifest?: { id: string; path: string };
  /** join this cartridge instead of minting — an image that is a rebuild of a known cartridge, registered elsewhere */
  cart?: string;
  hardwareType?: number;
  bankCount?: number;
  imageName?: string;
  imageSha256?: string;
  /** absolute directory the image was extracted into */
  extractDir?: string;
}

export interface RegisterCartridgeResult {
  record: CartridgeRecord;
  /** a token was minted by this call (the first extract of this lineage) */
  minted: boolean;
  /** the image joined a cartridge that already existed, by what it matched */
  joinedBy?: "lineage" | "artifact" | "hash" | "named";
}

/** Which registered cartridge an image belongs to, if any — by name, artifact, lineage, then bytes. */
export function findCartridgeForImage(carts: CartridgeRecord[], image: { id: string; lineageRoot?: string }, sha256?: string, named?: string): { record: CartridgeRecord; by: NonNullable<RegisterCartridgeResult["joinedBy"]> } | undefined {
  if (named !== undefined) {
    const hit = carts.find((c) => c.cart === named);
    if (hit) return { record: hit, by: "named" };
  }
  const root = image.lineageRoot ?? image.id;
  for (const c of carts) if (c.imageArtifactIds.includes(image.id)) return { record: c, by: "artifact" };
  for (const c of carts) if (c.lineageRoots.includes(root)) return { record: c, by: "lineage" };
  if (sha256) for (const c of carts) if (c.imageShas.includes(sha256)) return { record: c, by: "hash" };
  return undefined;
}

/** Mint (first extract of a lineage) or refresh (a re-extract, a rebuild) the cartridge node of an image. */
export function registerCartridge(store: GraphStore, slug: string, input: RegisterCartridgeInput): RegisterCartridgeResult {
  const carts = readCartridges(store.db);
  if (input.cart !== undefined) assertCart(input.cart);
  const found = findCartridgeForImage(carts, input.image, input.imageSha256, input.cart);
  const cart = found?.record.cart ?? input.cart ?? mintCartToken(new Set(carts.map((c) => c.cart)), input.image.title ?? input.image.path);
  const prev = found?.record;
  const root = input.image.lineageRoot ?? input.image.id;
  const shas = uniq([...(prev?.imageShas ?? []), input.imageSha256]);
  const generated: GeneratedAttrs["cartridge"] = {
    hardware_type: input.hardwareType ?? prev?.hardwareType,
    bank_count: input.bankCount ?? prev?.bankCount,
    image_name: input.imageName ?? prev?.imageName,
    image_file: basename(input.image.path),
    image_sha256: input.imageSha256 ?? prev?.imageSha256,
    image_shas: shas,
    lineage_roots: uniq([...(prev?.lineageRoots ?? []), root]),
    image_artifact_ids: uniq([...(prev?.imageArtifactIds ?? []), input.image.id]),
    manifest_artifact_ids: uniq([...(prev?.manifestArtifactIds ?? []), input.manifest?.id]),
    extract_dirs: uniq([...(prev?.extractDirs ?? []), input.extractDir ?? (input.manifest ? dirname(input.manifest.path) : undefined)]),
  };
  const compact = Object.fromEntries(Object.entries(generated).filter(([, v]) => v !== undefined));
  store.upsertGenerated({
    id: deriveCartridgeId(slug, cart), kind: "cartridge", name: cart,
    attrs: { cartridge: compact },
    origin: "static", confidence: "certain",
    evidence: [{ kind: "artifact", artifact_id: input.image.id }],
  }, CARTRIDGE_PRODUCER);
  const record = readCartridges(store.db).find((c) => c.cart === cart)!;
  return { record, minted: found === undefined, joinedBy: found?.by };
}

/** Declare what a cartridge is in this project (D3). Throws on an unknown token, naming the ones there are. */
export function setCartridgeRole(store: GraphStore, slug: string, cart: string, role: CartRole): CartridgeRecord {
  const carts = readCartridges(store.db);
  const rec = carts.find((c) => c.cart === cart);
  if (!rec) throw new Error(`no cartridge "${cart}" in this project — ${carts.length === 0 ? "none is registered yet (extract_crt registers one)" : `it holds: ${carts.map((c) => c.cart).join(", ")}`}`);
  if (!CART_ROLES.includes(role)) throw new Error(`role "${role}" is not source | target | other`);
  store.upsertHuman({
    id: deriveCartridgeId(slug, cart), kind: "cartridge", name: cart, attrs: { role },
    origin: "user", confidence: "user_asserted", evidence: [],
  });
  return readCartridges(store.db).find((c) => c.cart === cart)!;
}

interface ArtifactLike { id: string; path?: string; lineageRoot?: string; sourceArtifactIds?: string[]; derivedFrom?: string }

const norm = (p: string): string => resolve(p);

/**
 * Which cartridge an artifact belongs to: it IS an image or manifest of one, descends from one
 * (sourceArtifactIds / derivedFrom), or lies inside the directory one was extracted into. The nearest
 * link wins; the directory test is the last resort and takes the deepest directory.
 */
export function cartOfArtifact(artifacts: Iterable<ArtifactLike>, carts: CartridgeRecord[], artifactId: string | undefined, absPath?: string): CartridgeRecord | undefined {
  if (carts.length === 0) return undefined;
  const byId = new Map<string, ArtifactLike>();
  for (const a of artifacts) byId.set(a.id, a);
  const direct = (a: ArtifactLike): CartridgeRecord | undefined =>
    carts.find((c) => c.imageArtifactIds.includes(a.id) || c.manifestArtifactIds.includes(a.id))
    ?? carts.find((c) => c.lineageRoots.includes(a.lineageRoot ?? a.id));
  const seen = new Set<string>();
  let frontier: ArtifactLike[] = [];
  const start = artifactId ? byId.get(artifactId) : undefined;
  if (start) frontier = [start];
  for (let depth = 0; depth < 10 && frontier.length > 0; depth += 1) {
    const next: ArtifactLike[] = [];
    for (const a of frontier) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const hit = direct(a);
      if (hit) return hit;
      for (const id of [...(a.sourceArtifactIds ?? []), ...(a.derivedFrom ? [a.derivedFrom] : [])]) {
        const parent = byId.get(id);
        if (parent) next.push(parent);
      }
    }
    frontier = next;
  }
  const path = absPath ?? start?.path;
  if (path) {
    const p = norm(path);
    let best: { rec: CartridgeRecord; len: number } | undefined;
    for (const c of carts) for (const d of c.extractDirs) {
      const dir = norm(d) + sep;
      if (p.startsWith(dir) && (!best || dir.length > best.len)) best = { rec: c, len: dir.length };
    }
    if (best) return best.rec;
  }
  return undefined;
}

/** A cartridge token as the reader names it: `gmod2-orig (GMod2, source)`. */
export function describeCartridge(c: CartridgeRecord): string {
  const type = c.typeName ?? (c.hardwareType !== undefined ? `hardware type ${c.hardwareType}` : "type unknown");
  return `${c.cart} (${type}, ${c.role}${c.roleDeclared ? "" : " — not declared"})`;
}

export type CartChoice =
  | { ok: true; cart: string; how: "named" | "lineage" | "only-cartridge"; note?: string }
  | { ok: false; refusal: string };

/**
 * D7 — which cartridge a write to cartridge space goes to. The cartridge the caller names wins (and must exist);
 * else the one the bytes' own lineage says; else the project's ONLY cartridge, said out loud. Anything else
 * refuses by name and lists the cartridges — there is no "the first one".
 */
export function chooseCartridge(carts: CartridgeRecord[], named?: string, fromLineage?: CartridgeRecord): CartChoice {
  const list = carts.length === 0 ? "the project holds no cartridge yet (extract_crt registers one)" : `the project holds: ${carts.map(describeCartridge).join("; ")}`;
  if (named !== undefined) {
    return carts.some((c) => c.cart === named)
      ? { ok: true, cart: named, how: "named" }
      : { ok: false, refusal: `crt-needs-cart: no cartridge "${named}" — ${list}` };
  }
  if (fromLineage) return { ok: true, cart: fromLineage.cart, how: "lineage" };
  if (carts.length === 1) return { ok: true, cart: carts[0]!.cart, how: "only-cartridge", note: `cartridge ${carts[0]!.cart}: the project's only cartridge` };
  return { ok: false, refusal: `crt-needs-cart: a cartridge bank lives inside a cartridge and none was given (pass cart) — ${list}` };
}
