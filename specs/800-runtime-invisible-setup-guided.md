# Spec 800 — The runtime is invisible to the RE-agent (setup-guided, version-checked)

**Status:** BUILT (§A–§D implemented; C64RE typecheck + TRX64 `cargo check` green; the
version-parse + handshake decisions unit-verified: `v1`→OK, `v2`→hard-fail+recipe,
missing→tolerate). Live handshake exercises on the next daemon rebuild + MCP reconnect (the
running daemon predates the ping version → tolerated, no breakage).
**Repos:** cross-repo — C64RE primary (doctrine + tool strings + client handshake +
setup probe); TRX64 already exposes a runtime version string (verify it is returned at
connect; a tiny addition at most).
**Number:** 800 (shared board `specs/README.md`).
**Builds on:** the customer-surface-TRX64-only riegel (env-gated backend, `runtime_*`
routes to the daemon) and the consumer-surface spec-number scrub. This spec extends the
same principle — *internal infrastructure is invisible to the RE-agent* — to the runtime
backend brand itself, and closes the setup/version gap that a 2-repo split leaves open.

---

## 1. Problem

Two faces of one leak.

**(a) The runtime brand leaks onto the RE-agent surface.** `docs/agent-doctrine.md` §1.1
(loaded by `agent_onboard` / the doctrine prompt) actively *teaches* the RE-agent about
the backend: "TRX64 native Rust daemon", "the TypeScript runtime is the fallback", and the
owner-level split "Leitregel: Capability → TRX64, Meaning → C64RE". Three tool strings also
say "TRX64 backend". The Leitregel is *our* internal division of labour between two repos —
it is not an RE concept. Observed failure: a fresh crack session asks *"I don't have a
TRX64 tool… what is TRX64?"* and is tempted to bake the infrastructure into the RE
workflow. Correct behaviour is: the agent has no "TRX64 tool" and never needs one — it
drives one runtime through `runtime_*`.

**(b) The real dependency fails opaquely on a fresh/misconfigured box.** The runtime is a
separate repo's binary reached over WS — deliberately (two repos, no registry, no
build/link coupling). But nothing bridges *"is a runtime here?"* → *"here is how to get
one"*: there is no first-run guidance, no single setup recipe surfaced, and no
protocol-version check. A box without a built daemon (e.g. Windows, no sibling build) gets
a thin "start the daemon" message at best, or silently drifts.

## 2. Goals

1. **Agent surface names only "the runtime"** (reached via `runtime_*`). Remove the backend
   brand, the TS-fallback mention, and the Leitregel from the doctrine and every
   agent-facing string.
2. **Runtime availability is a deterministic, software-owned check**, surfaced at the setup
   boundary (`agent_onboard` first-run + the connect path) with **one** complete, per-OS
   setup recipe. The backend is named **only here**, and only when the runtime is actually
   missing.
3. **Protocol-version handshake**: on connect the client reads the daemon's runtime version
   and fails loudly + actionably on mismatch (pointing at the same recipe).

### Non-goals

- **No registry, no build/link coupling.** The two-repo split stays; the dependency remains
  a *running process + a WS protocol*, not a package.
- **No change to daemon discovery** — sibling path / `C64RE_TRX64_BIN` /
  `C64RE_RUNTIME_ENDPOINT` stay exactly as the riegel left them.
- **Not re-teaching the agent about the backend.** The recipe is a setup-boundary artifact,
  not doctrine.

## 3. The two layers (the reconciliation)

The apparent contradiction — "invisible to the agent" vs "guide the user to set it up" —
dissolves into two layers:

- **Operator / software layer** (C64RE code + setup + env): *knows* the backend — discovers,
  spawns, connects, version-checks it, and owns the setup recipe.
- **RE-agent layer** (the LLM customer): *blind* to the backend. Sees exactly one runtime,
  through `runtime_*`.

The setup recipe is the **single bridge** between them, and it fires only at the boundary
(runtime missing or version-mismatched) — never during normal RE work.

## 4. Design

### 4.1 §A — Scrub the agent surface

