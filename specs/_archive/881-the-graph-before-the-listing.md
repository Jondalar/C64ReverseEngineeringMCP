# Spec 881 — The graph before the listing

**Status:** BUILT 2026-09-26. `e2e:881-graph-first` 14/0, wired into CI. Ships in 0.2.0 —
a minor, not a patch: D1 refuses a call that used to succeed, and the version contract in
`INSTALL.md` reserves behaviour changes for minor versions.
**Repo:** C64RE only. TRX64: no change.
**Number:** 881 (registry: `specs/README.md`).
**Depends on:** 822.2 (the graph is the knowledge authority), 848/849 (the contract and its
standing ledger), 877 D1/D4 (doors that refuse; a per-session ledger re-armed by
`agent_onboard`).
**Origin:** the 877 sanity-check audit, 2026-09-25, third question — *is graph usage
enforced?* Answer: nowhere. Owner picked the two shapes below on 2026-09-26.

---

## §1 What is wrong

The server's own instructions say it plainly: *the graph tools ARE the static analysis,
indexed — query them before reading a full listing.* Nothing enforces it, and nothing
measures it.

What that costs was measured, not supposed. Across the supervised runs of 2026-09-24/25,
against **5** `disasm` calls there were **103** reads of the rendered listing, spread
25/19/17/16/14/12 across six participants. A 6000-line listing is read whole, repeatedly,
by grep, to answer questions the graph answers in one call — and every one of those reads
is context spent on text that was already indexed.

Two things are being asked for here, and they are different:

- a **door**, which binds what passes through it, and
- a **measure**, which binds nothing and is read by everyone.

Both were chosen because neither is sufficient. The third option considered and rejected —
redirecting `disasm`'s answer at the graph — changes the most-used tool in the product to
fix a habit, and is too large a lever for the problem.

## §2 D1 — the door

**`read_artifact` refuses a LARGE listing until the graph has been asked about it.**

- **Large** is a line count, not a byte count: a listing is refused at **≥ 1500 lines**.
  Below that a whole read is reasonable and the door is silent. The threshold is a constant
  with its reasoning beside it, not a setting — a knob here would be turned down once and
  never back.
- **Asked about it** means at least one of `graph_find` / `graph_node` / `graph_edges` /
  `graph_path` / `graph_overview` was called **in this session**. Not "about this artifact":
  tying the two together sounds stricter and is worse, because the honest first query is
  usually `graph_overview`, which names no artifact.
- **Session**, not process. The ledger is a file under `knowledge/`, and `agent_onboard`
  re-arms it exactly as 877 D4 re-arms the alias notices — a server outlives a session, and
  a door armed per process would fire once a week.
- **The refusal is not a no.** It names the artifact's own address range, the graph call
  that covers it, and says the read is available immediately after. A door that only
  refuses teaches avoidance; this one has to be a shorter path than the one it blocks.
- **Once per session per artifact.** The second `read_artifact` on the same listing goes
  through: the point was to make the graph the first question, not to ration the text.

**What this does not do, said here rather than discovered later:** a shell `cat` or `grep`
goes around it untouched. That is 877's stated boundary — a door binds what passes through
it — and it is the reason D2 exists.

## §3 D2 — the measure

**The ratio appears in the contract footer, as a delta, and refuses nothing.**

Run 7 of the unattended series is the evidence that this works at all: carrying the
contract's standing blockers back on every write, *as a delta*, moved `model_assert` 0 → 12
and orphans 62 % → 9.1 %. Run 6, same prompt, same contract, without the delta: unchanged.

So the footer gains one line, under the same discipline the others already follow:

- It **reports and never refuses.** Refusing a record punishes the behaviour we want.
- It **speaks only when something moved.** An identical footer becomes a banner and a
  banner is skipped — measured in the same series.
- It counts what the server can see: graph calls against listing reads **through tools**.

**And it says what it cannot see.** The 103 reads that motivated this spec were shell
reads, invisible to an MCP server, counted by an external watcher. The line must not imply
a ratio it cannot measure; when the tool-side count is clean the honest statement is that
the tools were used well, not that the listing was not read.

## §4 What does not change

- `disasm` and `analyze` are untouched. The listing is still produced and still readable.
- No new tool. D1 lives in `read_artifact`, D2 in the standing ledger that already exists.
- Nothing is enforced against the human's own session.
- Nothing in TRX64.

## §5 Acceptance

`e2e:881-graph-first`, red before the change:

1. `read_artifact` on a 1500-line listing, with no graph call this session, is refused —
   and the refusal names the artifact's address range and a concrete graph call.
2. The same read after any one of the five graph tools succeeds.
3. A short artifact is never refused, with or without a graph call.
4. A second read of the same listing in the same session succeeds.
5. `agent_onboard` re-arms it: a new session is refused again, over the same project, from
   the same server process.
6. The footer line appears when the ratio moves and is absent when it has not.
7. The footer never refuses a write, and a broken counter never breaks the parent call.

## §6 Open

Whether D1's threshold is right at 1500 lines. It is a guess from the size of the listings
in the corpus, and the first supervised run after this ships is what tells us — too high
and the door never fires, too low and it fires on files nobody would have grepped.

## §7 As built

The counter sits in the server's footer wrapper, which already sees every tool by name.
It went into `withGraph` first and `e2e:823` refused it: that spec draws a boundary around
`graph-tools.ts` — knowledge-graph, zod, safe-handler, types, nothing else — and it is a
good boundary. The wrapper is the better home anyway: a sixth graph door registered
somewhere else is counted without anyone remembering to. `agent_onboard`
re-arms the ledger beside 877 D4's alias notices and the project rules.

Two things the gate caught in its own first run, both worth keeping in mind for the next
door of this shape:

- An un-onboarded session is refused for a DIFFERENT reason, and asking only "was it
  refused" reads that as this door firing. The check now asks whether *this* door spoke.
- The footer never appeared because the write it rode on had failed validation. A footer
  that rides a write is invisible exactly when the write is — which is correct, and is
  worth remembering when one seems to be missing.
