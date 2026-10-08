from pathlib import Path

import pytest

from viewer.settings import Settings, find_opencode, load_settings


def executable(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


def test_missing_and_empty_settings_use_defaults(tmp_path):
    config = tmp_path / "settings.yaml"
    assert load_settings(config) == Settings()
    config.write_text("")
    assert load_settings(config) == Settings()


def test_default_search_uses_path_then_home(tmp_path, monkeypatch):
    binary = executable(tmp_path / "custom" / "opencode")
    monkeypatch.setattr("viewer.settings.shutil.which", lambda name: str(binary))
    assert find_opencode(None) == str(binary)
    monkeypatch.setattr("viewer.settings.shutil.which", lambda name: None)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    default = executable(tmp_path / ".opencode" / "bin" / "opencode")
    assert find_opencode(None) == str(default)


def test_configured_installation_directory_and_relative_path(tmp_path):
    binary = executable(tmp_path / "installation" / "bin" / "opencode")
    config = tmp_path / "settings.yaml"
    config.write_text("opencode_path: installation\nport: 9000\n")
    settings = load_settings(config)
    assert settings.port == 9000
    assert find_opencode(settings.opencode_path) == str(binary)
    assert find_opencode(str(binary.parent)) == str(binary)
    assert find_opencode(str(binary)) == str(binary)


def test_bad_explicit_path_never_silently_uses_another_installation(tmp_path):
    with pytest.raises(ValueError, match="not found"):
        find_opencode(str(tmp_path / "missing"))


@pytest.mark.parametrize("contents", ["[]", "unexpected: 1", "port: -1", "refresh_seconds: 0", "opencode_path: 42", "opencode_server: file:///tmp", "port: true", "host: null", "refresh_seconds: .nan", "[broken"])
def test_invalid_settings_are_actionable(tmp_path, contents):
    config = tmp_path / "settings.yaml"
    config.write_text(contents)
    with pytest.raises((TypeError, ValueError)):
        load_settings(config)
