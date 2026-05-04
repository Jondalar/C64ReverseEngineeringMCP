# Legacy Sprint 96 / 97 probe scripts

These scripts were one-shot probes written against single hypotheses
during the Bug 39 / Bug 40 investigations. They emit unstructured
console output and are kept for the hypothesis history they encode.

For new EOF / LOAD-completion investigation, use the structured EOF
trace harness instead:

- Spec 094: `src/runtime/headless/trace/eof-trace.ts`
- CLI: `npm run trace:eof -- --disk=<g64> --file=<name>`
- Schema: `docs/eof-trace-schema.md`

The harness produces a JSONL artifact with run-length-compressed PC
samples, decimated coarse state snapshots, named moments, and a summary
flag block — diffable against VICE captures (Spec 095) and stable
across versions.
