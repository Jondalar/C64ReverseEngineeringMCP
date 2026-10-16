# Contributing

C64RE and its runtime TRX64 are maintained by a very small team. These rules keep issues something we
can actually finish.

## Before you open an issue

- **Check `master` first.** If the issue is already fixed there, or an open issue already covers it, do not
  open another one. Comment on the existing issue instead.
- **One defect per issue.** Do not bundle findings, and do not add new findings to an issue that is
  being retested. Open a new issue for each one.
- **Windows-only failures come as a pull request, not an issue.** We develop and test on macOS and
  Linux and cannot reproduce, fix or verify anything that happens only on Windows. If you can, send a
  PR (see below). The same goes for portability fixes in test scripts.

## What an issue must contain

We take an issue only if we can reproduce it **end to end, exactly as you saw it**. If we cannot, we
close it and ask for what is missing. We do not fix half of an issue on a guess.

- **Versions:** the c64-re commit or version, and the TRX64 commit or version.
- **Platform:** macOS or Linux. A Windows-only failure is a PR (see above).
- **The exact steps, so that we can rerun it:** every tool call with its arguments, in order. A run on
  the machine needs its inputs with their timing (a scenario, or the keys/joystick with their cycles),
  so that our run does what yours did.
- **The medium, by name only:** title, release, file name and sha256. We use our own copy.
- **No game data on GitHub.** Do not post disk, cartridge or ROM images, or anything made from them:
  captures, RAM dumps, extracted payloads, listings. We do not need trace captures: we record our own
  from your steps.
- **Project knowledge the bug depends on** (a manifest, annotations, the knowledge graph): say that
  you have it. Do not attach it. We will ask for it privately when we need it.
- **What you expected, and what happened**, with the exact output.
- **Acceptance criteria** we can check, numbered.

If you cannot share an input, say so in the issue. We will then decide whether the issue can be
reproduced at all, before anyone starts on it.

## Retests

When you retest a fix, report only that fix. Retest on the real project and the real data you reported
with. If something new turns up during a retest, open a new issue for it.

## Pull requests

- One fix per PR, with a link to its issue.
- Add or adapt a test that fails without the fix.
- Run the tests your change touches (`npm run e2e:…` / `smoke:…`) on macOS or Linux and say which, with their result. A test script starts with `node scripts/ensure-built.mjs mcp` (or `pipeline`, `ui`, `all`), not with a build.
- Never make a check weaker so that a test passes.
- No third-party game or ROM bytes in the repository, and nothing made from them.
