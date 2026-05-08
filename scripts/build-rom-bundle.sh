#!/usr/bin/env bash
# Spec 220 — package ROMs for CI consumption.
#
# Builds resources/roms/*.bin into a base64-encoded tar.gz blob that
# fits in a GitHub Actions secret (`C64_ROM_BUNDLE_B64`).
#
# Usage:
#   scripts/build-rom-bundle.sh
# Then copy the printed value into the GitHub repo secret.

set -euo pipefail

if [ ! -d resources/roms ] || [ -z "$(ls -A resources/roms 2>/dev/null)" ]; then
  echo "resources/roms is empty — install ROMs first per project_commodore_ip memory." >&2
  exit 1
fi

cd resources/roms
tar -czf - . | base64 | tr -d '\n'
echo
