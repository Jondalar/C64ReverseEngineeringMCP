# Spec 912 — A game is mapped by its moves: every state reachable from an anchor, and the shortest way to a goal, as knowledge in the graph

**Status:** BUILT on branch spec/912 (2026-10-16), not merged; S7 by hand open. Ships with a TRX64 release that carries the jam-after-restore fix; until then S4 skips loudly on the released runtime.
**Repo:** C64RE. The search runs on a private sandbox with what TRX64 has: checkpoint
capture/restore, joystick, run, memory read and snapshot dump. TRX64 #12 (a restore from a
jammed machine kept reporting `jam`) is fixed on TRX64 main and must be released before this
ships.
**Number:** 912 (registry: `specs/README.md`).
**Origin:** owner, 2026-10-16. A reporter's skill (`c64-game-explorer`, a 25 KB Python driver
around a private daemon) maps a game, solves it and hunts bugs, because C64RE has no tool for
it. The owner: "Unsere Arbeit sollte allein für sich stehen … können wir da Verbesserungen /
Anpassungen dann vornehmen mit konkreten mcp Tools?" — and on the split from 911: "Jo dann 912".
**Depends on:** 911 (anchor as a file, `set the anchor` step, private runs), 906 (sandbox
limits), TRX64 release with the #12 fix.

---

## §1 The problem

**Who:** the LLM in an RE project. It wants to know a game's structure: which rooms, screens
or levels exist, how they connect, and how to get from here to there. That is for a map
document, a walkthrough, a cheat, or a bug ("down in room 2 crashes"). The owner wants the
same at the workbench.

**What they want:** to say what a state is (the bytes the room code indexes with), which moves
there are (joystick directions, fire, nothing), and what counts as dead or as the goal. Then to
get back the reachable states, the moves between them, the crashes, and a shortest path to
the goal. The LLM decides only the key, the moves and the goal, all read from the code. The
machine work is a tool.

**What happens today:**

- There is no tool for it. The building blocks exist on a sandbox session:
  `runtime_checkpoint_capture` / `_restore`, `runtime_joystick`, `runtime_session_run`,
  `runtime_monitor_memory`.
- An LLM that tries it from MCP makes one call per move per state: restore, set the joystick,
  run, release, run, read. A 9-state maze costs about 48 runs, which is around 300 tool calls
  and the tokens to read each answer.
- So agents write their own driver. The reporter's `explorer.py` does BFS with a state key,
  dead/goal predicates, JAM-as-crash and caps. Its results live in a case folder outside the
  project's knowledge: not in the graph, not searchable, not linked to the routines that make
  the rooms.
- A JAM after a checkpoint restore was reported on every later run (TRX64 #12, fixed on
  main), so a search hit phantom crashes.

**Why it matters:** mapping a game by hand is exactly the "boot, wait, watch, again" the
owner wants gone. It is also where agents leave C64RE and build their own tools.

**Worked example (the reporter's self-test game: four rooms, L/R move, fire in room 3 = goal,
down in room 2 = a planted JAM):**

```
runtime_state_map  anchor="maze_loop"  key=["$02","$03"]  actions=["L","R","U","D","F","N"]
                   frames=6  release_frames=4  goal="$03 == 1"  max_states=50
→ complete: 9 states, 48 runs, 1 crash
  S0 $02=00 $03=00  (anchor)
  S0 -R-> S1 ($02=01)   S1 -R-> S2 ($02=02)   S2 -R-> S3 ($02=03)   S3 -F-> S7 ($03=01) GOAL
  S2 -D-> JAM at $085F
  shortest path to the goal: R R R F (4 moves, 40 frames)
  saved: map maze_loop/rooms (graph), goal snapshot knowledge/anchors/maze_loop.goal.c64re
```

**Parts (MECE):**

- **P1 Describe the search:** a state key (addresses with lens and length), moves (joystick
  directions and fire on port 1 or 2, keys, "nothing"), hold and release frames, `dead` and
  `goal` predicates, and caps. These are validated before any run.
- **P2 Search:** breadth-first from the anchor on one private sandbox. Each state is reached
  by restoring its checkpoint, never by replay from boot.
  - A JAM is a crash state with its PC.
  - The search ends `complete`, `stopped` at a cap, or `goal` reached (in goal mode).
