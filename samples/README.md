# Samples

Disk images for headless emulator scenario testing.

**Disk images themselves are gitignored** (copyrighted material). The
local working copy holds .d64 / .g64 files; only the manifest is
tracked in version control.

## test-manifest.json

Single source of truth for Sprint 112 sample test scenarios. Smoke
scripts in `scripts/*.mjs` iterate the manifest entries. Add a new
sample by:

1. Drop the .g64 / .d64 file in this folder.
2. Add a new entry to `test-manifest.json` with:
   - `id` (kebab-case identifier)
   - `file` (filename in this folder)
   - `family` (loader family from `loaderFamilies`)
   - `expected` (one of `expectedOutcomes`)
   - `status` (`works`, `untested`, `broken-<sprint>`)
   - `purpose` (one-line note)

Entries with `status: "works"` gate the regression suite (Spec 144
TrueDrive-pure mode asserts `pureRun === true` for those). Entries
with `status: "untested"` produce reports but don't fail the run.

## Loader families

See `loaderFamilies` block in the manifest. Sprint 112 seed coverage:
- kernel-real-serial (MM s1/s2)
- system3 (motm, last ninja remix s1/s2/s3)
- epyx (impossible mission ii)
- synthetic (POLARBEAR.d64)

Pending coverage (user dropping originals from archive):
- vorpal (Bards Tale, Ultima 4/5)
- ocean (Op Wolf, Robocop)
- rainbow-arts (Turrican, Mars Cops)
- byteboozer (modern crack/demo loader)
- codemasters (Pavlodian / Time Crystal)
