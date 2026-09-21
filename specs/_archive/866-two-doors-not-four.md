# Spec 866 — Two doors, not four: the load address decides

**Status:** BUILT 2026-09-21 — on `spec-866-two-doors`; §10 records what was built, what
it cost the gates, and the one place the spec's own wording had to be weighed against the
rule it was replacing.
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


## §10 As built (2026-09-21)

**D1 `disasm` and D2 `analyze`** — `src/server-tools/analysis-workflow.ts`, both on the
default surface, both in the static-pass playbook where the four were.

**It is not a new decoder, renderer or analyser, and the diff is how you can tell.**
One body runs both readings and picks the pipeline verb from the reading —
`disasm-prg` for a headed file, `disasm-raw` for raw bytes — and everything past
that point is the same decoder, the same segment-aware path, the same annotation
handling, the same `.asm`/`.tas` pair and the same rebuild proof. The three
changes that went into the shared code went in *once* and both readings have them:

* **`loadRaw` takes a window** (`pipeline/src/analysis/prg.ts`), so the nine
  analysers run over exactly the span a listing will be rendered over. Without it
  the only way to analyse a window was to carve it into a file of its own — which
  is the shape of the reported defect, one level down.
* **`analyze-prg` takes `--offset`/`--length`** beside the `--load-address` it
  already had, and refuses a window with no address: a window's first byte is not
  a load header, so a window is raw bytes by definition.
* **`disasm-raw` takes `--relocations` and `disasm-prg` takes `--annotations`.**
  Neither is a property of the two bytes at the front. Relocated code arrives just
  as often with no header, and an annotations file often lives under a name no
  `<stem>_annotations.json` was going to match.

**What was one door's and is now both's.** A headed reading gained the provenance
line on the artifact row, the payload link and the §5 analysis lookup; a raw
reading gained the recorded platform (`platform: "c1541"` now writes the machine
for a block of drive code, which is the case the drive tables exist for), the
annotation name-length pre-check and the next-step task. What stayed
reading-specific is only the *shape* of the output: where a listing goes by
default (`<stem>_disasm.asm` beside a headed file, `analysis/raw-disasm/…` for
raw bytes) and which artifact roles it registers under, because those feed the
views.

**§2's rule, and the one thing it does not say.** A `load_address` makes the
bytes raw; its absence makes the file headed. The third case — "both, disagreeing"
— needs something to say the bytes *do* carry a header, because otherwise the
first rule swallows it. Two things can say so, and both are a statement rather
than a guess: the caller, with `headed: true`, and the **project store**, when it
has this file registered as a PRG and the caller named no window. Nothing is
inferred from the extension, which is the point: a `.bin` with no `load_address`
is read as headed, and a `.prg` with `headed: false` is read raw from offset 0.
Both are in the gate.

**§5 was weighed against BUG-055, not applied over it.** BUG-055's rule was *a
named analysis is never swapped* — and it was enforced by refusing a named path
that does not exist. §5 keeps the first half exactly (named and present is used
unchanged, and on a raw reading it is still held against the window) and changes
the second, because refusing was refusing **correct calls**: `extract_disk` writes
its analysis into a hashed payload directory, so the path a caller expects beside
the PRG genuinely is not there. The lookup is a link, not a stem guess — the store
records every analysis against the artifact it was produced from — and the
protection moved rather than vanished: the swap is stated in the answer, by name,
and a named path that exists nowhere (not in the store, not beside the bytes) is
still a refusal. `e2e:disasm-family` §3 now asserts both halves.

**D3 the old names.** `disasm_prg`, `disasm_raw` and `analyze_prg` are the same
body invoked under another name: identical listing, identical refusals, and the
tool's own name in its refusal header, so a caller of an old name never sees a
message about a tool it did not call. Each appends exactly one line naming its
successor and why the two became one. They are deliberately **not** in a playbook
— a playbook is what a session is steered by, and steering it at a name that is
going away is how a retired door stays alive.

**Gates.** `e2e:866` is hermetic and in CI: 65/65 with KickAssembler, 63 and 2
loud skips without. Six existing gates asserted behaviour that is now the merged
door's and were updated rather than muted — `e2e:disasm-family` (the analysis
lookup), `e2e:865` (the description now points at the same door without a load
address), `e2e:833` and `e2e:847` (both read the wrapper's source: the candidate
list is a named function now, and the importer is handed the path the renderer
printed), `e2e:842` (the relocation key is spread in conditionally) and
`e2e:849` (the two project rules ride on the new names). Regression-checked
green: `e2e:865`, `e2e:867-window`, `e2e:disasm-family`, `e2e:830`,
`e2e:830-seed`, `e2e:832-annotations`, `e2e:833-render`, `e2e:741`, `smoke:741`,
`smoke:disasm-sync`, `e2e:752`, `e2e:tooling-defects`, `e2e:one-store-writer`,
`e2e:842-graph`, `e2e:842-reloc-data`, `e2e:847-docs`, `e2e:849-rules`,
`e2e:861-impact`, `e2e:862-rules`, `e2e:751`, `e2e:758`, `e2e:759`, `e2e:829`,
`e2e:838-*`, the whole `check:mcp-product-surface` suite, `check:address-rule`
and `check:docs-current`.

### §10.1 What a caller of an old name sees

Exactly what they saw before, plus one line. The listing is byte-for-byte the
same file, the artifact row is the same row, a refusal still opens
`# disasm_prg refused`, and the answer ends with:

> Note: disasm_prg is now `disasm`, and this name keeps working for one release.
> disasm_prg and disasm_raw ran the same decoder, renderer, annotations and
> rebuild proof and differed only in whether two bytes at the front are a load
> address — so that is the only question left: pass load_address and the bytes
> are raw and start there, leave it out and the file's first two bytes are read
> as one.

Two answers changed shape for everyone, old names included, because they are the
rule: every answer now opens with `Reading: …` and carries an `Analysis: …` line
naming the file the render used and why.

### §10.2 Left as it was, and why

* **A verified rebuild check is still kept beside a headed reading** and still
  discarded beside a raw one, which is 865's rule unchanged: beside a PRG that
  stray `.prg` is unremarkable, beside a headerless listing it is the artefact
  the raw door exists to stop producing.
* **`platform` stays a parameter, not a door** (§7), and `cpu: "drive"` survives
  on the `disasm_raw` alias, mapped to `platform: "c1541"`.
* **The store lookup prefers the most recently written or used analysis** for
  these bytes. Using one re-registers it, so "the one you reached for last" wins
  a tie — which is the behaviour a session wants and is stated in the answer
  either way.
* **TRX64: no change.**
