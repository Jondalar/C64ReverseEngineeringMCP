# Spec 708 - Declarative Trace Definitions and TraceDB Control

Status: DRAFT (2026-05-23 CEST)
Depends: Specs 619, 623, 701, 705, 707
Consumed by: Spec 721 runtime-informed annotation; Specs 710-712
Owner: runtime evidence / monitor / knowledge

## 1. Purpose

Replace one-off diagnostic scripts and ad-hoc trace switches with declarative,
reusable runtime trace definitions. The same definition must be usable by a
human in the UI, an LLM through APIs, and reproducible experiment playback.

Tracing records the live runtime the user is actually viewing. It must not
create another diagnostic emulator path.

## 2. Binding Decisions

### 2.1 Structured Definition Is Canonical

The canonical object is a versioned structured definition. A text field or
future UI builder compiles to this object; text syntax is not a second
authority.

```ts
interface RuntimeTraceDefinition {
  id: string;
  version: number;
  name: string;
  domains: ("c64-cpu" | "drive8-cpu" | "iec" | "vic" | "sid" | "memory")[];
  triggers: TraceTrigger[];
  captures: TraceCapture[];
  stop?: TraceStopCondition;
  retention: "transient" | "evidence";
  checkpointPolicy?: "none" | "at-start" | "on-trigger" | "at-stop";
}
```

Definitions express *what* to observe and when. DuckDB is the query/storage
engine, not the user-facing definition language.

### 2.2 Trace Runs Bind to Checkpointed Experiments

A trace run records:

- definition/version;
- starting checkpoint reference where retained;
- media identity and intervention branch identity;
- runtime cycle range;
- explicit user/agent marks;
- resulting DuckDB evidence reference.

This makes later annotation and comparison reproducible.

### 2.3 Hot-Path Cost Is Explicit

No always-on full event firehose is introduced. Definitions compile into
minimal runtime taps, installed only while active. Each run reports event
counts, bytes written and measurable runtime overhead.

## 3. Initial Definition Surface

Required first-pass triggers:

- PC/address range execution in C64 or drive CPU;
- memory read/write address/range;
- IEC line transition;
- raster line/cycle window;
- breakpoint/monitor stop;
- manual mark.

Required first-pass captures:

- CPU register/PC/cycle row;
- memory access/value row;
- IEC line-state row;
- selected VIC register/raster row;
- checkpoint reference and media/branch metadata.

Existing specialized analysis tools such as swimlane, taint and path-following
consume retained trace data; they are not recreated here.

## 4. Monitor, API and UI Surface

Spec 623's TraceDB commands are implemented against a named definition:

```text
tracedb start "<definition-id>" ["<output>"]
tracedb stop
tracedb status
tracedb mark "<label>"
```

Backend APIs must also support:

```text
trace/definition/list
trace/definition/put
trace/definition/validate
trace/run/start
trace/run/stop
trace/run/status
trace/run/mark
```

The first UI may be a definition text editor plus validate/start/stop/status.
A graphical builder is optional later and must compile to the same structure.

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 708.1 | Inventory existing DuckDB/event/trace taps and map reusable sources; do not add parallel diagnostics. | none |
| 708.2 | Define JSON schema, validation, stable IDs and experiment/checkpoint linkage. | 707 |
| 708.3 | Compile initial triggers/captures into bounded runtime taps and DuckDB tables. | 708.1-2 |
| 708.4 | Implement monitor/API control and explicit marks. | 708.3 |
| 708.5 | Add minimal UI authoring/control surface using the canonical schema. | 708.4 |
| 708.6 | Connect retained trace refs to Spec 721 consumers. | 708.3 |

## 6. Acceptance

1. A declared C64-PC + IEC trace can be started from monitor or API, records
   identical schema, and can be queried from DuckDB.
2. A retained run links to its definition, start checkpoint, media identity
   and cycle range.
3. `tracedb mark` produces an evidence marker usable by paused VIC inspection
   and later annotation.
4. A known fastloader or KERNAL LOAD trace is reproducible without adding a
   title-specific diagnostic script.
5. Runtime overhead with no active trace is negligible; active trace reports
   its measured cost and bounded storage behavior.

## 7. Non-Goals

- Semantic annotation synthesis itself (Spec 721).
- Rewind/event replay implementation (Spec 712).
- Replacing monitor breakpoints or flow-focus stepping.
- Permanently recording every normal live session.

## 8. References

- `specs/619-vice-headless-kpi-trace-contract.md`
- `specs/623-vice-monitor-debugger.md` section 8
- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/721-runtime-informed-annotation.md`
