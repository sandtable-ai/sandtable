#!/usr/bin/env bash
# The customer's discovery material, and the CLI from this checkout with the Bedrock client installed in the project,
# so nothing stops the agent from running the model-backed steps it was told it may run.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/setup.sh"
copy_discovery
install_working_copy
npm_install @anthropic-ai/bedrock-sdk
rm -f package-lock.json
