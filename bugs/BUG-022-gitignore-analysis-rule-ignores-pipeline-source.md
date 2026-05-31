# Bug: `.gitignore` `analysis/` rule also ignores `pipeline/src/analysis/` source

- **ID:** BUG-022
- **Date:** 2026-05-31
- **Reporter:** claude
- **Area:** build / repo-hygiene
- **Severity:** medium
- **Status:** fixed

## What happened

`.gitignore` line 8 is a bare `analysis/`. It is meant to ignore the runtime
project-output `analysis/` directory, but the unanchored pattern ALSO matches
the source tree `pipeline/src/analysis/`. Tracked files there (29 of ~52) were
historically `git add -f`'d; any NEW source file under `pipeline/src/analysis/`
is silently ignored unless force-added.

Concretely surfaced during Spec 741:
- `pipeline/src/analysis/annotators/index.ts` (the whole `propose_annotations`
  annotator) was **untracked** — a fresh clone would lack it and the
  `propose-annotations` CLI (`require("./analysis/annotators/index")`) would
  fail to build/run.
- `pipeline/src/analysis/relocations.ts` (Spec 741, new) was ignored until
  force-added in commit `1ebbdc39`.

Both were force-added, but the rule still endangers every future file added
under `pipeline/src/analysis/`.

## Expected

Source under `pipeline/src/analysis/` is always tracked; only the runtime
project-output `analysis/` directory is ignored.

## Repro steps

```
echo 'pipeline/src/analysis/foo.ts' ; touch pipeline/src/analysis/foo.ts
git status --short pipeline/src/analysis/foo.ts   # → nothing (ignored)
git check-ignore -v pipeline/src/analysis/foo.ts  # → .gitignore:8:analysis/
```

## Scope guess (optional)

Likely fix: anchor the ignore to the output location only, e.g. replace bare
`analysis/` with the actual runtime output path(s) (anchored, not a bare
directory name), then audit `git ls-files --others --ignored --exclude-standard
pipeline/src/analysis/` and `git add -f` any source file that should be tracked.

Deferred from Spec 741 (out of scope there; changing the rule is broad and
risks un-ignoring unintended paths). Verify nothing under a real runtime
`analysis/` output dir gets accidentally tracked after the change.

## Resolution (fill on fix)

- **Root cause:** `.gitignore` used a bare `analysis/` directory pattern, which
  matches nested source directories such as `pipeline/src/analysis/` instead of
  only the repo-root runtime output directory.
- **Fix commit:** pending — `.gitignore` now uses anchored `/analysis/`.
- **Gate proving the fix:** `git check-ignore -v pipeline/src/analysis/foo.ts`
  returns no match, while `git check-ignore -v analysis/foo` still matches
  `.gitignore:/analysis/`.
- **Regression risk:** Low. The intended root output directory remains ignored;
  nested source directories named `analysis` are no longer hidden.
