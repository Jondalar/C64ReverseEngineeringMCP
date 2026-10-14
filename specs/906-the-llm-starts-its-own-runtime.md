# Spec 906 — The LLM starts its own full runtime for a purpose, works in it, and ends it

**Status:** PROPOSED (2026-10-14).
**Repo:** C64RE. The daemon is the same binary on its own port (`--headless`), so every capability
is already there; what is missing is C64RE reaching it. TRX64 gets a part only where a scenario
shows the daemon is the limit (D8), by decision recorded in §5, delegated to the TRX64 session.
**Number:** 906 (registry: `specs/README.md`).
**Origin:** issue #78 (2026-10-14, the reporter's LLM on Impossible Mission II): parallel projects
compete for the one shared runtime. The owner, same day: "das LLM sollte quasi einen N. Daemon vom
Featureset starten können, isoliert, damit arbeiten auf einem anderen Port … so wie alles, was
kein Menschen-UI bedient … ein für alle mal aus der Welt" — and: "sandboxes sind nicht endlos, die
werden für einen Zweck gestartet und bei Erreichen oder Fail sauber beendet."
**Depends on:** nothing. Retires the "no session id" rule of Spec 836 (§3 D1).

---

## §1 The problem

**Who:** an LLM in a project — often one of several LLM sessions the same person runs side by side,
each in its own project.

**What it is trying to do:** the runtime work of reverse engineering, on a machine of its own:
mount the medium, run to a point, set a breakpoint, step, read the monitor, capture a trace, inspect
the VIC, rewind, try a poke, compare two states — interactively, call after call, the way the
shared session allows.

**What happens today:**
- There is ONE interactive machine: the shared session, which the human co-drives and the UI shows.
  Every LLM session on the computer that needs to step, breakpoint, trace or rewind must use it.
- `runtime_sandbox_run` gives a private machine for ONE call and then it is gone: no session id, so
  no stepping, breakpoints, monitor, trace (the tool does not expose the trace `runSandbox` already
  has, `src/reel/run-sandbox.ts:113-124`), rewind or second read (`specs/_archive/836-a-machine-of-your-own.md:76-100`,
  `docs/runtime-sandbox.md:136-143`).
- #78, measured: the IM II LLM needed a `drive-mechanism` capture (mount, type, until, run, render,
  trace start/finalize). Only the shared session offers that. After a daemon restart the shared
  session served another project (`projectMismatch … decided in the workbench UI's requester, not by
  a tool`), and the IM II validation was blocked until the other project let go.

**Why it matters:** two LLM sessions — or an LLM and the human — cannot both do real runtime work at
once. Each workaround (scripting everything into one sandbox call) is a patch on one use case; the
next use case hits the same wall.

**Worked example (after this spec):**

```
runtime_sandbox_start { purpose: "validate IM II extraction against a drive-mechanism capture",
                        media_path: "media/im2.g64", budget_minutes: 30 }
→ session_id "sb-im2-1", port 47311, ends by 15:42 at the latest

runtime_trace_start   { session_id: "sb-im2-1", domains: [...], hypothesis: "..." }
runtime_type          { session_id: "sb-im2-1", text: "LOAD\"*\",8,1\n" }
runtime_until         { session_id: "sb-im2-1", address: "$0880" }
runtime_monitor       { session_id: "sb-im2-1", command: "m 0880 08ff" }
runtime_trace_finalize{ session_id: "sb-im2-1" }   → capture under the project's trace root
validate_extraction   { capture_path: ... }
runtime_sandbox_end   { session_id: "sb-im2-1", outcome: "reached", summary: "manifest matches 624/624" }
```

The shared session was never touched; the other project's LLM did the same in `sb-gs-1` meanwhile.

### Parts (MECE)

- **P1 Start for a purpose.** A sandbox session is started with a stated purpose and a budget, on its
  own port, isolated, and named by a session id.
- **P2 The full feature set.** Every runtime tool that does not serve a human UI works on a sandbox
  session exactly as on the shared one.
- **P3 Isolation.** A sandbox session is invisible to the UI and to other C64RE processes, never
  reaches the shared session, and the shared session never reaches it.
- **P4 Ending.** It ends cleanly when the LLM reports the purpose reached or failed, and ends itself
  when the budget runs out, when it is left idle, or when its owner process dies — with what it
  produced kept and the outcome recorded.
