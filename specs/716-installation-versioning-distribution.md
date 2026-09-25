# Spec 716 — C64RE distribution: npm package + the runtime beside it

**Status:** READY 2026-09-25 (was SCOPED 2026-08-11, DRAFT 2026-05-24).
**Repo:** C64RE, plus one TRX64 change that is now in scope (§4.5, §6.3).
**Counterpart:** [801](_archive/801-artifact-distribution.md) did this for TRX64 and is
closed. This is the C64RE half it deferred.
**Related:** [880](880-the-sandbox.md) consumes this spec's package — the image installs
C64RE from the registry, so the packaging gate below is a **prerequisite** of the sandbox,
not an alternative to it. What 880 would retire is §4, not §3.

## 0. What changed, and what died

Two corrections to the 2026-08-11 scoping, both from measuring rather than remembering.

**The reSID clauses are dead.** The draft required Emscripten documentation, a committed
`resid.wasm`, and GPL provenance for `third_party/resid/`. None of it exists: Spec 806
deleted the TypeScript emulator and its vendored reSID on **2026-08-12**, one day after
this spec was scoped. There is no `third_party/`, no `build:resid-wasm` script, and no WASM
in the tree. Those paragraphs are removed rather than rewritten — a spec that describes a
world that no longer exists is the thing doctrine rule 9 exists to prevent.

**TRX64's answers still stand** and are not re-derived here: one version for the whole
workspace, the artifact tag equals what the binary reports, tag-driven release from CI with
checksums beside each artifact, and *the package manager is the install doc*.

## 1. Problem

C64RE runs **only from a source checkout**: clone, `npm install`, run through `tsx`. Fine
for its author, wrong for everyone else. 801 §C.4 deferred npm with an explicit condition —
*revisit when someone needs to run C64RE without a checkout* — and that condition is met:
an external contributor hit a bug caused by exactly this shape (Spec 802), TRX64 is
installable in one line while the workbench that consumes it is not, and an MCP host config
has to point at a path that differs per machine.

## 2. Where the package actually stands

Measured 2026-09-25, not estimated.

`npm pack --dry-run` today produces **1373 files, 23.2 MB unpacked, 9.4 MB tarball** — and
**no `dist/`**. `dist` is gitignored, so npm takes the git view and the tarball would carry
the TypeScript sources and no built server. Nothing in it starts. What it *would* carry:
261 specs, 269 scripts, 68 bug records, 153 sample fixtures, the git hooks and the CI
workflow. The commercial corpus stays out (`samples/commercial/` is gitignored), so there
is no leak — but none of the rest belongs in an install.

The manifest has `name`, `version 0.1.0`, `license GPL-3.0-or-later`, `type: module`. It
has **no** `bin`, `main`, `files`, `engines`, `prepack` or `prepublishOnly`.

What already works, and is worth knowing before anyone "fixes" it:

- `src/run-cli.ts` resolves the pipeline child relative to **its own module**
  (`dist/pipeline/cli.cjs`), not against the cwd. That survives `node_modules` unchanged as
  soon as `dist` ships.
- `resources/platform-kb.sqlite` (1.5 MB) is tracked, so the knowledge base ships.
- `tsx` is a devDependency. The built server does not need it.
- `@c64re/mcp`, `c64re` and `c64-reverse-engineering-mcp` are all free on the registry.

## 3. Package shape — the gate

Registry publication is permitted only after these pass **from a packed tarball**, never
from the checkout.

### 3.1 Manifest

- `files` allowlist — `dist/`, `resources/`, `LICENSE`, `README.md`. Everything else is out
  by default, because an allowlist that has to be argued beats an ignore list that has to be
  remembered.
- `bin` → `c64re-mcp`, so an MCP host config is a command and not a machine-specific path.
- `main` → the built entry.
- `engines.node` → the LTS baseline, verified by a build and a smoke, not assumed.
- `prepack` → `npm run build`, so the tarball cannot be built from a stale tree.
- License metadata stays `GPL-3.0-or-later`; root `LICENSE` ships.

