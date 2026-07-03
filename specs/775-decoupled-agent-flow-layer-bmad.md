# Spec 775 — Decoupled Agent/Flow Layer via BMAD (private, in-repo)

Status: PROPOSED (2026-07-03)
Anchor: `docs/product-vision-and-workbench-contract.md` §3 (Leitregel) ·
Spec 773 (Workflow Cockpit / Onboarding) · Spec 730 (agent orchestrator) ·
`src/project-knowledge/types.ts:191` (`TeamMemberSchema` — the "BMAD-style" placeholder)

## Why this spec exists

C64RE already has a *vocabulary* of agents and a 5-phase lifecycle (Spec 773),
plus an orchestrator (`agent_set_role`, `agent_propose_next`, Spec 730). But the
agent/flow layer is **inert data**: `ProjectProfile.team[]` is a Zod roster the
UI mirrors and nobody executes; `agent_set_role` has a *different* 5-role
vocabulary (analyst/cartographer/implementer/archivist/cracker); the 7
"BMAD-style" roles in `TeamMemberSchema` are a note, not a loadable artifact. None
of it is portable to another runtime, and the shape quietly pulls toward C64RE
becoming a second LLM runtime — which the product explicitly refused (Spec 773 #1
= A: *"C64RE ≠ 2. LLM-Runtime. Harness redet+denkt, C64RE merkt+zeigt."*).

This spec fixes the **logical decoupling**: C64RE describes its agents and flows
in **BMAD's format** so they are runtime-portable, and hosts them as a **private,
in-repo** module — never published to any scene registry. It also defines the
seam for a **TREX-internal overlay** so scene-secret content (EF know-how,
Protovision MegaByter specifics, cracking flows) can layer on top **without ever
entering the public C64RE repo**.

**This is not a public-package effort.** BMAD is used strictly as an interop
grammar. Nothing is contributed to the BMAD marketplace or the outside scene.

## The decision

**BMAD (V6, "skills" architecture) is the decoupling contract.** C64RE authors
its agents + flows as a **private, local BMAD custom-module**; the harness
(Claude Code today) installs that module natively; the same source can later feed
other runtimes (CrewAI…) through a per-runtime adapter, without forking the
description.

```
C64RE onboarding (harness-driven)     →  decides team + flows            (MEANING)
  ⇓ authors / selects
private BMAD custom-module(s)          →  the portable, loadable contract (CONTRACT)
  ⇓ `bmad install --custom-source <local path>`
harness-native agents/skills          →  execution: Claude Code now,     (EXECUTION)
                                          CrewAI/other later via adapter
```

C64RE stays **meaning + memory**. It is **not** an execution engine and does
**not** run the agents. The Leitregel holds: capability→TRX64, meaning→C64RE, and
now **orchestration description → BMAD (portable), orchestration execution →
harness**.

### D1 — BMAD as interop grammar, not a package

- C64RE emits/hosts **real BMAD V6 artifacts** (schema-conformant), not
  "BMAD-style" look-alikes. "Real" = it installs and loads in a BMAD-aware
  harness; a look-alike is worthless for portability (that is exactly what
  `TeamMemberSchema` is today, and why it goes unused).
- **Never published.** No `.claude-plugin/marketplace.json` in our modules (that
  file is what makes a module discoverable in the BMAD installer UI — we omit it).
  Install is always by **local `--custom-source` path**, which BMAD supports as a
  first-class private/local install with no registry.

### D2 — Two-layer content model (the public/secret boundary)

The user's hard requirement: C64RE-generic RE know-how may live in the (public)
C64RE repo; TREX/EF/MegaByter know-how must **not**.

| Layer | Content | Location | Visibility |
|---|---|---|---|
| **C64RE base module** | domain-generic RE agents + flows (re-lead, media-cartographer, semantic-annotator, disk/CRT forensics flow, generic EF-port *skeleton*) | `bmad/c64re/` in this repo, **committed** | public-repo-safe — no scene secrets |
| **TREX-internal overlay** | scene-secret agents + flows: EF know-how, MegaByter/Protovision specifics, cracking-specific flows, private targets | **separate private git repo** (or a gitignored path in a TREX workspace) | never in the C64RE public repo |

Mechanism = BMAD's own **layered override** + **multiple `--custom-source`**:
- The base module is one `--custom-source` (the repo path).
- The TREX overlay is an *additional* `--custom-source` (a private path/URL).
- BMAD's TOML config layering already separates *committed* (`config.toml`) from
  *personal/gitignored* (`config.user.toml` / `custom/*.user.toml`) — the overlay
  rides the personal/private layer so a public checkout of C64RE never resolves
  the secret content.

**The base module carries no scene secrets.** The split is by *module*, not by
redaction — the secret module simply is not present in a public checkout.

### D3 — Demote the existing placeholders to a mirror

- `ProjectProfile.team[]` → a **UI mirror/index** of the installed BMAD roster,
  not a source of truth. The installed module is the truth for personas/flows;
  C64RE memory stays the truth for findings/meaning.
- `agent_set_role` (5 roles) and the Spec 730 `C64RE_WORKFLOW_STEPS` → keep as the
  *session* orchestration crosswalk, mapped onto the BMAD roster (do not rebuild
  730; do not unify the vocabularies by force — provide a crosswalk).
