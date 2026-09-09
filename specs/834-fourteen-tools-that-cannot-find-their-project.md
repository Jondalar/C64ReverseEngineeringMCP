# Spec 834 — Fourteen tools that cannot find their project

**Status:** PROPOSED 2026-09-09 — `sandbox_depack`, the fifteenth, is fixed here
already because it was the one that also *lied*: it declared `project_dir` and
resolved without it.
**Origin:** Spec 833 D5 widened `e2e-mcp-path-portability` to walk nested
schemas. It was hunting one tool and found fifteen.
**Anchor:** the path-portability rule in the tool-matrix header · Spec 833 (the
same shape, stated as a rule) · `project_default_tools_invisibility` — a tool
surface is only as good as what a caller can actually reach
**Touches:** `src/server-tools/headless.ts` · `src/server-tools/trace-store.ts`
· `src/server-tools/scene-reel.ts` · `scripts/e2e-mcp-path-portability.mjs` ·
one gate

## 1. The measurement

Of the 70 default tools that take a path, **15 hand `resolveProjectDir` no hint
at all**. The resolver then has nothing to walk up from and falls back to
`C64RE_PROJECT_DIR` or to the process cwd happening to sit inside a project.
The matrix header's rule says no default tool may be `broken-cwd-coupled` and
that path-taking tools resolve through the project resolver, never the process
cwd — so this is fifteen violations of a written rule, not fifteen rough edges.

One is fixed (see §5). The remaining fourteen fall into three shapes, and the
shapes matter more than the count because each one fails differently.

## 2. The six headless runtime tools — a silent miss

`runtime_session_start`, `runtime_loader_lens`, `runtime_load_prg`,
`runtime_run_prg`, `runtime_render_screen`, `runtime_recorder_dump`, all through
`resolveHeadlessProjectDir(context)` in `src/server-tools/headless.ts`, hintless
at every call site. Each call is in a try/catch, so a wrong root does not fail —
it produces a tool that quietly works against the wrong project, or against
none. `prg_path` and `media_path` sit in the same argument object, unused for
this purpose.

This is the worst of the three shapes: an error would at least be visible.

## 3. The seven trace-store readers — an explicit cwd fallback

`trace_store_info`, `trace_store_query`, `trace_store_top_pcs`,
`trace_store_bus_find`, `trace_store_anchor_list`, `trace_store_anchor_find`,
`trace_memory_map`. `resolveStorePath` resolves a relative store path against
`proj ?? process.cwd()`, and the fallback is deliberate and commented.

It is the honest one of the three — somebody decided it — but it predates the
rule it now breaks, and after Spec 827 a trace store lives OUTSIDE the project
under a per-user data root, so resolving one against the cwd is answering a
question nobody is asking any more.

## 4. `runtime_scene_reel` — the closest twin, and uncaught

`context.projectDir()` in `src/server-tools/scene-reel.ts`, hintless and NOT in
a try/catch, with `feature_path`, `out_path` and `media_path` right there. It
fails outright outside a project, which at least is loud.

## 5. `sandbox_depack` — fixed in this spec

The fifteenth is not deferred, because it belonged to Spec 833's own title
rather than to this list: it **declared** `project_dir` and resolved with
`ctx.projectDir(undefined, true)`, so the parameter a caller passed was read by
nobody. It now resolves `project_dir ?? input_path` — `input_path` is the packed
blob and is always present — and it has left the `KNOWN_HINTLESS` allowlist,
which is the only direction that list is allowed to move. Asserted in
`e2e:833-sandbox`.

## 6. Decisions

**D1 — every one of the fourteen takes a hint from a path the call already
carries.** Not a new parameter where one exists: `prg_path`, `media_path`,
`feature_path`, a store path. The shape is `project_dir ?? <the call's own
path>`, which is what `disk-g64.ts` has always done and what 833 gave the two
sandbox tools. Where a tool has no path at all, it says so in this spec and
keeps its fallback — but none of the fourteen is that case, which is why the
list is actionable.

**D2 — the trace-store fallback is removed rather than re-pointed.** Spec 827
moved a capture out of the project on purpose. `resolveStorePath` should take
the store path it was given, resolve a relative one against the project the
caller named, and fail with the 827 pointer file's location when it cannot —
not silently answer from the cwd.

**D3 — the headless six stop swallowing the resolution error.** A try/catch
around "which project am I in" turns a wrong answer into no answer at all. The
catch stays where it guards the daemon being absent; it does not stay where it
guards the project being unknown, because those are different failures and only
one of them is normal.

**D4 — the allowlist empties, and then the check has no exceptions.** When the
fourteen are done, `KNOWN_HINTLESS` is `new Set()` and the gate's rule becomes
unconditional. An allowlist that never empties is a rule nobody believes.

## 7. Not in this spec

- Whether `sandbox_6502_run` and `sandbox_depack` belong in `DEFAULT_TOOLS` at
  all (`e2e-mcp-project-inventory` 4c, red since before Spec 832). A tier
  decision, not a defect.
- `pathMode` in `docs/mcp-tool-usecase-matrix.md` is a hand-kept 24-name list
  against 70 real path-taking tools, so ~46 rows read wrong. The gate's live
  schema walk already supersedes it as the source of truth; regenerating the
  matrix is a separate, mechanical change and would churn a generated file.

## 8. Gate

`e2e:834-hints` — for each of the fourteen: the tool resolves from an explicit
`project_dir`; resolves from its own path argument when that is absent; and does
neither from `C64RE_PROJECT_DIR` nor from the process cwd (both removed in the
child). Plus: `KNOWN_HINTLESS` is empty and the portability rule has no
exceptions left.

## 9. Acceptance

`e2e:834-hints` green and in `gates.yml`; `e2e-mcp-path-portability` green with
an empty allowlist; every existing gate still green.
