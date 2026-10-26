#!/usr/bin/env bash
# A folder that holds only the customer's discovery material: no package.json, so it isn't an npm project yet, and an
# `npm install` here would land in whatever folder above it has one.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy_discovery
