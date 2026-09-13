# Project rules

Provisioned into `<project>/.claude/rules/` by `project_init` and re-synced by
`agent_onboard`. Spec 849.

These are the third steering layer. The first two speak at the edges of a session —
`CLAUDE.md` and the project steering at onboarding, the slot gates and the critic at
delivery. Between them lies the work itself, and nothing spoke there. A rule with a
`paths:` glob does: the harness loads it when a matching file is touched, decided by the
glob rather than by the model's judgement of its own task.

**What a rule may say.** What to do at that moment, and — where one exists — the door
that will refuse later, in the door's own words. The announcement is the point: a refusal
that was predicted teaches; a refusal that arrives unannounced only frustrates.

**What a rule may not say.** A refusal that does not exist. A rule naming a door that has
since opened teaches the session to disbelieve rules, which costs more than the rule was
worth. `npm run smoke:project-rules` checks every announced door against the registered
tool surface and the slot table.

**Editing.** A file changed by hand is never overwritten: the provisioner keeps the hash
of what it shipped in `.claude/rules/.provisioned.json` and syncs only files that still
match. To take a rule back under provisioning, delete it and run `agent_onboard`.
