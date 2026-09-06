---
name: model-router
description: "How to spend model capacity on a small plan: which work goes to Opus, which to Haiku, what stays on Sonnet. Read when deciding whether to delegate, when a session is burning budget faster than it is producing, or when setting up a machine that runs Sonnet by default."
when_to_use: "Trigger phrases: 'which model', 'this is getting expensive', 'route this', 'should I delegate', 'I'm running out of tokens', setting up a new machine."
user-invocable: true
---

# Routing work between Opus, Sonnet and Haiku

The session model is chosen by the human at startup and **cannot be changed by
Claude mid-session** — `/model` is a human action, hooks cannot influence it, and
`settings.json` is read once at start. Everything below works *without* changing
the session model.

## The three levers, and what each one costs

| Lever | Mechanism | What it costs |
|---|---|---|
| `/deep <question>` | a skill with `model: opus`, `effort: high` — **this turn** runs on Opus, the session returns to Sonnet on the next prompt | one Opus turn, in the current context — nothing is re-read |
| `/cheap <task>` | a skill with `model: haiku` — this turn runs on Haiku | almost nothing |
| `reasoner` / `bulk` subagents | agent definitions with `model:` — Claude delegates a *sub-question* | a fresh context that must be told everything it needs; the transcript never enters the parent |

The third lever is the one Claude pulls by itself. The first two are the human's.

**The saving is not the model, it is the frequency.** An Opus turn costs what an
Opus turn costs. What this doctrine buys is: Opus runs three times a session
instead of thirty, Haiku eats the volume, and the Sonnet context stays small
because a delegated sweep returns four lines instead of four hundred.

## Where the work goes

| Work | Model | Why |
|---|---|---|
| First-divergence hunt in a port or trace; "the reference and ours disagree, where exactly" | **Opus** | it is one long chain of reasoning; a wrong step is a wasted hour |
| A decision that is hard to reverse: an id grammar, a schema, a protocol, a spec's decisions | **Opus** | the cost of getting it wrong dwarfs the token bill |
| Code and documentation disagree and the truth has to be derived from the bytes | **Opus** | requires holding several files against each other |
| Loader / protection logic: what does this fastloader actually do with the register file | **Opus** | dense 6502 semantics, few tokens, high value |
| After two wrong hypotheses on the same bug | **Opus** | see the tripwires |
| Writing code from a decision that is already made | Sonnet | the hard part is over |
| Reading a listing and annotating routines | Sonnet | volume with judgement |
| Reviewing a diff, writing a commit message, answering the user | Sonnet | this is Sonnet's job |
| "List every place that writes `$D018`" / inventories / counting | **Haiku** | mechanical, verifiable, high volume |
| Running a known gate and reporting pass/fail with the failing lines | **Haiku** | the command is given, only the outcome matters |
| Extracting fields, reformatting, deduping, sorting, renaming lists | **Haiku** | no judgement involved |
| Reading a 4 000-line log and returning the 6 matching lines | **Haiku** | the point is to keep those 4 000 lines out of the parent |

## Escalate to Opus when one of these is true

Not "when it feels hard" — these are checkable:

- The second explanation in a row turned out to be wrong.
- A fix did not work and the reason is not understood.
- You are about to write "probably" or "should be" about machine behaviour.
- The answer depends on three or more files that have to be held together.
- The decision changes a stored format, an id, a protocol or a public interface.
- Someone will build on the answer for days.

One Opus call per *problem*, not per file. Ask it for a **decision with its
reasons and the evidence**, never for the implementation — Sonnet implements.

## Delegate down to Haiku only under contract

Haiku is reliable exactly as far as the prompt is precise. Every `bulk`
delegation carries:

1. the exact command or the exact paths — never "find the relevant files";
2. the exact output shape — "one line per hit: `<file>:<line> <symbol>`";
3. a ban on judgement — "if a case is ambiguous, list it under UNCLEAR and do
   not decide";
4. a cap — "stop after 200 hits and say how many were left".

If a task cannot be written that way, it is not Haiku work.

## Never delegate

- Anything you could finish in under a minute yourself. A delegation costs a
  whole context that has to be told what you already know.
- Work whose value *is* the context you are holding.
- The final answer to the user.
- A judgement you would have to re-derive anyway to check the answer.

## Install (user level, so it works in every project folder)

From a checkout of this repo:

```bash
mkdir -p ~/.claude/skills ~/.claude/agents
cp -R contrib/claude/skills/deep contrib/claude/skills/cheap contrib/claude/skills/model-router ~/.claude/skills/
cp contrib/claude/agents/reasoner.md contrib/claude/agents/bulk.md ~/.claude/agents/
```

User level is the point: skills and agents under `~/.claude/` apply in every
project folder, and reverse-engineering work happens in the project, not in this
repo.

Then put this in `~/.claude/CLAUDE.md`, so the rules apply without loading
anything:

```markdown
## Model budget
- Session runs Sonnet. Opus and Haiku are reached WITHOUT switching the session.
- Hard call (first divergence, schema/protocol decision, second wrong hypothesis,
  code vs. docs): stop and say "this is a /deep question" — or delegate the single
  sub-question to the `reasoner` agent (Opus). Ask for a decision + reasons, not code.
- Mechanical sweeps, counting, log triage, running a known gate: delegate to the
  `bulk` agent (Haiku) with exact commands and a fixed output shape.
- Do not delegate anything under a minute, or work whose value is the context held.
```

Optional, if the plan allows it: `"model": "sonnet"` plus `"advisorModel":
"opus"` in `~/.claude/settings.json` routes `/advisor` questions to Opus while
the session stays on Sonnet.

## Caveats, stated plainly

- **Plan access.** If the subscription does not include Opus, a `model: opus`
  value is ignored and the turn silently runs on the session model. Check what
  `/model` offers before relying on it.
- **One budget.** A subagent's tokens come out of the same plan limit as the
  parent. The win is a smaller parent context and fewer Opus turns, not cheaper
  Opus turns.
- **The router itself must be free.** This skill and the routing block carry no
  `model:` — deciding where to send work must never cost a model upgrade.
