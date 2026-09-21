# Spec 869 — What a decision governs

**Status:** PROPOSED 2026-09-21.
**Repo:** C64RE only. TRX64: no change.
**Number:** 869 (registry: `specs/README.md`).
**Depends on:** 847 (`documents declare themselves` — the frontmatter block, `doc_register`,
`doc_lint`, `wiki_index`).
**Origin:** the Wasteland_2 session, 2026-09-21, after writing eleven ADRs under `docs/adr/`
and finding nothing in the frontmatter that fits them; endorsed by the owner the same day.

---

## §1 What is wrong

847's frontmatter has one field for reach: `covers`, an address range or an artifact. That
field was drawn from documents that explain bytes, and for those it is right. A document
that records a **decision** often reaches nothing in the address space at all:

- *The game is English, monolingual* — governs the whole project, names no range.
- *Content first, questlog after* — an order of work, not a region.
- *Code lives locally, content on the NAS* — about the repository, not the cartridge.

`kind: decision` already exists and `covers` is already optional — a decision document with
`title`, `kind` and `status` and no `covers` parses and registers today. So nothing is
blocked. What is missing is the ability to say what the decision **does** govern, and two
things follow from that absence:

1. A decision that governs the whole project is indistinguishable from a document that
   simply forgot to declare its reach. Both read as empty.
2. A decision that *does* touch bytes — *a journal entry is 8 bytes* → the journal overlay —
   must choose between naming the artifact and naming the scope, because there is only one
   field and it means the artifact.

The session that hit this declined to invent a range, and was right to: a made-up `covers`
reads later as a claim about the game, and this repo's contract rule already says that no
document should be made to assert what nobody asked it. The cost of being right was that
eleven finished ADRs sit in `doc_lint`'s `undeclared` list, which is the backlog bucket for
documents nobody has got to yet.

## §2 The field

A new **optional** frontmatter field, a list like `covers`:

```
scope: project | medium | build | game
```

- **`project`** — the repository and how work in it is organised: where files live, which
  tool is used, naming conventions, what is tracked where.
- **`medium`** — the disk, cartridge or image and what is on it: layout, allocation, which
  side carries what.
- **`build`** — how the artifact is produced: packer, bank layout, assembler, the pipeline
  that emits it.
- **`game`** — what the finished program does or presents to a player: language, content,
  feature set, the order things are offered in.

Three rules bound it:

- **`scope` never replaces `covers`.** It sits beside it. A decision about an 8-byte journal
  entry declares both: `covers: journal overlay artifact`, `scope: build`. The range says
  where the decision lands in the bytes, the scope says what kind of decision it is.
- **A `scope` is not an assertion about the program.** It says which part of the work the
  decision governs, which is exactly what `covers` cannot say without lying.
- **The field is available on every kind, asked for on none but `decision`.** A parser
  branch per kind buys nothing, and 847's own warning applies — a field nobody fills is
  worse than no field, because it makes the declaration look complete.

## §3 What changes

- `src/docs/frontmatter.ts` — parse `scope`, validate against the closed set of four, refuse
  an unknown value by naming it and listing the four. The template placeholder is refused the
  way `covers`' is, for the same reason.
- `src/docs/register.ts` — carry `scope` onto the document node's attrs and report it in
  `doc_register`'s answer beside the coverage count.
- `wiki_index` — decisions group by `scope`, so the ADRs appear in the index without
  pretending to describe bytes.
- `doc_lint` — one new observation, and only for `kind: decision`: a decision that declares
  neither `covers` nor `scope` governs nothing that can be found. Named as its own line, not
  folded into `undeclared` (the file *is* declared) and not `malformed` (it parses).

## §4 What does not change

- No migration. Every document written before this parses unchanged; `scope` absent is
  absent, not empty-and-wrong.
- `covers` stays optional and keeps its meaning exactly.
- No new tool and no new door. `doc_register`, `doc_lint`, `doc_template` and `wiki_index`
  are the surface, as 847 left them.
- Nothing in TRX64.

## §5 Acceptance

`e2e:847-docs` extended, red before the change:

1. A decision with `scope: project` and no `covers` parses, registers, and appears in
   `wiki_index` under its scope.
2. A decision with both `covers` and `scope` keeps both, and the coverage entry still
   resolves in the graph.
3. An unknown scope value is refused, naming the value and the four that are allowed.
4. A decision with neither is reported by `doc_lint` on its own line — not as undeclared,
   not as malformed.
5. A document written before this spec, with no `scope`, parses and registers byte-identically
   to before.
