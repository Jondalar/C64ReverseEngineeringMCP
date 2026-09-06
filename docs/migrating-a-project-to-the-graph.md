# Taking an existing project into the knowledge graph

For a project that was analysed before Specs 817–826. Ten minutes, and the first
step is the one that already happened without you.

## 0. It has probably migrated itself

Opening a project cuts it over. The six JSON stores — `entities.json`,
`findings.json`, `relations.json`, `open-questions.json`, `labels.user.json`,
`flows.json` — fold into `knowledge/graph.sqlite` and move to
`knowledge/_legacy-822/`, where they stay for one release as read-only
archaeology. It is idempotent: the second open is a no-op.

So `ls knowledge/` answers where you stand:

| what you see | what it means |
|---|---|
| `graph.sqlite` and `_legacy-822/` | already cut over, go to step 2 |
| `graph.sqlite` and the six JSON files | a partial run; step 1 finishes it |
| only the six JSON files | never opened since the cut-over; step 1 |

Nothing is deleted, ever. The migration is additive and re-runnable.

## 1. Fold the old stores in

```bash
node <repo>/dist/cli.js graph migrate --project <project> --dry-run   # counts, writes nothing
node <repo>/dist/cli.js graph migrate --project <project>
```

The dry run computes every action and rolls back, so it is the cheap way to see
what will happen. The real run is incremental — running it twice creates
nothing the second time, and a ledger records which legacy id became which node.

On Wasteland_EF that is 46 936 records in about a second: 22 246 analysis
entities collapse to 4 612 nodes, 9 421 findings become 1 189 claims with 9 421
evidence rows. **The collapse is the point**, not a loss: fifty-six findings that
said the same thing about `$0031` become one claim with fifty-six pieces of
evidence.

## 2. Seed the structure

```bash
node <repo>/dist/cli.js graph seed --project <project>
```

Runs the producers over every `*_analysis.json` in the project: control flow
(819), memory access (820), the `RESOLVES_TO` pass (826.0) and the routine
signatures (826). It prints one line per artifact plus the totals, and it is
safe to repeat — each producer replaces exactly its own rows.

**Declare the machine for any drive code first.** Code that runs on the 1541 is
seeded as C64 RAM otherwise: `jsr $FDF5` resolves to a C64 address and every
zero-page access wears a KERNAL name. It looks plausible, which is what makes it
dangerous.

```bash
node <repo>/dist/cli.js graph machine t18s12-15_0300 c1541 --project <project>
node <repo>/dist/cli.js graph seed --project <project>          # re-seed after declaring
```

The seed prints which machine it used per owner (`c1541 (declared)`), and warns
when a path looks like drive code and nothing is declared. `graph machine` with
no arguments lists what has been declared.

## 3. Bring the annotations in

```bash
node <repo>/dist/cli.js graph annotations-import <stem>_annotations.json --project <project>
```

`disasm_prg` does this by itself whenever the file changes, so usually there is
nothing to do. Run it by hand after editing an annotations file outside the
tool. Names, comments and segment labels land in the **human layer**, which
re-analysis never touches.

## 4. Look at what it found — and at what it disagrees with

```bash
node <repo>/dist/cli.js graph stats      --project <project>
node <repo>/dist/cli.js graph overview   --project <project>
node <repo>/dist/cli.js graph boundaries --project <project>
```

`boundaries` is the one to read. It lists where a human drew a routine boundary
that discovery did not: a human routine starting inside a generated one means
two routines were merged into one; a human routine outside every generated one
means discovery never saw it. Both are free quality reports on the analysis, and
`boundaries --entries` prints the second kind in the form `analyze_prg` takes.

**Careful with that list.** `entry_points` does not add seeds to the heuristic
scan, it constrains it: an incomplete list silently drops code the speculative
pass had found. Pass the union of the entry points *and* every annotated routine
and label address, and diff the segment map before and after — a shrinking
`code` total is silent.

## 5. Ask it something

```bash
node <repo>/dist/cli.js graph find '$D018'            --project <project>
node <repo>/dist/cli.js graph edges c64:io:dd00 --in  --project <project>
node <repo>/dist/cli.js graph signature '$FC00'       --project <project>
node <repo>/dist/cli.js graph args '$FC00'            --project <project>
node <repo>/dist/cli.js graph path <from-id> <to-id>  --project <project>
```

The same five questions are MCP tools (`graph_find`, `graph_node`, `graph_edges`,
`graph_path`, `graph_overview`) and a tab in the workspace UI. **Reload the MCP
server (`/mcp`) after updating the repo**, or the session keeps the old tools and
you will be told a fixed thing is still broken.

For *prose* — how something works, what a routine is for — use `project_search`
and `project_find_related`. The graph carries structure; the wiki and the
annotations carry meaning. Asking the graph a "how does this work" question and
concluding it does not know is the most common mistake with this surface.

## If something looks wrong

- **A ROM address has callers it should not have.** Re-seed: before 826.0 a `jsr`
  into RAM under BASIC produced a `CALLS_ROM` to a BASIC address.
- **A path stops at an artifact boundary.** Run `graph resolve` — it links the
  ownerless address node to the routine another artifact holds there.
- **A zero-page cell "has no node".** It does; `graph edges c64:zp:00fe --in`
  answers. Do not count rows in `nodes` — a platform node is resolved from the id
  grammar and has no row by design.
- **Drive code wearing C64 names.** Step 2, `graph machine`.
- **You want the old shapes back.** `graph export --out <dir>` writes the graph
  into the legacy record files for reading and `git diff`. It never reads them.

## What this does not do

The migration does not delete, rename or move anything in `analysis/`. It does
not touch the `.c64retrace` or DuckDB captures (Spec 827 decides where *new* ones
go). And it does not re-run `analyze_prg` — the graph is built from the analysis
output that already exists.
