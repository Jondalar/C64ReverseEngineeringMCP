# Spec 893 — The project you name is the project you get, and every project is in git

**Status:** PROPOSED (2026-10-04)
**Repo:** C64RE. From issue #35 (Mike, Windows 11).

## §1 What went wrong

`contract_set(project_dir="D:\Claude\Shine PETSCII", …)` overwrote `knowledge/contract.json`
of a different project, the one `C64RE_PROJECT_DIR` named. No error; the success line
printed the wrong path. The old contract was gone: the project was not in git, and nothing
else kept it.

The cause is the order in `resolveProjectDir` (`src/project-root.ts:12`): the env var is
checked before `hintPath`, so an explicit `project_dir` is never read while the env var is
set. Every tool that resolves through `server.ts` `projectDir()` is affected, including
`agent_onboard` (it onboarded the env project) and the onboarding gate. `project_init`
resolves its own way and honoured the argument, which is how the second project came to
exist at all.

Two failures, two rules:

1. **A named project is honoured or refused, never swapped.**
2. **A project without history loses data on the first wrong write.** The owner,
   2026-10-04: *"USE … Git!"* — no `.prev` files, no private backup scheme: git.

## §2 Rule 1 — the project you name

- **An explicit `project_dir` wins** over `C64RE_PROJECT_DIR`. The env var is the default
  for a call that names no project, nothing more.
  - The named directory resolves to its project root the way it does today (walk up to
    the marker). No marker found: refuse, naming the directory and `project_init`. Never
    fall back to the env project or the cwd.
- **A file path used as the hint** (`prg_path`, `image_path`, `input_path`, `media_path`,
  `analysis_json`, …, i.e. every `projectDir(project_dir ?? <path>)` call where
  `project_dir` is absent) keeps today's behaviour: input files often live outside the
  project, so the env project (or the sole onboarded one) is used. **Except:** when that
  file lies inside a *different* project root, refuse and name both roots. A file of
  project B must not be processed into project A by accident.
  - The two cases must be told apart at the call site, not guessed inside the resolver:
    `projectDir()` takes the explicit `project_dir` and the file hint as separate inputs.
- **The onboarding gate and `agent_onboard`** resolve through the same path, so
  `agent_onboard(project_dir=B)` onboards B, and a tool naming B is gated on B.
- **Writers say where they write before success.** Every tool that overwrites
  hand-authored state (`contract_set`, `project_steering_set`, `write_annotations`,
  `model_*` writers, `save_*`) already names its target path or root in its answer; check
  that each one does and that the path is the RESOLVED root, not the argument echoed.
- `resolveWorkspaceRoot` in `project-knowledge/mcp-tools.ts` follows the same rule.
- The workbench (`src/workspace-ui/resolve-project-dir.ts`) has its own argv/env resolver;
  read it and apply rule 1 if it has the same order, else leave it.

## §3 Rule 2 — git

- **`project_init` needs git.**
  - No `git` on PATH: refuse before writing anything, with
    `PLEASE USE GIT TO AVOID LOSS OF DATA!` as the first line, then how to install it
    (Windows: Git for Windows / `winget install Git.Git`; macOS: `xcode-select --install`
    or Homebrew; Linux: the distro package) and to re-run `project_init`.
  - Git present and the project is not inside a work tree: `git init`, write a
    `.gitignore` (see below), then commit the scaffold (`c64re: project_init <name>`).
    The answer says so on its first lines.
  - Already inside a work tree (the project or a parent): touch nothing in git, add the
    `.gitignore` lines only if the file is ours or absent, and say which repo it is in.
  - A commit that fails because no identity is configured: the project stays initialised
    with the repo created, and the answer says exactly which two `git config` lines to run
    and to commit afterwards. Do not invent an identity.
- **`agent_onboard` checks every time.**
  - No `git` on PATH: refuse, same first line, same install hint. (A session that cannot
    keep history does not start writing.)
  - Project not inside a work tree: onboarding proceeds, and the answer's first line is
    `PLEASE USE GIT TO AVOID LOSS OF DATA!`, followed by the one command that fixes it
    (`git init && git add -A && git commit -m "…"` in the project root). Onboarding does
    not run git itself on an existing project — it holds the user's files and the user
    decides what goes in.
  - In a work tree with uncommitted changes under `knowledge/`: one line with the count
    and a reminder to commit. Not a refusal.
- **The doctrine says it too.** `docs/agent-doctrine.md` and the onboarding text an agent
  reads: commit the project after a working step that changed `knowledge/` (contract,
  findings, annotations, steering). The server cannot commit for the agent; it can tell it.
- **`.gitignore`** written by `project_init`: the per-machine UI starters
  (`ui-*.desktop`), the launcher log and pid files, runtime scratch, trace stores and
  other large regenerable outputs. **Read the scaffold and the writers to find the real
  names**; do not guess. Media, `knowledge/`, annotations and listings are committed.

## §4 Deliverables

1. `project-root.ts` / `server.ts` `projectDir()` / `mcp-tools.ts`: rule 1, with the
   explicit-vs-file-hint split at every call site.
2. Git checks in `project_init` and `agent_onboard` as in §3, plus the `.gitignore`.
3. Tests (a smoke wired into gates.yml, temp dirs only, never the env of the running
   session):
   - env = A, `project_dir` = B → the tool acts on B (contract_set writes B's
     `contract.json`, A's is byte-identical before and after);
   - `project_dir` = a directory with no project → refused, A untouched;
   - env = A, file hint inside B, no `project_dir` → refused, both roots named;
   - env = A, file hint outside any project → A, as today;
   - `agent_onboard(project_dir=B)` onboards B; the gate on a B call asks for B;
   - `project_init` with no git on PATH (PATH stripped) → refused, first line exact,
     nothing written;
   - `project_init` in a fresh dir → a repo with one commit, `.gitignore` present;
     inside an existing repo → no nested repo;
   - `agent_onboard` on a non-repo project → first line exact; no git → refused.
4. Docs: README / INSTALL / `docs/windows-setup.md` say a project needs git and why; no
   spec numbers. `docs/agent-doctrine.md` gets the commit rule.
5. Issue #35 answered when it ships.

## §5 Not in this spec

`.mcp.json` generation and checking (issue #36) and the ten items of issue #37.
