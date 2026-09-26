# Spec 882 — Exomizer raw: the backwards depack

**Status:** PROPOSED 2026-09-26 — open on purpose. Built when a project needs it.
**Repo:** C64RE only. TRX64: no change.
**Number:** 882 (registry: `specs/README.md`).
**Origin:** the dead-code audit of 2026-09-26 (Spec 883), finding #4.

---

## §1 What is wrong

Exomizer's `-b` is a property of the stream, not of the tool: the packed data is read from
its end towards its start and the output is written from high addresses to low. It is how
a game decrunches in place when the packed block and its destination overlap.

C64RE has one half of it:

| Side | Tools | `backwards` |
|---|---|---|
| Packer | `pack_exomizer_raw`, `pack_exomizer_shared_encoding` | works — `raw-cruncher.ts` takes `directionForward: false` |
| Depacker | `depack_exomizer_raw`, `try_depack` with `format=exomizer_raw` | throws — `raw-decruncher.ts`: *"Exomizer raw backwards depack (-b) is not implemented yet in TypeScript."* |

So the server can pack a stream it cannot unpack, and a game that decrunches an Exomizer
stream backwards gets an error from the one door that exists for it.

## §2 What is done now, and what is not

Spec 883 makes the depack side say this in its schema instead of offering the parameter
as if it worked. The throw stays; it is honest. Nothing is implemented here yet.

## §3 When it is built

- `raw-decruncher.ts` gains the backwards direction, read from the Exomizer sources the
  forward decruncher was ported from — not re-derived.
- Acceptance is a round trip against our OWN packer, which already writes the format:
  pack backwards → depack backwards → byte-identical, over the same corpus the forward
  direction is tested with.
- Then a real stream from a game, found statically, depacked and compared against what
  the game's own decruncher produces in `sandbox_depack`.
- The schema text from 883 goes back to describing a working parameter.

## §4 Open

Nothing blocks it. It waits for a project that needs it.
