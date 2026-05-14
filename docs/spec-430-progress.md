# Spec 430 — Sprint progress

Sha: `01f41759ea`  ·  Generated: 2026-05-14T14:26:53.253Z

## Canary verdicts

| Canary | Expected | Status | Verdict | Divergence row | Report |
|---|---|---|---|---|---|
| motm | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/motm/diff-01f41759ea.json) |
| mm-s1 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/mm-s1/diff-01f41759ea.json) |
| im2 | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/im2/diff-01f41759ea.json) |
| scramble | green | smoke-only | PASS (smoke-only — no VICE baseline) | — | [json](samples/traces/spec-430/scramble/diff-01f41759ea.json) |
| lnr-s1 | red | diverged | PASS (red as expected) | 1 | [json](samples/traces/spec-430/lnr-s1/diff-01f41759ea.json) |

## How to reproduce

```sh
npm run canary:spec-430                     # full gate
npm run canary:spec-430 -- --only lnr-s1    # one canary
npm run canary:spec-430 -- --skip-capture   # re-use HL trace
```