### 3.2 Execution proof

From `npm pack` installed into an empty temporary directory:

1. the `bin` starts, completes an MCP initialization, and answers one harmless tool call;
2. a tool that reads `resources/platform-kb.sqlite` answers, proving the resource shipped;
3. a tool that spawns the pipeline child answers, proving `dist/pipeline/` shipped and
   resolves;
4. the tarball contains no sample, no trace, no session output and no `.git*` hook.

### 3.3 Name

`@c64re/mcp`. Scoped, free, and it leaves room for `@c64re/*` siblings later without
renaming the first one. §9 carries this as the one open decision.

## 4. The runtime beside it

An installed C64RE has no machine. TRX64 is a separate daemon, and the recipe a user meets
today — `setup-recipe.ts`, whose **first** option is `cd ../TRX64 && cargo build --release`
— is a developer's answer handed to someone who typed `npx`.

**Decision: fetch on first use, never at install time.** Not a `postinstall`. `npx -y
@c64re/mcp` must start immediately, and a postinstall that pulls 27 MB from GitHub turns a
cold start into a download. The fetch is one explicit, visible act, once.

Four pieces:

### 4.1 Resolution

`resolve-daemon-spawn.ts` knows three places today: `C64RE_RUNTIME_BIN`,
`C64RE_TRX64_BIN`, and the sibling checkout `../TRX64/target/release/`. Two more, between
the env vars and the checkout:

- `trx64-daemon` on `PATH` — covers `brew install trx64` and anyone who placed it themselves;
- `~/.cache/c64re/trx64/<version>/trx64-daemon` — the copy this spec manages.

This is needed whatever else is decided, including under 880.

### 4.2 The fetch

A door and a CLI verb over the same code: map `process.platform` + `process.arch` to the
release asset, download `trx64-<v>-<target>.{tar.gz,zip}` and its `.sha256`, verify, unpack
into the cache directory, mark executable, report the path. Everything needed is already
published: v0.9.2, five targets, a checksum beside every archive, 23–33 MB each.

### 4.3 The pin — the part that will bite if it is done casually

`EXPECTED_RUNTIME_PROTOCOL = 2`, and the client requires an **exact** match: a daemon that
is ahead is a setup error, not a best-effort. So the fetch may never resolve "latest". It
needs a pinned version constant beside the protocol constant, bumped in the same lockstep
commit across both repos — **and a gate that fails when the two disagree.** Two
hand-maintained numbers that can silently contradict each other is a defect that only
surfaces on someone else's machine.

### 4.4 The recipe

`setup-recipe.ts` reorders: the one command first, the prebuilt-binary and endpoint options
second, `cargo build` third where it belongs.

### 4.5 Two gaps that code does not close

- **`macos-x86_64` is missing** from TRX64's release matrix (macos-arm64, linux-x86_64,
  linux-arm64, windows-x86_64, windows-arm64). An Intel Mac gets "no asset for your
  platform". **Decided 2026-09-25: add it.** With one caveat worth knowing before someone
  calls it a one-line change — `macos-latest` is arm64, so the entry is either `macos-13`,
  the last Intel runner and one GitHub is retiring, or a cross-build from `macos-latest`
  with `--target x86_64-apple-darwin`. The second is right and matches that workflow's own
  stated principle of keeping the floor independent of runner labels GitHub may drop. It
  costs slightly more than a matrix row: the `Package` step copies from a hard-coded
  `target/release/`, and a cross-build writes to `target/<triple>/release/`, so the path
  has to come from the matrix.
- **ROMs are the user's own and always will be.** The daemon looks in
  `C64RE_ROOT/resources/roms`, then beside its executable, then at a hard-coded sibling
  path. `C64RE_ROOT` is the clean route and already exists. But the ROMs are Commodore's
  property, they are gitignored here, and they are never in a package. The install is
  therefore three-part — C64RE, the daemon, the ROMs — and the third part has no technical
  answer and must not be given one.

## 5. `INSTALL.md`

