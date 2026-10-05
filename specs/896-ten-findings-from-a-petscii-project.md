# Spec 896 — Ten findings from a PETSCII logo project

**Status:** PROPOSED (2026-10-05)
**Repo:** C64RE (item 9 may reach TRX64). From issue #37 (Mike, Windows 11, 64tass only).

Mike's issue names a public CSDb file and an exact call for every item; unp64 confirmed
each depack byte-identical. The files are not in this repo and are not to be downloaded
by a build: each test below builds a minimal fixture that shows the same shape (a BASIC
stub, a self-extracting loop, a headerless depack, …).

## §1 The items, the rule for each

1. **The rebuild check ignores `preferredAssembler`.** `disasm_prg` always verifies with
   KickAssembler and warns "KickAssembler jar not found" in a 64tass-only project. Rule:
   the check uses the project's `preferredAssembler`; with none set, whichever assembler
   is installed (KickAssembler first, as today). It warns only when no assembler at all is
   available, naming both.
2. **`disasm` reads string `offset`/`length` as decimal.** The schema says strings are
   hex. Rule: a string is hex (`$`/`0x` prefix optional), a number is decimal — the same
   parser every address/length parameter uses. Check every numeric-or-string parameter of
   `disasm` and its siblings against that parser.
3. **`assemble_source` and `runtime_render_screen` fail when the output folder is
   missing.** Rule: every tool that writes to a caller-named path creates its parent
   directories. Fix these two and grep for the same shape in the other writers.
4. **`sandbox_depack` refuses a self-extracting file** ("packed payload overlaps the
   resident loader window") when the loader IS the packed file. Rule: source == loader is
   allowed — the payload is the loader image itself, loaded once, run from `entry_pc`.
   Overlap of two DIFFERENT images stays refused.
5. **`runtime_session_run` with `until` is "not yet routed through the Runtime Daemon"**
   (`headless.ts:264`). `runtime_until` already runs to a condition on the shared
   session. Rule: `runtime_session_run {until}` goes the same way; any `until` kind
   `runtime_until` cannot express is refused by name, not with an internal slice number.
6. **`try_depack format="byteboozer2"` writes a headerless body under a `.prg` name.**
   Rule: a depacker that knows the destination address writes a PRG with that load
   address; one that does not writes `.bin` and says so. Check every `try_depack` format.
7. **`sandbox_6502_run` reports I/O writes as `$00` under `$01=$37`.** Writes to
   `$D000-$DFFF` with I/O banked in are lost from `output_path` and the written-range
   report, while `$01=$34` captures them. Rule: with I/O visible, writes to the VIC/SID/
   colour RAM/CIA ranges are recorded as written (colour RAM as its low nibble), so a
   screen viewer's colour RAM and `$D018/$D020/$D021` can be checked. Read the sandbox's
   memory model first and say in §7 what it now does.
8. **`analyze` calls a BASIC line code.** `$0801-$0806` of a PRG loaded at `$0801` holding
   a valid BASIC line (`0B 08 CA 07 9E 32 30 35 39 00` = `1994 SYS 2059`) is classified
   as code. Rule: a PRG at `$0801` whose first line parses as BASIC (link pointer into the
   file, line number, tokens, `00` terminator, chain ending `00 00`) gets a `basic`
   segment, and a `SYS <n>` in it becomes an entry point.
9. **The shared session froze once**: PC and cycle count stood still while
   `runtime_session_run` answered "Ran up to ~4000000 cycles". Not reproduced. Rule on the
   C64RE side: a run answer reports the cycles actually advanced (after − before from the
   daemon), and an answer where that is 0 says plainly that the machine did not advance —
   never a "ran up to" figure the machine did not run. The daemon side (why it stalled) is
   not chased without a reproduction; issue reply asks for one.
10. **After an MCP restart `save_finding` refuses until `agent_onboard` runs again**, with
    nothing announcing it. Onboarding is per server process by design. Rule: the refusal
    says the server was (re)started since the last onboarding and that this is why — read
    the gate to see what it can know (process start time vs. the project's last onboarding
    record) and word it from that.

## §2 Tests

One smoke per item where an item has behaviour (all but 9's daemon half), wired into
gates.yml, temp dirs and own sandboxes only — never the shared session on :4312. Item 5's
test runs against a daemon of its own on its own port (see `scripts/e2e-886-idle-exit.mjs`
for the pattern).

## §3 Docs

Tool descriptions where behaviour changed (regenerate inventory → matrix → playbooks).
User docs only where they described the old behaviour. No spec numbers in user docs.
