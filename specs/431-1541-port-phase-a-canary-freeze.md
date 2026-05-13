# Spec 431 — Phase A: Canary freeze + DuckDB divergence diff infra

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase A  
**Depends on:** existing `samples/traces/v2-baseline/*`,
`vice_trace_runtime_start`, trace-store
**Doctrine:** No code refactor before frozen baselines + automated
divergence diff. Every later phase (432–437) must run this gate.
**Anchors:**
- `docs/vice-iec-arc42.md` §15 (Cloning checklist)
- `docs/vice-iec-arc42.md` §6.1–§6.5 (sequence diagrams to diff against)
- `docs/vice-1541-arch.md` §3.2, §6.1–§6.5

## Problem

Spec 430 is a structural rewrite of the 1541/IEC/VIA/GCR path. Without
a hard automated gate, "literal port" reviews regress quietly. Today
the divergence proof is by hand: dump JSONL, eyeball rows. That
violates [[feedback_trace_into_duckdb]].

## Goals

1. Freeze the current passing canary set so subsequent phases cannot
   regress them silently.
2. Provide one MCP-driven command that produces a divergence report
   against VICE baseline traces for any canary.
3. Mark LNR-S1 as the known-red target.

## Canaries

| ID | Title | Status | Baseline path |
|----|-------|--------|---------------|
| `motm` | Murder on the Mississippi | GREEN | `samples/traces/v2-baseline/motm/` |
| `mm-s1` | Maniac Mansion side 1 | GREEN | `samples/traces/v2-baseline/mm-s1/` |
| `im2` | International Karate IM2 | GREEN | `samples/traces/v2-baseline/im2/` |
| `lnr-s1` | Last Ninja Remix side 1 | RED (expected) | `samples/traces/v2-baseline/lnr-s1/` |
| `polarbear` | Polar Bear (Scramble/Krill) | GREEN | `samples/traces/v2-baseline/polarbear/` |

If a baseline directory is missing it must be re-captured ONCE before
Phase B starts (use `vice_trace_runtime_start`); after capture, do not
re-run VICE per [[reference_vice_baseline_traces]].

## Required infrastructure

### 1. Canary registry

Add `samples/canaries/spec-430.json`:

```json
[
  { "id": "motm", "media": ".../motm.d64",
    "boot": "load-mc + setpc",
    "trace_window_clk": [0, 10_000_000],
    "expected": "green" },
  { "id": "lnr-s1", ..., "expected": "red" }
]
```

Schema is JSON, not invented. One field set, no aliases.

### 2. Trace capture wrapper

New script `scripts/spec-430-canary-trace.mjs`:

- input: canary id
- runs headless boot scenario for the canary
- enables `vice_trace_runtime_start` for the canary window
- captures CPU, mem_read, mem_write, IRQ, drive_*, via_*, cia_*
- writes trace into the trace store with tag
  `spec-430/<canary>/headless/<git-sha>`
- never writes JSONL/CSV outside trace-store
  ([[feedback_trace_into_duckdb]])

### 3. Divergence query

New script `scripts/spec-430-diff.mjs`:

- two inputs: VICE-tag, HL-tag in trace store
- DuckDB query for first divergent row on the IEC/VIA contract
  surface only (do NOT diff opcode-by-opcode whole trace)
- columns compared (subset matching `docs/vice-iec-arc42.md`
  §11 risks):
  - C64 `$DD00` read/write effective byte
  - IEC `cpu_bus`, `cpu_port`, `drv_port`, `drv_bus[8]`,
    `drv_data[8]`, `iec_old_atn`
  - Drive VIA1 `$1800` read/write byte, ORB/DDR, PCR, IFR/IER
  - CA1 edge tag (rising / falling / 0)
  - Drive clock at the event
  - drive PC/SP across CA1 IRQ entry
- report: first-divergence row + 8 rows of context each side
- machine-readable JSON output for CI gate

### 4. CI gate target

New npm script `npm run canary:spec-430`:

- runs all canaries
- prints PASS/FAIL per canary
- exit non-zero if any canary marked `expected: green` diverges OR if
  `lnr-s1` UNEXPECTEDLY passes (track flip)

## Acceptance

1. `samples/canaries/spec-430.json` exists with 5 entries.
2. All 5 baseline traces present in `samples/traces/v2-baseline/`.
3. `scripts/spec-430-canary-trace.mjs` produces a tagged trace-store
   capture for each canary.
4. `scripts/spec-430-diff.mjs` returns 0 divergent rows for the 4
   green canaries on the current code.
5. `scripts/spec-430-diff.mjs` returns ≥1 divergent row for `lnr-s1`
   with a clearly identified first-divergence event family.
6. `npm run canary:spec-430` exits 0 today, against the unmodified
   pre-refactor code.
7. The report from step 5 is committed under
   `docs/spec-430-lnr-s1-pre-refactor-divergence.md` as the
   red-test baseline so post-refactor diffs can be compared.

## Do Not

- Do not write new one-off JSONL/CSV dump scripts.
- Do not start Phase B (Spec 432) before all 6 acceptance bullets
  pass.
- Do not regenerate VICE baselines unless a baseline directory is
  missing entirely.
- Do not extend the diff to opcode-by-opcode — keep it on the IEC/VIA
  contract surface.

## Agent Instruction

```text
Implement Spec 431. Build the canary infra for Spec 430 phase-gating.
No production-code edits to IEC/VIA/GCR/drive in this spec — only
scripts, registry JSON, baseline capture if missing, and a documented
pre-refactor divergence report for lnr-s1. Output must run through the
existing trace store (vice_trace_runtime_start + trace_store_query),
never through ad-hoc scripts. Stop when all acceptance items are
checked.
```
