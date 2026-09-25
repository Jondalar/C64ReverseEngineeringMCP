# Spec 877 — A promise with teeth, and the documents that lie about us

**Status:** BUILT 2026-09-25. All six decisions on `spec-877-promise-with-teeth`; the
as-built and its limits are §6.
**Repo:** C64RE only. TRX64: no change.
**Number:** 877 (registry: `specs/README.md`).
**Depends on:** 844 (the slots and their gates), 848 (the contract), 849 (the three
steering layers), 865/866 (the two doors), 847 (documents declare themselves).
**Origin:** two runs watched live from outside — Binky (2026-09-24, BUG-065) and
Neuromancer (2026-09-25, still running). The owner, on seeing the second one build a
cartridge with 0 of 171 routines named against a contract that asks for 90 %: *"Was mich
schockiert ist, dass ich doch KLAR semantisches disassemble allen codes bis 90% Abdeckung
angefordert habe und er hat es nicht gemacht."*

---

## §1 What is wrong

### §1.1 The contract is told, and told, and has no teeth

Everything up to the last inch works. `contract_set` stored the promise verbatim —
`namedRatio: 0.9`, *"ALL code: every payload that is code is disassembled AND semantically
annotated"*. `contract-standing.json` computes the shortfall. The write path delivers it,
in as many words:

    **Contract: now owed** — named 0.0 % (0/171 nodes) is below the 90 % the contract asks for

The run read that and carried on building the cartridge. Ninety minutes in: 21 payloads
extracted, 2 analysed, **0 annotation files, 0 named routines**, 105 files under `ef/`.

This is not a delivery failure of the machinery. 849 named the limit precisely — *"a stop
is not a tool call, so enforcing it belongs to a loop outside the session"* — and that
limit is exactly where this fell through. Rules speak while work happens, doors refuse at
delivery, and **nothing in between makes an owed promise cost anything.**

The owner's answer, asked directly whether a door should refuse: **yes.**

### §1.2 A document of ours forbids the tools of ours

`docs/runtime-sandbox.md`, read at onboarding, says in bold:

> **The MCP `runtime_*` tools cannot give you that** … **Do NOT use the MCP `runtime_*`
> tools for this** — they are for the shared session.

That was true before `runtime_sandbox_run` existed. That tool now describes itself as *"a
private daemon on its own port, started as a child of this call"* — precisely what the
document says is impossible. The Neuromancer run followed the document: its own daemon,
its own WebSocket driver (`tools/sb.mjs`), then a joystick step, then a regex that parses
our monitor's own text dump back into bytes, then a hand-rolled `until` loop polling the
PC every 50 frames — where a breakpoint stops on the instruction.

It used our tools as well (93 calls, `runtime_monitor` 14, `runtime_until` 4), so this is
duplication, not replacement. It is still a parallel tool surface grown out of one stale
paragraph.

### §1.3 A retired name says the wrong thing, on every answer

866 kept `analyze_prg` / `disasm_prg` / `disasm_raw` as aliases for one release, and it
built the note: `aliasNotice()` has been in `src/server-tools/byte-doors.ts` since 866
and `e2e:866` §8.6 has asserted it since 866. The note is not missing. Two things about
it are wrong.

**It repeats.** There is no ledger, so every answer under a retired name carries the
sentence. Repeated on every listing it becomes furniture, and furniture is not read.

**`analyze_prg`'s note names the successor where it means the alias.** It read *"analyze
took a PRG and nothing else"*. Read straight, that says the NEW door wants a PRG — which
is precisely the belief that produced the fabricated headers. The run reached for
`analyze_prg`/`disasm_prg`, those want a header, so it wrote `struct.pack('<H', addr) +
data` in front of every extracted block: the fake load headers 865 exists to abolish,
four days after it shipped. Our own note helped it along.

And the note carries no rule against the thing that went wrong. It says where the door
went; it never says *do not invent two bytes to get through one*.

### §1.4 The listing names nothing outside its own image

