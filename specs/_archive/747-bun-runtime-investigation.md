# Spec 747 — Bun Runtime Investigation for MCP + Runtime Daemon

**Status:** BACKLOG / INVESTIGATION (2026-06-01)
**Owner:** runtime daemon / MCP server / build tooling
**Related specs:** 744, 726.B, 723, 716

## 1. Goal

Evaluate whether Bun can replace Node.js for any product runtime process:

- MCP stdio server;
- Runtime Daemon from Spec 744.4c;
- trace writer/indexer support processes from Spec 726.B;
- workspace/UI backend where relevant.

This is an investigation spec, not approval to migrate. Node remains the product
baseline until this spec proves Bun is compatible, faster, and operationally
clean.

## 2. Non-Goals

- No emulator rewrite.
- No TypeScript source rewrite just to satisfy Bun.
- No replacement of TypeScript typechecking. `tsc`/`tsgo` and Bun runtime are
  separate questions.
- No hidden product fork where some sessions run under Node and some under Bun
  without the user knowing.
- No VICE involvement. This evaluates the C64RE product runtime only.

## 3. Current Hypothesis

Bun may reduce process startup and general JS runtime overhead, but the risky
areas are exactly the pieces C64RE depends on:

- MCP stdio protocol correctness;
- Node built-in API compatibility (`node:fs`, `node:worker_threads`,
  `node:child_process`, `node:net`, streams, timers);
- native dependency compatibility, especially `@duckdb/node-api`;
- WASM loading/copying for reSID assets;
- long-running worker stability for binary trace logs;
- behavior under sustained Runtime Daemon sessions.

The expected outcome may be one of:

1. Bun is safe for developer tooling only.
2. Bun is safe for MCP stdio but not the Runtime Daemon.
3. Bun is safe for Runtime Daemon but not DuckDB/indexing.
4. Bun is not worth using yet.
5. Bun is good enough to become an optional supported runtime.

Only outcome 5 can change product defaults.

## 4. Required Architecture Shape

Bun must not create another runtime topology.

The Spec 744.4c rule still wins:

```text
Runtime Daemon owns emulator sessions.
UI is a client.
MCP is a client.
```

If Bun is used, it runs that same daemon/client topology. It must not reintroduce:

- MCP-hosted product runtime;
- UI-hosted product runtime;
- two process-local runtime singletons;
- duplicated sessions for benchmark convenience.

## 5. Investigation Slices

### 747.1 — Static Compatibility Audit

Build a dependency/runtime map:

- every production entrypoint (`src/cli.ts`, runtime daemon entrypoint,
  workspace server, trace workers);
- every use of Node-specific APIs;
- every native dependency;
- every worker/thread/subprocess launch;
- every dynamic import / `import.meta.url` path resolution;
- every script that assumes `node`.

Output:

- `docs/bun-runtime-compatibility-audit.md`;
- a risk table with `works`, `unknown`, `blocked`, `must-test`.

No code migration in this slice.

### 747.2 — Bun Smoke Harness

Add opt-in scripts only. Do not change default scripts.

Required shape:

```json
{
  "scripts": {
    "bun:smoke:mcp": "...",
    "bun:smoke:runtime-daemon": "...",
    "bun:smoke:trace": "...",
    "bun:bench:runtime": "..."
  }
}
```

These scripts may fail initially, but failures must be classified. They must not
replace `npm run build:mcp`, `runtime:daemon`, or product gates.

### 747.3 — MCP Stdio Compatibility

Prove a real MCP client can talk to the server under Bun:

- initialize handshake;
- list default tools;
- call `project_status`;
- call `agent_next_step`;
- call one read-only knowledge/search tool;
- call one bounded runtime tool through the daemon client, if 744.4c is present.

Acceptance:

- no protocol framing differences;
- no stdout pollution;
- same default tool count as Node;
- same JSON schemas/tool names as Node.

### 747.4 — Runtime Daemon Compatibility

Run the Spec 744.4c Runtime Daemon under Bun, not a separate test-only daemon.

Acceptance:

- session start/list/status;
- UI client can attach;
- MCP client can attach;
- run/pause/resume works;
- media mount/swap/eject works through Spec 742 ownership path;
- browser reload and MCP reconnect do not fork sessions;
- idle daemon does not burn a core.

### 747.5 — Trace + DuckDB Compatibility

This is the critical path for long-running sessions.

Acceptance:

- binary `.c64retrace` writer works;
- trace worker startup path works from source and built output;
- finalize does not hang on worker failure;
- DuckDB index creation works through `@duckdb/node-api` or a documented Bun-safe
  adapter;
- `trace_store_info`, `trace_store_top_pcs`, and `runtime_query_events` return
  the same answers as Node on the same trace;
- large trace indexing is not slower than Node by more than 10%.

If `@duckdb/node-api` does not work under Bun, Bun cannot be product-default for
trace-owning processes until an adapter is implemented.

### 747.6 — Performance Benchmarks

Benchmarks must compare Node vs Bun on the same machine and commit.

Required metrics:

- MCP cold start to `initialize` response;
- MCP tool-call latency for `project_status`, `project_search`, and
  `agent_next_step`;
- Runtime Daemon cold start;
- Runtime session start;
- idle CPU for daemon with one paused session;
- run throughput with trace off;
- run throughput with binary CPU trace on;
- trace finalize/index latency;
- memory RSS after 10 minutes idle and after a 10-minute trace session.

Minimum bar to consider Bun useful:

- MCP cold start at least 25% faster, or
- Runtime run throughput at least 15% faster, or
- idle/resource behavior materially better,

with no failed compatibility gate.

If improvements are only within noise, do not migrate.

## 6. Product Decision Rules

### Bun Optional

Bun may become an optional developer/runtime choice if:

- all 747.3–747.5 gates pass;
- performance is equal or better;
- install docs clearly say Node remains supported.

### Bun Product Default

Bun may become the product default only if:

- all optional criteria pass;
- CI/gates run Bun regularly;
- macOS and Linux are green;
- Windows/WSL story is documented;
- DuckDB/worker/stdio behavior is stable;
- rollback to Node remains one command/config change.

### Bun Rejected

Bun is rejected for product runtime if:

- MCP stdio framing is unreliable;
- Runtime Daemon sharing breaks;
- DuckDB cannot be supported cleanly;
- worker semantics break trace finalization;
- performance gains do not justify the operational split.

## 7. Required Gates

New gates must be opt-in until a decision is made:

```text
npm run bun:smoke:mcp
npm run bun:smoke:runtime-daemon
npm run bun:smoke:trace
npm run bun:bench:runtime
```

The final investigation report must include:

- Node version;
- Bun version;
- OS/CPU;
- exact commit;
- gate counts;
- benchmark table;
- blocked APIs/dependencies;
- recommendation: reject / optional / product-default candidate.

## 8. Acceptance

Spec 747 is DONE only when the report exists and one of these outcomes is
recorded in this spec and `specs/README.md`:

- **REJECTED:** keep Node, with reasons.
- **OPTIONAL:** Bun works but is not default, with supported command paths.
- **PRODUCT-CANDIDATE:** Bun can become default after CI/install work.

Until then, Bun must not be advertised as a working runtime for the MCP or the
Runtime Daemon.
