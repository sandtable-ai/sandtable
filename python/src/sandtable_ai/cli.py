"""`sandtable` command: runs the matching release of the Node CLI through npx."""

import os
import shutil
import subprocess
import sys

from . import NPM_VERSION

NEEDS_NODE = "sandtable needs Node.js 20 or newer (https://nodejs.org)"

# npm settings for npx unless you set them in the environment. npm retries a failed registry request
# after 10 s and then 60 s, so a run without network stalled 70 s before npx fell back to its cache;
# a short backoff keeps the retries. Not --prefer-offline: it trusts the cached list of releases,
# which lacks a newer pinned version after you upgrade this launcher, and npx then fails (ETARGET).
NPM_DEFAULTS = {
    "npm_config_fetch_retry_mintimeout": "1000",
    "npm_config_fetch_retry_maxtimeout": "2000",
    "npm_config_update_notifier": "false",
}


def find_npx():
    """npx on PATH. On Windows, npm installs it as npx.cmd next to an extensionless shell script."""
    if os.name == "nt":
        return shutil.which("npx.cmd") or shutil.which("npx")
    return shutil.which("npx")


def command(npx, args):
    return [npx, "--yes", f"sandtable-ai@{NPM_VERSION}", *args]


def child_env(environ):
    env = dict(environ)
    # npm reads its config from env vars case-insensitively.
    yours = {k.lower() for k in env}
    for key, value in NPM_DEFAULTS.items():
        if key not in yours:
            env[key] = value
    return env


def invoked_as(argv0, environ):
    """How the user ran this launcher, so the CLI's printed hints run as written."""
    base = os.path.basename(argv0)
    if base == "__main__.py":
        return "python -m sandtable_ai"
    name = os.path.splitext(base)[0]
    # uvx runs the executable named after the package, and sets UV for what it runs.
    if name == "sandtable-ai" and "UV" in environ:
        return "uvx sandtable-ai"
    return name if name in ("sandtable", "sandtable-ai") else "sandtable"


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if shutil.which("node") is None:
        sys.stderr.write(f"{NEEDS_NODE}; `node` was not found on PATH.\n")
        return 127
    npx = find_npx()
    if npx is None:
        sys.stderr.write(
            "sandtable runs the CLI with `npx`, which ships with npm, and `npx` was not found on PATH.\n"
            "Install npm: it comes with Node.js 20 or newer from https://nodejs.org, "
            "but some Linux packages of Node.js leave it out.\n"
        )
        return 127
    cmd = command(npx, args)
    env = child_env(os.environ)
    env.setdefault("SANDTABLE_INVOKED_AS", invoked_as(sys.argv[0], os.environ))
    try:
        if os.name != "nt":
            # Become npx, so signals (Ctrl+C, SIGTERM from a process manager or a CI cancel)
            # and the exit code reach the CLI directly, with no launcher process in between.
            os.execve(npx, cmd, env)
        return subprocess.call(cmd, env=env)
    except KeyboardInterrupt:
        return 130
    except OSError as err:
        sys.stderr.write(f"could not start {npx}: {err}\n{NEEDS_NODE}.\n")
        return 127


if __name__ == "__main__":
    sys.exit(main())
