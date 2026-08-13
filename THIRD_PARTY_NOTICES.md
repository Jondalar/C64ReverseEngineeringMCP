# Third-Party Notices

## VICE

C64RE MCP contains no emulator (Spec 806, 2026-08-12) — the TypeScript headless
runtime whose portions were derived from, ported from, or validated against VICE
is deleted, and so is the vendored reSID copy that went with it. What remains
here having been READ from VICE is the monitor's verb set and expression syntax,
and the cartridge type table, whose every row cites the VICE source file it was
read from. The emulator, and the architecture references it is checked against,
live in the sibling TRX64 repo.

- Project: VICE, the Versatile Commodore Emulator
- Website: https://vice-emu.sourceforge.io/
- Source: https://sourceforge.net/projects/vice-emu/
- License: GNU General Public License, version 2 or later
- Local reference used during development: VICE 3.10 source tree

C64RE MCP is distributed under GPL-3.0-or-later. This uses VICE's
"GPL version 2 or later" permission to apply GPLv3 terms to the combined
derived work.

Thank you to the VICE project and contributors for decades of emulator
research, implementation work, and documentation.

## Commodore ROMs And Commercial Media

Commodore ROM images, commercial games, disks, cartridges, manuals, and
other copyrighted media are not covered by the C64RE MCP project license.
They must not be redistributed as part of this repository unless their
license explicitly permits it. Runtime setups should load ROMs and media
from user-provided local paths.

## Documentation References

The project may link to public technical references such as zimmers.net,
Commodore hardware documentation, and loader/game source repositories.
Links and short references do not transfer those materials into this
repository's license. If external text, tables, or code are copied into the
repository, add a specific notice here and verify license compatibility.
