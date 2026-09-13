# Spec 849 — Harness rules

**Status:** BUILT
**Repo:** C64RE
**Origin:** a measurement, not a proposal. `.claude/rules/*.md` with a `paths:` glob was
probed on this machine because a documentation answer claimed it exists and the skills on
disk showed no such field:

```
read:        src/code.asm   (that file only)
received:    NESTED-CLAUDEMD-9915   nested CLAUDE.md
             RULE-ALPHA-7731        paths: ["**/*.asm"]    fired
not received: RULE-BETA-4402        paths: ["**/*.json"]   correctly filtered
```

The session confirmed it never opened the rule files; both blocks arrived as auto-loaded
context. Glob targeting is real and deterministic.

## 1. The gap this fills

Specs 844–848 put pressure at two points. Neither is the moment the work happens.

| | when it speaks | kind |
|---|---|---|
| onboarding handover (848 D5) | session start | offers |
| door gates (844 D1) | on delivery | refuses |
| **a rule with `paths:`** | **when a matching file is touched** | **offers** |

The gap was named repeatedly during the 844–848 build and never closed: nothing speaks
between the start and the delivery. *"You just disassembled this — it is not understood
until its routines carry names."* *"You just corrected yourself — record it as a
refutation."* Both moments passed silently in every unattended run.

A rule fires exactly there, and fires because a glob matched, not because the model judged
the task correctly. That last part is the whole value: Spec 848 D3 was written because a
router keyed on the model's self-assessment does not fire when the model mis-classifies
what it is doing.

## 2. What it is not

A rule is prose injected into context. It targets precisely; it does not enforce.

The evidence is from the same day: an unattended run received the project contract at
onboarding, followed its form — filled seven slots, declared a document, corrected every
defect the critic flagged — and recorded that the disk sides carry copy protection. They
do not. Prose delivered at a better moment raises the odds of action. It does not compel
it, and it cannot make a claim true.

Three layers, each limited to its own kind of failure:

```
rule (paths:)   speaks at the moment of work    advisory
gate (844-848)  refuses at delivery             binding
critic (846)    refutes from the graph          form and contradiction only
```

None of them catches "weak sectors mean copy protection". Only reading the drive code
does.

## 3. Decisions

**D1 — Six rules, drawn from the moments the runs passed through.** One per moment the
three unattended runs touched a file and acted as if nothing were owed. The moment, not a
topic, decides what each rule is about — the column below says which file the moment shows
up as, and D4 says which tool actually delivers it:

| rule | fires on | the moment |
|---|---|---|
| `listing-is-not-understanding` | `**/*_disasm.asm` `.tas` `.tass` | a listing read, never annotated — run 1 produced zero annotation files |
| `annotations-assert-boundaries` | `**/*_annotations.json` | names written, no boundary asserted — U6's 978 names and 799 extents that share no node |
| `heuristics-are-proposals` | `**/*_analysis.json` | `probable_code` read as code |
| `g64-checksum-failures` | `**/*.g64` | checksum failures called protection — sonnet-2, on four sides that carry none |
| `documents-declare-themselves` | `docs/**/*.md` | prose written without frontmatter, invisible to the project |
| `contract-states-deliveries` | `knowledge/contract.json` | a fact written into the contract, which happened once, one message after the rule against it was stated |

S14 has no rule, and that is the honest answer rather than an omission: a retraction has
no file. Nothing is touched at the moment a claim is withdrawn, so no glob can fire there.
The refutation moment belongs to the critic or to a tool, not to this layer.

**D2 — The rules live in the project, provisioned from here.** `assets/project-rules/` is
the source: versioned, smoke-tested, written once. `project_init` copies them into
`<project>/.claude/rules/`, and **`agent_onboard` re-syncs them on every session**.

Init alone would freeze a project's rules at the day it was created, and a rule corrected
here would never reach a project that already exists. A sync at UI start would fix that
for one machine; an unattended run starts no UI. `agent_onboard` is the call every session
makes first.

A hand-edited rule is never overwritten. The ledger `.claude/rules/.provisioned.json`
holds the hash of what was SHIPPED, not of what is on disk: a file still matching its
shipped hash is untouched and may be replaced, anything else is the owner's and is
reported rather than clobbered. Deleting a rule brings it back — that is how a rule
returns to provisioning.

The boundary this keeps: the harness reads `.claude/rules/` relative to the SESSION's
working directory. It therefore applies to RE work inside a project and not to work in
this repo, which is correct — these rules are about reverse engineering, not about
building the server.

**D3 — A rule announces the door, in the door's own words.** Both layers, same wording:
the rule says what to do and names the refusal that follows, the door still refuses. The
announcement is the point — a refusal that was predicted teaches, a refusal that arrives
unannounced only frustrates.

