# Spec 265 — Media selector + multi-disk + cartridge

**Sprint:** 138
**Status:** PROPOSED 2026-05-09
**Master:** 260
**Parallel-eligible with:** 264

## Goal

UI panel for browsing + mounting media (.d64 / .g64 / .crt /
.prg / .vsf). Server-side filesystem browse. Multi-disk swap +
cartridge auto-detect. Tape deferred to V3.1.

## Browse

Server-side fs roots (configurable):
- `samples/` (vendored disks)
- `$C64RE_PROJECT_DIR` (current project)
- `~/Downloads`
- User-added paths (saved in `~/.config/c64re/media-roots.json`)

Filter: `.d64 .g64 .crt .prg .vsf .t64* .tap*` (* = grayed out
"V3.1")

Recent files: last 10 mounted, quick-pick.

## Mount

Drive 8: primary disk. Mount via `headless_integrated_session_*`
or new `runtime_media_mount`.

Multi-disk: Drive 8 has slot for current disk + "swap to" list
of next disks. UI button "Eject + Mount Side B" → unmount,
mount, no reset (= resume game).

Cartridge: `.crt` auto-detects mapper type via Spec 087/127
(easyflash/megabyter/magicdesk/ocean/normal_8k/normal_16k/ultimax).
UI shows detected mapper + "force type" override.

VSF: snapshot file mount via `runtime_load_vsf` (= jumps to
saved state).

## MCP tools

- `runtime_media_list_paths` — current fs roots
- `runtime_media_browse <path>` — list dir contents (filtered)
- `runtime_media_mount <slot> <path>` — drive 8/9 attach
- `runtime_media_unmount <slot>`
- `runtime_media_swap <slot> <next-path>` — convenience for multi-disk

## Acceptance

- Browse `samples/` shows vendored disks
- Mount motm.g64 → boots
- Mount MM s1, then swap to s2 mid-game → game continues
- Mount Action Replay 5 .crt → cartridge mapper detected
- Recent-files quickpick works across sessions
