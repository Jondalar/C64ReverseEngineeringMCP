# Spec 866 — Two doors, not four: the load address decides

**Status:** READY (2026-09-21)
**Repo:** C64RE only. TRX64: no change.
**Number:** 866 (registry: `specs/README.md`).
**Depends on:** 865 (`disasm_raw` and the headerless render path), the one address rule
BUG-055 settled, the analysis-import path.
**Origin:** the owner, 2026-09-21, after a run on four G64 sides: *"wie wäre es einfach nur
disasm und Analyse als Tools zu haben?"*

---

## §1 What is wrong

Four doors answer two questions. `disasm_prg` and `disasm_raw` render the same bytes with the
same decoder, renderer and annotations — they differ only in whether two bytes at the front
are a load address. `analyze_prg` classifies, and **there is no way to classify headerless
bytes at all**: the nine analysers run on a PRG or not at all.

The cost is not theoretical. A run over four G64 sides needed segment annotations on 1541
drive code. `disasm_raw` refused them — *"segment/table annotations need an analysis JSON"* —
and `analyze_prg` takes only a PRG, so the session built **fake 2-byte load headers**, wrote
`.prg` copies and routed through `disasm_prg --platform c1541`. That is exactly the
workaround 865 was written to end, reappearing one door over.

## §2 The rule

**The load address decides how bytes are read, not the file name.**

- `load_address` given → the bytes are raw and start there.
- `load_address` omitted → the file must carry a header; its first two bytes are read as the
  load address.
- Both a header and a `load_address` that disagree → refused, naming both. A guess is never
  silently preferred to what the caller said.

The extension is a **hint in the message, never the decider**. This repo already learned
that: `runtime_session_start` identifies a medium by content, because in a real corpus the
name lies — payloads carved out of a disk carry no extension at all (`pack1 (nameint1`),
`.bin` files are PRGs and `.prg` files are raw blocks. So the answer says which reading it
took and where the address came from:

> no `load_address` given and `s.bin` read as headed — the first two bytes are `$0A5F`; if
> that is wrong, pass `load_address`.

One line, at the top, where a wrong reading is caught before the listing is believed.

## §3 D1 — `disasm`

One door replacing `disasm_prg` and `disasm_raw`, keeping everything 865 built: the window
(`offset`/`length`), entry points, annotations, the named analysis, the bank and space, the
drive CPU, the reassembly proof, the registered listing with its provenance. Its inputs are
§2's rule plus what the two doors already take; nothing is dropped.

## §4 D2 — `analyze`

One door replacing `analyze_prg`, reading bytes by §2's rule, so **the nine analysers run on
headerless bytes** — a depacked chunk, a relocated overlay, a block of drive code. The
analysis JSON it writes is the same shape the renderer consumes, and it is registered like
every other output, so §5's lookup can find it.

## §5 The analysis a render uses

Both sides stop guessing at the filesystem. `analysis_json` names a path: if it exists it is
used, unchanged, and never swapped — the rule BUG-055 settled stands. If it does not exist,
or is not given, the **project store** is asked which analysis is registered for these bytes,
and the answer names the file it used and why it chose it. Only with nothing in the store does
the door fall back to the file beside the bytes.

This closes the second half of the same defect: `extract_disk` writes its analysis into a
hashed payload directory while `disasm_prg` insists on the path beside the PRG, so a correct
call was refused and the session re-ran `analyze_prg` for every extracted file.

## §6 The old names

`disasm_prg`, `disasm_raw` and `analyze_prg` are named in playbooks, in the doctrine, in
gates, and in project notes written months ago. They keep working as aliases of the new doors
for one release, and each says so once in its answer — naming the door to use and why the two
became one. They are removed in the release after, and the board records the date.

## §7 Scope

- **Not** a new decoder, renderer or analyser. This is the door in front of what exists.
- **Not** the runtime: reading a live machine stays `runtime_monitor_disasm`.
- **Not** a change to what an analysis JSON contains, or to how annotations are applied.
- The `platform` distinction (`c64` / `c1541`) stays a parameter, not a door.

## §8 Acceptance

1. **The same bytes, both ways.** A PRG rendered with no `load_address`, and its headerless
   body rendered with `load_address` set to the header's value, produce the same instructions
   at the same addresses.
2. **A disagreement is refused.** A header saying `$0801` and `load_address: $C000` is a
   refusal naming both, not a silent choice.
3. **The reading is stated.** Every answer says which rule it took and where the address came
   from; a headless caller can tell a wrong reading from the first line.
4. **The analysers run on raw bytes.** `analyze` on a headerless block of 6502 produces an
   analysis whose segments the renderer then applies — the 1541 case, end to end, with no
   `.prg` written anywhere.
5. **A named analysis is never swapped** (BUG-055's rule), but a missing one is looked up in
   the store and the answer names what it found — the `extract_disk` case that had to re-run
   `analyze_prg` for every file.
6. **The old names work and say so**: each alias renders identically and carries one line
   naming its successor.
7. **Nothing is invented**: after a run the input bytes are unchanged and no `.prg` was
   written to stand in for headerless bytes.

## §9 Surface

Two default tools, `disasm` and `analyze`, in the disassembly playbook where the four were,
with descriptions that say when to pass a load address and what happens when you do not. The
three old names stay on the surface as aliases for one release.
