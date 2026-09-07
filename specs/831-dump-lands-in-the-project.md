# Spec 831 — A dump lands in the project, and the button says so

**Status:** BUILT 2026-09-07 — `e2e:831` 35/0, hermetic, in `gates.yml`; every
other gate green. End-to-end proven without the browser: the route's absolute
path handed to the live daemon returned `fileBytes: 1471326` and the file
appeared at `Wasteland_EF/runtime/dumps/` (removed again — it was a probe).
Then seen on screen: clicking `⬇ Dump` in Safari puts
`⬇ 1455 KB · runtime/dumps/dump-…c64re` in the control bar and the file is
there. The size leads because the bar is tight — the ellipsis eats the nonce,
never the fact that it worked or where it went; the full string is the `title`.
(Three probe dumps were made in the course of that and removed again.)
**Origin:** The owner clicked `⬇ Dump` in the Live tab and asked whether it does
anything. It does — and neither answer was visible.
**Anchor:** `DOCTRINE.md` rule 6 (API first) · Spec 827 (where a capture lives,
and why a trace is the opposite case) · Spec 769.5 (the button itself)
**Touches:** `src/runtime/dump-location.ts` (new) · `src/workspace-ui/server.ts`
(one route) · `ui/src/workbench/components/MachineControls.tsx` ·
`ui/src/workbench/components/Filmstrip.tsx` ·
`scripts/e2e-831-dump-location.mjs` (new)

## 1. What happens today, measured

`⬇ Dump` calls the daemon's `snapshot/dump` with a **relative** path,
`dumps/dump-<ts>.c64re`. The workbench talks to `ws://127.0.0.1:4312` directly,
so nothing on the C64RE side sees the call, and the daemon resolves that
relative path against **its own working directory** — the tools repo.

Four `.c64re` files are sitting there right now:

```
C64ReverseEngineeringMCP/dumps/dump-1788688201142.c64re              1.4 MB  2026-09-06 11:50
C64ReverseEngineeringMCP/dumps/scrub-cp_3280224_131213-…c64re       58.1 KB  2026-07-10
C64ReverseEngineeringMCP/dumps/scrub-cp_67174_2691-…c64re           334.5 KB  2026-07-05  (×2)
```

That is Neuromancer's and Wasteland's machine state, in a directory belonging to
neither, `.gitignore`d, with nothing recording which project or session produced
it. The 2026-09-06 file is the click that prompted this spec.

Three defects, and the first is why the other two went unnoticed for two months:

1. **The button is silent in both directions.** Success is a `console.log`,
   failure a `console.error`. Without DevTools open there is no path, no size,
   no error — nothing in the DOM at all.
2. **The dump lands outside the project.** A relative path plus a daemon whose
   cwd is the tools repo.
3. **The visible effect lies.** `onSnapshotTaken()` sits outside the `try`, and
   in `Live.tsx` it grabs a screenshot — so a filmstrip frame appears whether the
   dump succeeded or threw.

## 2. Decisions

**D1 — `<project>/runtime/dumps/`, and Spec 827 does not apply here.** 827 moved
trace captures OUT of the project because a DuckDB index is large, binary and
**rewritten continuously while the trace runs**, which is the one object a sync
client can corrupt mid-write. A `.c64re` dump is the opposite: written once,
complete, then never touched again. A sync client handles that the way it handles
any other file the project contains. The dump belongs with the project it
describes — it IS project evidence — so it goes in, beside the pointer file 827
already puts at `runtime/traces.json`.

**D2 — The path is computed on the C64RE side and handed to the daemon
absolute.** The daemon has its own idea of a working directory and it is not the
project's. A relative path is the bug; the fix is not to guess better but to stop
sending one. Rule 6: the path policy is a library with its own gate
(`src/runtime/dump-location.ts`, the shape 827 established), reached through one
route, and only then used by a button.

**D3 — The button reports the path, the size, and the failure.** A durable
artifact that gives no receipt is indistinguishable from a no-op — which is
exactly the question that opened this spec. On success: the project-relative path
and the byte count. On failure: the message. In the DOM, next to the control,
not in a console.

**D4 — A failed dump takes no screenshot.** `onSnapshotTaken()` moves inside the
success path. A filmstrip frame is a claim that something was captured.

**D5 — The filmstrip's own dump gets the same treatment.** It writes
`dumps/scrub-<id>-<ts>.c64re` through the same relative path, and its label is
worth keeping: it restores the checkpoint first, so what it dumps is the frame
the user clicked, not the live machine.

**D6 — A sync warning is a note, never a refusal.** 827's `syncWarning` already
recognises OneDrive, Dropbox, iCloud, Google Drive, pCloud and Nextcloud. A
project inside one is the user's arrangement; the dump still writes, and the
answer says where it went.

## 3. Gate

`scripts/e2e-831-dump-location.mjs` (`npm run e2e:831`), hermetic — a temp
project, no daemon, no ROMs:

- the dump path is absolute, under `<project>/runtime/dumps`, and ends `.c64re`;
- the project-relative form is what the UI shows, and it never starts with `..`;
- two dumps in the same millisecond do not collide;
- a label with a slash or a space cannot escape the directory;
- `ensureDumpDir` creates `runtime/dumps` and is idempotent;
- the route returns the same path the library computes, and creates the
  directory before answering;
- the UI sends an ABSOLUTE path — asserted against `MachineControls.tsx` and
  `Filmstrip.tsx`, because a relative one is the defect;
- both call sites render the result, and `onSnapshotTaken` is inside the
  success path.

## 4. Acceptance

- Clicking `⬇ Dump` writes `<project>/runtime/dumps/dump-<ts>.c64re` and the
  control says so, with the size.
- A failure says why, in the UI, and no filmstrip frame appears.
- `e2e:831` green, in `gates.yml`; every other gate still green.

## 4b. One thing worth knowing

A project's own `.gitignore` typically carries `/runtime/` — Wasteland_EF's does.
So a dump is still not committed, which is right: it is machine state, not
source. What changed is that it now sits in the project it describes, next to
`runtime/traces.json`, where a human looking for "what state did I capture on
this project" will actually look.

## 5. Non-goals

- Registering the dump as an artifact with lineage. It should be one — it is
  project evidence with a provenance — but that is the artifact model's door
  (`save_artifact` / the graph), not a button's, and it needs its own decision
  about what a machine-state artifact IS. Recorded here, not built here.
- Moving the four stray files out of the tools repo. They are somebody's state
  from July and September and it is not mine to decide what they were for.
- Any change to the daemon. The path policy is entirely on this side.
