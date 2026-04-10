/*
 * Core structs aligned to C headers:
 * - src/match.h
 * - src/search.h
 */

export interface Match {
  offset: number;
  len: number;
  next: Match | null;
}

export interface EncodeIntBucket {
  start: number;
  end: number;
}

export interface EncodeMatchBuckets {
  len: EncodeIntBucket;
  offset: EncodeIntBucket;
}

export interface SearchNode {
  index: number;
  match: Match;
  totalOffset: number;
  totalScore: number;
  prev: SearchNode | null;
  latestOffset: number;
}
