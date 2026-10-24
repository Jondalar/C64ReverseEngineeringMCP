Welcome to the C64ReverseEngineeringMCP wiki!

We will collect small snippets and explanations of features here.

These pages are written and checked in the main repository under `docs/wiki/`,
then published here. `npm run check:wiki` proves the pages there are correct —
every spec reference exists, every tool named is a real tool, every example
parses — and also compares this published copy against them, so a page that was
edited and never published is caught instead of quietly drifting.

## Pages

- **[The Knowledge Graph](The-Knowledge-Graph)** — where a reverse-engineering
  project's facts live so the next session reads instead of re-deriving. What it
  holds, what it can answer that a listing cannot, and why the alternatives lost.

- **[Capture Scenarios](Capture-Scenarios)** — drive a C64 from a written schedule,
  get screenshots or a animated GIF. Runs on its own throwaway machine; the same
  file always produces the same bytes.
- **[Recording Scenarios](Recording-Scenarios)** — press REC in the Live tab, play,
  press stop, and the run you just did is a `.feature` file. The daemon stamps every
  input with the cycle it landed on.
- **[Trying a Fix](Trying-a-Fix)** — name the instant before a problem, write the fixes
  as files, and one scenario runs them all from there and tells you which works. The
  winner goes into your build, and the build is checked.
- **[Testing a Build](Testing-a-Build)** — one scenario per behaviour, started from a
  snapshot, the build's bytes loaded in, a verdict that fails when the build fails.
  Run the whole folder after every build.
- **[Mapping a Game](Mapping-a-Game)** — find every room or level a game has, how they
  connect, which moves crash it and the shortest way to a goal, from an anchor, with
  one call. The map is kept in the project, and the goal becomes the next anchor.
- **[Scenario Goals and Acceptance](Scenario-Goals-and-Acceptance)** — state what a
  run has to achieve, in the same `.feature` files. Partly built.
- **[Planning with Cards](Planning-with-Cards)** — agree the work packages and what
  "done" means for each, let one session hand out small closed tasks, and let the tool,
  not the worker, say whether each was kept. You are asked only where only you can judge.
