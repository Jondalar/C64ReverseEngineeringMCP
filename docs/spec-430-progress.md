# Spec 430 — Sprint progress

Sha: `932ca23113`  ·  Generated: 2026-05-13T20:23:13.974Z

## Canary verdicts

| Canary | Expected | Status | Verdict | Divergence row | Report |
|---|---|---|---|---|---|
| motm | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/motm/diff-932ca23113.json) |
| im2 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/im2/diff-932ca23113.json) |
| scramble | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/scramble/diff-932ca23113.json) |

## How to reproduce

```sh
npm run canary:spec-430                     # full gate
npm run canary:spec-430 -- --only lnr-s1    # one canary
npm run canary:spec-430 -- --skip-capture   # re-use HL trace
```
