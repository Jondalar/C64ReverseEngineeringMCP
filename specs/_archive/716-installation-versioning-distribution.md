# Spec 716 — C64RE distribution: npm package + the runtime beside it

**Status:** DONE 2026-09-26. Every slice including 716.6: `@trex64/c64re` is published,
and the second release went out through the tag pipeline over OIDC with no stored token.
(Was BUILT 2026-09-25, READY 2026-09-25, SCOPED 2026-08-11, DRAFT 2026-05-24.)
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

### 3.3 Name — decided 2026-09-26

**`@trex64/c64re`**, executable `c64re`.

Scoped, though not for the reason a scope is usually taken. There are no npm siblings and
probably will not be: TRX64 and the U64 work are Rust, and 801 settled that they ship as
release binaries and a Homebrew tap, never crates.io and never npm. So today exactly one
artifact belongs on a registry.

The scope is taken because it is the thing that cannot be retrofitted. A name people have
written into an MCP configuration is permanent in practice — packages can be added to a
scope forever, and `c64re-mcp` could not be moved under `@trex64` later without breaking
every config that names it. Taking the scope costs five minutes; wanting it afterwards
costs a break. (The npm scope need not match the GitHub organisation, and does not:
`trex64-dev` is the org, `@trex64` the scope.)

`c64re` rather than `mcp` inside the scope, because MCP is how the thing is reached and not
what it is — and a TRX64-side MCP server would otherwise find its name already spent. The
executable follows: the CLI has always spoken as `c64re` (`c64re graph`, `c64re doc`,
`c64re setup`), and the `bin` name was the one place it called itself something else.

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

**716.1 — Truth. BUILT.** The baseline is Node 22 LTS, and the requirement behind it is
not a number: it is the built-in `node:sqlite` that carries the graph and the platform
reference. `engines.node` is a warning at install time and nothing at run time, and the
exact 22.x that first shipped the module unflagged would have been guessed rather than
measured — so `cli.ts` checks whether *this* Node can import it and says so naming the
version in play. Runtime assets: `resources/platform-kb.sqlite` and
`resources/fingerprints/bundled/`, and nothing else under `resources/` is read at run time.

**716.2 — The package gate. BUILT.** `scripts/e2e-716-package.mjs`, 26/0. Red first, and
red in the way that mattered: seventeen failures ending in "cannot load module", because
`dist/` is gitignored and the tarball carried sources and no server. 1373 files / 23.2 MB →
642 files / 8.2 MB, 1.8 MB packed. Runtime dependencies 13 → 4. One real defect fell out of
it: `c64ref_lookup` required a 27 MB derived snapshot that is in no package and whose
builder fetches from the network, so every install answered `knowledge_missing`; it now
answers from the platform KB that ships.

**716.3 — The runtime beside it. BUILT.** `scripts/e2e-716-runtime.mjs`, 39/0.
`src/runtime/install-daemon.ts` maps platform → release asset, verifies the published
`.sha256`, unpacks into a per-version cache; `runtime_install` and
`npx c64re-mcp runtime install` are one implementation. Resolution gained the cache and
`PATH`, cache first because it holds exactly the pinned release. The pin is
`REQUIRED_TRX64_VERSION` beside the protocol constant, cross-checked against the sibling
checkout's workspace version *and* the daemon's own `RUNTIME_VERSION` string. Proved live,
not only in unit form: the fetched 0.9.2 daemon reports 0.9.2 and speaks
`trx64-runtime/2`.

**716.4 — Versioning contract. BUILT.** Written down in `INSTALL.md`: minor may break,
patch does not intentionally change tool schemas, `.c64re` compatibility or invocation;
`package.json` is the one authority and a release is tagged `v<version>`; and the pinned
TRX64 release moves with it, because the protocol match is exact.

**716.5 — `INSTALL.md`. BUILT.** Three audiences, five routes, and the three-part install
stated up front — package, runtime, ROMs — because the third part is the one nobody warns
about. `README.md` keeps a quick-start and links here. Validation is honest rather than
claimed: macOS and Linux/container are exercised by the gates; the Windows and WSL2 sections
are written from the shape of the problem (path quoting, `$env:`, the filesystem boundary)
and are marked in this spec as not yet run on those shells — §9's first follow-up.

**716.3b — `macos-x86_64` in TRX64. BUILT.** The gate found this itself: the installer
claimed to serve `darwin-x64` and the release workflow built no such target. A cross-build
entry from `macos-latest`, not a `macos-13` runner label GitHub is retiring; `--target`
threaded through, one `$BINDIR` computed from the matrix and read by every step below it,
and a static proof step for the cross entry because an arm64 runner cannot run an x86_64
binary without Rosetta. Six targets now.

**716.6 — Publish. OPEN by design.** Both gates are green, the manifest is complete, and
`.github/workflows/release-npm.yml` exists and is inert until a `v*` tag does. What remains
is in this order, and the first step is a human one:

