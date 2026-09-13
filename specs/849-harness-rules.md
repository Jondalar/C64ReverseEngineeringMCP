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
three unattended runs touched a file and acted as if nothing were owed. The glob, not a
topic, decides what each rule is about:

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

## 4. Built

```
assets/project-rules/*.md              six rules + a README stating what a rule may say
src/project-rules/provision.ts         ensureProjectRules — copy, sync, never clobber
  → project_init                       creates them, reports what it wrote
  → agent_onboard                      re-syncs them, names them in the handover
scripts/smoke-project-rules.mjs        every announced door checked against the real one
scripts/e2e-849-rules.mjs              provisioning, re-sync, and the hand-edit case
```

```
npm run smoke:project-rules      57 passed, 0 failed
npm run e2e:849-rules            18 passed, 0 failed
```

**Not measured yet.** Whether the rules change what an unattended run does. The method is
the one Specs 844-848 used: a throwaway copy, the same prompt word for word, hard counts.
Everything above is machinery that fires; none of it is evidence that it works.
