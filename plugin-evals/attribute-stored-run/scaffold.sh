#!/usr/bin/env bash
# The accepted domain and a stored run of it with three failed tasks, each with a different owner.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy wrenfield sandtable
copy_run
install_working_copy
