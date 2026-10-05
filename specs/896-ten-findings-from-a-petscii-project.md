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

## §4 As built — items 1, 2, 3, 6, 8

Branch `spec-896-static`. Smoke: `npm run smoke:896-static` (`scripts/smoke-896-static.mjs`,
in gates.yml). Items 4, 5, 7, 9, 10 are another branch.

1. **Rebuild check.** `chooseRebuildAssembler` (`src/lib/rebuild-verify.ts`) reads
   `knowledge/project.json` `preferredAssembler` (`64tass` → 64tass first, `kickass` or none →
   KickAssembler first) and takes the first assembler that can actually run here
   (`findKickAssemblerJar` / `find64tassBinary` in `src/assemble-source.ts`). 64tass checks the
   `.tas` beside the `.asm`. With neither, the warning names both (jar + `C64RE_KICKASS_JAR`,
   64tass + `C64RE_64TASS_BIN` / PATH). The verdict line now ends `with KickAssembler` /
   `with 64tass`, also stamped in the listing head. Not provoked in the smoke: the "neither"
   warning (both assemblers resolve from fixed install paths on the dev machine; skipped
   loudly).
2. **`disasm` offset/length.** Already hex on master (`parseCount`, commit 91790b41, after
   Mike's build): the smoke now pins it (`"113"/"70"` = `$113`/`$70`, numbers decimal, also
   `disasm_raw`). What was still wrong: `try_depack`, `depack_byteboozer`,
   `depack_byteboozer_lykia` and `suggest_depacker` parsed `offset`/`length` with a 16-bit
   `parseHexWord`, so a window past `$FFFF` was refused. They use `parseCount` now.
3. **Output folders.** `assembleSource` creates the output's parent (covers `assemble_source`
   and the rebuild check); `basic_tokenize`, the pipeline CLI's `basic-tokenize`, `ram-report`
   and `pointer-report` too; `runtime_render_screen` writes through `writeFileCreatingDirs`
   (`src/lib/write-output.ts`). Other writers that take a caller path were read and already
   `mkdir -p`. `runtime_render_screen` needs a daemon, so the smoke tests its writer with a
   stubbed screenshot reply, not the tool.
6. **`try_depack` output.** `src/lib/depack-output.ts`. PRG with the load address:
   `byteboozer2` (always knows its destination), `exomizer_sfx` (was already a PRG), `rle` with
   `has_rle_header`. Body only: `exomizer_raw`, `rle` without a header. Naming decision:
   no `output_path` → `<input>.<format>.unpacked.prg` or `.bin` by that rule; a caller's name is
   kept, except a header-less result named `.prg` is written as `.bin` beside it and the answer
   says so. A PRG the caller names `.bin` stays `.bin`. Every answer states "Output format".
   Not changed: the standalone `depack_byteboozer` / `depack_byteboozer_lykia` tools still write
   headerless bodies (their default name is `.bin`).
8. **BASIC launcher.** The chain walk (`walkBasicProgram`, already present) required a `$0000`
   end, but packers write the launcher with its next-line pointer on the first byte of the code
   the SYS jumps to (`0B 08 CA 07 9E 32 30 35 39 00` + code at `$080B`, no `00 00`). Such a
   chain now reads as a `basic` segment (`$0801-$080A`) with the SYS target as a `basic_sys`
   entry point, but only when a resolved SYS target lies at or after the chain break, which is
   what proves the exit (`analyzeBasicProgram`, `openEnded`). `walkBasicProgram` itself stays
   strict. The `basic` kind and the SYS entry-point source already existed; nothing was added to
   an enumeration. A canonical chain ending `00 00` was already handled and is covered too.
