---
description: A document without frontmatter does not exist for the project — it is not indexed, not linted, and covers nothing.
paths: ["docs/**/*.md"]
tools: ["doc_template", "doc_register", "render_docs"]
---

# Prose has to declare what it covers

A markdown file in `docs/` is invisible to the project until it says what it is about.
The declaration is frontmatter, and `covers` is the field that matters: an artifact id,
or an address range as `$XXXX-$YYYY`.

```
doc_template   → a skeleton with the fields, placeholders deliberately unparseable
doc_register   → registers the file and its coverage
doc_lint       → reports files that assert nothing, and coverage that names nothing real
wiki_index     → builds the index from what is declared
```

The block, exactly:

```
---
title: <one line>
kind: synthesis | reference | decision | generated
covers:
  - $C820-$CFFF          # a range, or a single $C820
  - artifact:07_game.prg  # and/or the file it is about
sources: [what.asm, you.prg]
method: >
  How you know.
status: current | superseded
---
```

One `covers` entry per `- ` line and nothing else on it: no parenthetical, no comma
list, no prose. Quotes around an entry are accepted and stripped.

An undeclared document is not a small omission. The contract can require a document
covering the loader; a file that describes the loader beautifully and declares nothing
does not satisfy it, and the completion verdict is right to say so.

**What refuses later.** S7, S9 and S10 gate `render_docs`. Those slots are about the
game, not about this file — but a rendered document set that describes an unmapped game
is exactly the Neuromancer failure: documentation saying EXHAUSTIVE at fifteen per cent
coverage.
