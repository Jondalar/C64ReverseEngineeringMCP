# LLM Debug Stack Notes (Sprint 107 / Specs 122-126) — v1

Sprint 107 ships V1's LLM-debug surface: trace channel registry,
event-indexed search, VICE swimlane (existing), scenario DSL,
knowledge integration hooks.

## v1 status

| Spec | Status     | Where                                                          |
|------|------------|----------------------------------------------------------------|
| 122 M5.1 trace channels | **Covered** | `trace/channels.ts:TraceRegistry` — per-channel ring or jsonl mode |
| 123 M5.2 event index | **Covered** | `trace/event-index.ts:buildEventIndex()` + findEventsByPc/Addr |
| 124 M5.3 VICE swimlane | **Smoke-only** | Existing `scripts/swimlane-diff.mjs` (Spec 095) preserved; align modes deferred to v2 |
| 125 M5.4 scenario DSL | **Covered** | `scenario/dsl.ts:parseScenario()` — JSON shape v1; YAML loader deferred |
| 126 M5.5 knowledge integration | **Hooks only** | scenario `knowledge: true` + `findings: [...]` + `tasks: [...]` parse; runtime hookup gated on scenario runner v2 |

`npm run smoke:llm-debug` — 22/22 pass.

## Trace channel registry (Spec 122)

```ts
import { TraceRegistry } from "src/runtime/headless/trace/channels.ts";
const reg = new TraceRegistry();

// Ring buffer (in-memory, last N events).
reg.configure("iec", { mode: "ring", capacity: 10000 });

// JSONL file (append per event).
reg.configure("cpu", { mode: "jsonl", path: "/tmp/cpu-trace.jsonl" });

// Producer side:
reg.publish("iec", session.c64Cpu.cycles, { atn: false, clk: true });

// Reader side:
const events = reg.getRing("iec");
```

Registered channel names: `cpu | io | iec | drive_pc | gcr | vic | cia | sid | keyboard | joystick | eof`.

Existing channels (iec, drive_pc, eof) keep their existing producer
sites; the registry is the new aggregate point. Plumbing each
producer through the registry happens incrementally — v1 ships the
registry shape so downstream consumers can subscribe.

## Event-indexed search (Spec 123)

```ts
import { buildEventIndex, findEventsByPc, findEventsByAddr } from "src/runtime/headless/trace/event-index.ts";

const idx = buildEventIndex("/tmp/cpu-trace.jsonl");
console.log(`pc $ee13 hits: ${(idx.pcOffsets.get(0xee13) ?? []).length}`);

// Fetch matching lines:
const r = findEventsByPc("/tmp/cpu-trace.jsonl", idx, 0xee13, 50);
for (const h of r.hits) console.log(`@${h.offset} ${h.line}`);
```

Index entries:
- `pcOffsets`: `pc → byte offsets` for every event with `data.pc`
- `addrReadOffsets / addrWriteOffsets`: `addr → byte offsets` for
  events with `data.kind === "r" | "w"` + `data.addr`
- `iecEdgeOffsets`: every event with `channel === "iec"`
- `byChannel`: per-channel byte offsets for arbitrary lookups

`saveEventIndex` writes `<trace>.idx` JSON. Re-builds are fast
enough that incremental update is not yet needed.

## Scenario DSL (Spec 125 + 126)

```json
{
  "version": 1,
  "media": { "disk": "samples/synthetic/1byte.g64" },
  "resetProfile": "pal-default",
  "mode": "true-drive",
  "steps": [
    { "atFrame": 30, "kind": "type", "text": "LOAD\"X\",8,1\r" }
  ],
  "expect": [{ "kind": "status90", "bit": "EOI" }],
  "artifacts": [{ "kind": "screenPng", "path": "/tmp/out.png" }],
  "knowledge": true,
  "findings": [
    { "title": "Boot loader at $02A7",
      "addressRange": { "start": 681, "end": 771 },
      "tags": ["loader"] }
  ]
}
```

Validation: version must be 1; media must declare disk/prg/crt;
steps must be an array. Anything else permissive.

YAML loader: thin wrapper around a YAML→JSON conversion library;
deferred since `JSON.parse` covers most agent-driven scenarios. Node
ships no YAML by default; v2 can add `js-yaml` when actually needed.

Knowledge hooks (`knowledge: true` + `findings: [...]` + `tasks: [...]`)
parse and validate. Runtime side that calls the MCP knowledge tools
ships with the scenario runner (Spec 125 v2 / Sprint 110 ops).

## Open follow-ups

- Plumb every existing trace producer (iec, drive_pc, eof) through
  the new TraceRegistry instead of their bespoke ring buffers.
- Swimlane align modes (`cold-boot`, `eof`, `pc=...`, `cycle=...`).
- YAML loader.
- Scenario runner that consumes `knowledge: true` + writes via MCP
  knowledge tools.

## Files

- `src/runtime/headless/trace/channels.ts`
- `src/runtime/headless/trace/event-index.ts`
- `src/runtime/headless/scenario/dsl.ts`
- `src/runtime/headless/c64/llm-debug-tests.ts` (4 suites, 22 checks)
- `scripts/smoke-llm-debug.mjs` + `npm run smoke:llm-debug`
