# Spec 838 — Three field reports: a Windows path, a harvest that invents bytes, and code nobody reaches

**Status:** PROPOSED 2026-09-10
**Origin:** Issues #15, #17 and #16, all from the same reporter, all reproducible.
**Anchor:** Spec 832 D4 (tolerant is not the same as inventing) · Spec 827
(a path policy is a library with a gate) · the `entry_points` finding —
they make discovery STRICTER, not additive
**Touches:** `src/lib/prg-workflow.ts` · the sandbox harvest ·
`pipeline/src/analysis/*` · three gates

## 1. D1 — an entity id is not a path (#15)

`src/lib/prg-workflow.ts:331` composes
`artifacts/generated/payloads/${payload.id}`, and a payload id looks like
`crazy-news-c64:ram/loader:payload:0801`. On Windows `:` is reserved (drive
letters, NTFS alternate data streams), so `mkdir` fails, the first payload's L2
step throws `ENOENT`, and the remaining seven are skipped. The extraction
succeeds and the doctrine guarantee — **there is no raw extract without a
disassembly** — silently does not hold on that platform.

**Decision.** An id is an identifier; a path is a filesystem write. Every
segment derived from an id is sanitised for the strictest platform we target,
not the one the developer is on: `:` `*` `?` `"` `<` `>` `|` are replaced, the
reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
`LPT1`–`LPT9`) cannot be a whole segment, no segment ends in a space or a dot,
and the mapping stays **stable and reversible enough to find the artifact
again** — a hash suffix when the sanitised form would collide, never a silent
merge of two payloads into one directory.

This is Spec 827's rule one level down: a path policy is a library with a gate,
not an expression inlined at a call site. The gate runs the same assertions on
every platform, because the platform it targets is not the one it runs on.

**D1 — BUILT 2026-09-10.** `src/lib/id-path.ts` is the library: pure policy
(`safeSegment`, `deviceSafeName`, `isDosDeviceName`) plus the one mkdir
(`ensureIdDirUnder` / `ensureIdDirIn`). A segment that is already safe passes
through verbatim, so nothing an existing project holds is renamed; anything the
policy had to change carries eight hex of the id's own hash, so two ids can no
longer meet in one directory — including two that differ only in case, which is
one directory on Windows. A directory written before this spec is READ WHERE IT
IS: `idDirUnder` returns the pre-existing raw-id path when it finds one, so a
project written on macOS keeps working and only new work is portable.

Six sites went through it: the reported one
(`src/lib/prg-workflow.ts` → `artifacts/generated/payloads/<entity id>`),
`snapshots/<artifact id>` (`src/project-knowledge/service.ts`),
`session/checkpoints/<id>.json` and `analysis/runs/<id>.json`
(`src/project-knowledge/storage.ts`), `session/graphics-scan/<run_id>`
(`src/server-tools/graphics-render.ts`) and `delta-<candidate id>`
(`src/server-tools/runtime.ts`). `analysis/g64/<image>/track-N/` gets the narrow
guard only (`deviceSafeName`): its stem comes from a file the host already
accepted, so the one thing that has to change is the name Windows refuses
outright — renaming the rest would move a directory every existing project has.
Gate: `npm run e2e:838-paths`, 165 assertions, hermetic, same table on every
platform.

## 2. D2 — a harvest may not invent bytes (#17)

`sandbox_depack` / `--harvest` return a CONTIGUOUS RAM window with no signal
for which bytes the routine actually wrote. Un-written bytes come back as
whatever the sandbox held — on a ROM-seeded machine, BASIC or KERNAL ROM —
indistinguishable from real payload. A multi-block depacker writes disjoint
runs, so the gaps between them are exactly where this bites.

This is Spec 832 D4 with different bytes: the GCR decoder used to emit 256
fabricated zeroes for a block it could not read, and the fix was that an
unreadable thing yields NO bytes rather than plausible ones.

**Decision.** The write set already exists — `sandbox-types.ts` returns the real
core's distinct-address write set. The harvest becomes **authoritative about
it**: it reports `writtenRuns: [{lo,hi}]` and the bytes of those runs. A caller
that asks for a window anyway gets the window AND the runs, so the gaps are
identifiable rather than implied. Nothing fills a gap with sandbox residue,
ever. The reporter's option 2 (a doctrine note instead) is declined as the
primary fix: a note does not stop the next person, and we have the data.

## 3. D3 — code entered only from another overlay (#16)

`disasm_prg` classifies a region as `unknown` and emits a `.byte` wall when its
recursive traversal never REACHES it from a trusted entry inside the same PRG.
That misses resident code entered only from a different overlay sharing the
address space, or through an indirect vector, a jump table or a self-modified
operand. It is real 6502 code and it renders as data.

Passing those addresses as `entry_points` does not fix it, and this repo already
knows why: **`entry_points` constrains the scan rather than adding to it** —
feeding a list moved 417 bytes from `code` to `unknown` on a measured project,
because the speculative scan had found things the explicit list did not. So the
reporter's workaround makes the listing worse, and the tool never says so.

**Decision, and the build must respect the order.** (a) An `entry_points`
address that lands INSIDE an already-claimed extent must not be silently
dropped — that is the reported symptom and the smallest honest fix. (b) The
seed set gains the addresses the graph already knows are code: a human `routine`
node, a `CALLS`/`JUMPS_TO` edge from another owner, a resolved jump-table
target. The graph has crossed the overlay boundary since Spec 826's
`RESOLVES_TO`; the disassembler has not been told. (c) Whatever changes, a
region promoted from `unknown` to `code` must be **byte-identical on rebuild**
and must say which seed reached it, so a wrong promotion is visible rather than
merely plausible.

Do not turn this into a byte-shape heuristic. Spec 750 settled that: scanning
for structure finds tables that are not there. The seeds come from the graph or
from a human, or the region stays `unknown`.

## 4. Gates

`e2e:838-paths`, `e2e:838-harvest`, `e2e:838-islands` — one per decision,
hermetic, each asserting the RULE rather than the reported instance.

## 5. Acceptance

Three gates green and in `gates.yml`; every existing gate green; the reporter's
three cases fixed and, for D3, the rebuild still byte-identical.
