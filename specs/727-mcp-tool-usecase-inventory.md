# Spec 727 — MCP Tool Use-Case Inventory

**Status:** READY  
**Owner:** MCP server / product API  
**Depends on:** Specs 722, 725, 726  
**Source:** `docs/product-vision-and-workbench-contract.md` and
`docs/llm-human-c64re-swimlane.md`

## 0. Hard Path-Portability Rule

An LLM may call the MCP from **any current working directory**. No normal tool
may assume the C64RE development repo, `samples/`, or process `cwd`.

Required behavior:

- The LLM can say: "I have this `.d64` / `.g64` / `.crt` / `.prg` / `.duckdb`
  here" and pass that path to the relevant tool.
- Tools resolve paths through the project/path resolver, not through hard-coded
  repo-relative paths.
- Tools accept absolute paths and project-relative paths.
- Project-relative paths resolve against the active C64RE project root, not the
  MCP server install directory.
- Repo samples are dev fixtures only and must require an explicit dev/sample
  mode.
- Any tool that still requires repo-root resources must be marked advanced or
  fixed.

This rule is part of the use-case matrix. Every tool row must classify its path
behavior:

```ts
pathMode:
  | "no-path"
  | "project-relative-ok"
  | "absolute-ok"
  | "project-or-absolute-ok"
  | "repo-dev-only"
  | "broken-cwd-coupled";
```

`broken-cwd-coupled` is a fix/retire candidate, never acceptable for default.

## 1. Purpose

Create a complete use-case inventory for **every MCP tool**. The current tool
surface was classified by namespace/tier, but that is not enough. Each tool must
answer:

- which product workflow lane it belongs to;
- when an LLM should use it;
- when an LLM must not use it;
- which adjacent tool supersedes or complements it;
- whether it is default, advanced, oracle-only, maintenance-only or obsolete;
- which end-to-end use-case proves it belongs in the product.

No tool may remain "probably useful" or "historical". If a tool cannot be tied
to the LLM-human swimlane or to a deliberate advanced/operator function, it is a
retirement candidate.

## 2. Tool Universe

The audit source is the generated inventory:

- `docs/tool-surface-inventory.json`
- `docs/tool-surface-inventory.md`

The current inventory is approximately 270+ tools and changes as Specs 725/726
land. The exact count is not hard-coded; the gate reads the generated inventory.

## 3. Required Classification Fields

Create `docs/mcp-tool-usecase-matrix.md` and
`docs/mcp-tool-usecase-matrix.json`. Every registered tool gets exactly one row.

Required fields:

```ts
interface McpToolUseCaseRow {
  name: string;
  namespace: string;
  sourceFile: string;
  tier: "default" | "advanced";
  role:
    | "workflow"
    | "knowledge-read"
    | "knowledge-write"
    | "media-ingress"
    | "static-analysis"
    | "disassembly"
    | "runtime-control"
    | "runtime-monitor"
    | "runtime-inspect"
    | "trace-capture"
    | "trace-query"
    | "change-intervention"
    | "view-docs"
    | "internal-dev-oracle"
    | "maintenance"
    | "format-forensics"
    | "debug-only"
    | "obsolete";
  swimlane:
    | "entry-project-baseline"
    | "runtime-explore"
    | "freeze-inspect"
    | "trace-capture"
    | "trace-analysis"
    | "disassembly-improve"
    | "asset-linking"
    | "change-intervention"
    | "validation"
    | "internal-dev-only"
    | "operator-maintenance"
    | "none";
  useWhen: string;
  notFor: string;
  useInstead?: string;
  adjacentTools: string[];
  e2eUseCases: string[];
  keepDecision: "keep-default" | "keep-advanced" | "rename" | "merge" | "retire";
  pathMode:
    | "no-path"
    | "project-relative-ok"
    | "absolute-ok"
    | "project-or-absolute-ok"
    | "repo-dev-only"
    | "broken-cwd-coupled";
  notes?: string;
}
```

## 4. Swimlane-Aligned Buckets

### 4.1 Entry / Project Baseline

Tools here guide an LLM into the project and keep progress in the knowledge
store:

- onboarding/status;
- workflow selection;
- findings/questions/entities;
- artifact listing/reading;
- dashboard/view generation.

If a project-entry tool does not persist or read project state, explain why it
exists.

### 4.2 Runtime Explore

Default tools here let an LLM run the real Headless product runtime:

