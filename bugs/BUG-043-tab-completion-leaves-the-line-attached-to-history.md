# Bug: Tab completion leaves the line attached to history, so an arrow key silently discards your edit

- **ID:** BUG-043
- **Date:** 2026-08-14
- **Reporter:** human (mounting a series of disks from history)
- **Area:** other (cockpit TUI)
- **Severity:** high (you see one command and a different one runs — and nothing warns)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened

Mounting a series of disks by recalling the previous `/mount` and editing the number:

```
> /mount GameDisks/map_s2.d64      ← executed
> /mount GameDisks/map_s2.d64      ← executed
> /mount GameDisks/map_s2.d64      ← executed
```

while the command line read `/mount GameDisks/map_s1.d64`. The screen showed `s1`; `s2`
ran, three times in a row.

The echo in the log is the decisive detail: it prints the same string that is executed,
and it said `s2`. So the buffer really did hold `s2` while the display had `s1` — the
display and the buffer had come apart.

## Root cause

`hist_idx` marks the line as "recalled from history". **Every editing path clears it —
except completion.**

```rust
XKeyCode::Char(c)   => { cp.insert_char(c); cp.hist_idx = None; }
XKeyCode::Backspace => { cp.backspace();    cp.hist_idx = None; } // editing a recalled line detaches it
XKeyCode::Delete    => { cp.delete_at();    cp.hist_idx = None; } // editing a recalled line detaches it
XKeyCode::Tab       => { autocomplete(&mut cp, engine); }         // ← does not
```

`autocomplete` assigns `cp.input` directly and never touched `hist_idx`. So a line
recalled with Up and then Tab-completed stayed *attached*, and the next Up/Down replaced
the edited line with the history entry — silently, because a history recall is supposed to
overwrite the line.

The three comments saying "editing a recalled line detaches it" are the giveaway: the
invariant was known and written down twice, and the fourth path was added without it.

## Expected

Any path that rewrites the input line detaches it from history. What you see is what runs.

## Repro steps

1. Run several commands so there is history.
2. Press Up to recall one.
3. Press Tab (completing anything).
4. Press Up or Down.
5. The edited line is gone, replaced by a history entry — and Enter runs that.

## Resolution

- **Fix:** `autocomplete` clears `hist_idx` after rewriting the line, like the other three.
- **Gate:** `every_line_rewriting_path_detaches_from_history`, checked at the SOURCE rather
  than behaviourally. That is deliberate — the invariant breaks when someone adds the
  *next* editing verb, and a behavioural test only covers the paths that already exist. It
  pins `autocomplete` explicitly and asserts the three that were already right stay right.
- **Regression risk:** none. Tab now behaves like every other edit.

## Notes

Same shape as the day's other findings, one layer down: a rule that lives in a comment
rather than in a check holds until someone adds a path that did not read the comment.
