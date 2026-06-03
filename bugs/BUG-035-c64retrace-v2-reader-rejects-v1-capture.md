# BUG-035 — c64retrace format bumped to v2 with no back-compat; live daemon still writes v1 → every fresh capture is unindexable

**Severity:** high (blocker for Spec 753 + all trace query tools) — every trace the
current daemon produces fails background indexing, so no `.duckdb` is created and
`trace_memory_map` / `trace_store_*` / all query tools have nothing to read.
**Area:** runtime / binary trace log / `c64retrace` format versioning (`binary-format.ts`)
**Status:** FIXED (2026-06-03) — read-compat added; v1 corpus recovered, `e2e:753` 34/34.
**Found:** Wasteland-Claude, 2026-06-03, validating Spec 753 (`trace_memory_map`) on a
fresh title→area capture.

## Fix (2026-06-03)
Root choice = **read-compat** (the bug's preferred option), not a stricter writer.
The v2 reject I added during the Spec 753 adversarial review was over-strict: it
chose data-loss-safety against a *silent mis-frame* but orphaned the whole v1
corpus AND tripped on the live daemon's writer skew. Replaced with **version-aware
decoding**:
- `decodeFileHeader` now accepts `version` 1..`C64RETRACE_FORMAT_VERSION` (rejects
  only a FUTURE/invalid version, which it genuinely cannot lay out).
- `decodeEvent(buf, off, version)` + `decodeEventStream(buf, start, version)` take
  the header version; a v1 mem-access record (RAM_WRITE/IO_WRITE/DRIVE_RAM_WRITE)
  decodes at the 14-byte (no-old_value) width, v2 at 15 (present-bit + old_value).
- `binary-log-indexer` keeps the header `version` and threads it into every
  `decodeEvent` in the streaming loop.
- **Defect 2 (writer skew) is now non-fatal:** even a v1 writer's output indexes
  fine (just without `old_value`). The writer DOES emit v2 after a clean build —
  proven by `traces/e2e746.c64retrace` (header ver=0002). The earlier "post-restart
  still v1" was a transient stale-`dist`/running-process skew, not a code bug; the
  daemon just needs to run on freshly-built `dist`.

**Verified:** re-indexed a real on-disk v1 log (`.tmp/smoke-trace-binary/trace.c64retrace`,
5.7 MB) WITHOUT re-tracing → 300003 `trace_event` + 3 `bus_events` (drive VIA1 $1800,
decoded at v1 width), `old_value` correctly absent; 300003 clean CPU rows after the
mem records prove the framing held (a mis-frame would cascade). Gate `e2e:753` Parts
F (v1 accepted / future rejected) + G (v1 mem-access stream decodes at 14-byte width).
The 1.8 GB `live_mpy3s9oh.c64retrace` can now be re-indexed in place.

## Repro
1. Run the daemon, start a live capture, drive the game (title → into an area), stop.
2. Capture writes the binary log `runtime/integrated-1/live_<id>.c64retrace` (here
   `live_mpy3s9oh.c64retrace`, 1.8 GB — capture itself is fine).
3. Background indexing into `.duckdb` FAILS; no `live_mpy3s9oh.duckdb` is produced.
4. `trace_memory_map` (and any query tool) has no `.duckdb` → unusable on the fresh trace.

## Daemon log
```
[trace] background index failed for .../runtime/integrated-1/live_mpy3s9oh.duckdb:
  c64retrace: unsupported format version 1 (this build reads v2); re-capture the trace
```

## Root cause (confirmed)
A **writer/reader version skew** around `C64RETRACE_FORMAT_VERSION`:

- `src/runtime/headless/trace/binary-format.ts:29` — `C64RETRACE_FORMAT_VERSION = 2`.
- Reader `binary-format.ts:126-127` hard-rejects anything `!= 2`:
  `throw "c64retrace: unsupported format version ${version} (this build reads v${...}); re-capture the trace"`.
- Writer `binary-format.ts:105-107` writes `C64RETRACE_MAGIC` then the version as `setUint16(8, …)`.

But the **bytes the running daemon actually wrote are v1**. Header of every current
`.c64retrace` (hexdump, offset 0):
```
43 36 34 52 45 54 52 31 | 01 00 00 00 | 93 03 00 00 | {"runId":...}
 C  6  4  R  E  T  R  1  |  ^^^^^ uint16 @off8 = 0x0001 = version 1
```
So magic = `C64RETR1` (8 bytes, `binary-format.ts:24`) and the **uint16 version field at
offset 8 = 1**. The live capture path emitted **v1**, while the indexer/reader is built
with `C64RETRACE_FORMAT_VERSION = 2` → mismatch → reject.

I.e. the constant was bumped 1→2, but the **writer in the long-running daemon process is
still on v1** (process/dist skew — the daemon emitting the log predates, or wasn't rebuilt
onto, the v2 writer). Restarting the daemon via `node scripts/runtime-daemon.mjs` did NOT
fix it — the freshly-restarted daemon still wrote v1 (`mpy3s9oh` @ 15:31 is post-restart),
so the deployed `dist/` writer is still v1 even though the source constant reads 2.

## Two distinct defects
1. **No back-compat on the bump.** The reader hard-rejects v1 instead of supporting
   `version <= C64RETRACE_FORMAT_VERSION` (migrate/read-old). A format bump that orphans
   every existing `.c64retrace` (and the 7 GB+ of prior captures: `live_mpvrre8a`,
   `live_mpvorwa8`, …, all `C64RETR1` v1) is a silent data-loss footgun.
2. **Writer not actually on v2.** The deployed writer still stamps v1 (header proof above),
   so even a clean re-capture stays v1 → the reader still rejects it. The daemon's advice
   "re-capture the trace" is therefore wrong/misleading for this case — re-capture alone
   does not help; the writer build (or the version policy) must change.

## Expected
Either: the reader accepts v1 (read-time migration / `version <= CURRENT`), OR the writer
and reader are the SAME version in one consistent build, so a fresh capture indexes.
Bonus: the daemon's "re-capture" hint should only fire when re-capture would actually fix
it (i.e. writer ≥ reader), else say "incompatible build (writer v{w} / reader v{r})".

## Actual
Reader = v2, deployed writer = v1, no migration → 100% of fresh captures unindexable;
all historical captures (v1) also now unreadable by this build.

## Impact
- Spec 753 (`trace_memory_map`) cannot run on any new capture (its whole point).
- All `trace_store_*` / `runtime_query_events` query tools are dead on fresh traces.
- 7 GB+ of existing v1 captures orphaned.

## Data is intact / recovery
`live_mpy3s9oh.c64retrace` (1.8 GB) is complete — only indexing fails. Once the version
mismatch is resolved (reader accepts v1, OR writer rebuilt to v2 + re-capture), the
existing binary log can be **re-indexed without re-tracing**. Prefer adding v1 read-compat
so the historical corpus survives the bump.

## Pointers
- `src/runtime/headless/trace/binary-format.ts` :24 (magic), :29 (`FORMAT_VERSION=2`),
  :105-107 (writer stamps magic+version), :119 (magic check), :126-127 (version reject).
- Header evidence: `runtime/integrated-1/*.c64retrace` all start `43 36 34 52 45 54 52 31 01 00` (magic `C64RETR1` + uint16 v1).
- Affected fresh trace: `runtime/integrated-1/live_mpy3s9oh.c64retrace` (2026-06-03 15:31).
