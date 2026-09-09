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
  (Specs 817–826)

- **[Capture Scenarios](Capture-Scenarios)** — drive a C64 from a written schedule,
  get screenshots or a animated GIF. Runs on its own throwaway machine; the same
  file always produces the same bytes. (Spec 812)
- **[Recording Scenarios](Recording-Scenarios)** — press REC in the Live tab, play,
  press stop, and the run you just did is a `.feature` file. The daemon stamps every
  input with the cycle it landed on. (Spec 814)
- **[Scenario Goals and Acceptance](Scenario-Goals-and-Acceptance)** — state what a
  run has to achieve, in the same `.feature` files. Partly built. (Spec 810)
