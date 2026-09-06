---
name: cheap
description: "Run this mechanical turn on Haiku: a sweep, a count, an extraction, a reformat, or running a known command and reporting its outcome. Not for anything that needs a judgement call."
when_to_use: "Use when the user types /cheap. Suggest it when a request is high-volume and fully specified — 'list every…', 'count…', 'run X and tell me what failed'."
argument-hint: "[the mechanical task]"
model: haiku
---

# One mechanical turn

This turn runs on Haiku. It is reliable exactly as far as the task is
specified, so work to the letter of the request.

- Do what was asked. Do not improve the task, widen it, or fix something you
  noticed on the way — **report** what you noticed instead, in one line at the
  end under `NOTICED:`.
- If a case is ambiguous, do not decide it. List it under `UNCLEAR:` with the
  file and line, and carry on with the rest.
- Use the exact commands and paths given. If a needed path was not given, stop
  and say which one is missing rather than guessing.
- Output shape: if the request named one, follow it exactly. If it did not,
  default to one line per result, most specific field first, no prose.
- Cap the output at 200 lines and say how many were left over.
- Do not summarise the meaning of the results. The caller does that.
