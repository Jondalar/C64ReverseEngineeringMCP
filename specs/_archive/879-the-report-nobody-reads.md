# Spec 879 — The report nobody reads

**Status:** BUILT 2026-09-25.
**Repo:** C64RE only. TRX64 already has this and is the template.
**Number:** 879 (registry: `specs/README.md`).
**Origin:** the owner, 2026-09-25, on finding CI red again: *"Das wollten wir doch hier
abfangen mit einem pre commit hook?"*

---

## §1 What is wrong

`e2e:839-media` went red at **7dfb3c5f** — the commit that brought `runtime_monitor`'s
description in line with TRX64 0.9.2. Among other things it taught `eject` to take a unit,
so `eject [cart|disk]` became `eject [cart|disk|<unit>]`. The description got better and
the gate went red over it, because the check asserted the bracket as a literal substring.

It then stayed red through two more pushes — Spec 877's and Spec 878's — and nobody saw.

**The rule is not the problem.** *CI reports, never gates* is this repo's decision and it
stands: a pull request is read and judged by a human, and branch protection blocks only
force-push and delete. What the rule assumes is that someone **reads** the report. Nobody
does. A report nobody reads is not a weaker gate; it is not a gate at all, and it had been
standing in for one.

Nor was the existing hook ever going to catch it. `.githooks/pre-commit` does exactly one
thing: on a `src/` change it regenerates `docs/tool-surface-inventory.json` and stages it.
It runs no gate and never claimed to. The gate hook the owner remembered is **TRX64's**
`hooks/pre-push`, which says so in its own header: *"nothing else runs these tests … This
hook is the only thing standing between a red workspace and main."* C64RE never got one.

## §2 The decision

**A pre-push gate, scaled to what the push carries.** Pre-push, not pre-commit: work is
committed per slice, and a slice must stay cheap. A push to master is the moment something
becomes everyone's.

Two questions decide the tier, the same two TRX64's hook asks:

1. **Does it reach master?** A feature branch is work in progress and gates when it
   merges. Anything else — a branch, a tag — is not gated.
2. **What does it carry?** Prose and pictures do not have to build the workspace bundle
   to prove themselves. But they are not free either: this repo has gates that judge
   *documents*, and doctrine rule 9 is one of them. So a docs-only push runs the document
   tier, not nothing — which is where this differs from TRX64, whose emulator has no such
   gates and treats Markdown as wholly inert.

The file test is a **whitelist of inert files, not a blacklist of code**. A `package.json`,
a workflow, a build script, a file type nobody listed — all run the full gate. Guessing
wrong in that direction costs minutes; guessing wrong in the other ships red to master.

## §3 What was built

**`scripts/gate.sh`** — runs the gates locally, and runs *exactly* the ones CI runs. It
carries **no list**: it parses `.github/workflows/gates.yml` and executes that workflow's
steps, in its order, under its names, skipping `npm ci` (a working tree already has its
dependencies; re-installing them is not what is being tested). There is no second list to
keep in step, because a second list is precisely how this went wrong.

- `scripts/gate.sh` — all 80 steps.
- `scripts/gate.sh docs` — the 3 that judge documents.
- `GATE_LIST=1 scripts/gate.sh` — print the steps, run nothing.
- On red it stops, names the failing step, and prints the one command that re-runs it.
- An empty step list exits 2. It will not report green on a run that did nothing.

**`.githooks/pre-push`** — the decision, and the block. `core.hooksPath=.githooks` is
already set by `package.json`'s `prepare`, so `npm install` installs it. `GATE_SKIP=1`
bypasses one push behind a loud banner; `GATE_DRYRUN=1` prints the tier and the file list
and runs nothing.

**The gate that was red** — `e2e-839-media.mjs`'s forwarded-verb list now takes a pattern
where a literal would pin something still moving. What the check guards is that the verb
is named and that both media it can take come out; the alternatives after that are the
daemon's to grow. 43/0.

## §4 What does not change

- **CI still reports and does not gate.** This adds a local gate; it does not turn the
  GitHub workflow into a blocker, and branch protection is untouched.
- The `pre-commit` hook keeps its one job.
- The gates that need ROMs, an assembler, real media or the daemon stay local and manual:
  the workflow is deliberately the hermetic subset, which is exactly why it is the part
  that can be demanded of every machine.
- Nothing in TRX64.

## §5 Acceptance

1. `GATE_LIST=1 scripts/gate.sh` lists 80 steps; `docs` lists 3.
2. `GATE_DRYRUN=1` on a real push to a feature branch → tier NOTHING.
3. …on master carrying only `specs/*.md` → tier DOCS, naming the three files.
4. …on master carrying `scripts/e2e-839-media.mjs` → tier ALL.
5. `scripts/gate.sh` green over all 80 steps on master.
6. The hook blocks a push when a step is red, and names the step and the re-run command.

## §6 What the first live push taught

The gate went green, the hook printed *"push allowed"*, and `git push` then died with
exit 141 — SIGPIPE — without the commit reaching the remote. Twice.

Git hands a pre-push hook its ref lines on **stdin**, and every child the hook starts
inherits that pipe. The gate's eighty node steps inherited it, one of them drank from it,
and the pipe broke under git. The hook was reporting on a push it had just killed.

So the refs are read once, at the top, and everything downstream — `scripts/gate.sh`, and
inside it every step — is started with `</dev/null`. TRX64's hook never hit this because
`cargo` does not read stdin; eighty npm scripts are a different animal.

The general shape is worth keeping: **a hook's stdin belongs to git, and is only ours to
read once.**
