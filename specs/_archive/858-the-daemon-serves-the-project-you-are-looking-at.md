# Spec 858 — The daemon serves the project you are looking at

**Status:** BUILT 2026-09-18 — D1–D5. TRX64 daemon tests + `npm run smoke:858` (13 checks). See §5.
**Repos:** TRX64 (`trx64-daemon`) builds the capability: it says which project it serves and
can be moved to another one. C64RE builds the meaning: the UI notices a mismatch and asks.
**Number:** 858 (registry: `specs/README.md`).
**Origin:** the owner, 2026-09-18, in the Ultima VI EasyFlash project: the CART `[insert ▾]`
dropdown in the Live tab was empty. Not a regression. The daemon on 4312 had been started five
days earlier with `--project …/_trial-neuromancer-rules` for an unattended run, the U6 workspace
attached to it, and `media/recent` — which by design (BUG-013) lists only media inside the
DAEMON's project — scanned the Neuromancer folder. There are no cartridges in it. Nothing
anywhere compared the two projects, so the only symptom was an empty list.

The owner's decision: the daemon is corrected, not the workspace refused — but only after a
requester says what will be lost and the human confirms. And the daemon is moved in place, not
restarted, so it does not matter who started it.

---

## §1 Where the daemon's project lives today

Nowhere it can change. Seven sites read `--project` straight out of `std::env::args()`, each
with its own copy of the fallback chain (`--project` → `C64RE_PROJECT_DIR` → sometimes cwd):
`resolve_project_dir`, `project_is_bound`, the monitor's `fs_project_dir`,
`resolve_fs_path_with_state`, `media/list_paths`, `scan_recent_media`, and
`project_knowledge::active_project_dir`. Three of them already disagree on details (whether an
empty `--project ""` counts, whether cwd is the last resort).

## §2 Deliverables

**D1 — One source.** A single resolver, `bound_project()`: a runtime override if one was set,
else `--project`, else `C64RE_PROJECT_DIR`, empty strings ignored. `active_project_dir()` adds
cwd as the last resort for the callers that resolve paths. All seven sites go through it. The
behaviour at startup is unchanged; the point is that there is now one place to change it.

**D2 — The daemon says what it serves.** `ping` returns `project` next to `version` (null when
unbound). A client that connects learns it in the handshake it already makes.

**D3 — `project/set { path, dry_run? }`.** Canonicalises `path` (must exist and be a
directory, else -32602) and compares it with the canonical current project.

- Same project: `{ changed: false }`, nothing happens.
- `dry_run: true`: `{ changed: false, same, current, requested, media }` — what the switch
  would touch: the mounted disk and cartridge paths, and `blocked`, the reason it would be
  refused, if any. (Unwritten disk changes are not reported: the switch writes them back.)
- Otherwise, in this order:
  1. refuse with the same reason `media/unmount` gives if dirty media cannot be persisted —
     nothing is changed;
  2. write the outgoing disk and cartridge back to their files, as `media/unmount` does, and
     eject both;
  3. clear what belongs to the old project's session: recent media, the scenario registry,
     candidates, media events, batches, checkpoint thumbnails, inspect evidence, the input
     journal, the recorder, the last trace/run ids, and the monitor's working directory;
  4. set the override;
  5. power-cycle (`do_power_off` + `do_power_on`: fresh chips, empty ring, discarded timeline);
  6. broadcast `project/changed { project, previous }` to every client.
  
  Returns `{ changed: true, project, previous, persisted }`.

Machine configuration that is not project state stays: machine profile and speed table, an
attached REU, trace definitions, pacing, streaming.

**D4 — C64RE: the requester.** When the Live view connects, it compares the daemon's project
(D2) with the workspace's own, through `project/set { dry_run: true }` so the comparison is
made on canonical paths by the side that owns the filesystem. On a mismatch a modal says, in
this order: which project the daemon is serving, which one this workspace is, what is mounted
and whether a switch is blocked, and that the running session there will end. Two
buttons: switch, or leave it. Switch calls `project/set`; leave keeps the UI connected and
shows a persistent banner that the daemon serves another project.

On `project/changed` every open view reloads what it derives from the daemon's project — the
media pickers above all.

**D5 — C64RE: the MCP side reports, never switches.** `runtime_session_status` includes the
daemon's project and a `projectMismatch` flag when it differs from the tool call's project. No
MCP tool calls `project/set`: moving the shared machine ends the human's session, and that
decision belongs to the requester.

## §3 Gates

- TRX64 daemon tests: `ping` carries the project; `project/set` refuses a missing path and a
  file; same-project is a no-op; `dry_run` changes nothing and reports mounted media; a real
  switch ejects media, empties `media/recent` and `media/list_paths` follows the new root, and
  `project/changed` is broadcast; refused dirty media leaves everything unchanged.
- C64RE: a smoke that drives the requester's API path against a live daemon — mismatch
  detected, switch performed, pickers reload.

## §4 Not in this spec

- Restarting the daemon process, or the workspace starting one. The owner chose in-place.
- Several projects in one daemon. One machine per process stays the contract.
- Persisting the recent-media list across daemon restarts.

## §5 As built (2026-09-18)

**TRX64** (`937b68b`). All seven sites go through `project_knowledge::bound_project()`; only the
resolver itself still reads the process arguments. `ping` carries `project`; `project/set` does
what §2 D3 says, in that order. A machine that is powered off holds its media in the session, so
`project/set` powers it on first — one path then writes back and ejects both cases. Two daemon
tests: refusal of a missing path, a file and an empty `path`; and the full move — `ping`, no-op
on the same project, a dry run that changes and ejects nothing, then a real move that ejects the
mounted disk, empties `media/recent` of the old project, moves `media/list_paths`' project root
and broadcasts `project/changed`. The full daemon suite stays green.

**The override is per thread in the unit tests**, process-wide in the daemon. The tests run in
parallel threads of one process; a test that moves the project must not move it under a
neighbour that reads `media/recent` at that moment.

**C64RE.** `ProjectMismatch` sits at the root of the workbench, so it appears whatever tab is
open. On connect it asks `project/set { dry_run }`; on a mismatch it shows the modal §2 D4
describes (runtime project, this workspace, what is mounted, what switching ends), with "Switch
to this project" and "Leave it"; "Leave it" collapses to a bar along the bottom that reopens it.
It asks again on every `project/changed`, so a workspace notices when another one moves the
daemon away. The inspector's device pickers and the Media tab's roots and recents reload on
`project/changed`. A daemon without `project/set` makes the check fail quietly — there is
nothing to compare, and no reason to block the workspace over it.

`runtime_session_status` takes an optional `project_dir` and adds a `Project:` line: agreement,
or `projectMismatch` with both paths and the sentence that moving the runtime is the UI's
decision. **The MCP's project resolution lets `C64RE_PROJECT_DIR` outrank `project_dir`** —
existing behaviour, left alone: the comparison is made for the project the MCP server is bound
to, which is the one that matters.

**`npm run smoke:858`**, 13 checks against its own sandbox daemon on port 4398 with a 90 s budget,
never the shared one: the daemon names its project, the dry run changes nothing and compares
canonical paths, the pickers show the daemon's project (the empty-dropdown situation,
reproduced), the switch moves it, broadcasts, and the pickers follow; the MCP status reports the
mismatch and does not move the daemon back.

**Not covered by a test:** the refusal on dirty media that cannot be persisted. It needs a
writable cartridge mapper without a persistence port, and there is no fixture for one; the code
path is the one `media/unmount` already uses.
