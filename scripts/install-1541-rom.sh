#!/usr/bin/env bash
# Install the 1541 DOS ROM (Spec 062 Q1.α: bundle dos1541 directly).
#
# Usage:
#   ./scripts/install-1541-rom.sh [<source-rom-path>]
#
# If <source-rom-path> is omitted, looks for VICE's bundled copy at
# the standard checkout location used by this project.
#
# The 1541 DOS ROM is Commodore IP. This project ships the bundled
# binary under the same precedent as VICE / Gideon's 1541ultimate
# (~30 years tolerance, no enforcement). Users who prefer to avoid
# this can:
#   (a) skip this script — Sprint 60 synthetic tests work without ROM
#   (b) build mist64/dos1541 from source (cc65) and pass that as the
#       source path (output is byte-identical except for checksum)
#   (c) point C64RE_1541_ROM_PATH at a user-supplied dump
#
# The bundled file lives at:
#   resources/roms/dos1541-325302-01+901229-05.bin
# and is gitignored to keep the repo binary-blob-free.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_DIR="${REPO_ROOT}/resources/roms"
DEST_FILE="${DEST_DIR}/dos1541-325302-01+901229-05.bin"
EXPECTED_SIZE=16384

SOURCE="${1:-/Users/alex/Development/C64/Tools/vice/vice/data/DRIVES/dos1541-325302-01+901229-05.bin}"

if [[ ! -f "${SOURCE}" ]]; then
  echo "Source ROM not found at: ${SOURCE}" >&2
  echo "Supply a path explicitly: $0 <path-to-rom>" >&2
  exit 1
fi

actual_size=$(stat -f%z "${SOURCE}" 2>/dev/null || stat -c%s "${SOURCE}")
if [[ "${actual_size}" != "${EXPECTED_SIZE}" ]]; then
  echo "ROM at ${SOURCE} is ${actual_size} bytes; expected ${EXPECTED_SIZE}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
cp "${SOURCE}" "${DEST_FILE}"
echo "Installed: ${DEST_FILE} (${actual_size} bytes)"
