# Spec 916 — A scenario tests the build: built bytes loaded into a start state, judged strictly

**Status:** BUILT on branch `spec/916-scenario-tests` (2026-10-23), not merged. D1–D4 and S1–S6 green in `npm run e2e:916-scenario-tests` (60 checks); the 900 / 911 / 912 / 810 / 813 / 814 smokes and `check:mcp-product-surface`'s playbook probe stay green. Decisions D1–D4 taken by the owner's "mach die Spec, bauen, dann testen".
**Repo:** C64RE (scenario parser, feature runner, `runtime_feature_run`, CLI help, agent doctrine, wiki). TRX64 untouched.
**Number:** 916 (registry: `specs/README.md`).
**Origin:** a reporter's project lost two working features (a packed boot, a trainer) without anyone
noticing: every check had been a hand-driven sandbox session, never repeated. The scenario runner
could have caught both, but the surface presents it only as a way to try fixes. The reporter's
skill had to add a Python wrapper to make it a test suite (wrapper sources with `.binary`, its own
strict verdict). Owner, 2026-10-23: build it into C64RE.
**Depends on:** 900 (`c64re scenario run`), 911 (feature file, variants, candidates).

---

## §1 The problem

**Who:** the LLM or the human who changes a game (port, trainer, saver, fix) and has to prove the
change still works after every build.

**What they want:** one file per behaviour. Start from a known state (a mark, a `.c64re` snapshot,
or the medium), put the build's bytes in, play fixed inputs, decide fixed facts. Run all of them
after every build. Same bytes, same verdict.

**What happens today** (read from the code, 2026-10-23):

1. **Only sources go in.** A variant is `And variant "x" assembles "src.tas" at $0900`
   (`src/project-knowledge/scenario-gherkin.ts` ~L1080; `assembleTarget` in
   `src/candidates/variant.ts`). A built PRG or a packed binary cannot be loaded; the reporter
   wraps each one in a two-line source with `.binary`.
2. **The verdict is a trial's verdict.** A scenario with variants is PASS when ANY variant passes;
   the baseline's result decides nothing (`src/scenario/feature-run.ts` ~L465). Right for choosing
   between fixes, too lax for a test: a test of the build must fail when the build fails, and a test
   that cannot tell the old code from the new one proves nothing.
3. **The surface names only the trial.** `runtime_feature_run`'s description and
   `docs/agent-doctrine.md` describe "try a fix → choose a candidate". Testing a build after every
   build is not mentioned, so an agent drives a sandbox by hand instead.
4. **Small gaps.** The tool description names a mark or a medium as the start, not
   `Given the snapshot "x.c64re"` (which the parser accepts). For a checkout without `c64re` on PATH,
   nothing says the CLI is `node <checkout>/dist/cli.js`.

## §2 The design

**D1 — Built bytes are loaded, not assembled.** A new variant form:

```gherkin
And variant "build" loads "build/trainer.prg"                 # a PRG: its own load address
And variant "build" loads "build/trainer.prg" at $0900        # a PRG placed elsewhere (header skipped)
And variant "build" loads "build/patch.bin" at $47A5          # raw bytes: the address is required
And variant "build" loads "build/bank3.bin" at roml bank 3 $8000
```

- A file whose name ends in `.prg` is a PRG: its first two bytes are its load address and are not
  loaded. Every other file is headerless; without `at` it is refused with that reason. No address
  is ever guessed from bytes.
- `loads` and `assembles` targets mix freely under one variant name; all targets of a name are
  one variant, as today.
- A loaded target goes into the machine exactly as an assembled one (same patch path, same
  side-effect accounting). For a candidate record it carries the file path and the sha256 of the
  bytes, and no source text.

**D2 — A scenario can say it is a test.** One of two lines makes it a test of the build:

```gherkin
Then the baseline fails        # the start state's own code must NOT show the facts (default for a test)
Then the baseline passes       # it must (the change must not alter this behaviour)
```

In a test, the scenario is PASS only when EVERY variant passes all its `Then` lines AND the
baseline does what the line says. The baseline line is judged on the baseline run only; it is not a
check on the variants. The report says which part failed ("baseline should fail but passed: the
start state already shows these facts, the test cannot see the change"). A test with no variant is
refused at parse time (there is nothing to compare). A scenario without the line keeps today's
trial verdict, unchanged.

**D3 — A test is not a trial.** A test-mode scenario keeps no candidate record (nothing to choose);
the slot gate that guards a fix delivery (`runtime_feature_run`) does not apply to it, since a
test checks bytes the build already placed and allocates nothing; its JSON result carries `"mode": "test"` (a trial `"mode": "trial"`), and every run's verdict as
today.

**D4 — The surface names the use.**
- `runtime_feature_run` description: the test use first-class (snapshot / mark + `loads` +
  `Then the baseline fails`, run the whole folder after every build), `Given the snapshot`, and the
  `loads` form.
- `c64re scenario run --help`: the `loads` forms, the two baseline lines, what PASS means in each mode;
  and how to start it from a checkout (`node <checkout>/dist/cli.js scenario run …`).
- `docs/agent-doctrine.md`: a short rule beside the fix loop — a change is proved by a test
  scenario run with the whole suite, never by a hand-driven sandbox session.
- A wiki page "Testing a Build" (user doc, no spec numbers): make the start state with a scenario
  that ends in `And I set the anchor`, write one test per behaviour, run the folder after every build.

## §3 Acceptance

- **S1** `loads`: a PRG at its own address, a PRG with `at`, a raw `.bin` with `at`, a raw file without
  `at` refused at parse/prepare time with the reason, a missing file refused; bytes in memory equal the
  file's (without the header for a PRG).
- **S2** `loads` into a cartridge bank (`roml bank N`), on a synthetic EasyFlash image built by the
  test: the bank shows the bytes; the baseline does not.
- **S3** Test mode: build passes + baseline fails → PASS; build fails → FAIL naming the build's
  check; baseline passes under `Then the baseline fails` → FAIL with the "cannot see the change"
  reason; two variants, one failing → FAIL; `Then the baseline passes` honoured; a test without a
  variant → parse error, exit 2.
- **S4** Trial mode unchanged: the existing 911 / 900 scenario smokes stay green, a trial with one
  passing variant is still PASS, candidates are still kept for trials and not for tests.
- **S5** A suite: a folder of test scenarios from one snapshot made by a scenario
  (`And I set the anchor`), run twice on fresh daemons → identical verdicts and JSON.
- **S6** The surface: `runtime_feature_run` description and `scenario --help` name the forms (a check
  greps them), the doctrine rule and the wiki page exist.
