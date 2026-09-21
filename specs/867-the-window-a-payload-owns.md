# Spec 867 — The window a payload owns, and who is resident in it

**Status:** READY (2026-09-21)
**Repo:** C64RE only. TRX64: no change — the runtime half is 804's residency, already built.
**Number:** 867 (registry: `specs/README.md`).
**Depends on:** 818 (address identity: space, owner, bank), 804 (residency by byte-match),
838 D3b (graph code seeds), 842 D4 (code keyed on its runtime address).
**Origin:** the owner, 2026-09-21, on a game that is nothing but overlays: *"Loadtime Kontext
über den Payload, Runtime Kontext über Verständnis bzw. Trace."*

---

## §1 What is wrong

Identity is not the problem. A node id already carries its owner (`ram/<owner>` plus the
address), so `$7400` in module 3 and `$7400` in module 0 are already two nodes.

What is missing is the layer above it. Nothing records **which window a payload occupies when
it is loaded**, so two things go wrong on a game built out of overlays:

- The graph's code seeds are filtered by owner, and a seed belonging to another owner is
  dropped as `owned_by_other` with no further thought. On Neuromancer that refused
  `Entry points NOT seeded: 6 (owned_by_other=6)` for the six modules sharing `$1000`, and
  five for the `$7400` family — each of them the payload's *own* window.
- A payload that spans a lot of address space collects seeds that merely fall inside it:
  `05_s.prg` covers `$0A5F-$CBDA` and picked up **52** seeds from the engine's routines, with
  24 more rejected, because overlap in a flat address space was read as relevance.

Both are the same missing fact: **the load-time context**, which the project knows the moment
a payload is registered — the load address and the length say which window it occupies, and
the code that loads it says so outright.

## §2 D1 — The load-time context is the payload's window

A payload record gains the window it occupies when loaded: the address range, its space, and
its bank where one applies. It is not new knowledge — `payloadLoadAddress` plus the byte
length is the window, and the loader's own call sites name it too. This spec makes it
explicit, so it can be asked.

With that recorded:

- **Seeding is scoped to the window, not to the owner alone.** A seed inside the payload's own
  window is the payload's, whoever wrote it down, and is used. A seed outside it belongs to
  whatever else lives there and is not the payload's business — it is not "rejected", it is
  simply not in scope, and the answer says how many were out of scope rather than reporting a
  refusal.
- **Overlap stops meaning relevance.** A payload spanning `$0A5F-$CBDA` no longer inherits
  every node in that span; only what its own window and its own owner claim.

## §3 D2 — Who claims this address

A query that names an address without a payload cannot have one answer on an overlaid
machine, and must stop pretending otherwise. It answers with the claimants: the payloads whose
window covers that address, each with its owner, so the caller can name one. This is the same
move `get_current_artifact` made when a bare filename stopped being an identity — the honest
answer to an ambiguous question is the list of what it could mean.

## §4 D3 — The runtime context is residency

Which of the claimants is actually in the window at a given moment is not a static fact and is
not guessed. Two sources answer it, in this order:

1. **The bytes.** 804's residency: at a freeze or a trace anchor the runtime hands over the
   memory, and C64RE matches it against the payloads' bytes in the graph. Decided, not
   inferred.
2. **The reading.** Where no capture exists, the code that loads the window says what it puts
   there — the load call names track, sector and destination — so the context is known from
   the disassembly, with that call as its evidence.

Where neither settles it, the answer says the window is ambiguous and names the claimants.
It never picks one silently.

## §5 What this does not change

- Node identity keeps its shape; nothing is re-keyed and no id changes.
- An owner-less node stays what it is: a fact about an address with nobody claiming it.
- The cartridge context keeps identifying by bank, as it must.
- Nothing about TRX64.

## §6 Acceptance

1. **Six modules on one window.** Six payloads all loading at `$1000` each seed their own
   entry points; none is refused as another's, and the answer reports out-of-scope seeds as
   out of scope rather than as a rejection.
2. **A wide payload stops collecting neighbours.** A payload spanning `$0A5F-$CBDA` seeds only
   what its own window claims — the 52 cross-owner seeds are gone, and nothing it does own is
   lost with them.
3. **An ambiguous address names its claimants.** Asking about `$7400` with no payload returns
   the five payloads whose window covers it, with their owners, and no single answer.
4. **Residency decides.** With a capture, the byte-match names which claimant is in the
   window, and the names resolve to that one.
5. **The reading decides where no capture exists.** A load call naming track, sector and
   destination settles the context, with that call recorded as the evidence.
6. **Neither available is said, not guessed.** No capture and no load call yields a named
   ambiguity, never a silent pick.
7. **Existing projects keep working**: a project whose payloads have no recorded window
   behaves as before — the window is derived from the load address and the byte length when it
   is missing, and nothing is dropped.

## §7 Surface

No new tool. The payload doors record the window, the graph query answers claimants, and the
seeding path scopes by window. `disasm`/`analyze` (866) and the graph tools carry the context
where they already carry the owner.
