# Spec 728 — MCP LLM Playbooks

**Status:** READY  
**Owner:** MCP product workflow / agent guidance  
**Depends on:** Specs 727, 725, 726  
**Source:** `docs/llm-human-c64re-swimlane.md`

## 0. Hard Path-Portability Rule

The playbooks must work when the LLM calls the MCP from an arbitrary directory.
They must not assume the MCP server is started from the C64RE development repo.

The LLM may begin with statements like:

- "I have `./game.d64` here."
- "I have `/Users/alex/projects/foo/trace.duckdb`."
- "Open this `.crt` from my current project folder."

Playbooks must instruct the LLM to:

1. Treat user-supplied media/trace paths as first-class inputs.
2. Prefer project-relative or absolute paths.
3. Register important inputs as project artifacts.
4. Never rely on repo `samples/` unless the user explicitly asks for a dev
   sample.
5. Report path resolution failures clearly and ask for the missing file, not
   silently fall back to repo fixtures.

## 1. Purpose

Write the instructions an LLM actually needs in order to use the MCP as a
product, not as a bag of tools.

The playbooks are ordered by intent, not by implementation namespace. They tell
the LLM:

- what to do first;
- which tools to call;
- what to persist;
- what not to do;
- when to ask the human;
- which next branch to propose.

## 2. Output Files

Create:

- `docs/mcp-llm-playbooks.md` — human-readable instructions.
- `docs/mcp-llm-playbooks.json` — machine-readable playbooks for future prompt
  injection / agent contract.

Each playbook has:

```ts
interface McpLlmPlaybook {
  id: string;
  title: string;
  userIntentExamples: string[];
  preconditions: string[];
  steps: {
    actor: "llm" | "human" | "mcp" | "runtime" | "tracedb" | "ui";
    action: string;
    tools: string[];
    persist: string[];
    askHumanWhen?: string;
  }[];
  stopConditions: string[];
  nextActions: string[];
  forbiddenShortcuts: string[];
}
```

## 3. Required Playbooks

### 3.1 New Project Onboarding

Use when the user says "make this folder a C64 project" or asks to connect to
C64RE.

Must cover:

- `agent_onboard`;
- project status/profile;
- role/workflow selection;
- media input instruction;
- first next action.

### 3.2 Media Inventory

Use when media has been added or the project has no inventory.

Must cover:

- accepting arbitrary `.d64`, `.g64`, `.crt`, `.prg` paths from the user;
- disk/CRT/PRG inspection;
- extraction;
- payload list;
- initial findings/questions;
- project dashboard refresh.

### 3.3 Trace-First Runtime Discovery

Use when the fastest way to understand the project is to run it first.

Must cover:

- starting from arbitrary media paths, not repo samples;
- writing trace output to a project-relative or absolute `.duckdb` path;
- Headless start/mount;
- trace_out + domains once Spec 726 lands;
- human-assisted input;
- marks;
- render/checkpoint;
- trace queries;
- findings and next disassembly candidates.

Normal disk boot trace sequence for `.d64` / `.g64`:

```text
runtime_session_start({
  disk_path: "<user/project .d64 or .g64>",
  trace_out: "traces/<run>.duckdb",
  trace_domains: ["c64-cpu", "drive8-cpu", "iec", "memory"]
})

runtime_session_run({
  session_id: "<id>",
  max_instructions: 2000000,
  until: { kind: "stable_screen", frames_stable: 3 }
})

runtime_mark({ session_id: "<id>", label: "basic-ready" })

runtime_type({
  session_id: "<id>",
  text: "LOAD\"*\",8,1\\rRUN\\r"
})

runtime_session_run({
  session_id: "<id>",
  max_instructions: 10000000,
  until: { kind: "stable_screen", frames_stable: 5 }
})

runtime_mark({ session_id: "<id>", label: "loaded-or-title" })
runtime_trace_finalize({ session_id: "<id>" })
```

If the disk requires directory load or manual command choice, use
`LOAD\"$\",8` for directory discovery first, then type the selected `LOAD`
command. If the program autostarts or uses a custom loader after the first
KERNAL load, keep tracing and add marks around human-visible phases.

