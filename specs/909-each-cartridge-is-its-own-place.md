# Spec 909 — Each cartridge in a project is its own place, with its own type and its own role

**Status:** PROPOSED (2026-10-14).
**Repo:** C64RE (meaning and memory: the graph's id grammar and everything that writes or reads it).
TRX64 untouched.
**Number:** 909 (registry: `specs/README.md`).
**Origin:** found while fixing `extract_crt`'s manifest role (2026-10-14, branch `fix/crt-manifest-role`):
the second cartridge's chips point at the first cartridge's `.bin`. The owner: "Eigene Spec bitte. Cart type
source und target bitte bedenken."
**Depends on:** nothing. Reuses 785 A4 (`src/project-knowledge/cartridge-identity.ts`) for what a
cartridge IS (hash, hardware type, bank count) and 908's per-type `$DE00-$DFFF` names.

---

## §1 The problem

**Who:** the LLM in a cartridge project — most of all a **port**: the original cartridge (the source,
e.g. a GMod2 or Magic Desk image) and the cartridge being built from it (the target, e.g. an EasyFlash
image) sit in one project. Also: two releases of one game, or a rebuilt target next to the last one.

**What it wants:** analyse each cartridge's banks, name things in each, ask "what is at bank 5 $8000"
of a named cartridge, and get the `$DE00` register named for that cartridge's type.

**What happens today** (read from the code, 2026-10-14):

- The graph has one cartridge. The id grammar (`src/knowledge-graph/ids.ts:8,58-61,76-81`) allows
  `crt/<bank>` and refuses an owner (`crt-no-owner`: "a cartridge context is identified by bank, not
  owner"). A chip is `<slug>:crt/00:chip:8000` in every cartridge of the project.
- Every producer builds that context the same way: `migrate.ts:504,510,517,535,1050`,
  `producers/machine.ts:37`, `producers/runtime.ts:597`, `analysis-workflow.ts:384-391`,
  `symbols/layers.ts:72,91`; `records.ts:324,625` read it back.
- One entity carries one `payloadSourceArtifactId`. So after `extract_crt` on a second cartridge, its
  chip for bank 0 / $8000 is the FIRST cartridge's node and still points at the first `.bin`. The auto
  disassembly of cartridge 2 analyses cartridge 1's bytes. Names, findings and segments of both land on
  one node. Nothing says so.
- The type follows from the same blindness. `cartridgeTypeFor` (`cartridge-type.ts:1-13`) finds the
  type by lineage, then place, then "the project holds one type". A port holds two, so a node that has
  lost its lineage gets no type, and `$DE00` is named neutrally — on both carts.
- Source vs target is recorded nowhere. 785 A4 measured two cartridges extracted to one path, the second
  overwriting the first; the manifest is right, its label wrong. The same collision happens in the graph,
  one level down.

**Why it matters:** a port is the main thing this workbench is for (C64 half of a port). With two
cartridges the graph silently mixes them; a name given in the target is shown in the source, and a
disassembly of the target can be the source's bytes.

### Parts (MECE)

- **P1 Identity.** Every cartridge-space node names the cartridge it is in; two cartridges never share
  a node, one cartridge rebuilt keeps its nodes.
- **P2 Type and role.** Each cartridge carries its hardware type and its role in the project (source,
  target, or other); the type comes from the cartridge in the id, not from a guess over the project.
- **P3 Producers and readers.** Everything that writes or reads cartridge nodes — extract, analysis
  import, runtime traces, symbols, graph tools, views, UI — speaks the new form and asks or answers per
  cartridge.
- **P4 Old projects.** A project written with `crt/<bank>` opens, is moved to the new form once, and
  says which nodes it could not place.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 two cartridges, two sets of chips
  Given a project and two synthetic CRTs (generated in the test): A = GMod2 (type 60), B = EasyFlash (type 32), both with bank 0 at $8000
  When  extract_crt runs on A, then on B
  Then  A's bank 0 chip and B's bank 0 chip are two nodes, each pointing at its own .bin
  And   the auto disassembly of B's bank 0 reads B's bytes (byte compare against B)
  And   graph_find "crt bank 0 $8000" without a cartridge lists both, each with its cartridge

Scenario: S2 a rebuilt target is the same place
  Given B extracted, and a name saved at B bank 1 $8010
  When  a rebuilt B' (same lineage, different bytes) is extracted
  Then  the name is still on B's node, B' is a new version of B, not a third cartridge

Scenario: S3 type and role per cartridge
  Given A declared source and B declared target
  When  the listings of A bank 0 and B bank 0 are built
  Then  $DE00 is named as GMod2's register in A's listing and as EasyFlash's in B's
  And   project_status / contract_show name A as source (GMod2) and B as target (EasyFlash)
  And   a node reached without lineage still gets its type, from the cartridge in its id

Scenario: S4 a second unexplained cartridge is not guessed
  Given two cartridges, no role declared
  Then  both have role "other", nothing is filed as source or target, and the answer says how to declare it

Scenario: S5 runtime traces land in the mounted cartridge
  Given B mounted in a sandbox, a trace with bank-switched code at $8000
  When  the trace is imported
  Then  the nodes it creates are B's, identified by the mounted image's hash, never A's

Scenario: S6 an old project moves once
  Given a fixture project written with crt/<bank> ids holding two cartridges (the bug's state: B's chips on A's nodes)
  When  the project is opened
  Then  every crt node is renamed to crt/<cart>/<bank>, with its edges, evidence, findings, segments, labels
  And   nodes whose source artifact is A go to A; nodes with no way to tell are listed by name in the answer, kept, and not guessed
  And   B's chips are created fresh from B's .bin; a second open changes nothing

Scenario: S7 the old form is refused for writing
  When  any tool is asked to write a crt/<bank> id without a cartridge
  Then  it refuses by name (crt-needs-cart) and says which cartridges the project holds
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | two cartridges, two chip sets | `scripts/e2e-909-cartridge-identity.mjs` → `e2e:909` | `gate.sh` + `gates.yml` (synthetic CRTs) |
| S2 | P1 | rebuilt target keeps its nodes | same | same |
| S3 | P2 | type and role per cartridge | same | same |
| S4 | P2 | no role guessed | same | same |
| S5 | P3 | traces land in the mounted cart | `scripts/e2e-909-runtime-cart.mjs` → `e2e:909-runtime` | `gate.sh` (needs the daemon) |
| S6 | P4 | old project migrates once | `scripts/e2e-909-cartridge-identity.mjs` (fixture graph) | `gate.sh` + `gates.yml` |
| S7 | P3 | old form refused | same, plus a unit case in the ids tests | same |
| — | P1–P4 | the owner's own port project | by hand: a real source + target pair (third-party bytes) | — |

## §3 Decision

- **D1 (P1) grammar:** `ctx = "crt/" cart "/" bank`. `cart` is a slug token, `[a-z0-9-]{1,24}`, unique in
  the project. `ids.ts` `ctxToken` / `parseCtx` take it; `crt-no-owner` is replaced by `crt-needs-cart`.
  The `Ctx` type gets `cart` for `space: "crt"`. Lost: an owner token reused from `ram/<owner>` — a cartridge
  is not a file owner, and a bank lives inside a cartridge, so the order is cart then bank.
- **D2 (P1) what a cartridge is:** a cartridge = one lineage of cartridge-image artifacts (Spec 025
  `lineageRoot`). The token is minted once, at the first `extract_crt` of that lineage, from the image's
  name (`gmod2-orig`, `ef-port`), with a suffix on a clash, and stored on a `cartridge` node
  (`<slug>:crt/<cart>:cartridge`) with the 785 A4 identity: hash, hardware type, bank count, image name.
  A rebuild in the same lineage keeps the token (S2). Lost: the hash as token — a rebuilt target would
  become a new cartridge on every build.
- **D3 (P2) type and role:** the `cartridge` node holds `hardwareType` (from the .crt header, `$16`) and
  `role: source | target | other`, default `other`. Declared by `slot_record`/`contract_set` (a
  `cartridges: [{cart, role}]` field) — never inferred from type or file name. `cartridgeTypeFor` asks
  the cartridge in the id first; lineage / place / project stay only for bytes outside the graph. 908's
  `$DE00-$DFFF` names then come from that type on every node. A target built by the cart builder is just
  an image that is registered: C64RE does not call into or describe the builder.
- **D4 (P3) producers:** every site in §1 that builds `{space: "crt", bank}` gets the cart from its source:
  `extract_crt` and its relink (`extract-auto-chain.ts`) from the image lineage; the analysis import
  from the artifact's lineage; `producers/runtime.ts` and the trace import from the mounted image's hash
  (matched against the `cartridge` nodes; no match → the import says so and writes no crt nodes);
  `analysis-workflow.ts` takes an optional `cart` argument and refuses if the project holds more than
  one cartridge and none is given.
- **D5 (P3) readers:** `graph_find` / `graph_node` / `graph_edges` / `inspect_address_range` take an
  optional `cart`; without it they answer for all cartridges, each row naming its cartridge. Views and
  the UI group cartridge space by cartridge, with type and role in the header. `symbols/layers.ts`
  carries the cart into the payload kind.
- **D6 (P4) migration:** a one-time step in `migrate.ts` (the 822.2 cut-over path), guarded by a schema
  version: each `crt/<bank>` node goes to the cartridge its `payloadSourceArtifactId` / evidence artifact
  descends from; a project with exactly one cartridge moves everything to it; anything left is kept under
  a `crt/unplaced/<bank>` cartridge marked `role: other`, listed by name in the open's answer, and never
  merged into a real one. Edges, evidence, findings, segments, labels and annotations follow the rename.
  Then the chips of every cartridge are re-derived from its own manifest, which repairs the bug's state.
- **D7 (P3) refusal:** writing a cartridge id without a cart refuses (`crt-needs-cart`), naming the
  project's cartridges. No silent default to "the first".

## §4 Out

- Relating source and target: "target bank 5 $8000 carries source bank 12's payload". Wanted for ports,
  but it is a relation between two places that must first exist; it gets its own spec once 909 is built.
- Disk images: `ram/<owner>` already keeps two disks apart.
- The cart builder itself — walled off, invoke-only.

## §5 Decisions taken while building

(filled in at the end)
