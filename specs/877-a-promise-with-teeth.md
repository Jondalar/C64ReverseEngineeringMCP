# Spec 877 — A promise with teeth, and the documents that lie about us

**Status:** PROPOSED 2026-09-25.
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

### §1.3 A retired name does not say what replaced it

866 kept `analyze_prg` / `disasm_prg` / `disasm_raw` as aliases for one release. Its
as-built says *"each naming its successor once"*. The code comment at
`analysis-workflow.ts:1227` repeats it: *"says so once in its own answer"*. **No code does
that.** The answer states which reading it took — correct, and 866's own rule — and never
mentions that the door has a successor.

Consequence, measured: the run reached for `analyze_prg`/`disasm_prg`, those want a
header, so it wrote `struct.pack('<H', addr) + data` in front of every extracted block —
the fake load headers 865 exists to abolish, four days after it shipped.

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

**D4 — A retired name says its successor in the ANSWER.** Once per process, as the comment
already claims. And the comment is corrected in the same change, whichever way it ends up.

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
4. The alias answer names its successor once per process; `e2e:866` asserts it.
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
