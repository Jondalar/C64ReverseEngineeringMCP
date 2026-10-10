// Spec 898 D3 -- the row shapes of the per-platform seed files beside this one.

/** [address, symbol, name, description, source] -- the source names file and label. */
export type SeedRow = [address: number, symbol: string, name: string, description: string | null, source: string];

/** [start, end, name, source] -- a multi-byte variable or register block, end inclusive. */
export type SeedRegion = [start: number, end: number, name: string, source: string];
