# Spec 880 — The sandbox: an environment you cannot step outside

**Status:** PROPOSED 2026-09-25.
**Repo:** C64RE owns the image, the plugin and the graph. TRX64 contributes the runtime
layer it already has (Spec 799).
**Number:** 880 (registry: `specs/README.md`).
**Builds on:** 799 (`wl-trx64` — one container, one daemon, one live C64), 848/849 (the
contract and its three layers), 877 (the doors that refuse, and the two limits it stated),
830-ish `agent_*` family (roles, onboarding, recorded steps).
**Scale:** this is the 3.0 shape. It is not a packaging task with a workflow bolted on; the
packaging is what makes the enforcement possible.

---

## §1 What is wrong

Everything built for autonomy so far reaches the session **through a tool call**, and a
session that does not call the tool is not reached. That is not a suspicion. It was
measured twice, in two different ways.

**Seven unattended runs, 2026-09-12/13** (Specs 844–849) put a number on every channel:

| channel | when it reaches the session | verdict |
|---|---|---|
| `CLAUDE.md`, project steering | session start | always, but only once |
| `.claude/rules/*.md` with `paths:` | a matching file is read with the **native** Read tool | **useless here** |
| MCP tool result footer | the tool is called | the real channel |
| MCP write footer (`save_*`, `slot_record`, `declare_*`) | 14–24× per run | the enforcement channel |
| `project_critique` | only when asked — 0 calls in 114 turns | unread |

The `paths:` glob was the expensive lesson: it fires on a **native read**, and an RE
session reads through `read_artifact` / `graph_find` / `disasm`. Run 4 made four native
file accesses in 102 turns, all of them writes, and fired zero rules. The moment belongs
to the tool, not to the harness.

Carrying the contract's standing blockers back on every write worked — `model_assert`
0 → 12, `project_critique` 0 → 2 with both findings fixed, orphans 62 % → 9.1 %. And then
it stopped working, at exactly one place: **run 7 read its three blockers repeatedly and
left anyway.** That is not a tooling defect any more. It moves the failure from "was never
told" to "read it and left", and nothing inside the session can gate a stop, because a
stop is not a tool call.

**Two supervised runs, 2026-09-24/25** (BUG-065, and the Neuromancer run after it) showed
the other half of the same hole. 877's contract footer delivered the debt verbatim —
*"named 0.0 % (0/171 nodes) is below the 90 % the contract asks for"* — and the run read it
and went on building a cartridge. And when the tooling did not obviously offer what a run
wanted, the run did not get refused: it **went around**. It built its own daemon, its own
WebSocket driver, a regex parser for our own monitor's text dump, an `until` that polls the
PC every 50 frames beside a breakpoint that stops on the instruction, and a `step` macro in
6502 writing progress markers to `$02F8` — beside `runtime_step_into`, which it never
called. 103 shell reads of one rendered listing against 5 `disasm` calls.

**A door only bites what passes through it.** That is the sentence this spec exists for.
877 said the same thing in its own closing limits and could go no further, because an MCP
server has exactly one lever — refusing a call — and no purchase at all on a session that
declines to make one.

The measured prescription was already written down and had nowhere to live: *enforcing the
stop needs a loop OUTSIDE — `claude -p` → critique → `--resume` with the blockers.* A
container is that outside.

## §2 The four estates

The brief is a strict separation, and the separation is the design. Each estate answers a
different question, lives in a different place, is changed by a different authority, and
acts at a different moment. Conflating any two of them is how agent frameworks turn into
prose that nobody can enforce.

### 2.1 Guardrails — what must not happen, anywhere, ever

Invariants. Not phase-dependent, not role-dependent, not waivable by the work.

> Never power-cycle the shared machine. Every disk mounts r/w and persists into the
> ORIGINAL, so never mount an original. Never invent a 2-byte load header to get headerless
> bytes through a door. Reserved, erased and fragmented space is not free.

- **Lives in:** the MCP doors (they refuse), and the image (what is absent cannot be done).
- **Changed by:** the owner, in `DOCTRINE.md`, never by a workflow author.
- **Acts:** at the moment of the call, every call, in every node of the graph.

A guardrail is the only estate permitted to say *no* without reference to state.

### 2.2 Agents — who is working

A named worker with a role, a voice, and a claim. `agent_set_role` already exists and is
the seed.

- **Lives in:** the plugin's agent definitions, and the graph (an agent is a node that owns
  the records it wrote).
