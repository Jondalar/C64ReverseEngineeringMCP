# Spec 849 — Harness rules

**Status:** DRAFT
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

## 3. Open

**Which rules to write.** The annotation moment is the obvious first one. The others
follow from the moments the runs passed through silently, and should be drawn from the
transcripts rather than invented.

**Where they live.** `.claude/rules/` is harness territory. Committed into the project it
travels with the repo but not to another harness — the same boundary Spec 847 D7 drew for
the write hook. Deliberately out of scope for now.

**Whether a rule can name a refusal.** A rule that states the door which will refuse later
may make the refusal unnecessary. Untested.
