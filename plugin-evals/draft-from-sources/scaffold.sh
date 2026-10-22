#!/usr/bin/env bash
# The customer's discovery material, and the CLI from this checkout installed in the project.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy_discovery
install_working_copy