- **Changed by:** the workflow author.
- **Acts:** at session start and at every hand-off.

**An agent is not a phase and it is not a grant.** This is the separation most frameworks
lose: a persona that both names who you are *and* decides what you may touch cannot be
audited, because a reach change looks like a personality change. Here the role selects
prompts, defaults and voice. It selects **no** reach whatsoever.

### 2.3 The workflow graph — what order work happens in

Nodes and edges. Not prose, not a numbered list in a document.

A node carries three things: an **entry condition**, a **body** (what work it is), and an
**exit proof**. An edge from A to B exists only if A's exit proof is *checkable from the
graph*. No edge may be traversed on a claim — "I have annotated the code" is not an exit
proof; `namedRatio ≥ 0.9` over the artifact's nodes is.

- **Lives in:** one declarative file in the project, and the knowledge graph as the state.
- **Changed by:** the workflow author; a project may extend but not remove a node.
- **Acts:** on every transition attempt.

**One graph, and only one.** Today `src/agent-orchestrator/lifecycle.ts` exists to
crosswalk a 5-phase lifecycle, a 7-phase per-artifact pipeline, a deterministic step
orchestrator and a persisted 9-phase workflow state. Four models and a translator between
them is three models too many; 880 replaces them with the graph and deletes the crosswalk.

### 2.4 Grants — what a node may reach

The only estate that is **enforced** rather than delivered. A grant binds a node of the
graph to a reach, and comes in three strengths:

| | grant | enforced by | strength |
|---|---|---|---|
| G1 | **Tools** — which MCP doors this node sees | the surface the server presents | weak today (§5.2) |
| G2 | **Exec + filesystem** — what the harness may run and write | the plugin's `PreToolUse` hook on Bash/Write | real |
| G3 | **Environment** — what exists in the container at all | the image, and egress policy | strongest |

The distinction that makes the whole spec work:

> **A guardrail is what you must not do. A grant is what you cannot do.**
> One is refused at a door. The other is arranged by construction, and there is no door to
> go around.

G3 is why the container is not a packaging convenience. A run that wants a second emulator
cannot build one when there is no `cargo` and no `cc`; a run that wants a different tool
cannot fetch one when there is no egress. It removes **acquisition**.

**It does not remove invention,** and this spec will not pretend otherwise: node is present
because the harness needs it, so a determined session can still write a 6502 interpreter in
JavaScript, exactly as one wrote a stepper in 6502. G3 makes the detour expensive and
visible; it does not make it impossible. What makes it *unattractive* is the other half of
the work — the tool being obviously there, which is 877 D3's gate and the playbook change.

## §3 The enforcement ladder

What each layer can actually do, in order of increasing force. Every row below the line is
new in 880.

```
  reaches, binds nothing    CLAUDE.md / project steering        once, at session start
  reaches when called       MCP result + write footers          14–24× per run
  binds what passes         door refusal (877)                  at the call
  ──────────────────────────────────────────────────────────────────────────────
  binds what is run         plugin PreToolUse on Bash/Write     at the call, harness side
  binds the transition      the graph's exit proof              at the edge
  binds by absence          the image                           always
  binds the stop            the outside loop                    when the session ends
```

The **outside loop** is the piece that has never existed: the container's entrypoint, not
the session, owns the run. It starts the harness non-interactively, and when the session
ends it asks the graph whether the node's exit proof holds. If it does not, it resumes the
session with the blockers rather than accepting the stop. Run 7 left with three blockers
standing; in this shape, leaving is not a way out of the node.

## §4 The image

799 already settled the bottom of the stack and its decisions carry unchanged: one
container is one `trx64-daemon` is one live C64; ROMs are a **volume** seeded from a private
image and never a layer; the build cross-compiles amd64 from Apple Silicon for the NAS.

880 adds three layers above it:

- **C64RE**, installed from the registry rather than from a checkout — which is also the
  cheapest possible answer to Spec 716's five-row platform matrix.
- **The harness**, Claude Code or codex-cli, installed from npm at build time. The user
  chooses at first run; both are prepared.
- **The plugin** (§5), which is the only thing in the image that knows about the four
  estates.

Mounted, never baked: the project directory, the ROM volume, and the harness credentials —
credentials on a volume or it is a fresh authorization every start.

Absent on purpose: the Rust toolchain, a C/C++ compiler, and network egress at run time.

**The version coupling disappears with the image.** `EXPECTED_RUNTIME_PROTOCOL = 2` demands
an exact match between C64RE and the daemon; built together, they are pinned together, and
the protocol→release mapping that a downloader would have needed is never written.