- `docs/agent-doctrine.md` §1.1 → keep the *operational* core verbatim ("there is exactly
  one runtime; the `runtime_*` tools are the only runtime you have; no external emulator to
  fall back on; if `runtime_*` cannot answer, go read the code"). Remove: "TRX64 native Rust
  daemon", the TS-fallback sentence, "Leitregel: Capability → TRX64 / Meaning → C64RE", and
  the `(… Spec 771)` / date in the heading.
- Three tool strings → neutral "the runtime backend" / "the runtime daemon":
  `src/server-tools/runtime.ts:485` (candidate guard), `src/server-tools/headless.ts:1176`
  (overlay description), `:1213` (overlay cart-bank error).
- Backend brand stays in code comments, `CLAUDE.md`, commit messages, `specs/` — internal
  only.

### 4.2 §B — Single-source setup recipe

One home (a `src/server-tools/runtime-setup-recipe.ts` const, or `docs/runtime-setup.md`
that the tool reads). Per-OS content:

- **Build the sibling**: `cargo build --release -p trx64-daemon` in `../TRX64` (needs Rust +
  a C++ compiler for reSID). Windows → `trx64-daemon.exe`.
- **Or point** `C64RE_TRX64_BIN` / `C64RE_RUNTIME_ENDPOINT` at a prebuilt binary / running
  daemon.
- **Or run the container** (the packaging spec) and point at its WS endpoint.

This is the ONLY customer-reachable output that names the backend, and only when the runtime
is unavailable.

### 4.3 §C — Health probe + wiring

- `runtimeHealth()` — reuse `resolveDaemonSpawn` + `probeLiveness`. Returns `ok` **or**
  `{ status: "unavailable", reason, recipe }`.
- Wire:
  - `agent_onboard` runs the probe; if unavailable, its output carries the recipe (the
    first-run hint the agent relays to the user).
  - the connect / `ensureDaemon` "not reachable" path replaces its thin message with the
    full recipe.
- The agent needs **no** new doctrine. One optional neutral line may be added: *"if a runtime
  tool reports the runtime is unavailable, relay its setup guidance to the user"* — it names
  no brand.

### 4.4 §D — Version handshake

- C64RE declares the protocol it needs: `EXPECTED_RUNTIME_PROTOCOL` (the daemon already
  announces `runtime_version: "trx64-runtime/N"`; `main.rs:5417`).
- On connect, the client reads the daemon's version and checks it against the policy
  (§6 OQ1). Mismatch → an actionable error that points at the recipe ("rebuild / update the
  runtime").
- Cross-repo: confirm the version is present in a connect-time response (`ping` /
  `session/create`); add it TRX64-side if it is not (minor).

### 4.5 §E — Product version vs protocol epoch (two independent numbers)

The epoch alone cannot answer *"is this an ancient daemon?"* — two builds can share an epoch
and still differ (e.g. the Highpool colour-restore fix changed behaviour without touching the
wire). So the runtime carries a **product version** next to the epoch:

- **One version for the whole TRX64 workspace** (`[workspace.package] version`, every crate
  inherits it). The crates are never consumed separately, so per-crate semver would be pure
  bookkeeping. Bump freely — 0.x: minor for features, patch for fixes.
- **Surfaced** at: `--version` on both binaries, the daemon's start log
  (`TRX64 0.1.0 (trx64-runtime/1)`), the `ping` payload (`version` next to
  `runtime_version`), and the container image tag + OCI `version` label.
- **The epoch stays independent** and is bumped ONLY on a wire-breaking change, in lockstep
  with `EXPECTED_RUNTIME_PROTOCOL`. The `.c64re` `schemaVersion` likewise keeps its own count.
- **C64RE consumes it informationally**: the handshake still hard-gates on the epoch, but the
  daemon's build is recorded (`runtimeDaemon.runtimeBuildVersion`, and via the liveness ping
  for `runtimeHealth().build`) and named in the mismatch error, so an ancient daemon is
  visible at a glance.

## 5. Acceptance

1. **grep clean:** no backend brand or "Leitregel" in agent-facing strings or the doctrine
   (code comments / `CLAUDE.md` exempt).
2. **Fresh box, no daemon:** `agent_onboard` and the first `runtime_*` call return the
   complete per-OS setup recipe; the backend is named only there.
3. **Version mismatch:** the client fails loudly with rebuild guidance.
4. **Normal operation** (daemon up, version OK): zero backend brand anywhere the agent sees;
   `runtime_*` work unchanged.

## 6. Decisions (refined 2026-08-05)

1. **Version policy → breaking-epoch integer, exact-match, hard-fail.** `N` is bumped ONLY
   on a wire-breaking change (additive changes do not touch it); the client requires
   `daemon.N == EXPECTED_RUNTIME_PROTOCOL` and hard-fails on any mismatch with the setup
   recipe. Co-owned repos → a breaking bump is one lockstep commit across both.
2. **Recipe home → a typed TS const** (`runtime-setup-recipe.ts`), selected per
   `process.platform`; the probe/error emits it directly. It is authoritative; it may point
   at a human-readable `docs/runtime-setup.md`, but the const is the source of truth (no
   runtime file dependency, testable by the grep gate).
3. **Probe cadence → every `agent_onboard`** (same cheap liveness probe `ensureDaemon`
   already runs on the first tool call), so a runtime that went down or drifted after
   session 1 is still caught.