This buys one obligation. **An announced refusal that does not happen is worse than
silence**: a session told `render_docs` will refuse, which calls it and is served, learns
that rules are decoration, and that costs more than the rule was worth. Nothing else in
the build would notice — the rule still parses, still ships, still fires.

So `smoke:project-rules` checks every rule against the machinery it describes: the
frontmatter parses, every glob is anchored or wildcarded, every `Sn` exists in the slot
table, every backticked token shaped like a tool is one the server registers, and every
announced refusal names a door the slot table actually gates. Proven to bite by a
deliberately wrong rule: four failures, one per class.

## 4. Measured — and the mechanism was wrong

Run 4 on `_trial-neuromancer-rules`: a fresh copy of the same four G64 sides, the same
contract byte for byte, the same prompt word for word as run 3. One difference:
`.claude/rules/` present. 16 minutes, 102 turns.

Launched as a real session with its working directory in the project, not as a subagent —
a subagent inherits the parent's working directory, and the harness reads `.claude/rules/`
relative to the session's own. That difference is the reason the run was launched at all.

**Not one rule fired.** No rule text reached the session through the harness in 102 turns,
despite three writes to `*_annotations.json` and one to `docs/loader.md`, both matching
globs. An isolating probe says why:

```
Read  thing.asm      → RULE-READ-5521    fired
Write docs/note.md   → RULE-WRITE-8834   did NOT fire
```

A rule fires on a native **read**. This workflow does not read natively — it reads through
`read_artifact`, `graph_find`, `disasm_prg`, and the harness cannot see those touches. The
run made four native file accesses in 102 turns and every one was a write.

The rules reached the session anyway, by an accident that proves nothing about the
mechanism: the agent listed `.claude/`, saw six files, and read them itself. Their wording
was still visible ninety turns later — S13 recorded "analyze_prg segment kinds and tool
status flags are proposals, not evidence", S14 rejected a 0.95-confidence LUT hit as
graphics bytes, S2 declined to call the `gcr_error` sectors protection because they are
not clustered. That is evidence the TEXTS work, on one run, and no evidence at all that
the delivery works.

**D4 — The moment belongs to the tool.** Each rule names the MCP tools that ARE its
moment, in a `tools:` key beside `paths:`, and the tool appends the rule to its own
result. `paths:` stays: it costs nothing and still serves a human who opens a listing by
hand.

**D5 — Said once per session, re-armed by onboarding.** A rule appended to every call is a
banner, and a banner is read once and skipped for ever. Delivery is recorded in
`knowledge/rules-delivered.json` and `agent_onboard` clears it — a session that is
onboarding has either just begun or just lost its context, and in both cases has been told
nothing. A project's own `.claude/rules/<id>.md` is delivered in place of the shipped
text, or the provisioner's promise not to clobber a hand-edit would be hollow.

## 5. Built

```
assets/project-rules/*.md              six rules; `paths:` + `tools:` + the prose
src/project-rules/provision.ts         ensureProjectRules — copy, sync, never clobber
src/project-rules/rules.ts             parse and index by trigger tool
src/project-rules/deliver.ts           once per session, re-armed by agent_onboard
src/server.ts                          ruleFooterHandler — one wrap, beside the 039
                                       phase-tag injector, appends to the last text block
  → project_init                       creates .claude/rules/, reports what it wrote
  → agent_onboard                      re-syncs the files, re-arms the delivery
scripts/smoke-project-rules.mjs        77 passed — every trigger tool registered, every
                                       announced refusal gated, no tool carrying two rules
scripts/e2e-849-rules.mjs              47 passed — provisioning, hand-edits, delivery
```

Verified against the live stdio server, not only in a test: two `contract_show` calls, the
first carrying the rule and the second silent.

**Two defects the run surfaced**, both of the kind only a run finds:

1. **Steering against the prompt.** The extract-first doctrine asks for a project-owned
   extractor script; the prompt forbade own scripts. The agent obeyed the prompt, never
   cut the engine or the drive code out, and S5, S7, S10 and S11 stayed empty. That
   collision is the whole difference between run 3's numbers and run 4's — not the rules.
2. **`disasm_prg` could not find the obvious annotations file.** `propose_annotations`
   leaves `<stem>_annotations.draft.json` beside the listing, so dropping `.draft` is the
   natural way to finish it — and `<outdir>/<stem>_annotations.json` was the one name
   neither the renderer nor the wrapper looked for. The run was told "No semantic
   annotations found", renamed the file by hand, and then imported 45 names. Both
   candidate lists now include it.

**Still not measured.** Whether a rule delivered at its moment changes what a run does.
Run 4 measured the mechanism and found it broken; the replacement has not faced a run.
