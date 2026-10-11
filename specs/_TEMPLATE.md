# Spec NNN — <what is true when this is done, as one sentence>

**Status:** PROPOSED (YYYY-MM-DD).
**Repo:** C64RE | TRX64 | both — and which part lives where (Leitregel: capability → TRX64,
meaning and memory → C64RE).
**Number:** NNN (registry: `specs/README.md`, next free number from there — never from memory).
**Origin:** who asked, when, in their words if there are any. Issue number if there is one.
**Depends on:** specs / releases this needs, or "nothing".

---

## §1 The problem

Written for the reader who opens this in three months and remembers nothing.

- **Who** has the problem: the owner at the workbench, the LLM in a session, a user from an
  issue, a gate.
- **What they are trying to do** — the use case, in their terms, not the system's.
- **What happens today** instead — concretely: the call, the output, the wrong number, the
  file. Read from the code and measured, not from a comment or an older spec.
- **Why it matters** — what it costs, what it blocks, what goes wrong unnoticed.

One worked example, with real addresses / commands / output, beats three paragraphs.

## §2 Scenarios — what proves it is solved

The acceptance, as behaviour. Each scenario names the test that runs it; a scenario
without a test is a wish. Write these BEFORE the design: they are the contract the design
has to meet, and the place a reader looks first.

```gherkin
Scenario: <one behaviour, from the user's side>
  Given <the state the user starts from>
  When  <what they do: the tool call, the command, the click>
  Then  <what they observe — exact, checkable>
  And   <what must NOT happen: the shared machine did not move, nothing was written, …>
```

| # | Scenario | Test (script / gate step) | Where it runs |
|---|---|---|---|
| S1 | … | `scripts/e2e-NNN-….mjs` → `e2e:NNN` | `gate.sh` + `gates.yml` (Linux / Windows) |
| S2 | … | by hand, on the owner's project X — why it cannot be in the gate | — |

Rules:
- The negative is a scenario too: refusals by name, the shared machine untouched, a red
  rebuild stays red.
- A scenario that needs real hardware, real game bytes or Commodore ROMs says so and is
  run by hand; nothing third-party is checked in.

## §3 Decision

D1, D2, … — what is built, each with the reason. Name files and functions. Where a choice
was weighed, say what lost and why, in one line.

## §4 Out

What this spec deliberately does not do, and why. Anything not built is listed here — by
decision with the owner, not by omission.

## §5 Decisions taken while building

Filled in at the end: every choice the spec left open, and what was chosen.

---
<!--
Closing: Status → DONE (date) + which scenarios are green where; move to `_archive/`,
row out of `README.md`, row into `_archive/README.md` — in the same commit as the code.
No spec numbers in user docs.
-->
