// The producers that write the project graph, each under an id that says what it does.
//
// A `producer` column value is public: `c64re graph dump`, graph_node and the node cards print it.
// An earlier release wrote numbers there; a graph from such a release is renamed once, on open
// (`migrateProducerIds`), and every id a caller hands in is read through `canonicalProducer`.

export const CONTROL_FLOW_PRODUCER = "control-flow";
export const MEMORY_ACCESS_PRODUCER = "memory-access";
export const RUNTIME_TRACE_PRODUCER = "runtime-trace";
/** the legacy-JSON-stores / annotation-file import into the project graph */
export const KNOWLEDGE_IMPORT_PRODUCER = "knowledge-import";
export const SIGNATURE_PRODUCER_ID = "signatures";
export const SIGNATURE_RESOLVE_PRODUCER = "signature-resolve";
export const CARTRIDGE_PRODUCER_ID = "cartridge";
export const DOCUMENT_PRODUCER = "document";
export const BOUNDARY_MODEL_PRODUCER = "boundary-model";
/** Spec 917 - the plan packages, cards, their edges and verdicts */
export const WORK_PLAN_PRODUCER = "work-plan";

/** Ids earlier releases wrote -> the id that replaces them. Reader-only: nothing writes a key of this table. */
export const LEGACY_PRODUCER_IDS: ReadonlyMap<string, string> = new Map([
  ["819", CONTROL_FLOW_PRODUCER],
  ["820", MEMORY_ACCESS_PRODUCER],
  ["821", RUNTIME_TRACE_PRODUCER],
  ["822", KNOWLEDGE_IMPORT_PRODUCER],
  ["826", SIGNATURE_PRODUCER_ID],
  ["826r", SIGNATURE_RESOLVE_PRODUCER],
  ["909", CARTRIDGE_PRODUCER_ID],
  ["847", DOCUMENT_PRODUCER],
  ["845", BOUNDARY_MODEL_PRODUCER],
]);

/** Any producer id a stored row or a caller carries -> the id this release writes. Unknown ids pass through. */
export function canonicalProducer(id: string): string {
  return LEGACY_PRODUCER_IDS.get(id) ?? id;
}

/** `meta.producer_ids`: the graph's producer columns speak the descriptive ids. */
export const PRODUCER_IDS_STAMP = "descriptive";
