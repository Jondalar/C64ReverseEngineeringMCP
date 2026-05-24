# C64 Reverse Engineering MCP

C64RE is a reverse-engineering workbench for Commodore 64 software. It
pairs a human reverse engineer with an LLM and gives them a shared,
controllable C64 — a headless runtime you can snapshot, rewind, replay,
and inspect cycle by cycle — fused with a disassembly pipeline that turns
raw bytes into explained, named, semantic source.

The aim isn't to boot software. It's understanding: turning disks,
cartridges, PRGs, traces, and screenshots into durable project knowledge,
built by a human and an LLM **together** — the LLM proposes structure and
meaning, the human steers and confirms, and the runtime proves or refutes
every claim against a real execution.

## The Killer Combination

Semantic disassembly tells you what code *means*. A controllable runtime
lets you *watch it happen*. C64RE puts both on one timeline:

- rewind to the exact cycle a fastloader flips a bank,
- overlay the named, explained routine onto the live execution,
- replay that moment with findings and labels attached.

Plain emulators run code but don't know what it means. Disassemblers
describe code but can't run it. Meaning + execution, human + LLM — that's
the point.

## The Runtime

A TypeScript C64 + 1541 + cartridge runtime, controllable and inspectable
in ways neither real hardware nor a normal emulator offers:

- **time travel** — snapshot / `.c64re` persistence, checkpoint ring,
  rewind & replay
- **code overlay** — map live execution onto disassembly and findings
- **observation** — DuckDB traces, swimlanes, monitor, frozen-frame
  exploration
- **live browser workbench (V3)** — the backend owns the clock, monitor,
  media, trace, and audio; the browser commands and visualizes
- **frame-locked audio**, media ingress, mutable disks & cartridges

It already boots real scene software end-to-end — multi-stage cracks,
custom fastloaders, EasyFlash cartridges — and its fidelity is gated on
every change.

## The Disassembly Pipeline

Bytes → structure → meaning:

1. deterministic extraction (PRG / CRT / D64 / G64; banks, sectors,
   xrefs, candidate segments)
2. heuristic disassembly (full 6502 ISA incl. undocumented opcodes)
3. **semantic annotation — the heart of it**: the LLM reads the whole
   listing and proposes segment reclassifications, labels, and routine
   explanations; the human reviews
4. verification: byte-identical rebuild (`cmp -l`)

The valuable phase is the semantic one — where `segment $7C21-$7F4F
contains code` becomes `loader-side dispatcher: switches KERNAL serial →
custom fastloader, hands control to scene init`.

## Human + LLM, With A Contract

The collaboration has structure, not just chat. Work moves through a
defined workflow, and the LLM operates under explicit roles:

- **analyst** — forms and tests hypotheses
- **cartographer** — maps structure, memory, and flows
- **implementer** — writes and verifies

Progress persists as entities, findings, relations, flows, tasks, and
open questions — durable knowledge that survives across sessions, not
console logs. The Workspace UI renders that knowledge; it never becomes a
second analysis engine.

See [docs/workflow.md](docs/workflow.md) (workflow contract),
[docs/agent-doctrine.md](docs/agent-doctrine.md) (roles), and
[docs/re-phases.md](docs/re-phases.md) (seven-phase model).

## Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│ LLM clients / human users                                      │
│ Claude Code · Codex · Cursor · Browser UI                     │
└──────────────────────────────┬────────────────────────────────┘
                               │ MCP tools / HTTP / WebSocket
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ C64RE MCP Server                                               │
│                                                               │
│ runtime evidence                                               │
│ - Headless TS C64 + 1541 + cartridge runtime                   │
│ - snapshots · checkpoint ring · rewind / replay                │
│ - DuckDB trace store · swimlanes · monitor                     │
│ - VICE oracle / monitor / traces (correctness reference)       │
│                                                               │
│ disassembly + project knowledge                                │
│ - TRXDis analysis / heuristic + semantic disassembly           │
│ - CRT, disk, G64, compression, BWC helpers                     │
│ - artifacts · entities · findings · relations                  │
│ - flows · tasks · open questions · views                       │
└──────────────────────────────┬────────────────────────────────┘
                               │ view models / runtime streams
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ User Interfaces                                                │
│                                                               │
│ Emulator UI / V3 Workbench                                     │
│ - live C64 screen · media · monitor · inspector                │
│ - keyboard / joystick · trace swimlanes · frozen explore       │
│                                                               │
│ Workspace UI                                                   │
│ - dashboard · docs · memory · cartridge · disk                 │
│ - load sequence · flow graph · annotated listing · activity    │
└───────────────────────────────────────────────────────────────┘
```

## Setup

```bash
git clone https://github.com/Jondalar/C64ReverseEngineeringMCP.git
cd C64ReverseEngineeringMCP
npm install
npm run build
```

The bundled TRXDis pipeline is built automatically.

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `C64RE_PROJECT_DIR` | Working directory for the RE project | Yes |
| `C64RE_TOOLS_DIR` | Override: external TRXDis build instead of bundled | No |
| `C64RE_KICKASS_JAR` | Override path to KickAssembler jar | No |
| `C64RE_64TASS_BIN` | Override path to `64tass` | No |
| `C64RE_EXOMIZER_BIN` | Override path to `exomizer` | No |
| `C64RE_BYTEBOOZER_BIN` | Override path to `b2` / ByteBoozer 2 | No |
| `C64RE_VICE_BIN` | Override path to `x64sc` | No |
| `C64RE_VICE_CONFIG_PATH` | Override source `vicerc` copied into VICE sessions | No |
| `C64RE_VICE_CONFIG_DIR` | Override source VICE config dir, with `vicerc` inside | No |

### Claude Code

Add `.mcp.json` at the RE-project root:

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "npx",
      "args": ["tsx", "/path/to/C64ReverseEngineeringMCP/src/cli.ts"],
      "env": { "C64RE_PROJECT_DIR": "/path/to/your/re-project" }
    }
  }
}
```