- **P3 Result:** a compact answer for the LLM: states with their key values, moves that change
  the state, crashes, and the shortest path to the goal with its frame count.
  - The answer says whether the map is complete.
  - It does not dump every edge unless asked.
- **P4 Memory:**
  - The map is saved in the graph: states as nodes, moves as edges, crash and goal marked,
    linked to the anchor.
  - The goal state, and on request every state, is saved as an anchor file, so 911 scenarios
    and the next map can start there (solving a game in segments).
  - A walkthrough is the chain of paths.
- **P5 Caps that stop:** caps on states, runs and depth, and the 906 sandbox budget. Over a
  cap the tool stops, returns what it has, and says which cap. Re-running the same map with
  the same inputs costs nothing new: it reads the graph.
- **P6 Taught:** the agent docs and the wiki show when to map (structure questions, a crash
  reachable by moves) and how to pick a key that neither merges states nor explodes (no
  timers or sprite positions in it).

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 a bad description is refused before any run
  When  runtime_state_map gets an empty key, an unknown action, or a goal over an address
        not in the key or readable memory
  Then  it refuses naming the field, and no sandbox was started

Scenario: S2 the whole maze is found
  Given the self-test maze PRG (built in the test from its own source) and an anchor at its loop
  When  runtime_state_map runs with key $02,$03 and the six actions
  Then  it answers complete with 9 states and 1 crash at $085F
  And   every edge it lists reproduces when replayed as a 911 feature from the anchor

Scenario: S3 goal mode gives a shortest path and a goal anchor
  When  it runs with goal "$03 == 1"
  Then  the path is R R R F
  And   a 911 feature from the goal anchor reads $03 = 1
  And   a second map started from the goal anchor finds the states beyond it

Scenario: S4 a crash after a crash is not a phantom
  Given the search restored a checkpoint after reaching the JAM
  Then  no later state is reported as a crash unless its PC holds a JAM opcode

Scenario: S5 caps stop and say so
  When  max_states is 3
  Then  it answers "stopped: max_states 3" with the 3 states found, and the sandbox is ended
  And   the same call again starts no machine and answers from the graph

Scenario: S6 the map is knowledge
  Then  graph_find finds the states and moves, linked to the anchor
  And   project_search finds the map by its name
  And   the shared session's cycle did not move during S2–S5

Scenario: S7 a fresh agent maps instead of driving
  Given a fresh agent with the onboarding, doctrine and wiki, and a game with rooms
  When  asked which rooms exist and how to reach the last one
  Then  it reads the room code for the key, sets an anchor, calls runtime_state_map —
        no per-move runtime calls, no own driver
