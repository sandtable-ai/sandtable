"""Offline tests for the launcher: no Node, npm or network needed."""

import json
import os
import pathlib

import pytest

from sandtable_ai import NPM_VERSION, cli

ROOT = pathlib.Path(__file__).resolve().parents[2]


def which(found):
    return lambda name: found.get(name)


class Exec(Exception):
    pass


def test_runs_the_pinned_release():
    assert cli.command("/bin/npx", ["demo", "--no-open"]) == ["/bin/npx", "--yes", f"sandtable-ai@{NPM_VERSION}", "demo", "--no-open"]


def test_pinned_release_matches_package_json():
    assert NPM_VERSION == json.loads((ROOT / "package.json").read_text())["version"]


def test_without_node_it_says_to_install_node(monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", which({}))
    assert cli.main(["--version"]) == 127
    err = capsys.readouterr().err
    assert "Node.js 22 or newer" in err and "https://nodejs.org" in err


def test_with_node_but_no_npx_it_says_to_install_npm(monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", which({"node": "/usr/bin/node"}))
    assert cli.main(["--version"]) == 127
    assert "Install npm" in capsys.readouterr().err


@pytest.mark.skipif(os.name == "nt", reason="POSIX exec path")
def test_replaces_itself_with_npx_so_signals_reach_the_cli(monkeypatch):
    calls = []

    def fake_execve(path, argv, env):
        calls.append((path, argv, env))
        raise Exec()

    monkeypatch.setattr(cli.shutil, "which", which({"node": "/n/node", "npx": "/n/npx"}))
    monkeypatch.setattr(cli.os, "execve", fake_execve)
    with pytest.raises(Exec):
        cli.main(["validate", "a b"])
    path, argv, env = calls[0]
    assert path == "/n/npx" and argv[-2:] == ["validate", "a b"]
    assert {k: env[k] for k in cli.NPM_DEFAULTS} == cli.NPM_DEFAULTS


def test_keeps_the_users_npm_settings():
    env = cli.child_env({"NPM_CONFIG_UPDATE_NOTIFIER": "true", "npm_config_fetch_retry_mintimeout": "5000"})
    assert env == {
        "NPM_CONFIG_UPDATE_NOTIFIER": "true",
        "npm_config_fetch_retry_mintimeout": "5000",
        "npm_config_fetch_retry_maxtimeout": "2000",
    }


def test_windows_runs_npx_cmd_and_returns_its_exit_code(monkeypatch):
    monkeypatch.setattr(cli.os, "name", "nt")
    monkeypatch.setattr(cli.shutil, "which", which({"node": "C:/n/node.exe", "npx.cmd": "C:/n/npx.cmd", "npx": "C:/n/npx"}))
    seen = []
    monkeypatch.setattr(cli.subprocess, "call", lambda cmd, env: seen.append(cmd) or 3)
    assert cli.main(["demo"]) == 3
    assert seen[0][0] == "C:/n/npx.cmd"


def test_a_failed_start_prints_the_install_hint_not_a_traceback(monkeypatch, capsys):
    def broken(*_args, **_kwargs):
        raise OSError(8, "Exec format error")

    monkeypatch.setattr(cli.shutil, "which", which({"node": "/n/node", "npx": "/n/npx", "npx.cmd": "/n/npx.cmd"}))
    monkeypatch.setattr(cli.os, "execve", broken)
    monkeypatch.setattr(cli.subprocess, "call", broken)
    assert cli.main(["demo"]) == 127
    err = capsys.readouterr().err
    assert "Exec format error" in err and "Node.js 22 or newer" in err


def test_the_launcher_license_is_the_projects():
    assert (ROOT / "python" / "LICENSE").read_text() == (ROOT / "LICENSE").read_text()