1. Create the npm organisation `trex64` (free for public packages) and sign in.
2. `npm publish` 0.1.0 once, by hand. A trusted publisher is configured **on a package**,
   so the package must exist before it can be pointed at a workflow. This first release
   cannot be automated, and publishing is irreversible after 72 hours.
3. On npmjs.com, point the package at this repository and `release-npm.yml`. Since
   2026-09-03 a new configuration permits `npm stage publish` only unless direct publishing
   is also ticked.
4. Every release after that is `git tag v0.1.1 && git push --tags`. No token is stored
   anywhere: the workflow presents a GitHub OIDC token and npm generates provenance
   attestations automatically, so the published package carries a verifiable link back to
   the commit and the run that produced it.

## 6a. The rule this spec learned twice

**Every shipped component gets an acceptance criterion that says it STARTS, not that it is
PRESENT.**

This spec asked the right question once — an earlier draft's §5.1 read *"Decide whether UI
assets are included in the MCP package or delivered as a later separate package/build
artifact"* — and the rewrite deleted it and answered it silently by omitting `ui/` from the
allowlist. When the owner corrected that, `ui/dist` went in and the gate was taught to
check the files were there. §7 was not extended, so nothing asked the follow-on question:
*if the workbench ships, what starts it?*

Nothing did. 0.1.1 shipped a workbench that could not be started from an installed package:
the launchers `project_init` writes ran `npm run workspace`, which is
`tsc -p tsconfig.json && node scripts/workspace.mjs`, and a package has no tsconfig, no
`scripts/` and no TypeScript. The gate was green throughout, because presence is not
function — which is this spec's own founding argument, applied one layer up and missed.

Found by a reader of the published package, not by any gate here.

## 7. Acceptance

1. `npm pack` produces a tarball whose contents are an audited allowlist — no samples, no
   traces, no session output, no hooks.
2. That tarball, installed into an empty directory, starts the MCP server, answers an
   initialization and one tool call, reads its shipped knowledge base, and spawns its
   pipeline child.
2a. `--help` and `--version` answer instead of waiting on a stdin nobody will write to.
2b. The workbench **starts** from that installation — `c64re ui` serves the built bundle on
   its port — and the launchers `project_init` writes invoke it without a build step and
   without baking a path that the npx cache will move.
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

## 10. What is not yet proved

Stated rather than implied, so nobody reads a green board as more than it is:

- **Windows PowerShell — proved 2026-09-25**, run 36183644245: both jobs green. Getting
  there took three runs and found three POSIX assumptions, all of them in the gate rather
  than in the package: `execFileSync` does not consult PATHEXT, so `npm` was ENOENT; naming
  `npm.cmd` then hit Node's refusal to spawn a batch file without a shell, answered by
  running npm through `npm_execpath` with this Node instead of reaching for `shell: true`
  and buying a quoting problem; and an absolute Windows path handed to `import()` parses as
  the scheme `d:`.

  The gate then grew the part that was missing on every platform: it checked that npm had
  written the executable's shim and never ran it. It now completes an MCP session three
  ways — `node <entry>`, the shim npm wrote, and `npx <name>` — because a harness names the
  command, and on Windows that name is a `.cmd` reached through a shell.
- **WSL2 — proved 2026-09-25**, run 36194897749. This spec previously said WSL2 could not
  be proved on a GitHub runner, on the belief that the images lack nested virtualisation.
  That was out of date — it arrived with the Dadsv5 image in January 2024, WSLv2 works from
  `windows-2022` onward, and `Vampire/setup-wsl` defaults to version 2. The claim was
  withdrawn and then tested: Debian-13 under WSL2, Node installed inside it, and the gate
  green 29/0 on the distribution's own filesystem. The job also asserts
  `/proc/sys/fs/binfmt_misc/WSLInterop`, so a green run cannot mean it quietly ran
  somewhere else.

  **And the `/mnt` warning was measured rather than repeated.** Both filesystems run the
  full check: **23 s on the distribution's own disk, 31 s under `/mnt`**, both 29/0. That is
  a third slower, not the "great deal" `INSTALL.md` claimed, so the document was corrected
  to say what was measured — while noting that the check is not a file-heavy workload and a
  disassembly listing is, so the gap widens with the work. The advice survives; its
  justification is now a number.

  One thing that did not work and was rebuilt: the timing was first carried between steps
  through `$GITHUB_ENV`, which does not exist inside the distribution — `setup-wsl` gives
  the step a shell in WSL, and the runner's environment is not in it. Both measurements now
  happen in one step and nothing reads the runner's environment.

- **`npx -y @c64re/mcp` cannot be true until 716.6.** Everything in `INSTALL.md` that names
  the registry describes the package this spec built and has not published.
