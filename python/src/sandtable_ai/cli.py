"""`sandtable` command: runs the matching release of the Node CLI through npx."""

import os
import shutil
import subprocess
import sys

from . import NPM_VERSION

NEEDS_NODE = "sandtable needs Node.js 20 or newer (https://nodejs.org)"


def find_npx():
    """npx on PATH. On Windows, npm installs it as npx.cmd next to an extensionless shell script."""
    if os.name == "nt":
        return shutil.which("npx.cmd") or shutil.which("npx")
    return shutil.which("npx")


def command(npx, args):
    # The version is pinned exactly, so a cached copy is always the right one: --prefer-offline
    # skips the registry round trip that otherwise stalls every run without network.
    return [npx, "--yes", "--prefer-offline", f"sandtable-ai@{NPM_VERSION}", *args]


def child_env(environ):
    env = dict(environ)
    # npm reads its config from env vars case-insensitively; leave the user's setting alone.
    if not any(k.lower() == "npm_config_update_notifier" for k in env):
        env["npm_config_update_notifier"] = "false"
    return env


def exit_code(returncode):
    """A child killed by signal N reports -N; a shell reports that as 128+N."""
    return 128 - returncode if returncode < 0 else returncode


def main(argv=None):
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
    try:
        if os.name != "nt":
            # Become npx, so signals (Ctrl+C, SIGTERM from a process manager or a CI cancel)
            # and the exit code reach the CLI directly, with no launcher process in between.
            os.execve(npx, cmd, env)
        return exit_code(subprocess.call(cmd, env=env))
    except KeyboardInterrupt:
        return 130
    except OSError as err:
        sys.stderr.write(f"could not start {npx}: {err}\n{NEEDS_NODE}.\n")
        return 127


if __name__ == "__main__":
    sys.exit(main())
