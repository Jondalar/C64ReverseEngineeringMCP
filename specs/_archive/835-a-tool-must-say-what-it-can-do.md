# Spec 835 — A tool must say what it can do

**Status:** BUILT 2026-09-09 — `e2e:835` 12/0, hermetic, in `gates.yml`; every
existing gate green.
**Origin:** A project session could not work out how to start a runtime session
from a cartridge. The tool has taken one since BUG-041; nothing anywhere said so.
**Anchor:** Specs 832–834 (a tool that knows something and does not say it) ·
`project_default_tools_invisibility` — reach a caller cannot see is reach the
tool does not have
**Touches:** `src/server-tools/headless.ts` · `docs/tools/headless.md` ·
`scripts/e2e-835-session-start-says-so.mjs` (new)

## 1. What was wrong

`runtime_session_start` accepts a `.crt` through `media_path`, and the daemon
decides the medium type from the file's content. That was the point of BUG-041:
a session is a MACHINE and a medium is something you put in it, so the old
required `disk_path` — which forced a caller to name a `.g64` nobody used and
then mount the cartridge separately — was replaced by one parameter for every
medium.

From outside the repo none of that was visible:

- `media_path` was `z.string().optional()` with **no description at all**. The
  paragraph explaining the content-sniffing sits directly above it, as a source
  comment. An MCP client never sees a source comment.
- The tool's own description said "Start a headless C64+1541 session" and never
  mentioned a cartridge, a PRG or a snapshot.
- The one visible name that *did* suggest media was `disk_path`, the deprecated
  alias — whose name says the opposite of the truth.
- `docs/tools/headless.md` mentioned CRT exactly once, for the monitor's
  `swapcrt`, which swaps a cartridge in a session that is already running.
- Of the tool's 15 parameters, 3 were described.

So the fix for BUG-041 shipped and the news of it did not. 832 and 833 were
about tools claiming what they had not done; this is the mirror image, and it
costs the same thing — a caller doing it the hard way, or not at all.

## 2. Decisions

**D1 — every parameter of this tool is described.** Not just `media_path`. An
undescribed parameter is invisible reach: `enable_kernal_serial_traps` decides
whether a fastloader is even observable, and it was a bare boolean. Where a
setting has a trap in it, the description says so rather than naming the
setting again in prose.

**D2 — the description names the cartridge case explicitly**, along with the
disk, the PRG and the snapshot, and says the type comes from the file's
content — so nobody goes looking for a per-medium tool that does not exist.

**D3 — the deprecated alias explains that its own name is the misleading part.**
`disk_path` cannot be removed without breaking callers, so it says what it is.

**D4 — the "sandbox" collision is documented, not renamed.** The word means two
things here: `sandbox_6502_run` / `sandbox_depack` are a CPU sandbox with no
machine at all — flat RAM and the real 6502 core, no VIC, no CIA, no drive, no
KERNAL — while an ephemeral MACHINE on its own port is started with
`runtime_session_start` like any other session. Someone hunting for "a sandbox
with a cartridge" will find the CPU tools first and they are the wrong ones.
Renaming an MCP tool breaks every caller and every stored reference for a
cosmetic gain, so the collision is stated where a reader hits it instead.

## 3. Gate

`e2e:835`, hermetic — it reads the generated tool surface and the source, no
daemon and no network. The tool's description names the cartridge case and the
parameter that takes it; `media_path` is described and names `.crt`, the
snapshot case and the content rule; the deprecated alias explains itself; **every
parameter is described**, which is the rule rather than the instance; and the
doc shows the actual call rather than prose about it, plus the sandbox
collision.

## 4. Not in scope

Renaming `sandbox_6502_run` / `sandbox_depack` (D4), and the older question of
whether they belong in the default tool surface at all
(`e2e-mcp-project-inventory` 4c, red since before Spec 832).