Full scope — the npm route is a supported path (§9).

Create `INSTALL.md` at repository root; `README.md` keeps a short quick-start and a link.
It must distinguish three audiences — use the MCP server, use the runtime UI, develop and
rebuild — and cover macOS, Windows PowerShell, Windows + WSL2, Linux and container, each
validated on the relevant shell or in CI before it is labelled supported.

Required content: the Node LTS baseline and npm expectations; `C64RE_PROJECT_DIR` and how to
make one; optional tool overrides kept separate from the minimum path; where `dist/` appears;
how to update without losing project data; tested Claude Code and Codex MCP configurations
that run the built server and reserve stdio for protocol traffic; the runtime UI as an
optional second step with its ports; a committed container recipe with the project mounted
rather than baked; and a troubleshooting list of reproducible failures only — wrong Node
major, Windows quoting, unresolvable `npx`/`node`, missing `C64RE_PROJECT_DIR`, and the
missing runtime, which since Spec 806 is a first-class install failure with no fallback.

## 6. Slices

**716.1 — Truth.** Establish the Node LTS baseline from a build and a smoke. List the
minimum runtime assets and environment variables. *Exit:* no undocumented prerequisite for
MCP startup.

**716.2 — The package gate.** §3 in full: manifest, `prepack`, pack-and-install proof in a
clean directory. *Exit:* a tarball that starts and answers, with an audited file list.
**This slice depends on no open decision and is the whole of the risk.**

**716.3 — The runtime beside it.** §4.1–4.4, with the protocol/version agreement gate.
*Exit:* a machine with neither a checkout nor Homebrew reaches a running daemon in one
command, and a mismatched pin fails loudly at build time rather than quietly at the user.

**716.4 — Versioning contract.** Pre-1.0 semver written down: minor may break, patch does
not intentionally change MCP tool schemas, `.c64re` compatibility or invocation. Tag
`v<version>`; the package's version is the one authority. *Exit:* `0.1.0` means something.

**716.5 — `INSTALL.md`.** §5 in full: five platform routes, each validated on its shell or
in CI before it may be called supported.

**716.3b — `macos-x86_64` in TRX64.** The cross-build entry of §4.5, and the `Package` step
taught to take its binary directory from the matrix. Carried across rather than deferred —
"→ TRX64" is this owner's own work, not a handoff.

**716.6 — Publish.** GO only after 716.2 and 716.3 are green, and only on explicit
approval.

## 7. Acceptance

1. `npm pack` produces a tarball whose contents are an audited allowlist — no samples, no
   traces, no session output, no hooks.
2. That tarball, installed into an empty directory, starts the MCP server, answers an
   initialization and one tool call, reads its shipped knowledge base, and spawns its
   pipeline child.
3. A machine with no checkout and no Homebrew gets a running daemon in one command, with
   the checksum verified.
4. A protocol/version mismatch between C64RE and the pinned TRX64 release fails a gate.
5. `setup-recipe.ts` leads with that command, and `cargo build` is the third option.
6. Versioning policy is written down and `engines.node` is declared from evidence.
7. Publication happened only after an explicit approval, or is recorded as deferred with the
   gate that blocked it.

## 8. Non-goals

Bundling ROMs. A GUI installer. Publishing Rust crates (801 settled that). Runtime
correctness or feature work of any kind. Treating publication as mandatory — a proven
container distribution remains an acceptable outcome, and 880 may make it the preferred one.

## 9. The decision, taken

**2026-09-25 — the bare npm route is a supported, documented path.** Someone who already
has a harness on their own machine installs the package and is a first-class user; the
image (880) is a second route, not the only one.

Consequences, all now in scope:

- §5 is written in full — macOS, Windows PowerShell, Windows + WSL2, Linux and container,
  each validated before it may be called supported.
- Intel Macs are a first-class audience, so `macos-x86_64` joins TRX64's release matrix
  (§4.5, slice 716.3b).
- Publication still needs its own explicit approval (716.6). Deciding that npm is supported
  is not deciding to publish today.