## §5 The plugin

One plugin, in the image, holding the grants and nothing else.

### 5.1 What it does

- `SessionStart` — inject the current node: its body, its exit proof, its guardrails.
- `PreToolUse` on Bash and Write — enforce G2 against the current node's grant. A refusal
  names the node and the tool that *is* granted for this work, never a bare no.
- `PostToolUse` — record the step into the graph, so the exit proof is computed from what
  happened rather than from what was claimed.

### 5.2 The tool grant, honestly

G1 is the weakest of the three **today**, and the spec says so rather than assuming it.
The server builds its tool surface once at process start: there is no
`notifications/tools/list_changed` anywhere in `src/`, and `DEFAULT_TOOLS` is a static set
— a tool outside it is not merely discouraged, it is invisible and uncallable, which has
already caused three bugs in one day. So a node cannot today be given a different surface
without restarting the server.

Three ways out, and this spec does not pick one yet (§8):

1. the server learns `list_changed` and the host honours it;
2. a node transition is a **process** boundary — the server is restarted with that node's
   surface, which is crude and completely deterministic;
3. the grant is checked at the door — weaker, since it is another refusal to walk around,
   but it composes with G2 and G3.

### 5.3 The limit 877 stated, and how this closes it

877 could not enforce that a run may not waive its own contract, because **MCP carries no
caller identity** — the server cannot tell the human from the session. It said so in the
code instead of wearing a fig leaf.

In the sandbox the identity exists: the plugin sits between the harness and the server and
knows which it is. A waiver arriving through the harness is a self-waiver by construction.
877's stated limit is a 880 deliverable, not a permanent condition.

## §6 What is deliberately not enforced

- **Judgement inside a node.** A grant says what may be reached, never what must be
  concluded. The critic refutes from the graph (849); it does not vote.
- **Invention.** See §2.4. A session can still build the wrong thing out of what is present.
- **The human.** Every grant is a grant on the *agent*. The owner's own session in the
  container is not gated, because a workbench that argues with its owner gets turned off.

## §7 Acceptance

1. One image builds and runs on podman, Docker and Apple `container`, amd64 and arm64.
2. From a cold start: the user picks a harness, completes its auth flow once, and the
   credential survives a restart.
3. `agent_onboard` → a node of the graph → work → exit proof, with the whole path visible
   in the graph afterwards and no prose state anywhere.
4. A node whose grant excludes Bash refuses a Bash call, names the node, and names the
   granted tool for that work.
5. **The regression that motivated this:** a run given the Neuromancer prompt cannot build
   its own daemon — no toolchain, no egress — and reaches `runtime_step_into` instead. The
   measure is the same one BUG-065 used: shell reads of the listing against `disasm` calls.
6. A session that ends with its node's exit proof unmet is resumed with the blockers, and
   the resume is recorded. Run 7's ending is not reachable.
7. `lifecycle.ts`'s four-model crosswalk is deleted, not wrapped.
8. No ROM, no sample and no credential is in any image layer — proved by inspecting the
   layers, not by reading the Dockerfile.

## §8 Open, for the owner

1. **The tool grant's mechanism** — §5.2's three ways out. Restarting the server per node
   is the dumb one that certainly works; `list_changed` is the clean one that depends on
   the host.
2. **How much of 716 the sandbox actually retires.** Not all of it, and the first draft of
   this line was wrong: the image installs C64RE *from the registry*, so 716's packaging
   gate — `files`, `bin`, `engines`, a `prepack` that builds, and the pack-and-install
   proof — is a **prerequisite** of the sandbox, not an alternative to it. What the sandbox
   does retire is the expensive half: the five-row platform matrix, `INSTALL.md`'s five
   routes, and the runtime downloader with its protocol→tag map. The question is whether
   the bare npm route is then still advertised as a supported path for someone who already
   has a harness on their own machine, or whether the image becomes the only answer.
3. **Local or remote.** `podman exec` is enough for a container on this machine; ssh only
   earns its second service if the image lives on the NAS — which is a remote workbench, a
   different thing with different costs (the A/V stream is fine on a LAN and not over the
   internet; the latency governor sits at 100 ms).
4. **Whether the workflow graph is C64RE's or the plugin's.** In the graph it is portable to
   any harness and survives a handover; in the plugin it is enforceable but dies with the
   harness — which is 847 D7's argument, decided once already in the other direction.