Reported from inside by the Binky run, and the root of the loudest number in BUG-065:
labels for `$F2A3`, `$F276` and the rest are in the graph; the `.asm` prints the bare
address. So a session that wants to know who touches game state searches the rendered
text for `$F2A3` — 103 shell reads of the listing against 5 `disasm` calls, spread evenly
over all six participants.

### §1.5 Meaning has no write door

Five subagents each invented a generator (`genA.py`, `B_gen.py`, …) to turn tuple lists
into an annotations JSON, not agreeing on a filename or on address spelling. The merge
then had to undo that (`s["start"].upper().lstrip("$")`), and the merge script carried the
JUDGEMENTS — `segpref = {"82E6": "E"}`, a rename table, a priority order — in a scratchpad
that dies with the session. `propose_annotations` writes a draft; nothing takes *"here are
40 segments and 60 routines, write the file"*, and nothing merges two fragments.

## §2 What we decide

**D1 — An owed promise refuses the doors that finish the work.**
While the contract records a promise and `contract-standing.json` says it is owed, the
doors that PUBLISH refuse: `render_docs`, registering an artifact whose role is a release
(`release-crt` and its kin), and `agent_record_step` for a step that closes a phase. The
refusal names the number, the promise and the shortest path to clearing it, in the shape
844's gates already use. Reads, analysis, disassembly, annotation, runtime and sandbox
work are NEVER refused — the refusal must never block the work that would clear it.

**D2 — The human can always overrule, and it is recorded.** `contract_set` takes
`waive: [<promise>]` with a reason. A waiver is a decision and belongs in the project:
timeline entry, and the standing file names it. A run may not waive its own promise.

**D3 — An agent-facing document may not assert what a tool cannot do.** Capability claims
go stale; that is the same rule the owner already applies to comments, one level up.
`docs/runtime-sandbox.md` is rewritten to lead with `runtime_sandbox_run` and keep the raw
recipe for what the tool genuinely cannot do (an interactive session that survives the
call). A gate greps the agent-facing docs for "cannot" / "do NOT use" next to a tool name
and fails when the named tool exists.

**D4 — A retired name says its successor in the ANSWER.** Once per SESSION, re-armed by
`agent_onboard` — the comment said "once per process", and a server that outlives a session
and serves several projects would then tell the second session nothing. The ledger is a
file, the same shape the project rules already use for the same reason. And the comment is
corrected in the same change, whichever way it ends up.

**D5 — The listing carries equates for the addresses it references.** Every name the graph
holds for an address outside the rendered image is emitted as an equate, so the name is
greppable where the session is already looking. Byte output is unchanged; the rebuild stays
byte-identical.

**D6 — One door writes an annotation file, one door merges fragments.** The writer takes
segments / labels / routines and produces the file the importer accepts. The merger takes
N fragments, refuses a contradiction by naming both sides, and records the resolution as a
finding — because who was right at `$82E6` is exactly what the project exists to remember.

## §3 What does not change

- 849's three layers stand. This adds teeth at delivery, not a driver: nothing decides for
  the session, it only stops it from calling the work finished while it is not.
- No slot changes, no contract-schema change beyond `waive`.
- Nothing in TRX64.

## §4 Acceptance

1. A project with an owed `namedRatio` refuses `render_docs` and the release registration,
   naming the number; `analyze`, `disasm`, `save_finding` and every runtime door still work.
2. Clearing the promise clears the refusal with no further action.
3. `contract_set waive:` releases it, writes the timeline entry, and the standing file says
   who waived what and why.
4. The alias answer names its successor once per session, and `agent_onboard` re-arms it;
   `e2e:866` asserts it, including across a second server process.
5. A doc claiming a tool "cannot" do what the tool's own description says it does fails the
   new gate; `docs/runtime-sandbox.md` passes after the rewrite.
6. A listing whose graph holds a name for an out-of-image address prints an equate for it,
   and the rebuild is byte-identical before and after.
7. The annotations writer round-trips: fragments in, one file out, importer accepts it; two
   fragments contradicting at one start are refused with both named.

## §5 Not in this spec — plain defects, filed separately

From the two runs, all reported from inside, none needing a design decision:

