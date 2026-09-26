#!/usr/bin/env bash
# Backward-compatibility wrapper — the installer is now setup.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup.sh" "$@"
