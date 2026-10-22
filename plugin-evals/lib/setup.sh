# Sourced by each case's scaffold.sh. A scaffold runs in the run's empty workspace, as you and outside the agent's
# sandbox, before Claude starts, and only with `claude plugin eval --scaffold`. It may use the network (npm).

EVALS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$EVALS/fixtures"
RUN_DIR=".sandtable/runs/2026-11-02T09-00-00-000Z-wrenfield-returns"

# One npm cache for every run, so the installs after the first are offline and fast.
export npm_config_cache="$EVALS/.cache/npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_loglevel=error

# copy <fixture> <dest>: a fixture directory's contents into the workspace.
copy() { mkdir -p "$2" && cp -R "$FIXTURES/$1/." "$2/"; }

# The discovery material a customer hands over: the OpenAPI spec, the SOP and the support chats.
copy_discovery() {
  copy discovery discovery
  cp "$FIXTURES/wrenfield/policy.md" discovery/sop.md
}

# The stored run of the accepted domain, where `sandtable run` would have written it.
copy_run() {
  mkdir -p "$RUN_DIR"
  cp "$FIXTURES/wrenfield-run/results.json" "$RUN_DIR/results.json"
}

# A Node project. The agent's sandbox can't write to its home directory, so npm and npx keep their cache and logs
# in the project.
npm_project() {
  printf '{\n  "name": "wrenfield-agent",\n  "private": true\n}\n' > package.json
  printf 'cache=%s/.npm\nlogs-dir=%s/.npm/_logs\nupdate-notifier=false\nfund=false\naudit=false\n' "$PWD" "$PWD" > .npmrc
}

# The CLI from this checkout (packed by `npm run evals:pack`), as a dev dependency, the way a project installs it
# from npm. The plugin's skills describe this version.
install_working_copy() {
  local tgz version
  tgz="$(ls -t "$EVALS"/.cache/sandtable-ai-*.tgz 2>/dev/null | head -1)"
  if [ -z "$tgz" ]; then
    echo "no packed CLI in $EVALS/.cache: run npm run evals:pack first" >&2
    exit 1
  fi
  npm_project
  npm_install "$tgz"
  version="$(node -p "require('./node_modules/sandtable-ai/package.json').version")"
  npm pkg set "devDependencies.sandtable-ai=^$version"
  rm -f package-lock.json
}

# npm_install <spec>: a dev dependency, installed even where the environment omits dev dependencies
# (NODE_ENV=production), and checked.
npm_install() {
  npm install --save-dev --include=dev "$@" >/dev/null
  if [ ! -f node_modules/sandtable-ai/package.json ]; then
    echo "npm install $* left no node_modules/sandtable-ai in $PWD" >&2
    exit 1
  fi
}

# install_release <version>: a published release from npm, for a project pinned to an older CLI than the skills.
install_release() {
  npm_project
  npm_install --save-exact "sandtable-ai@$1"
  rm -f package-lock.json
}
