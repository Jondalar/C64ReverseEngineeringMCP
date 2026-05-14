# Spec 430 — Sprint progress

Sha: `a502074b3a`  ·  Generated: 2026-05-14T21:39:24.953Z

## Canary verdicts

| Canary | Expected | Status | Verdict | Divergence row | Report |
|---|---|---|---|---|---|
| motm | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/motm/diff-a502074b3a.json) |
| mm-s1 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/mm-s1/diff-a502074b3a.json) |
| im2 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/im2/diff-a502074b3a.json) |
| scramble | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/scramble/diff-a502074b3a.json) |
| lnr-s1 | red | diverged | PASS (red as expected) | 1 | [json](samples/traces/spec-430/lnr-s1/diff-a502074b3a.json) |

## How to reproduce

```sh
npm run canary:spec-430                     # full gate
npm run canary:spec-430 -- --only lnr-s1    # one canary
npm run canary:spec-430 -- --skip-capture   # re-use HL trace
```
