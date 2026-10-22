#!/usr/bin/env bash
# The accepted domain in a project pinned to sandtable-ai 0.1.2, which has no critical tasks (#28 came later),
# while the plugin's skills under test describe a newer CLI.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy wrenfield sandtable
install_release 0.1.2
