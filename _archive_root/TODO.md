# TODO

The free-form backlog has been migrated. Active work and remaining
items now live in `PLAN.md` and `specs/`.

- Sprint plan and sprint status: `PLAN.md`.
- Per-feature design and acceptance criteria: `specs/*.md`.

If you are about to add a new TODO here, add it as a sprint entry in
`PLAN.md` and back it with a spec file under `specs/` instead.

## Migration Notes

Items from the previous `TODO.md`:

- Disk file-layer abstraction + custom LUT extraction → Sprint 7,
  `specs/010-disk-file-origin-custom-lut.md`.
- Headless runtime trace speed → Sprint 8,
  `specs/011-headless-trace-throughput.md`.
- Stdio-server crash surface (per-handler wrapping) → Sprint 9,
  `specs/012-server-tool-error-wrapping.md`.
- `suggest_depacker` Lykia / shared-encoding variants → Sprint 10,
  `specs/013-suggest-depacker-lykia-variants.md`.
- Lightweight 6502 sandbox tool — closed (commit 87470bd).
- Undocumented-opcode emulation in `depack_exomizer_sfx` — closed
  (commit 8f89d3b: `sandbox: complete 6502 opcode coverage`).
- `inspect_disk` cycle guard — closed (`src/disk/base.ts` keeps a
  `visited` set on directory and chain walks).
