# Artifact Access

Generic file access for everything the analysis pipeline writes into a
project (ASM, JSON, SYM, MD).

## Tools

| Tool | Description |
|---|---|
| `read_artifact` | Read a generated file (ASM, JSON, SYM, MD). Truncated to a configurable byte cap for context safety. |
| `list_artifacts` | List analysis artifacts in a project subdirectory. |
| `build_tools` | Recompile the bundled TRXDis pipeline (`npm run build`). |

## Context-size note

C64 binaries themselves are at most 64 KB, but a fully annotated
disassembly with comments, labels, and segment headers can grow well
beyond that. `read_artifact` enforces a byte cap and reports truncation;
the LLM is expected to chunk via `slice` parameters or use the
[knowledge layer](knowledge.md) views (`annotated-listing`, `memory-map`)
to focus on a specific window instead of pulling whole files into
context.