- Onboarding (Spec 773) gains one job: **materialize/select** the project's BMAD
  module set (base [+ overlay]) and record the roster the harness installed.

## BMAD V6 format facts (grounding — verify before emitting)

From `docs.bmad-method.org/llms-full.txt` (2026-07-03). **Treat exact field names
as to-be-pinned** (see OQ1); this is the shape, not a frozen schema:

- **Layout:** `_bmad/` holds modules (`core/`, `bmm/`, custom modules), `custom/`
  (TOML overrides: `config.toml` committed, `config.user.toml` gitignored,
  `{skill}.toml`/`.user.toml`), `_config/manifest.yaml` (installed modules +
  versions + sources), `scripts/`. Run artifacts → `_bmad-output/`.
- **Skills architecture:** agents *and* workflows are `SKILL.md` (Markdown + YAML
  frontmatter). Agent frontmatter: `name, title, icon, role, description,
  principles[], persistent_facts, activation_steps_prepend/append, menu[]`.
  Workflow frontmatter: `name, title, description, activation_steps_*,
  persistent_facts, on_complete, doc_standards, external_sources/handoffs`.
- **No `.flow` filetype.** A "flow package" = a workflow `SKILL.md`. (User's
  ".flow" intuition maps to a workflow skill; vocabulary only.)
- **No standalone team file.** Team membership is a `team` scalar in the
  `[agents.<code>]` config roster.
- **Custom module = a directory** with skill subdirs (each `SKILL.md`) +
  `module.yaml` + *optional* `marketplace.json` (we omit). Installed via
  `npx bmad-method install --custom-source <git-url | LOCAL PATH>` — **local +
  private supported**, comma-separated for multiple sources.
- **Claude Code target:** installer writes `.claude/skills/{skill}/` (invocable as
  a skill/slash command). Other IDEs: `.cursor/skills/`, `.cline/skills/`, …
- **Version:** BMAD **V6**. Artifact format is **not explicitly versioned** (the
  manifest records module versions/SHAs) → we must pin ourselves (OQ1).

## Non-goals

- No public BMAD package / marketplace publish. No contribution to the outside
  scene. (D1.)
- C64RE does not become an LLM runtime / execution engine. (Leitregel; Spec 773.)
- Do not rebuild the Spec 730 orchestrator or force-unify the role vocabularies —
  crosswalk only. (D3.)
- Do not vendor BMAD into this repo. We author *modules*, not a fork of BMAD.

## Open questions

- **OQ1 — Pin the BMAD V6 schema.** Which V6 release/commit do we target, and what
  is the **round-trip validation** (author module → `bmad install` into a scratch
  Claude Code project → does it load + invoke)? "Real BMAD" means nothing without
  a concrete schema + a passing round-trip. This gates any file emission.
- **OQ2 — Physical home of the TREX overlay.** Separate private git repo vs a
  gitignored path in a TREX workspace. Affects install ergonomics + secret
  hygiene. (Leaning: separate private repo, installed as a 2nd `--custom-source`.)
- **OQ3 — Who runs `bmad install`?** The harness as an onboarding step, or a thin
  C64RE MCP tool that shells out. A C64RE tool that writes `.claude/skills/` makes
  C64RE harness-aware (Claude-Code-path-coupled) — the one place the clean
  meaning/execution seam smudges. (Leaning: harness step; C64RE only records the
  roster.)
- **OQ4 — CrewAI (and other) adapter.** Deferred. The point of D1 is that the
  BMAD module is the constant source; each new runtime is one adapter, no fork.
  Not built now — named so the boundary is designed for it.
- **OQ5 — Crosswalk mapping.** Concrete map: BMAD roster ⇄ `team[]` (UI) ⇄
  `agent_set_role`/730 steps (session). Small, but must be written down (D3).

## Implementation sketch (thin loops; nothing lands before OQ1)

- **Loop A — base module skeleton + round-trip.** Author `bmad/c64re/`:
  `module.yaml` + 2–3 agent `SKILL.md` (re-lead, media-cartographer,
  semantic-annotator) + 1 flow `SKILL.md` (generic EF-port skeleton, **no
  secrets**). Install into a scratch Claude Code project; prove it loads +
  invokes. Resolves OQ1. → commit (base is repo-public-safe).
- **Loop B — private overlay proof.** A minimal TREX overlay module in a
  *separate/gitignored* location; prove layered install (base + overlay) resolves,
  and that a public C64RE checkout **without** the overlay path still installs
  cleanly (secret absent, not broken). Resolves OQ2. → the overlay is **not**
  committed here.
- **Loop C — onboarding crosswalk.** Wire Spec 773 onboarding to record the
  installed roster; `team[]` becomes the mirror; write the OQ5 crosswalk. →
  commit.
- **Loop D — adapter spike (deferred).** BMAD-module → CrewAI mapping proof.

## Cross-links

- Product direction + Leitregel: `docs/product-vision-and-workbench-contract.md`.
- Onboarding / cockpit that drives module selection: Spec 773.
- Existing orchestrator to crosswalk onto: Spec 730; `agent_set_role`.
- The placeholder this replaces as source-of-truth: `TeamMemberSchema`
  (`src/project-knowledge/types.ts:191`).
