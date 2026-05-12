# Spec 012: Server Tool Error Wrapping

## Problem

Top-level `uncaughtException` and `unhandledRejection` handlers in
`src/cli.ts` (commit 91c86f8) catch process-fatal errors, but
individual long-running tool handlers in `src/server-tools/*.ts` can
still throw asynchronously and surface as unhandled rejections instead
of structured tool errors. This makes failures look like crashes to the
client and loses the recommended-next-action contract.

## Goal

Every MCP tool handler must return a structured tool error on failure
instead of escaping as an unhandled rejection. The error must conform
to the project's tool-output contract (Spec 007).

## Approach

Add a thin wrapper helper, e.g.:

```ts
function safeHandler<TArgs, TResult>(
  toolName: string,
  fn: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult>;
```

Wrap every server-tool handler in `safeHandler`. On caught errors the
wrapper:

1. Resolves the project root if available.
2. Returns a `textContent` block with the standard error fields
   (resolved root, failing phase, input path, files written so far,
   recommended next action). Spec 007 defines the exact shape.
3. Logs to stderr with the tool name for telemetry.

## Coverage

At minimum wrap handlers in:

- `src/server-tools/agent-workflow.ts`
- `src/server-tools/payloads.ts`
- `src/server-tools/compression.ts`
- `src/server-tools/sandbox.ts`
- `src/server-tools/headless.ts`
- `src/server-tools/vice.ts`
- `src/project-knowledge/mcp-tools.ts`

## Acceptance Criteria

- A deliberately failing handler returns a structured error to the
  client and does not crash the stdio process.
- Stderr logs identify the tool by name on failure.
- Existing handlers keep their current success behavior.

## Tests

- Smoke: induce a failure in one wrapped handler and assert the
  client receives a structured error.
- Inspect handler output for the standard error fields.

## Out Of Scope

- Re-architecting the `tool` registration API.
- Per-tool retry policies.
