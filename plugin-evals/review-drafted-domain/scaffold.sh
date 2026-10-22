#!/usr/bin/env bash
# A domain as `sandtable init` drafted it, with planted problems, next to the sources it was drafted from.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy drafted sandtable
copy_discovery
install_working_copy
