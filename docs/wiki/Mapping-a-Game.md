# Mapping a Game

You want to know how a game is built: which rooms, screens or levels there are, how
they connect, how to get to the last one, and whether some move crashes it. Walking the
game by hand, one input at a time, is slow and every step costs a question and an
answer. A map does the walking for you.

The work is split. **You** (or your assistant) read the code and decide what a state
is, which moves exist and what counts as the goal. **The tool** starts a machine of its
own at the instant you name, tries every move in every state it finds, and hands back
the map. The machine you are watching is not touched.

## The loop

1. Read the code that picks the room or level, and write down the bytes it indexes with.
2. Set an **anchor** where the game waits for input.
3. Ask for the map.
4. Read the answer; continue from the goal, or start a fix from a crash.

## 1. Pick the key

A **state** is whatever the game's own code uses to decide where you are: the room
number, the level, a flag for "has the key". Those bytes are the **key**. Two moments
with the same key are the same state.

```
"$02"          one byte at $02
"$0400:2"      two bytes from $0400
"$D020@io"     a byte as the I/O area shows it (lenses: cpu, ram, io, rom, cart)
```

Read the key out of the code. A key that is too small merges rooms that differ; a key
that is too big (a timer, a frame counter, a sprite position) makes every run a new
state and the map never ends. The tool refuses a key that gives a new state with every
one of the first twenty runs.

## 2. Set the anchor

Bring the game to the loop where it waits for input and set an anchor there
(see [Trying a Fix](Trying-a-Fix)):

```
runtime_anchor_set
  name = maze_loop
  why  = the room loop, waiting for the stick
```

The anchor is a file in your project, `knowledge/anchors/maze_loop.c64re`, so the map
can start from it any time later.

## 3. Ask for the map

```
runtime_state_map
  anchor  = maze_loop
  key     = ["$02", "$03"]
  actions = ["L", "R", "U", "D", "F", "N"]
  goal    = "$03 == 1"
```

- `actions` are the moves: `L R U D F` (left, right, up, down, fire), a combination
  such as `"UF"`, `N` for nothing, or a key as `key:SPACE`. They go to joystick port 2
  unless you say `port = 1`.
- `frames` (default 6) is how long a move is held, `release_frames` (default 4) how long
  the machine runs after it is let go. If the game reads the stick only now and then,
  or needs the stick to return to centre first, make `frames` longer than its
  debounce, or the game never sees the press.
- `goal` and `dead` are conditions on a byte: `"$03 == 1"`, `"$02 != 0"`, `"$02 < 3"`,
  `"$D020@io >= $05"`, and with a mask `"$03 & $80 == $80"`. A `dead` state is a state
  but its moves are not tried.

With a `goal` the search stops at the first, shortest way there. Add
`continue_after_goal = true` to map on and still get that shortest path.

The same thing from a script, with the inputs in a file:

```
c64re state map maze.json
```

## 4. Read the answer

```
complete: 9 states, 48 runs, 1 crash

  s0 $02=00 $03=00  (anchor)
  s1 $02=01 $03=00  depth 1  first reached by R
  s2 $02=02 $03=00  depth 2  first reached by R R
  ...
Moves that change the state:
  s0: R->s1
  s2: L->s1  R->s3  D->s4
Crashes:
  s4 JAM at $085F, reached by R R D (3 moves, 30 frames)
Shortest path to the goal ($03 == 1): R R R F (4 moves, 40 frames) -> s5
```

The first word says whether the map is whole:

- **complete** - every move was tried in every state.
- **goal reached** - the search stopped at the goal.
- **stopped: max_states 400** (or `max_runs`, `max_depth`, `budget`) - a cap ended it.
  The states found are listed; the map is not complete. Raise the cap on purpose if you
  want more. Defaults: 400 states, 3000 runs, depth 64, and a ten minute budget.

A **JAM** is a state of its own, named by the address the CPU stopped at. Every move
that lands on the same JAM is one crash. `edges = "all"` also lists the moves that left
the state as it was.

## 5. What is kept

The map is saved in the project's graph under its `name` (default: the anchor's name):
one `state_map` node, a `game_state` node per state with its key values, and a move
between two states as an edge. `graph_find`, `graph_edges` and `project_search` find
it. Ask for the same map again - same anchor, key, moves and caps - and the answer comes
from the graph without starting a machine. Another set of inputs under the same name
replaces the map.

The goal state is written as an anchor, `maze.goal` (with `save_states = true` every
state is, as `maze.s0`, `maze.s1`, ...). That is how a game is solved in segments:

```gherkin
Scenario: the goal holds
  Given the mark "maze.goal"
  When I wait 3 frames
  Then $03 is $01
```

and a second map can start there: `anchor = maze.goal` finds what lies beyond. A walkthrough
is that chain: the path of one map to its goal, then the path of the map that starts at the
goal anchor, and so on - each map's `STARTS_FROM` link in the graph names the anchor the
previous one wrote. A crash
on the map is where a fix starts: set an anchor on the way to it (or start from a state
anchor) and try the fix as described in [Trying a Fix](Trying-a-Fix).

## Good to know

- Moves are discrete: a joystick position or a key, held for some frames. A search over
  timing, analogue paddles or random seeds is not what this is for.
- A state is reached by restoring its saved machine, never by replaying from the start,
  so the map costs about one short run per move tried.
- The key is read after each move. A condition (`goal`, `dead`) over an address outside
  the key is read at the same moment; if it can differ between visits to one state, put
  that address in the key.
- An anchor name that already belongs to something else is not overwritten by a map; the
  tool says so and asks for another `name`.
