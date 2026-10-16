# Spec 912 — A game is mapped by its moves: every state reachable from an anchor, and the shortest way to a goal, as knowledge in the graph

**Status:** BUILDING (2026-10-16), owner: "Ja Bau."
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

(filled in at the end)