- `runtime_render_screen` does not create its output directory and leaks a Node stack.
- `runtime_session_run` with `until` is not routed through the daemon (744.4c slice 2 is
  unfinished) — belongs to that spec, not this one.
- `read_memory` parses its length as HEX without saying so.
- A sandbox run past ~120 s goes to the background and cannot be re-run with a larger
  budget; nothing captures mid-run state.
- `project_inventory_sync` does not walk a project subfolder the session created, and no
  `save_artifact` exists on the surface to register a release by hand.
- The contract matches documents by boundary or artifact name, not by a registered
  document's `covers`.
- `save_finding` on an existing id silently rewrites it into a refutation; a supersede or
  retire action is the honest door.

---

## §6 As built — 2026-09-25

Six decisions, six gates, one branch (`spec-877-promise-with-teeth`). What each one
became, and what it does NOT do.

### D1 — an owed promise refuses the doors that publish

`src/contract/promises.ts` turns the contract into `ContractPromise` records — an id a
waiver can name, what was asked, what was measured, and the shortest path to closing the
gap. `src/contract/teeth.ts` holds the three publishing doors as data (`PUBLISHING_DOORS`:
`render_docs`, `save_artifact`, `agent_record_step`), `isReleaseRole` decides which
artifact role is a release, `closesAPhase` decides which step closes a phase, and
`checkContractTeeth` is what the doors call. `src/critic/run.ts` renders its contract
blockers from the same records rather than computing them a second time — one
computation, two readers, which is why 848's wording is unchanged.

The refusal's `clear:` line is remedy text printed verbatim, so it names live doors only.
It first shipped naming `disasm_prg`, which 866 had retired, and never naming
`write_annotations`, which D6 had shipped two commits earlier for exactly that job; the
gate now fails on either.

**Gate:** `e2e:877-teeth` — 78 checks, hermetic (temp projects, a synthetic
`graph.sqlite`, no media, no runtime).

### D2 — the human overrules, and it is recorded

`src/contract/waive.ts` (`waivePromises`) and `src/contract/standing.ts`
(`listWaivers` / `activeWaivers` / `formatWaivers`), reached through `contract_set
waive:`. A waiver must be signed (`by`, never defaulted) and must carry a reason; it
records the channel it actually arrived on; it lapses when the human moves the bar; and
it does not launder the number — `project_critique` and the 849 footer keep measuring and
keep reporting the shortfall. It is written into the project timeline as an event.

**Gate:** `e2e:877-teeth` (same run as D1).

### D3 — a document may not deny what a tool does

`docs/runtime-sandbox.md` rewritten to lead with `runtime_sandbox_run` and keep the raw
recipe only for what the tool genuinely cannot do; `docs/agent-doctrine.md` brought in
line. `scripts/check-doc-capability-claims.mjs` greps the agent-facing documents for a
denial next to a tool name and fails when the named tool exists, with an explicit
deliberate-limitation mark for a denial that is true.

**Gate:** `check:doc-capability-claims` — 12 agent-facing documents against 298
registered tools, 3 deliberate-limitation marks, 2 self-tests on the paragraph the gate
was written for.

### D4 — a retired name says its successor, once per SESSION

