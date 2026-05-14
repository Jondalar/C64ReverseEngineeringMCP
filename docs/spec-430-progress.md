# Spec 430 — Sprint progress

Sha: `cd9ad498c6`  ·  Generated: 2026-05-14T13:11:16.692Z

## Canary verdicts

| Canary | Expected | Status | Verdict | Divergence row | Report |
|---|---|---|---|---|---|
| motm | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/motm/diff-cd9ad498c6.json) |
| mm-s1 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/mm-s1/diff-cd9ad498c6.json) |
| im2 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/im2/diff-cd9ad498c6.json) |
| scramble | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/scramble/diff-cd9ad498c6.json) |
| lnr-s1 | red | diverged | PASS (red as expected) | 1 | [json](samples/traces/spec-430/lnr-s1/diff-cd9ad498c6.json) |

## How to reproduce

```sh
npm run canary:spec-430                     # full gate
npm run canary:spec-430 -- --only lnr-s1    # one canary
npm run canary:spec-430 -- --skip-capture   # re-use HL trace
```
