# Spec 867 — The window a payload owns, and who is resident in it

**Status:** BUILT 2026-09-21 — on `spec-867-payload-window`; §8 records what it cost and what it corrected
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

---

## §8 What was built (2026-09-21)

**The model is two rules, and nothing else.** A window is a space, a bank, a start and
an end. Two payloads loading at the SAME start are occupants of ONE window — five
modules at `$7400` are alternatives to each other, never each other's holes. A window
with a DIFFERENT start lying wholly inside another is a hole punched in it: at an
address the inner window covers, the outer payload is not the claimant, because
something else loads there. Claimants of an address = every window covering it, minus
every one an inner window covering it supersedes. `src/knowledge-graph/windows.ts`.

**A window comes from one of three places, and the answer always says which.**
`payload` — a payload record's own window. `image` — the extent the project holds for
that owner, the union of its `segment`, `routine` and `entry` nodes, which is the
mapping it was analysed at. `analysed-range` — the range in front of the caller, for an
owner the project records nothing about.

**One deviation from §2, recorded rather than quietly taken.** For an image's OWN
window the graph's extent is never used; it is the payload record's window, or the
range being analysed. The extent is a lower bound — the graph knows the routines a run
found, not the file's length — and a window that is too small drops an address that is
in the image, which §6.7 forbids. For every OTHER owner the same lower bound is exactly
right, because there it is only ever used to say "something else loads in here". The
838 fixture proved the point: `resident`'s two routine nodes made its extent
`$C000-$C03D`, and an address at `$C050` would have fallen out of its own image.

**Out of scope is not a refusal.** A cross-owner address the window puts outside this
payload's business travels in `codeSeedReport.outOfScope`, never in
`rejectedEntryPoints`: nobody asked for it, so nothing was taken away. Spec 838's
`owned_by_other` subtraction survives in exactly one case — the resolving owner has no
window at all, and the graph's owner claim is still the best answer anyone has.

**Measured on the reported project** (`Neuromancer_Test`), the same graph read both ways:

| owner | window | before | after |
|---|---|---|---|
| `05_s` | `$0A5F-$CBDA` | 40 cross-owner seeds, 36 refused | **1** seed, 75 out of scope, 0 refused |
| `mod_s3_t1s9` | `$7400-$7BFC` | 3 seeds, 4 refused | 6 seeds, 0 refused |
| `mod_s4_t1` | `$7400-$83FC` | 4 seeds, 4 refused | 7 seeds, 0 refused |
| `ov_4300_engine` | `$4300-$73FC` | 23 seeds, 30 refused | 48 seeds, 0 refused |

§1's "52 seeds, 24 rejected" was an older state of that graph; the counts above are the
same graph before and after, which is the comparison that means something. **Nothing
`05_s` owns was lost with them**: its 7 human routines and 36 Spec 826 aliases — the
addresses its own owner claims — still seed, and it is only the cross-owner ones that
are gone. That is §2's "its own window AND its own owner", read exactly as written.

**D1's record half.** `EntityRecord.payloadWindow`, persisted as `attrs.payload.window`.
`register_payload` derives it from the bytes it is handed, the manifest door from the
spans, the cart-chunk door from where the chunk lands. **Nothing is migrated and nothing
is rewritten** (§5): a record written before today has no window, and one is derived on
read from the same two facts — `list_payloads` marks a derived window with a star and
says so in a footer.

**D2.** `graph_find` on an address and `graph_node`'s card both carry the claimants,
each with its owner and where its window came from, plus the windows an inner window
supersedes, naming the one that claims the address instead. On the reported project
`$7400` answers with the eight payloads of that window and says the 50 KB file is not
one of them; `$4315` answers with the engine alone.

**D3.** `src/symbols/window-residency.ts`. The bytes are Spec 804's residency, used and
not rebuilt — `PayloadBytes`, the same class the name resolver uses. The reading is Spec
750.4's sector-load detector: an immediate track, an immediate sector, then the call.
Where neither settles it the answer names the claimants and says which source was
missing. Two doors carry it: `runtime_resolve_pc` (it has a machine, so the bytes
decide) and `list_payloads { address }` (it has none, and never pretends to).

**One extension to 750.4, additive.** Its grouped candidate now carries `positions` —
every track/sector it is called with, each with its call site — instead of only the best
one. It already counted the distinct pairs to decide the candidate was a loader at all;
reading them back out of the evidence prose would have been a second implementation of
the same scan. `suggest_loader_entrypoints` is unchanged.

**Two implementations, held to each other.** The window model exists twice — ESM in
`src/knowledge-graph/windows.ts` and CommonJS in
`pipeline/src/analysis/payload-windows.ts` — because `src/` and `pipeline/src/` cannot
import each other, the same split `platform-kb` and the cycle table already live under.
The gate runs both over one fixture graph and fails if they disagree, window for window
and claimant for claimant.

**One existing gate changed its words**, deliberately, and 838's own reasoning asked for
it: `e2e:838-islands` still asserts that `$C050` stays data, is not in the seed list and
is named in the listing, but it is now **out of scope** rather than **refused** —
`overlay_b`'s routine node gives it a window of its own inside the image, and an address
inside another payload's window was never this payload's to refuse.

**Gates.** `e2e:867-window` 51/0 — hermetic, in CI (`.github/workflows/gates.yml`): six
modules on one window, a payload spanning half the machine, an engine loading inside it,
a loader calling one routine from three sites, its own graph through the real schema,
and the capture handed in as the `ByteSource` the runtime implements. `smoke:867` 10/0
against a real TRX64 sandbox: load one payload at `$1000`, ask who is in the window,
load another over it, ask again — the answer follows the memory and names nobody while
the memory holds neither. Also run green: `e2e:838-islands` 53/0, `e2e:838-harvest`
65/0, `e2e:830-seed` 10/0, `e2e:842-graph` 11/0, `e2e:820-2` 40/0, `e2e:tooling-defects`
87/0, `e2e:subject-identity` 49/0, `e2e:one-store-writer` 63/0,
`check:mcp-product-surface` (293 tools, inventory regenerated), `check:docs-current`,
`test:project-knowledge`.

**TRX64 unchanged**, as §0 said it would be.