`aliasNotice` in `src/server-tools/byte-doors.ts`. The note names the OLD door as the one
that wanted a header (that was §1.3's second fault), and every note ends with the rule
the run broke: never invent a 2-byte load header to get headerless bytes through a door.

"Once" is bounded by the SESSION, not by the process. It shipped as a module-level `Set`,
which made it once per process — and this server outlives a session and serves several
projects at once, so a globally configured one that had already answered a single
`analyze_prg` handed the NEXT session nothing. The ledger is now
`knowledge/alias-notices.json` and `agent_onboard` re-arms it, which is 849 D5's shape
exactly (`src/project-rules/deliver.ts` states the reasoning). A call with no project
behind it keeps the process-scoped set — there is no file to keep a ledger in.

**Gate:** `e2e:866` §8.6 — 77 checks over the whole spec, of which §8.6 asserts the note,
that it is not repeated in the session, that `agent_onboard` re-arms every retired name,
and that a SECOND server process over the same project behaves the same.

### D5 — the listing carries equates for the addresses it references

`src/symbols/listing-equates.ts` decides WHICH name (the three layers, the precedence,
the ambiguity rule, the project's name-length limit) next to the resolver, where names
are already decided once; `pipeline/src/lib/graph-equates.ts` is the CommonJS bridge the
renderer reaches through, and `pipeline/src/lib/prg-disasm.ts` /
`pipeline/src/lib/tass-converter.ts` emit them in both dialects. A name that loses says
why. Bytes are unchanged and the rebuild stays byte-identical.

**Gate:** `e2e:877-equates` — 24 checks; the byte-identity half needs KickAssembler and
skips loudly without a jar.

### D6 — one door writes an annotation file, one door merges fragments

`write_annotations` and `merge_annotations` in `src/server-tools/annotation-doors.ts`,
over `src/server-tools/annotation-file.ts` and `src/server-tools/annotation-merge.ts`.
The writer normalises every address spelling to bare uppercase hex and refuses BEFORE the
file exists, naming every offender by its own index. The merger collapses agreement
silently and REFUSES a contradiction by naming the key, every claimant and what each
claimed; the resolution is written into the project as a finding carrying who claimed
what, which one won and why — that is the point of the door, not the merged file.

Both are in `DEFAULT_TOOLS` (`src/server-tools/tier-tools.ts`), so a normal session sees
them.

**Gates:** `e2e:877-write` — 23 checks; `e2e:877-merge` — 40 checks. The byte-identical
rebuild half of each needs KickAssembler and skips loudly without a jar.

### The gates, and where they run

All six gates plus `check:doc-capability-claims` are wired into
`.github/workflows/gates.yml`. They were not: for a while only `e2e:877-equates` ran
there, and a gate nothing runs is not a gate. The same round wired five long-standing
ones that had been in `package.json` and in no workflow — `e2e:844-teeth`,
`e2e:846-critic`, `e2e:847-docs`, `e2e:849-rules`, `e2e:849-standing`.

### The limits, stated

**"A run may not waive its own promise" is NOT enforced, and cannot be from inside.**
`contract_set` is an MCP tool: every call arrives on the same channel, from the same
client, whether the human typed it or the run decided it. MCP carries no caller identity,
and the harness relays both identically; the permission prompt that might distinguish
them happens outside this server and is never reported back into the call. Anything that
claimed to tell the two apart — a name that "looks human", an environment variable, a
confirmation file — is a string a run with a shell can also produce, and a fig leaf here
is worse than the honest gap. `src/contract/waive.ts` opens with that paragraph. What is
enforced instead: the waiver must be signed, it must carry a reason, it records the
channel it came on, it lapses when the bar moves, it never launders the measurement, and
while any other promise is owed the refusal names every waiver already granted. What
remains uncovered is a run that signs a human's name to an honest-looking reason and
ships — which shows up in the timeline, the standing file and `contract_show`, from
outside, in one glance. That is where 849 already says this kind of enforcement belongs.

**One of D1's three teeth cannot bite in a normal session.** `save_artifact` is not in
`DEFAULT_TOOLS`, so it is hidden unless the advanced surface is switched on. The release
registration is gated in code and the gate is asserted, but a default session has no way
to reach the door at all — which is also §5's own entry: *"no `save_artifact` exists on
the surface to register a release by hand"*. Putting it on the default surface is that
defect's fix, not this spec's.

**The teeth are at delivery, not in the loop.** 849 named the limit and it still stands:
a stop is not a tool call. Nothing here decides for the session; it only stops the session
calling the work finished while it is not. A run that never reaches a publishing door is
never refused.

**D4's "once" now depends on onboarding.** A session that works in a project without
`agent_onboard` inherits the previous session's ledger and is not told. Doctrine rule 8
and the onboarding gate make that a refused session rather than a silent one, so the case
is closed elsewhere — but it is a dependency, not an independent guarantee.

**D3's gate scans the agent-facing documents, not every document.** A capability claim
that goes stale in a file outside that set is not caught. The wider sweep the same audit
found — retired names emitted in live text across the source, and graph usage nowhere
enforced — is not in this spec.