- **P5 Long work inside it.** Captures and runs of tens of millions of cycles complete without
  tripping the host's call limit or the trace-index timeout.
- **P6 Doors and doctrine tell the truth.** Tool texts, docs and DOCTRINE describe the new shape;
  refusals that point at a door point at one that works.

## §2 Scenarios — what proves it is solved

Runtime scenarios spawn their own daemons on synthetic media built in the test — no third-party
bytes, never the shared daemon. They need the TRX64 daemon and ROMs: local pre-push gate.

```gherkin
Scenario: S1 start for a purpose
  When  runtime_sandbox_start { purpose, media_path, budget_minutes: 5 } is called
  Then  it answers a session id "sb-…", its port, the machine it booted, and the deadline
  And   the shared session's state (cycle, project, media) is byte-for-byte unchanged
  And   a call without a purpose, or without a budget, is refused by name

Scenario: S2 the full feature set, tool by tool
  Given a sandbox session with a synthetic PRG and disk
  When  every runtime tool on the parity list (D3) is called once with that session id
  Then  each answers as it does on a shared session given the same state (same fields, same values)
  And   the UI-only tools (D3's list) refuse a sandbox session id by name, saying why

Scenario: S3 two sandboxes and the shared session, side by side
  Given two sandbox sessions started by two different MCP processes, and the shared session running
  When  each is stepped, breakpointed and traced at the same time
  Then  none sees another's state; each trace holds only its own machine's events
  And   process B calling a tool with process A's sandbox id is refused ("not yours")
  And   the workspace UI lists only the shared session

Scenario: S4 ending: reached, failed
  When  runtime_sandbox_end { outcome: "reached" | "failed", summary } is called
  Then  the daemon is gone, its port free, its scratch removed
  And   captures and snapshots written to the project are kept, and the answer lists them
  And   the outcome, purpose, duration and artefacts are recorded in the project (agent step log)

Scenario: S5 ending itself: budget, idle, owner death
  When  the budget runs out / no tool call reaches it for the idle limit / its MCP process is killed
  Then  it ends within seconds, with a trace in progress finalized (not lost)
  And   the next call with its id answers "ended: <reason> at <time>", never "no such session"
  And   the outcome recorded is "budget" / "idle" / "owner gone"

Scenario: S6 a long capture inside a sandbox
  Given a sandbox session and a run of ≥ 60M cycles with drive-mechanism armed
  When  runtime_session_run and runtime_trace_finalize are called
  Then  neither fails on the host's call limit (long calls answer a job id; analysis_job_status completes them)
  And   the index exists, or the answer names the intact .c64retrace and the lazy index retry
  And   wall-clock and index-build time are recorded in §5

Scenario: S7 doors and doctrine
  Then  docs/runtime-sandbox.md, the tool texts, DOCTRINE.md rule 2 and CLAUDE.md rule 2 describe sandbox sessions as built
  And   the C64U "no live trace on the device" refusal names runtime_sandbox_start, and following it works
  And   trace_store_* read a store file while a C64U is selected (served by an emulator reader, not refused)
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | start for a purpose | `scripts/e2e-906-sandbox-session.mjs` → `e2e:906` | local gate; refusal half hermetic → `gates.yml` |
| S2 | P2 | full feature set | `e2e:906` walks the D3 parity list from code, so a new runtime tool without a sandbox verdict fails it | local gate |
| S3 | P3 | side by side | `e2e:906` (two MCP processes) | local gate |
| S4 | P4 | end reached/failed | `e2e:906` | local gate |
| S5 | P4 | end itself | `e2e:906` (short budget/idle values, killed owner) | local gate |
| S6 | P5 | long capture | `e2e:906` behind `C64RE_E2E_LONG=1`; one by-hand run on a real loader capture, numbers into §5 | local, by hand |
| S7 | P6 | doors + doctrine | `check:docs-current`, `check:doc-capability-claims`, `e2e:906` with `scripts/lib/fake-ultimate.mjs` | `gates.yml` + local gate |

## §3 Decision

- **D1 Doctrine.** Rule 2 becomes: one SHARED machine the human sees, plus sandboxes the LLM
  starts for a purpose — one-shot (`runtime_sandbox_run`, unchanged) or a session
  (`runtime_sandbox_start`). Every sandbox has a stated purpose and a budget, is invisible to the
  UI, and ends on reached / failed / budget / idle / owner gone. 836's "no session id" is retired
  with this reasoning in DOCTRINE.md: the defect it guarded against — debugging against a
  forgotten machine — is prevented by the purpose, the budget and the self-ending, not by refusing
  a second call.
- **D2 Start (P1).** `runtime_sandbox_start { purpose, budget_minutes, media_path?, model?,
  drive_type?, run?, idle_minutes? }` spawns `trx64-daemon --headless` on a free port through
  `SandboxSession` (keeper, ledger, scratch as today), binds it to the project (captures land in the
  project's trace root, not in scratch), and returns `sb-<slug>-<n>`. Budget default 30 min, max
  240 min; idle default 10 min. Max 4 live sandbox sessions per MCP process (ports and cores; the
  5th is refused naming the 4 and their purposes).
- **D3 Routing (P2).** The `runtimeDaemon` proxy (`src/runtime/backend.ts:149`) dispatches by
  session id: `sb-…` → that sandbox's client, anything else → the active backend as today. So every
  tool that takes a `session_id` works unchanged. The parity list lives in code
  (`src/runtime/sandbox-parity.ts`): each runtime tool is `works`, or `ui-only` with a reason —
  live A/V streaming, input keymap config (`runtime_input_*`), the project requester / owner flip,
  `runtime_backend`, `runtime_down`. Anchors and candidates work on a sandbox (its own marks; its
  `sandbox/runMany` clones run inside the sandbox daemon). Tools that today assume "the" session
  (no `session_id` parameter) get one.
- **D4 Isolation (P3).** Sandbox ids are owned by the MCP process that started them (ledger entry
  carries the owner pid); another process gets "not yours". The workspace UI and `session/list`
  of the shared daemon never see them (separate daemons). `runtime_sandbox_list` shows the caller's
  own: id, purpose, port, deadline, idle time.
- **D5 End (P4).** `runtime_sandbox_end { session_id, outcome: reached|failed, summary }`.
  Self-ending reuses the keeper (budget, owner pid) and adds the idle timer (reset by every routed
  call). Every end: finalize an active trace, `daemon/shutdown`, SIGTERM after grace, scratch
  removed, ledger entry closed with reason; the outcome goes to the project's step log
  (`agent_record_step` shape: purpose, outcome, summary, duration, artefacts). An ended id answers
  "ended: <reason> at <time>" for the life of the MCP process.
- **D6 Long work (P5).** Calls routed to a sandbox whose run can exceed ~150 s answer a job id
  (`startAnalysisJob` / `analysis_job_status`, as `runtime_loader_lens` does). `trace/run/stop`
  gets an explicit timeout sized to the capture (today the shared client's 60 s default kills it,
  `src/runtime/daemon-client.ts:425-429`); on timeout the answer names the intact `.c64retrace` and
  the lazy index on first read. This fixes the shared session's finalize timeout from #77 too.
- **D7 Doors (P6).** The C64U refusal of a live trace names `runtime_sandbox_start`.
  `trace/read` on a store file is served by an emulator reader when a C64U is selected
  (`src/runtime/c64u/routing.ts:67-69` refuses it today). Fix `docs/runtime-sandbox.md`,
  `docs/tools/sandbox.md`, the tool texts of `runtime_sandbox_run` / `runtime_session_start`,
  DOCTRINE.md (rule 2, the budget line "cycles and wall-clock" → what is built), CLAUDE.md rule 2,
  and the stale comment at `src/server-tools/trace-read.ts:19-23`.
- **D8 TRX64.** None planned. If S6 shows the index build is the limit, or the daemon needs a
  self-termination deadline as a last line behind the keeper, that part is specced into §5 and
  delegated to the TRX64 session.

Lost: one shared daemon per project (#78's first choice) — the shared machine is the human's and
stays one; per-project sandboxes give the LLM the same without a second machine in the UI.
Extending the one-shot call with more step verbs (this spec's first draft) — a patch per use case.

## §4 Out

- Showing a sandbox in the workspace UI — the UI shows the shared session only (DOCTRINE.md:44).
- Handing a sandbox to the human, or promoting it to the shared session.
- Sandboxes on a C64 Ultimate — a sandbox is always the emulator.
- #77's loader-lens reading of a stack-buffered loader and raw `$1C01` blocks — its own spec.

## §5 Decisions taken while building

(filled in at the end)
