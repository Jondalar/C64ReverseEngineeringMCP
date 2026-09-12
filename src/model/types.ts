// Spec 845 — the model layer.
//
// Ultima VI's graph holds 11 161 nodes. The model its session produced holds 177, over
// three levels, and it is the 177 that a re-entering session can actually read. Eleven
// thousand nodes is an index, not a model: re-reading it costs as much as re-deriving it,
// which is the cost this whole spec exists to remove.
//
// So the model layer sits ABOVE the graph, in the same tables. Its nodes carry kind
// `container` and an explicit level; everything underneath stays exactly where it is.
// Membership is never stored — it is address containment, computed on read (D2), which is
// the only way it cannot drift from the graph it describes.

/** D1. Three levels, as the session used them. §5 leaves open whether this set closes. */
export const MODEL_LEVELS = ["system", "container", "component"] as const;
export type ModelLevel = (typeof MODEL_LEVELS)[number];

/** The kinds that count as MEMBERS of a container. `label` and `addr` are sub-routine
 *  detail — counting them would make every orphan report noise, and they are already
 *  reachable through the routine that CONTAINS them. */
export const MEMBER_KINDS = ["routine", "segment", "payload", "data_block", "entry"] as const;

export interface ModelNode {
  id: string;
  name: string;
  level: ModelLevel;
  space: string;
  owner: string | null;
  bank: number | null;
  start: number;
  end: number;
  /** What this container IS, in the asserter's words. */
  description: string;
  /** D3 — never empty. The door refuses a boundary without one. */
  evidence: string[];
  /** The 844 slot this boundary also answered, when it came in through slot_record (D7). */
  slot?: string;
}

/** D4 — derived on read from the fine edges, never stored. */
export interface ModelEdge {
  from: string;
  to: string;
  type: string;
  /** How many fine edges of this type cross the boundary. */
  count: number;
  /** A few of the fine edges themselves. They ARE the citation. */
  evidence: Array<{ from: string; to: string }>;
}

export interface ModelMembership {
  containerId: string;
  members: number;
  byKind: Record<string, number>;
}

/** D5 — a fine node inside no container. Visible, and countable. */
export interface Orphan {
  id: string;
  kind: string;
  name: string | null;
  address: number;
}

export interface ModelReport {
  nodes: ModelNode[];
  edges: ModelEdge[];
  membership: ModelMembership[];
  orphans: Orphan[];
  /** Fine nodes of a member kind, total. The denominator for the orphan count. */
  memberTotal: number;
}
