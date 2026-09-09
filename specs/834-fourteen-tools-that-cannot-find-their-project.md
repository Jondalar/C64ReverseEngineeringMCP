# Spec 834 — Fourteen tools that cannot find their project

**Status:** BUILT 2026-09-09 — `e2e:834-headless` 118/0, `e2e:834-trace-store`
93/0, `e2e:834-scene-reel` 41/0, all three hermetic and in `gates.yml`;
`KNOWN_HINTLESS` is **empty** and the portability rule has no exceptions left;
every existing gate green. Three agents, one shape each. `sandbox_depack`, the
fifteenth, was fixed when this spec was written because it was the one that also
*lied*: it declared `project_dir` and resolved without it.
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

**Corrected by the build: for this family the hint is nearly a formality, and
the spec implied otherwise.** An ABSOLUTE store path needs no project at all —
a capture under the 827 per-user root has no project marker above it to walk up
to anyway. A RELATIVE one handed to `resolveProjectDir` is equivalent to
hintless, because the search start is resolved against the cwd before the walk
begins. `project_dir ?? path` is implemented as D1 says and satisfies the
portability rule, but the load-bearing fix is the CANDIDATE SEARCH:
`<project>/<input>`, then `traceDirForProject(project)/<input>`, then the 827
pointer file at `<project>/runtime/traces.json` — newest first, matched on file
name, trailing segment or `runId` — each candidate PROBED rather than composed,
so a relative path finds a real store instead of a plausible one.

Neither the pointer file nor the computed directory is sufficient alone, which
is why both are in the chain. `traceDirForProject` is computed from the CURRENT
`C64RE_TRACE_DIR`, so a capture written while that pointed elsewhere is
invisible to it and only the pointer can answer; and the pointer is append-only
and soft-fail by 827's own design, so a capture whose pointer write failed is
found only by the computed directory.

## 4. `runtime_scene_reel` — the closest twin, and uncaught

`context.projectDir()` in `src/server-tools/scene-reel.ts`, hintless and NOT in
a try/catch, with `feature_path`, `out_path` and `media_path` right there. It
fails outright outside a project, which at least is loud.

Corrected by the build: unlike `sandbox_depack`, which declared `project_dir`
and ignored it, this tool **declared none at all** — it never offered a caller
any way to say where they were. D1's "not a new parameter where one exists" does
not cover that case; here one had to be added. Its hint order is
`feature_path → media_path → out_path`, and the reasoning is worth keeping: the
first two are INPUTS that already exist, and the feature file is the anchor the
tool already trusts (`resolveMedium` looks beside it before it looks in the
project). `out_path` is an OUTPUT that need not exist yet and whose own contract
is "relative to the project dir", so deriving that project dir from it is
circular — it is in the list only because it is the one REQUIRED argument, which
is what makes the hint never `undefined`. The resolution also moved BELOW the
argument guards, so a call missing its scenario is told that, instead of being
told about a project it never reached.

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

## 6b. A second cwd fallback, one level down — found, NOT fixed

`absStorePath()` in `src/server-tools/trace-read.ts` resolves a relative store
path against `process.env.C64RE_PROJECT_DIR ?? process.cwd()`. It is dead for
MCP callers once §3 lands — they now always hand it an absolute path — but the
**workspace-UI REST endpoints reach `traceRead` directly**
(`src/workspace-ui/server.ts:439`), so the same defect survives on the UI's side
of the same store.

Not folded in: it is a different caller with a different resolution (the UI
server is started WITH its project and knows it), and mixing that into a batch
about the MCP tool surface would hide it. It needs its own decision about where
the UI's trace routes get their root — a question this spec does not ask.

## 6c. Two things the build found that change the count

**Two of the six were worse than §2 says.** `runtime_render_screen` and
`runtime_recorder_dump` never called `resolveHeadlessProjectDir` at all — they
resolved NO project. They appeared on the allowlist only because the portability
gate's test is per FILE: one hintless `.projectDir(` anywhere in `headless.ts`
marked every path-taking tool in it. Their real defect is worse than "the wrong
project": the PNG landed against the **MCP process cwd**, and the dump path went
raw to the **project-agnostic daemon**, which resolves it against its own cwd
while serving several projects.

**Fifteen was a floor, not a count.** `runtime_trace_start` is a sixteenth
instance the gate could not see, because its path parameter is called `output`
and the walk's name matcher did not know that word. It is fixed with `output` as
its hint, and `PATH_NAME` now also knows `output`, `out`, `source`, `dest` and
their kin — a name list is only as good as the names people chose, and the right
moment to widen it is when a case walks in.

## 7. Not in this spec

- Whether `sandbox_6502_run` and `sandbox_depack` belong in `DEFAULT_TOOLS` at
  all (`e2e-mcp-project-inventory` 4c, red since before Spec 832). A tier
  decision, not a defect.
- `pathMode` in `docs/mcp-tool-usecase-matrix.md` is a hand-kept 24-name list
  against 70 real path-taking tools, so ~46 rows read wrong. The gate's live
  schema walk already supersedes it as the source of truth; regenerating the
  matrix is a separate, mechanical change and would churn a generated file.

## 8. Gates

One per shape, not one for all fourteen as first written — they fail
differently, they were built in parallel, and a shared gate file would have been
three agents editing one script. `e2e:834-headless`, `e2e:834-trace-store`,
`e2e:834-scene-reel`: for each tool, resolution from an explicit `project_dir`;
resolution from its own path argument when that is absent; and from neither
`C64RE_PROJECT_DIR` nor the process cwd, both removed in the child. Plus, once
all three land: `KNOWN_HINTLESS` is empty and the rule has no exceptions.

`KNOWN_HINTLESS` is FILE-granular, not per-tool — the portability gate flags a
tool when its FILE contains a hintless `.projectDir(` call — so the list empties
in steps of a whole file, and only after the last of the three is clean.

## 9. Acceptance

the three gates green and in `gates.yml`; `e2e-mcp-path-portability` green with
an empty allowlist; every existing gate still green.
