# Spec 886 — The auto-started runtime ends itself when nobody uses it

**Status:** PROPOSED (2026-10-02)
**Repos:** C64RE (this spec). The capability is TRX64's: **Spec 887**
(`../TRX64/docs/887-idle-exit.md`), the TRX64 half, numbered on this board.

## §1 What is wrong

The MCP server starts the runtime daemon on :4312 itself, **detached**, so that it
outlives an MCP reconnect (`spawnDaemonDetached`, Spec 744.4c). Nothing ever ends it. A
session that closes, crashes or is killed leaves its daemon running for good, holding RAM
and a core. On the owner's machine they "just stay around", one after another. There is
no shared live session to protect: whenever the human is not watching, a daemon on :4312
is leftover.

The design has never needed it to live forever. When a tool call finds no daemon, the
client starts a fresh one and waits for it (`daemon-client.ts`, the "auto-start the
daemon … then poll for it" branch). An ended daemon costs the next call a boot of a few
seconds and the machine state it had.

## §2 The rule

An **auto-started** daemon ends itself after **10 minutes idle**. Idle means all three
of the following, for the whole window:

- no client request arrived (an RPC from the MCP, the UI or anything else);
- nobody is subscribed to the A/V stream (nobody is watching);
- no trace is recording.

A daemon someone starts by hand (`npm run runtime:daemon`, `c64re ui`, `trx64-daemon`
directly) has no idle exit unless asked for one.

The LLM can say "this has to keep running": a keep-alive for N minutes, or for good. A
keep-alive lasts until it runs out or the daemon ends, and it is reported back.

## §3 Deliverables

- **D1 — the autostart asks for it.** `spawnDaemonDetached` passes `--idle-exit 600`
  (887). The value is `C64RE_RUNTIME_IDLE_EXIT` seconds, `0` = never; default 600. Both
  places that start the shared daemon do this: the MCP's eager warm-start and the lazy
  respawn. The workspace launcher's daemon does not, because the person who ran
  `c64re ui` is watching it.
- **D2 — `runtime_keep_alive`.** `{ minutes?: number, forever?: boolean }`. It calls 887's
  `daemon/keep_alive`, answers with when the daemon will end itself now ("in 42 min",
  "not on its own"), and says that the next tool call starts a fresh machine once it has
  ended. It goes on the default surface, in the playbook "machine-of-your-own" or
  "rewind-and-scrub", and in the use-case matrix.
- **D3 — status says so.** `runtime_session_status` carries 887's idle deadline: "ends
  itself after 10 min idle (in 7 min)" / "kept alive until 14:30" / "no idle exit".
- **D4 — the respawn is visible.** When a call finds the daemon gone and starts a new
  one, the tool answer says that the machine is fresh and the earlier one ended itself
  when idle. Machine state does not come back silently.
- **D5 — a test on its own port.** It starts a daemon with a 3 s idle exit and checks:
  - the daemon ends after 3 s idle;
  - a request resets the clock;
  - a keep-alive of 10 s holds it, and `forever` holds it until it is killed;
  - an MCP tool call after the daemon has exited brings up a new one.
  
  This replaces e2e-744-4c-daemon and e2e-744-4c-autostart. They test session creation
  with a disk on attach (refused since Spec 836) on the repo as a project, and are
  deleted.

## §4 Not in this spec

Sandboxes: they are private, born with a budget, and kept by a keeper since 2026-10-02.
The shared session's machine state surviving a daemon exit: a snapshot is
`runtime_checkpoint_*`'s job, and the owner is not asking for persistence across an idle
exit.

## §5 Acceptance

D5 green against a TRX64 that carries 887, the pin raised to it, and no auto-started
daemon left on this machine after a day of use.