Use a full path to `npx` if your shell uses `nvm`.

### Codex

```toml
[mcp_servers.c64re]
command = "zsh"
args = ["-lc", "cd /path/to/C64ReverseEngineeringMCP && NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx src/cli.ts"]
env = { C64RE_PROJECT_DIR = "/path/to/your/re-project" }
```

## Running The Workbenches

**V3 Workbench** — the live emulator/debugger. The backend owns the
C64/1541 clock, monitor state, media state, trace capture, and WebSocket
streams; the browser is a command and visualization client.

```bash
npm run v3:server           # runtime WebSocket/API server
npm run ui:v3:dev           # V3 browser client
npm run ui:v3:build         # production V3 bundle
```

Runtime / backend / UI details: [docs/tools/headless.md](docs/tools/headless.md).

**Workspace UI** — the project-knowledge browser: artifacts, findings,
relations, memory maps, media views, disassembly context, and activity.

```bash
npm run ui:build
npm run ui:serve            # API + bundled UI on http://127.0.0.1:4310
npm run ui:dev              # Vite live reload on http://127.0.0.1:4311
```

## Tool Surface

Per-area docs:

| Area | Doc |
|---|---|
| Analysis pipeline (`analyze_prg`, `disasm_prg`, `assemble_source`, reports) | [docs/tools/analysis.md](docs/tools/analysis.md) |
| CRT cartridges and bank layouts | [docs/tools/crt.md](docs/tools/crt.md) |
| Disk images, D64/G64 extraction, low-level media data | [docs/tools/disk.md](docs/tools/disk.md) |
| Compression and depack triage | [docs/tools/compression.md](docs/tools/compression.md) |
| BWC bit-stream codec | `src/bwc-bitstream-ts/` |
| C64Ref BASIC/KERNAL/ROM lookup | [docs/tools/c64ref.md](docs/tools/c64ref.md) |
| VICE runtime, monitor, debugger, trace oracle | [docs/tools/vice.md](docs/tools/vice.md) |
| Headless TS C64 + 1541 runtime | [docs/tools/headless.md](docs/tools/headless.md) |
| 6502 sandbox | [docs/tools/sandbox.md](docs/tools/sandbox.md) |
| Project knowledge tools | [docs/tools/knowledge.md](docs/tools/knowledge.md) |
| Artifact access | [docs/tools/artifacts.md](docs/tools/artifacts.md) |
| Agent workflow doctrine | [docs/agent-doctrine.md](docs/agent-doctrine.md), [docs/re-phases.md](docs/re-phases.md) |

## Workflow

Project-first:

1. initialize or audit a project workspace
2. register real input media and source artifacts
3. run deterministic extraction/disassembly
4. import outputs into project knowledge
5. record semantic findings, tasks, open questions, and relations
6. collect runtime evidence only when it answers a concrete question
7. aggregate traces/snapshots into reusable artifacts
8. rebuild UI views

Headless and VICE runs are evidence providers. Their output should be
registered as artifacts and linked back to findings/entities instead of
living only as console logs or loose markdown.

## Planning & Status

- [PLAN.md](PLAN.md) — roadmap + working baseline + step gates
- `specs/` — implementation specs and ADR follow-ups
- [docs/runtime-gates.md](docs/runtime-gates.md) +
  [docs/runtime-proof-baseline-2026-05-16.md](docs/runtime-proof-baseline-2026-05-16.md)
  — the runtime proof-gate truth (the single "is this green" source)
- [CLAUDE.md](CLAUDE.md) — working doctrine for contributors and agents

## License & Credits

C64RE MCP is licensed under the GNU General Public License v3.0 or later
(`GPL-3.0-or-later`). See [LICENSE](LICENSE).

VICE is C64RE's correctness oracle: where the runtime ports C64, 1541,
VIC-II, CIA, VIA, IEC, GCR, monitor, or trace behavior, it does so
faithfully and validates against
[VICE](https://vice-emu.sourceforge.io/), the Versatile Commodore
Emulator. VICE is licensed under the GNU General Public License version 2
or later; C64RE uses the "or later" permission and distributes under
GPL-3.0-or-later. Thank you to the VICE project and its contributors.

Additional notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### ROMs And Third-Party Media

Commodore ROM images, commercial disks, cartridges, and other copyrighted
media are not part of this project license. If runtime tests or examples
need ROMs, provide them locally through your own legally obtained copies or
through files whose licenses permit redistribution.
