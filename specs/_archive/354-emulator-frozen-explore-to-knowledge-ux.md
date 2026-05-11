# Spec 354 — Frozen Explore to C64RE knowledge UX

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Depends:** 350, 351

## Goal

Turn the live VIC-rendered C64 screen into a reverse-engineering input
surface. When the VM is frozen, a user can select visual regions and
create structured C64RE artifacts such as logos, text blocks, sprites,
bitmaps, or charset evidence.

Explore is only active on a frozen state.

## State model

```text
running
  screen click -> keyboard focus into VM

paused/frozen
  screen click/drag -> Explore selection
  selection can create knowledge/artifacts
```

The frozen state must bind:

- cycle;
- CPU registers;
- VIC state;
- visible frame pixels;
- screen/color RAM;
- sprite state;
- current media;
- current drive state;
- runtime snapshot id if available.

## Explore toolbar

Visible only while frozen:

```text
Explore: [Select] [Logo] [Text] [Sprite] [Charset] [Bitmap]
         [Find Source Memory] [Create Artifact]
```

First pass may implement only `Select`, `Logo`, and `Create Artifact`,
but the toolbar reserves the other semantic types.

## Selection inspector

After a screen region is selected, the inspector shows:

- screen coordinates and dimensions;
- VIC mode;
- raster/cycle;
- likely screen memory address range;
- likely color RAM range;
- likely charset/bitmap/sprite memory hints;
- screenshot crop preview;
- artifact type and name fields.

## Artifact creation

Creating an artifact writes to the C64RE project data layer.

Minimum artifact fields:

```json
{
  "kind": "visual.logo",
  "name": "Title screen logo",
  "source": "runtime-explore",
  "cycle": 12345678,
  "screenRegion": { "x": 40, "y": 32, "w": 240, "h": 64 },
  "vic": { "mode": "standard-bitmap", "bank": 0 },
  "memoryHints": ["$2000-$27ff", "$d800-$dbff"],
  "media": "murder.g64",
  "snapshotId": "..."
}
```

The implementation must also store a screenshot crop asset if the
artifact store supports it.

## Knowledge policy

- Writes go to the active C64RE project root knowledge/artifact store.
- No child `knowledge/` folders may be created from UI actions.
- The UI shows the created artifact id and link/navigation target.

## Acceptance

- Pause VM and select a region on the C64 screen.
- Mark selection as `Logo`.
- Create artifact writes a visual artifact into the project store.
- Artifact includes cycle, screen region, media, VIC context, and memory
  hints where available.
- Resuming VM disables Explore overlay and restores keyboard focus mode.