The playbook must use convenience readers first:

- `trace_store_info`
- `trace_store_top_pcs`
- `trace_store_bus_find`
- `runtime_query_events`
- `runtime_swimlane_slice`

It must not switch to raw `trace_store_query` because wrappers are broken. Raw
SQL is only for exploratory custom questions after the supported reader shape
works.

### 3.4 Disassembly-First Static Pass

Use when the media/payload is simple enough to disassemble before runtime, or
when the user explicitly asks for code first.

Must cover:

- PRG analysis;
- disassembly;
- ROM lookup;
- annotation proposal;
- validation by later trace.

### 3.5 Disassembly + Trace Validation

Use when labels, entry points or code/data boundaries need proof.

Must cover:

- targeted trace;
- executed-PC sets;
- memory read/write sets;
- PC-to-source resolution;
- annotation updates with evidence refs.

### 3.6 Human-Assisted Loader / Protection Investigation

Use when interaction is necessary: fire button, menu choices, passwords, disk
swaps, copy protection prompts.

Must cover:

- asking the human for input;
- runtime input tools;
- trace marks;
- IEC/DD00/drive queries;
- open questions when human context is missing.

### 3.7 Frozen Visual Inspect To Code/Data

Use when the human points at a logo, text, sprite, charset or screen region.

Must cover:

- checkpoint/freeze;
- `runtime_vic_inspect_at`;
- trace queries around writes;
- link visual evidence to RAM/file/payload/disassembly.

### 3.8 Change / Patch / Crack / Port Iteration

Use when the project moves from analysis to intervention.

Must cover:

- recording the intended change;
- keeping before/after evidence;
- using runtime and trace to validate;
- recording success/failure and next branch.

### 3.9 Internal Dev Oracle / VICE

This is **not** a normal external LLM project playbook.

Use only when:

- developing/debugging the C64RE MCP/core itself;
- validating a port-fidelity question internally;
- explicitly working on emulator implementation, not a user's RE project.

Must forbid:

- exposing VICE as a product workflow path;
- using VICE trace as a replacement for C64RE Headless evidence;
- telling an external LLM/user to switch to VICE.

It must also forbid hidden repo-sample fallback. VICE may compare against a
specific internal dev fixture/artifact, not an implicit dev fixture.

### 3.10 Operator / Maintenance

Use only when the project store itself needs repair/backfill/dedupe/import.

Must cover:

- asking before destructive or bulk changes;
- not using maintenance tools to solve normal analysis questions.

## 4. Global LLM Rules

Every playbook must include these rules:

1. Persist important results in project knowledge, not only in chat.
2. After each substantive step, call or produce the equivalent of
   `agent_record_step`.
3. Propose next action using current evidence.
4. Do not enable `C64RE_FULL_TOOLS` as a normal solution.
5. Do not use V3 WebSocket directly when an MCP tool exists.
6. Use the C64RE Headless runtime for product work. VICE is internal-dev-only
   and must not appear in normal user-project playbooks.
7. Prefer bounded evidence queries over dumping huge raw traces into chat.
8. Never assume repo-relative `samples/` or process `cwd` for user media.
9. Do not use raw SQL as a workaround for broken product readers. Fix or report
   the reader/schema mismatch.

## 5. Gates

Create `scripts/probe-mcp-llm-playbooks.mjs`.

It must assert:

- all required playbook IDs exist;
- every tool named by a playbook exists in the current tool inventory;
- every default tool appears in at least one playbook or is explicitly marked
  "supporting";
- no `vice_*` tool appears outside the Internal Dev Oracle playbook;
- no advanced maintenance tool appears in normal user playbooks;
- runtime trace capture playbooks include Spec 726 writer tools once they land.

Required gates:

```sh
npm run build:mcp
node scripts/probe-mcp-tool-usecase-matrix.mjs
node scripts/probe-mcp-llm-playbooks.mjs
```

## 6. Acceptance

A new LLM should be able to read `docs/mcp-llm-playbooks.md` and execute a
project without knowing the sprint/spec history.

If it still asks "which of these 270 tools do I use?", this spec is not done.
