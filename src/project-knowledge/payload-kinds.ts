// One answer to "is this entity a payload?", for every door that asks.
//
// The store keeps a payload's DECLARED kind: `extract_disk` registers a DOS file as
// `disk-file`, `extract_crt` a chip as `chip`, a cartridge slot chunk as `cart-chunk`,
// and `register_payload` a bare blob as `payload`. All four are payload-bearing — the
// entity carries `payload.*` attributes, a load address, spans and an asm link — and
// `entityKindOf` round-trips the declared kind faithfully, which is correct: a caller
// that saved a `disk-file` must be able to list it back as one.
//
// What was wrong was the READER. `list_loader_models` counted the four kinds and
// reported its payloads; `link_payload_to_lut_row`, ten lines below it, filtered
// `listEntities({ kind: "payload" })` and could not see a payload `extract_disk` had
// created — so two real LUT rows were unlinkable purely because of which door made the
// payload. Two views of one store, ten lines apart.
//
// So the predicate lives here, once, and every door imports it.

import type { EntityRecord } from "./types.js";
import type { ProjectKnowledgeService } from "./service.js";

/** Every entity kind that carries payload bytes. Order is not significant. */
export const PAYLOAD_ENTITY_KINDS: ReadonlySet<string> = new Set([
  "payload",     // register_payload / register_payloads_from_manifest
  "disk-file",   // extract_disk (a DOS directory entry)
  "cart-chunk",  // bulk_create_cart_chunk_payloads (a LUT slot)
  "chip",        // extract_crt (a CHIP packet)
  "asset",       // a carved asset blob
]);

export function isPayloadEntity(entity: { kind: string }): boolean {
  return PAYLOAD_ENTITY_KINDS.has(entity.kind);
}

/** Every payload-bearing entity in the project, whichever door created it. */
export function listPayloadEntities(service: ProjectKnowledgeService): EntityRecord[] {
  return service.listEntities().filter(isPayloadEntity);
}

/**
 * One payload by id, or a refusal that says what WAS found — a caller who passed a
 * real id and got "No payload with id X" cannot tell a typo from a kind filter, and
 * that is exactly the confusion this module exists to end.
 */
export function findPayloadEntity(
  service: ProjectKnowledgeService,
  payloadId: string,
): { payload: EntityRecord } | { refusal: string } {
  const all = service.listEntities();
  const hit = all.find((e) => e.id === payloadId);
  if (hit && isPayloadEntity(hit)) return { payload: hit };
  if (hit) {
    return {
      refusal: `Entity ${payloadId} is a "${hit.kind}", which carries no payload bytes. `
        + `Payload-bearing kinds are: ${[...PAYLOAD_ENTITY_KINDS].join(", ")}. `
        + `List them with list_payloads.`,
    };
  }
  return { refusal: `No payload with id ${payloadId}. List the project's payloads with list_payloads.` };
}
