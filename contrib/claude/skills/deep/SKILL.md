---
name: deep
description: "Answer the current question on Opus with high effort, in the context that is already loaded, without changing the session model. For a hard call: a first-divergence hunt, a schema or protocol decision, code and documentation disagreeing, or a bug that has already survived two wrong hypotheses."
when_to_use: "Use when the user types /deep, or suggest it when the work hits an escalation tripwire from the model-router skill."
argument-hint: "[the hard question]"
model: opus
effort: high
---

# One hard turn

This turn runs on Opus. The next prompt is back on the session model, so
everything expensive has to happen now.

**Produce a decision, not an implementation.** Sonnet writes the code
afterwards, cheaply, from what you decide here.

Answer in this shape:

1. **The answer**, in one or two sentences, first.
2. **Why**, as the chain that actually decides it — the specific bytes, lines or
   measurements, not a restatement of the question.
3. **What would change it**: the observation that would make this answer wrong.
   If there is none, say the answer is forced and why.
4. **What Sonnet does next**: the concrete steps, small enough to execute
   without re-deriving anything.

Rules for this turn:

- Read before concluding. If the answer depends on a file that has not been
  read, read it now — this is the turn that can afford it.
- Report the FIRST divergence and its window, never statistics.
- Suspect the harness, the conversion and the assumption written in a comment
  before suspecting the algorithm.
- If the question is actually two questions, answer the one that unblocks the
  other and say the second is still open.
- Do not pad. A decision plus its evidence is short. Length here is expensive
  and buys nothing.
