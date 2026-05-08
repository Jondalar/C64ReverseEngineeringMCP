# Spec 247 — Routine fingerprinting (library match)

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 trace store, pipeline disasm
**Master:** 230 / 240

## Goal

Hash routines (= contiguous code regions ending in RTS/JMP) from
trace + disasm and match against a curated library of known
patterns: KERNAL CHRGET/CHKIN/CHKOUT, BASIC interpreter primitives,
common fastloaders (Action Replay, Fast Hack'em, Krill, ByteBoozer
runtime), copy protection routines.

Auto-tag matched routines via `save_finding` + propose
`RoutineAnnotation`.

## Library schema

`samples/routine-fingerprints/<name>.json`:

```json
{
  "name": "kernal-chrget",
  "version": "C64 KERNAL 901227-03",
  "category": "kernal",
  "entry": 115,
  "length": 16,
  "hash_kind": "structural",
  "hash_value": "sha256:...",
  "byte_pattern": "AD 7A 00 8D ... <relocatable>",
  "register_use": { "reads": [], "writes": ["a","y","flags"] },
  "entry_signature": "incs $7a, lda ($7a),y, returns char in A",
  "links": ["mapping-c64-rom-symbols.md#chrget"]
}
```

## Hash kinds

- **structural** — opcode sequence with operand-positions masked
  out (= relocation-resistant). Best for short routines.
- **byte** — exact byte sequence. Best for ROM-resident routines.
- **graph** — call-graph topology hash (= matches reorganized code
  with same structure). Heaviest, optional.

## Surface (sketch)

```ts
interface FingerprintMatch {
  routinePc: number;
  artifactId: string;
  matchedFingerprint: string;     // library entry name
  matchKind: "structural" | "byte" | "graph";
  confidence: number;             // 0..1
  details: { byteOverlap?: number; opcodeMatch?: number };
}

scanFingerprints(artifactId: string): FingerprintMatch[];
addFingerprintToLibrary(entry: FingerprintEntry): void;
```

Run automatically as part of `analyze_prg` pipeline.

## Open questions

- **OQ1:** Library bootstrap — manual curation, or auto-extract from
  reference disasms (KERNAL ROM, known cracks)?
- **OQ2:** Confidence threshold for auto-emit `save_finding` —
  ≥0.9 / ≥0.95 / configurable?
- **OQ3:** Per-game vs per-platform fingerprint scope?
  (= some fastloaders are game-specific)
- **OQ4:** Distribution of library — bundled in repo, or external
  resource fetched via init script (license concerns for cracks)?
- **OQ5:** Hash collision policy — multiple matches per region:
  return all + rank by confidence, or return best only?

## Acceptance (draft)

- Library bootstrapped with 20+ KERNAL routines + 5+ common
  fastloaders + 3+ copy-protection patterns.
- Scanning a fresh PRG auto-tags KERNAL calls.
- Match precision ≥95% on a known-corpus regression set.
- Pipeline integration: `analyze_prg` emits matches as findings.
