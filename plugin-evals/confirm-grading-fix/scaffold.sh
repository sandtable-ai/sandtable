#!/usr/bin/env bash
# The stored run, and the domain with the too-strict rule already made soft: a grading-only fix.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy wrenfield sandtable
perl -0pi -e 's/(  - id: account-before-order\n    description: [^\n]*\n)/$1    soft: true\n/' sandtable/sandtable.yaml
grep -q "soft: true" sandtable/sandtable.yaml
copy_run
install_working_copy
