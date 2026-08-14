# Bug: Session start demands a disk path that does nothing, and cannot start from a cart, PRG or snapshot

- **ID:** BUG-041
- **Date:** 2026-08-14
- **Reporter:** human ("Warum gibt es immer eine .g64 oder .d64 beim Start einer Session?")
- **Area:** mcp-tool
- **Severity:** medium (pure ceremony today; blocks the obvious cart-first workflow)
- **Status:** open <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Surface: mcp default
- Tool: `runtime_session_start` → WS `session/create`

## What happened

`runtime_session_start` requires `disk_path` (`z.string()`, no `.optional()`), and there is
no cartridge, PRG or snapshot equivalent. So a cart-first workflow reads:

> start a session with a `.g64` as boot medium, then mount the 0.9.71 release CRT

The `.g64` is never used. On a shared attach the daemon does not act on it at all — its own
comment says so:

> On a SHARED ATTACH the device/pal/start_track/write_protected params do **NOT** reconstruct
> the singleton machine (TS attach does not auto-mount/re-cold either)

Mounting happens through `media/ingress` / `media/mount`, which handles carts perfectly
well. So the required parameter is inert, and the workflow is a detour to satisfy a schema.

This is a leftover from the disk era. When a session meant "a drive with a medium", a disk
path *was* the session. Since carts, snapshots and the shared singleton machine, the session
IS the machine and a medium is something you put in.

## Expected

One optional `media_path` that decides by **content, not extension** — the same rule the
cartridge readers already follow (`readerForMedium` chooses by magic).

| type | detection | on start |
|---|---|---|
| `.c64re` | own magic + sha256 (Spec 707) | undump — the whole machine |
| `.crt` | `"C64 CARTRIDGE   "` in the first 16 bytes | insert cartridge |
| `.g64` | `"GCR-1541"` | mount in the drive |
| `.d64` | **no magic** — size (174848 / 175531 / 196608 …) + BAM plausibility on track 18 | mount in the drive |
| `.prg` | **nothing at all** — 2 bytes of load address, then data | load; see below |

Order matters: magic first, then size, then the fallback. A `.prg` can only ever be the
LAST resort — it is "none of the others", never a positive match.

**`.prg` autostart rule (owner, 2026-08-14):** load address is exactly `$0801` **and** the
first line is a valid BASIC line → type `RUN` + RETURN. Otherwise load and leave it.

This is better than it first looks: most machine-code `.prg`s also load at `$0801` behind a
stub (`10 SYS 2061`), and that stub **is** how they are meant to be started. One rule covers
BASIC programs and SYS-stub releases without a special case. A `.prg` at `$C000` has no
defined entry point, so loading and stopping is the honest answer.

"Valid BASIC line" is checked, not assumed: load address exactly `$0801`; the next two bytes
are a link pointer that points FORWARD and lands inside the loaded data; two bytes of line
number follow; the line terminates with `$00`. Any of those failing means load-only. **No
guessing** — a `.prg` at `$0801` with garbage at the front is broken or exotic, and `RUN` on
it is a bet, not a behaviour.

## Repro steps

1. Call `runtime_session_start` with only a cart path → schema error, `disk_path` required.
2. Pass any `.g64` to satisfy it, then `runtime_media_mount` the `.crt`.
3. Observe the `.g64` was never touched.

## Scope guess

- `src/server-tools/headless.ts:65` — `disk_path: z.string()` and the tool description
  ("Inputs: disk_path"), which walks every reader into the same detour
- `crates/trx64-daemon/src/main.rs` — `"session/create"`, plus wherever `media/ingress`
  already does the per-type work

## Notes / follow-up

- **The detection and the autostart rule belong in the DAEMON**, not the MCP tool. The tool
  passes a path and renders the reply. Otherwise the next client — the C64RE UI, a script,
  the TUI — reimplements the same logic with a different edge case at `$0801`. Same root
  cause as BUG-040 and the same rule from `project_trx64_daemon_owns_all_state`.
- Keep `disk_path` accepted as a deprecated alias so existing callers do not break; it maps
  to `media_path`.
- `runtime_run_prg` already covers "load and run this one thing" and stays as it is.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