- start/status/run/snapshot;
- media mount/swap/unmount/browse;
- type/joystick/load PRG;
- render screen.

Rules:

- This is normal workflow, not advanced.
- No old mode flags, no lockstep, no legacy drive/CPU path.
- V3 WebSocket is not the LLM's required path.

### 4.3 Freeze / Inspect

Tools here inspect a paused or checkpointed state:

- monitor registers/memory/disassembly;
- frozen VIC inspect;
- checkpoint/dump references where relevant.

### 4.4 Trace Capture

Tools here create durable runtime evidence:

- live-session trace start via `trace_out`;
- marks;
- finalize;
- trace status.

This bucket is incomplete until Spec 726 lands.

### 4.5 Trace Analysis

Tools here query DuckDB evidence:

- `trace_store_*`;
- `runtime_query_events`;
- swimlane;
- taint;
- follow-path;
- loader profile.

These are default if they are required by the normal LLM RE workflow.

### 4.6 Static Analysis / Disassembly

Tools here analyze media/payloads and create assembly/annotations:

- PRG analysis;
- disassembly;
- address/range inspection;
- ROM reference lookup;
- annotation proposal/import.

### 4.7 Change / Intervention

Tools here support patching, code overlays, branch experiments, rebuild
verification and future intervention UI.

If a tool is not implemented yet, it must be absent or marked future/deferred,
not exposed as if production-ready.

### 4.8 Internal Dev Oracle / VICE

All `vice_*` tools are internal-dev-only oracle tools.

Use when:

- MCP/core developers are validating C64RE emulator behavior during internal
  development;
- a port-fidelity question requires comparison with VICE behavior or source.

Not for:

- normal project workflow;
- initial runtime runs;
- replacing Headless trace capture.
- external LLM use of C64RE as a product.

External/product LLM workflows must use the C64RE Headless core, monitor,
inspect and trace tools. VICE is not a fallback for user projects.

### 4.9 Maintenance / Operator

Backfill, dedupe, repair, registration, bulk import, sandbox, low-level format
forensics and build helpers stay advanced unless a specific LLM workflow needs a
small facade.

## 5. Required Output Shape

The matrix must include:

1. A full tool table sorted by swimlane then role.
2. A default-surface table.
3. An advanced-surface table.
4. A retire/merge/rename candidate table.
5. A "tool gaps" table listing missing tools needed by the swimlane.

Example gap rows expected today:

- live Headless trace capture writer (Spec 726);
- trace mark/finalize MCP tools (Spec 726);
- trace writer/reader schema alignment: convenience readers must consume the
  same `trace_run` / `trace_event` / `trace_mark` schema produced by the live
  writer, not old `meta` / `instructions` tables;
- code-overlay/intervention facade (Spec 711, later);
- rewind/timeline facade (Spec 712, later).

## 6. Gates

Create `scripts/probe-mcp-tool-usecase-matrix.mjs`.

It must assert:

- every tool in `docs/tool-surface-inventory.json` appears exactly once in
  `docs/mcp-tool-usecase-matrix.json`;
- no row has empty `useWhen` or `notFor`;
- every default tool has at least one `e2eUseCases` entry;
- every trace reader tool has a writer schema version or adapter listed;
- no default trace reader is classified as complete if it only works through
  raw SQL;
- every `vice_*` row has `role="internal-dev-oracle"` and `tier="advanced"`;
- every `runtime_drive_*` / `runtime_drive_session_*` row is advanced;
- no row has `keepDecision="keep-default"` with `swimlane="none"`;
- no default row has `pathMode="repo-dev-only"` or
  `pathMode="broken-cwd-coupled"`;
- all retire/merge candidates name a successor or reason.

Required gates:

```sh
npm run build:mcp
node scripts/probe-tool-surface.mjs
node scripts/probe-mcp-tool-usecase-matrix.mjs
```

No `runtime:proof`; this is API/product-surface work.

## 7. Acceptance

Accepted when a fresh LLM can inspect the matrix and answer:

- "Which tool starts a project?"
- "Which tool starts Headless?"
- "Which tool writes a durable trace?"
- "Which tool queries a trace?"
- "Which tool disassembles a payload?"
- "Which tool records a finding?"
- "Which tools are not for normal workflow?"

If the answer requires reading implementation source or old spec history, this
spec is not done.

Internal-dev-only tools are audited for maintainers and guards, but they are not
part of the consuming LLM's decision model.
