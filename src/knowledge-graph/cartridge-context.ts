// Spec 909 — the cartridge a project's artifact belongs to, for producers that start from a project directory
// and an artifact record (the 819/820/826 seeds, the analysis workflow) rather than from an open store.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRecord } from "../project-knowledge/types.js";
import { CART_ROLES, cartOfArtifact, chooseCartridge, describeCartridge, readCartridges, setCartridgeRole, type CartChoice, type CartRole, type CartridgeRecord } from "./cartridges.js";
import { graphPath, GraphStore, readProjectSlug } from "./store.js";

function readArtifacts(projectDir: string): ArtifactRecord[] {
  const path = join(projectDir, "knowledge", "artifacts.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { items?: ArtifactRecord[] } | ArtifactRecord[];
    return Array.isArray(raw) ? raw : raw.items ?? [];
  } catch { return []; }
}

/** The cartridges the project's graph holds; empty when there is no graph yet. */
export function projectCartridges(projectDir: string): CartridgeRecord[] {
  if (!existsSync(graphPath(projectDir))) return [];
  const store = GraphStore.open(projectDir, { readOnly: true });
  try { return readCartridges(store.db); } finally { store.close(); }
}

export interface CartridgeRoleDeclaration { cart: string; role: CartRole }

/**
 * D3 — what each cartridge IS in this project, said by the owner (contract_set, slot_record). All or nothing: one
 * unknown cartridge refuses the whole call, naming the ones the project holds, and nothing is written.
 */
export function declareCartridgeRoles(projectDir: string, items: CartridgeRoleDeclaration[]): { ok: true; cartridges: CartridgeRecord[] } | { ok: false; refusal: string } {
  const store = GraphStore.open(projectDir);
  try {
    const held = readCartridges(store.db);
    const list = held.length === 0 ? "the project holds no cartridge yet (extract_crt registers one)" : `the project holds: ${held.map(describeCartridge).join("; ")}`;
    for (const it of items) {
      if (!held.some((c) => c.cart === it.cart)) return { ok: false, refusal: `no cartridge "${it.cart}" — ${list}` };
      if (!CART_ROLES.includes(it.role)) return { ok: false, refusal: `role "${it.role}" is not source | target | other` };
    }
    const slug = readProjectSlug(projectDir);
    for (const it of items) setCartridgeRole(store, slug, it.cart, it.role);
    return { ok: true, cartridges: readCartridges(store.db) };
  } finally {
    store.close();
  }
}

/** The text a status or contract answer carries for the cartridges: each with its type and role, and how to say what an undeclared one is. */
export function formatCartridges(carts: CartridgeRecord[]): string[] {
  if (carts.length === 0) return [];
  const lines = [`Cartridges (${carts.length}):`];
  for (const c of carts) {
    lines.push(`  ${describeCartridge(c)}${c.bankCount !== undefined ? ` — ${c.bankCount} banks` : ""}${c.imageFile ? `, image ${c.imageFile}` : ""}`);
  }
  const undeclared = carts.filter((c) => !c.roleDeclared);
  if (undeclared.length > 0) {
    lines.push(`  ${undeclared.map((c) => c.cart).join(", ")}: role not declared — nothing is filed as source or target by guess. Say it: contract_set cartridges:[{cart:"${undeclared[0]!.cart}", role:"source"|"target"|"other"}].`);
  }
  return lines;
}

/** D7 for an artifact that sits in a bank: the cartridge it belongs to, else the project's only one, else a refusal that lists them. */
export function chooseCartridgeForArtifact(projectDir: string, artifact: Pick<ArtifactRecord, "id" | "path">, named?: string): CartChoice {
  const carts = projectCartridges(projectDir);
  return chooseCartridge(carts, named, cartridgeOfProjectArtifact(projectDir, artifact, carts));
}

/** The cartridge an artifact descends from or sits beside — undefined when nothing ties it to one. */
export function cartridgeOfProjectArtifact(projectDir: string, artifact: Pick<ArtifactRecord, "id" | "path">, carts = projectCartridges(projectDir)): CartridgeRecord | undefined {
  if (carts.length === 0) return undefined;
  return cartOfArtifact(readArtifacts(projectDir), carts, artifact.id, artifact.path);
}
