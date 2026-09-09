# The Knowledge Graph

Every reverse-engineering session ends the same way: somebody knows things that
nobody can look up. The graph is where those things go. (Specs 817–826)

## The problem it solves

Assembler declares nothing. A 6502 routine has no signature, no name, no
argument list and no return type — those exist only in the head of whoever read
it, or in a comment somebody wrote and nobody indexed. So the second session on
a project starts by re-deriving what the first one already knew, and the third
one disagrees with both.

Worse, the obvious workaround does not work. You cannot recover this by scanning
bytes: a byte at `$8000` is an opcode or a pixel or a pointer depending on who
jumps there, and a plausible-looking table of addresses is very often data that
happens to decode. Pattern matching over an image produces confident answers
that are wrong in a way nobody notices, because every row still looks
reasonable.

The graph holds what was actually established, with the evidence attached, so
the next session reads instead of re-deriving.

## What it is

One SQLite file per project, `<project>/knowledge/graph.sqlite`, plus one shared
store describing the machine itself (Spec 817). Nodes are the things an RE
project talks about — routines, labels, addresses, zero-page locations, I/O
registers, ROM entries, payloads, subsystems — and edges are what they do to
each other: calls, jumps, reads, writes, contains, belongs-to.

Three properties do most of the work.

**Every id is derived, never assigned.** A node's id says what the node is:

```
c64:io:d018                          the VIC's memory control register
c64:rom:ffd2                         the KERNAL's CHROUT
myproj:ram/engine_0200:routine:1dd2  a routine in that payload
myproj:crt/07:routine:8000           code in cartridge bank 7
```

Because the id is derived, re-running the analysis lands on exactly the same
rows. Nothing accumulates duplicates, and two producers looking at the same
routine cannot disagree about which row it is.

**Banking is part of identity** (Spec 818). On a C64 the address `$8000` is not
a place — it is a place *and* a configuration. The id names where the bytes
live: `ram/<artifact>`, `crt/<bank>`, `drv/<artifact>`. A cartridge with sixty
banks has sixty different `$8000`s and the graph never confuses them.

**There are two layers, and re-analysis cannot touch the human one.** Everything
a producer derives is the `generated` layer; everything a person asserts is the
`human` layer. A producer replaces only its own rows. So you can re-run the
analysis on a payload you have already documented, as often as you like, and
your names survive it — which is the property that makes re-running safe, and
therefore the property that makes people do it.

Every row also carries where it came from (`static`, `runtime`, `user`,
`imported`) and how sure it is (`certain`, `inferred`, `observed`, `heuristic`,
`user_asserted`), so a claim and its standing travel together.

## What it can answer that a listing cannot

A disassembly answers "what is at this address". These are the other questions:

- **Who calls this?** Not "who mentions this number" — who actually calls it,
  by an edge a producer wrote from a decoded instruction.
- **What does this routine do to the registers?** The 6502 declares no
  interface, so the graph computes one (Spec 826): which registers a routine
  reads before writing (`in`), which it leaves meaningful (`out`), which it
  destroys (`clobbers`), which it saves and restores (`preserves`), and what it
  does to the stack. Where the answer cannot be computed it says `partial` and
  names the site that defeated it, instead of guessing.
- **What is passed at each call site?** The argument slice sits on the call
  itself, so two callers of one routine can be told apart.
- **Which addresses does this touch?** Reads, writes, indirect accesses,
  zero-page use, hardware registers — separately, because they mean different
  things.
- **What is at `$D018`, and who uses it?** The platform store knows the machine;
  the project store knows your code; a query crosses both.
- **What has nobody looked at yet?** Coverage is a property of the graph, so the
  honest answer to "what is left" is a query rather than a memory.

## How you use it

Five tools on the MCP surface (Spec 823): `graph_overview` for the shape of a
project, `graph_find` to search, `graph_node` for one thing and everything known
about it, `graph_edges` for what reaches it or what it reaches, and `graph_path`
for how two things are connected.

On the command line the same store is reachable through
`node dist/cli.js graph <verb> --project <dir>`. `seed` fills it from the
analysis JSONs, `resolve` links ownerless addresses to whoever actually lives
there, `signature` and `args` answer the register questions for one routine,
`callers` and `readers` answer the other direction, `boundaries` reports what
the human named that discovery never found, `migrate` brings an older project
in, and `name` / `link` / `assign-subsystem` are the human layer's door.
`node dist/cli.js graph help` lists them all.

You rarely write to it directly. The doors are the ordinary tools: analysing a
payload fills the generated layer, an annotations file is imported when the
listing is rendered, and `save_finding` / `save_entity` / `link_entities` write
the human layer (Spec 822). Naming a routine in an annotations file IS entering
it into the graph; there is no second step to forget.

## Seeing it

The **Graph** tab draws the whole project four ways (Specs 824–825), from one
in-memory model:

- **Force** — clusters by what actually calls what, so subsystems separate
  themselves.
- **Layers** — entries at the top, then routines, then labels, then addresses,
  zero page, I/O and ROM at the bottom; calls and accesses read downward.
- **Radial** — rings by hop distance from whatever you focus on. Ring one is
  the immediate neighbourhood.
- **Address** — the C64-native view: horizontally the address axis `$0000`
  through `$FFFF`, vertically a lane per bank. A cartridge shows its RAM band
  and a tower of bank lanes standing on the cartridge window.

Filters are lenses: turning an edge family off hides it and never moves a node,
so the picture stays stable while you narrow it.

Measured on a real project (a cartridge conversion): 13 060 nodes, 28 761
collapsed edges, drawn in about 200 ms, and 162 communities detected over the
call graph alone.

## Why it is worth the trouble

The honest argument is not that a graph is elegant. It is that the alternatives
have all been tried in this repo and they lost:

- **Notes in Markdown** cannot be queried, drift from the code, and the next
  session does not read them.
- **JSON stores per concept** — findings here, entities there — had no identity,
  no cross-references and no way to ask a question that spanned two of them.
  They were folded into the graph (Spec 822.2) and the files retired.
- **Scanning for structure** finds tables that are not there and misses the ones
  that are, because on this machine the shape of a byte does not tell you what
  it is.

What is left is: write the fact down once, with its evidence, in a place where a
query can find it and a re-analysis cannot quietly overwrite it. That is the
whole idea.

## Where these pages live

This page is written and checked in the main repository under `docs/wiki/` and
published into the wiki by hand. `npm run check:wiki` verifies both halves: that
the source pages are correct — every spec reference exists, every tool named is
a real tool, every example parses against the live parser — and that the
published copy still matches them, read over git rather than over the raw CDN,
which serves a stale page for minutes after a push.

## Related

- Reference for the tools, producers and edge types: `docs/tools/knowledge-graph.md`
- Taking a project that predates the graph into it: `docs/migrating-a-project-to-the-graph.md`
