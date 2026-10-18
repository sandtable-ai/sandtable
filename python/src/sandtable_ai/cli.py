"""`sandtable` command: runs the matching release of the Node CLI through npx."""

import shutil
import subprocess
import sys

from . import NPM_VERSION


def main() -> int:
    npx = shutil.which("npx")
    if npx is None:
        sys.stderr.write("sandtable needs Node.js 22.18 or newer (https://nodejs.org); `npx` was not found on PATH.\n")
        return 127
    cmd = [npx, "--yes", f"sandtable-ai@{NPM_VERSION}", *sys.argv[1:]]
    try:
        return subprocess.call(cmd)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
