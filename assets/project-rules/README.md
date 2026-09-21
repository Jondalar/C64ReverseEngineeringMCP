# Project rules

Provisioned into `<project>/.claude/rules/` by `project_init` and re-synced by
`agent_onboard`. Spec 849.

These are the third steering layer. The first two speak at the edges of a session —
`CLAUDE.md` and the project steering at onboarding, the slot gates and the critic at
delivery. Between them lies the work itself, and nothing spoke there.

**A rule is delivered by the tool that IS its moment**, named in the `tools:` key, and
appended to that tool's own result once per session. The `paths:` glob was the first
design and it does not work for this: measured on a 102-turn unattended run, a glob fires
when a matching file is read with the native Read tool, and an RE session reads through
`read_artifact` / `graph_find` / `disasm` — four native file accesses in the whole
run, all writes, zero rules fired. The globs stay in the frontmatter because they cost
nothing and still serve a human who opens a listing by hand.

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
