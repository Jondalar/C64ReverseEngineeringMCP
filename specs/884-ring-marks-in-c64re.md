# Spec 884 — Ring marks in C64RE

**Status:** PROPOSED 2026-09-26.
**Repos:** C64RE (the doors, the workbench). TRX64: one prerequisite, D0 — a capability,
so it is carried across under this spec rather than waited for (Leitregel).
**Number:** 884 (registry: `specs/README.md`).
**Depends on:** TRX64 809 (marks, sandboxes), 808 (transport), 787 (scratch instances),
769.5b (the workbench filmstrip).
**Origin:** the owner, 2026-09-26, on the dead bookmark panel: *"Das wollten wir mit dem
Ring machen können, um schnell zu iterieren."*

---

## §1 What exists — read from the code, not from 809's text

TRX64 has named marks on the checkpoint ring, and they do what 809 promised in the parts
that matter:

| RPC | Takes | Answers (as built) |
|---|---|---|
| `mark/set` | `name` | `{ mark, used, cap, message }` — names and pins the anchor the **transport cursor** stands on; with the cursor at the live head that is the newest anchor, at most one anchor interval (20 ms) behind the live instant |
| `mark/list` | — | `{ marks, used, cap, windowSeconds, windowCostSeconds }` — no `message` |
| `mark/drop` | `name` | `{ dropped, cycles, message }` — not the list 809 §5b describes |
| `mark/goto` | `name` | the transport status (808) |

- A mark is a pinned anchor with a label: it survives PLAY cutting the future, and three
  attempts from one mark give the identical machine (809 G1, gated).
- The cap is 32 and the 33rd is **refused**, because unlimited pins would shrink the rewind
  window silently.
- A name works where an anchor id is taken: `runtime/overlay_run` and the transport's
  `goto` resolve it (`mark_id`).
- `ringdump` / `ringload` carry the labels, so a `.c64rering` is a session with its marks.
- There is **one** ring — the shared machine's. None of the four takes a `session_id`.

And `sandbox/run` / `sandbox/runMany` take `from: <mark name>`.

## §2 What is missing on this side

**C64RE calls none of it.** Not one MCP tool and not one workbench component sends
`mark/*` or `sandbox/*`. What exists instead:

- `runtime_checkpoint_pin` pins by id and cannot name anything.
- `runtime_mark` sounds like the answer and is not: it stamps a phase label into an
  active *trace* (`boot`, `title`) and needs a streaming trace running.
- The filmstrip (769.5b) restores, continues and dumps a frame, and knows nothing of marks.
- The Trace tab's bookmark panel calls a daemon op `listBookmarks` that does not exist,
  catches the error to `[]`, and is always empty. The MCP pair behind the older idea wrote
  into the retired TS trace store and was deleted by 883.

So the capability the owner wants for fast iteration is built and unreachable.

## §3 D0 (TRX64) — a sandbox run must not be the shared machine

This came out of reading the code for this spec, and it decides whether "iterate from a
mark" is safe to offer at all.

`sandbox/run` says in its own comment that *"the live machine is NEVER used for a sandbox
run (doctrine rule 2)"*. It then dispatches `runtime/overlay_run` against the same daemon
state, and `overlay_run` does `restore_live_checkpoint(&mut st.session, …)` followed by
`st.session.running = false`. **A sandbox run today restores, patches, runs and pauses the
machine the human is watching.** 809's own sandbox test asserts the mark survives and that
no verdict is attached; nothing asserts the live machine is untouched, so 809's G7 was
never a gate, and the board row that says the sandbox capability shipped "with all their
gates" is wrong on exactly this.

D0: `sandbox/run` / `runMany` run on 787 scratch instances restored from the mark's
anchor, and G7 becomes a test — the live machine's cycle count and state are identical
before and after a `runMany`. Until D0 lands, D2 below is not offered.

## §4 Design

**D1 — the four doors.** One MCP tool per RPC, returning the daemon's object and its
`message`.

- Setting, listing and dropping a mark disturb nothing: a pin and a label. They are free
  for the LLM to use on the shared session.
- **Going to a mark moves the shared machine** — restore, paused. Its description says so
  in those words, in the same terms as the `runtime_session_*` family: seize it only when
  the human invited it.

**D2 — iterate from a mark.** One door over `sandbox/runMany`: from a mark, N patch-sets,
a cycle budget, N end states back. No name, no verdict (809's line, and 810's job). This
is the loop the owner asked for — and it is the only door that must wait for D0.

**D3 — a name wherever an id is taken.** The daemon already resolves names in
`overlay_run` and `goto`. Each C64RE door that takes an anchor id —
`runtime_checkpoint_restore`, `_pin`, `_unpin`, `runtime_overlay_run`, the candidate
doors — is checked against the daemon and either passes a name through or says it cannot.
Measured per door, not assumed.

**D4 — the workbench** (API first: D1 is merged before any of this).

- The filmstrip shows marks on their frames, sets one on the selected frame, and goes to
  one.
- The transport line shows the nearest mark once the daemon reports it (`transport/status`
  gains `nearestMark` in 809 §5b; **not built** — to be carried across with D0).
- The Trace tab's bookmark panel is replaced by the marks list. The dead call to
  `listBookmarks` goes with it.

**D5 — what a mark is to the project.** A mark lives in the ring and dies with the daemon.
Whether C64RE also records it — a graph node naming the cycle, the frame and why — so that
the *meaning* outlives the anchor, is §6's first question. The Leitregel suggests yes:
capability → TRX64, meaning and memory → C64RE.

## §5 Gates

- **G1** — each D1 door round-trips against a real daemon: set → list shows it → goto lands
  on its cycle → drop → list is empty.
- **G2** — set/list/drop leave the shared machine's cycle count and run state untouched;
  goto is the only one that moves it, and its description says so (a text gate, like
  877 D3).
- **G3** — the 33rd mark comes back as the daemon's refusal, verbatim, not as an empty
  success.
- **G4** (with D0) — `runMany` from a mark touches the live machine not at all, asserted by
  cycle count and state before and after.
- **G5** — every D3 door is listed with its measured answer: takes a name, or refuses one
  with a sentence.
- **G6** — the workbench shows a mark set over MCP without a reload, and a mark set in the
  workbench is listed by the MCP door (one ring, two clients).

## §6 Open — one question at a time

1. Does C64RE record marks in the project (D5), or are they deliberately session-scoped?
2. Naming. `runtime_mark` is taken by the trace phase marker, and a second family called
   `runtime_mark_*` would put two unrelated things one letter apart. Rename the old one,
   or name the new family after the ring?
3. Should `mark/set` offer "mark the live instant" — capture a fresh anchor first — rather
   than the newest one up to 20 ms back? It matters only when a mark is set on a single
   frame's event.