```

| # | Solves | Test | Where it runs |
|---|---|---|---|
| S1 | P1 | `scripts/e2e-912-state-map.mjs` → `e2e:912`, `── S1` | `gate.sh` |
| S2 | P2 | same, `── S2` (maze source in the test, assembled there) | `gate.sh` |
| S3 | P3, P4 | same, `── S3` | `gate.sh` |
| S4 | P2 | same, `── S4` (needs the TRX64 #12 fix) | `gate.sh` |
| S5 | P5 | same, `── S5` | `gate.sh` |
| S6 | P4 | same, `── S6` | `gate.sh` |
| S7 | P6 | agent run on a throwaway copy of a real corpus game with rooms, by hand | — |

## §3 Decision

- **D1 One tool, `runtime_state_map`.** It has two modes: map everything, or stop at the goal.
  It takes:
  - `anchor`, which is a 911 anchor file by name;
  - `key[]` as `"$02"`, `"$0400:2"` or `"$D020@io"`;
  - `actions[]` from `L R U D F N` plus combinations like `"UF"` and keys like `key:SPACE`;
  - `port` (default 2), `frames`, `release_frames`;
  - `dead[]` and `goal?` in the 911 predicate notation (`$addr is $byte`, plus `<`, `>`,
    `!=`, and a bit mask);
  - `max_states`, `max_depth`, `max_runs`, `save_states?` and `name`.

  The same thing is on the CLI as `c64re state map <file.json>`, which calls the same
  function. Lost: separate `map` and `solve` tools, because goal mode is the same search with
  a stop.
- **D2 Search on one sandbox session.** The search starts from the anchor file and works one
  move at a time:
  - restore the state's checkpoint;
  - set the move;
  - run `frames`, release, run `release_frames`;
  - read the key;
  - if the key is new, capture a checkpoint.

  The checkpoints live in the sandbox's ring. Spilling to a snapshot file happens only on ring
  pressure. Default parallelism is 1, because a sandbox is one machine; more sandboxes are a
  later decision. A JAM ends that branch as a crash state with its PC; S4 relies on the TRX64
  fix.
- **D3 Answer.** By default the answer lists states (id, key values, depth, first path), the
  moves that change the state, the crashes and the goal path. `edges: "all"` lists every
  edge. The answer begins with `complete` / `stopped: <cap>` / `goal reached`.
- **D4 Graph.** The map is saved in the graph:
  - one `state_map` node (name, anchor, key, actions, caps, outcome);
  - one `game_state` node per state, with its key values, depth and crash/goal flags;
  - one `MOVES_TO` edge per state-changing move, with the action and frames;
  - one `STARTS_FROM` edge to the anchor.

  The goal state, and with `save_states` every state, is written as an anchor file
  `<name>.<state>`. A repeated call with the same anchor, key, actions and caps answers from
  the graph.
- **D5 Caps.** Defaults are `max_states` 400, `max_runs` 3000 and `max_depth` 64, plus the
  906 sandbox budget. Only the caller raises them, and every cap is stated in the answer.
- **D6 Taught.**
  - `docs/agent-doctrine.md` gets a short section, "the game's structure: map it". It says:
    - read the room/level code for the key;
    - anchor at the loop, using 911's `set the anchor`;
    - call `runtime_state_map`;
    - continue from the goal anchor for the next segment.
  - The traps, in one line each: timers in the key, a debounce longer than `frames`, and
    `screen shows` matching the BASIC banner.
  - Wiki: new page `Mapping-a-Game.md`, linked from `Home.md` and from `Trying-a-Fix.md`
    (911), because a crash found on the map is where a fix starts.
  - No spec numbers in any of these.

## §4 Out

- Searching over anything but discrete moves from a start state, such as timing, analogue
  paddles or random seeds.
- Parallel sandboxes for one search (D2).
- Picking the key automatically. The key comes from reading the code; the tool only refuses
  a key that changes every frame, which it detects as a state count growing by one per run
  for the first 20 runs.
- Rendering the map as a picture (later, from the graph).

## §5 Decisions taken while building

- **Goal mode stops; the worked example does not.** D1 says goal mode is the same search with a stop, and §1's worked
  example gives a goal and still finishes (`complete: 9 states, 48 runs`). Both are served: a `goal` stops the search at the
  first, shortest way there (`goal reached`), and the added `continue_after_goal: true` maps on and still reports that path.
- **A crash is one state per JAM address.** The state is named by its PC and not by the key (the key at the moment of the
  JAM is kept as information): the 9 states of the maze are its 8 rooms plus the one JAM at `$085F`, which both
  `down` in room 2 with `$03 = 0` and with `$03 = 1` reach. A crash is a leaf; its moves are not tried.
- **State ids are `s0`, `s1`, … (lower case).** Upper-case `S<n>` is what the public-surface check treats as an internal id,
  and the answer is quoted in the wiki. The anchors a map writes are `<name>.goal` (the first goal state found) and, with
  `save_states`, `<name>.s<N>`; `name` defaults to the anchor's name (the spec used `<name>.<state>` and a `maze_loop.goal`
  file in one place each). A map replaces an earlier one of its name, its own anchors with it; an anchor of that name that
  is not the map's is refused by name, never overwritten.
- **The machine is a `SandboxSession` of the call's own** (the class `runtime_sandbox_run` and the feature runs use), not a
  `runtime_sandbox_start` session: one call, one machine, ended in a `finally` and by its keeper. The search opens a copy of
  the anchor file (the runtime lays embedded media out beside the file it opens), and reaches the states through
  `checkpoint/capture` + `checkpoint/pin`, `checkpoint/restore`. A capture the ring refuses goes to a snapshot file
  (`snapshot/dump`, reopened with `media/open`); `ringStates` in the library call (not a tool field) lets a gate make the ring
  small enough to prove it. A move is one `session/run` per phase (hold, release), the stick set and cleared through the
  runtime's input calls.
- **S4 is decided by what the runtime does, not by its version.** `ping` reports `0.13.3` on the released daemon and on TRX64
  main with the fix (the crate version is bumped at release), so a version test cannot tell them apart. The gate asks the
  daemon itself: checkpoint after reaching the JAM in room 2, restore a checkpoint taken before it, run one frame; a jam
  reported there means the fix is missing, and S4 prints `SKIPPED` with the runtime's version and path (a skip is not a
  pass). The tool is safe on such a runtime too: a jam report counts as a crash only when the byte at its PC is a JAM opcode;
  the others are counted, left out, and named in the answer as a note (`reported a jam N times at a PC that holds no JAM opcode`).
- **Gates.** The call's `project_dir` goes to the check, not `C64RE_PROJECT_DIR`. `runtime_state_map` allocates no memory in the
  game, so no slot guards it. The read-before-runtime discipline applies to the one thing that comes from reading, the key: its
  addresses must resolve against what the project has read (the citation check `runtime_loader_lens` and the trace doors use),
  and it stays dormant in a project that has analysed nothing. The command line is not a door and is not gated.
- **Caps and the budget.** `budget_minutes` (default 10, at most 240) is the sandbox's wall clock; the search stops before it
  with `stopped: budget`. `max_states` stops when a new state would be the one over the cap; `max_depth` leaves states at
  that depth unexpanded and says so only if some were. A key that gives a new state with each of the first 20 runs is refused
  (`key — changes with every run`), and nothing is saved.
- **Asking again.** The graph's `state_map` node keeps the description and a hash of it with the anchor file's bytes (not the
  name, `edges` or `json`); a call whose hash matches answers from the graph, unless the earlier map stopped on the budget
  or an anchor file it wrote is gone. The moves that left a state as it was are kept on the state, so `edges: "all"` is served
  from the graph as well.
- **The graph.** New node kinds `state_map` and `game_state` are withheld from the entity projection (like `anchor` and
  `candidate`); `project_search` has a `state_map` record kind, one per map, and its index version is 3. Edges: `STARTS_FROM`
  (map to anchor), `CONTAINS` (map to state), `MOVES_TO` (the move is the edge's key, so two moves between one pair are two
  edges) and `SAVED_AS` (state to its anchor).
- **The condition notation** is one byte against a number: `==` `=` `is` `!=` `is not` `<` `>` `<=` `>=`, a lens `@io`, and a
  mask (`$03 & $80 == $80`; `$03 & $80` alone: any masked bit set). A condition's address outside the key is read in the same
  breath as the key.
- **The gate is `scripts/e2e-912-state-map.mjs` (`npm run e2e:912`).** The test game is four rooms in `$02` with a goal flag in
  `$03` and a JAM at `$085F` (down in room 2), written as 64tass source in `scripts/lib/e2e-912-maze.mjs`, assembled in the
  test, with a 16-bit hash of every frame's stick in `$0A/$0B` as the byte a key must not contain. The runtime binary of the
  refusal sections is a tripwire script that records that it was started. S2 replays every edge as a feature from the anchor;
  S6 runs the tool beside a stand-in for the shared session and compares its cycle before and after.
- **What the "changes with every run" check catches.** The spec's test (the state count grows by one per run for the first 20
  runs) fires on a key that differs for every move even from one state (a hash of the input, a random seed). A counter that
  advances by the same amount whatever the move (a frame counter) makes one new state per state and is not caught by it; the
  caps stop that search (`max_states`, `max_runs`).
- **A key that follows time.** Found on a real EasyFlash game: the key held a counter, every move from every state led to the same
  next state (a chain), and the 20-run check did not fire. After the search, when at least two states were expanded and each has
  exactly one successor other than itself whatever the move, the answer begins `complete — but the key follows time, not the
  moves…`, the `state_map` node carries `key_follows_time: true`, the JSON has `keyFollowsTime`, and the command line exits 1.
  The map is saved. It is decided after the search, not earlier.
- **Seen, not touched:** `check:wiki`'s comparison with the published wiki fails for the pages of both specs (nothing is
  published from this branch); `probe-mcp-llm-playbooks` check 9 still names the three sandbox session tools.
