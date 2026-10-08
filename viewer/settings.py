import os
import shutil
from dataclasses import dataclass, fields
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Settings:
    opencode_path: str | None = None
    opencode_server: str | None = None
    host: str = "127.0.0.1"
    port: int = 9193
    refresh_seconds: float = 5
    request_timeout_seconds: float = 30


def load_settings(path: Path) -> Settings:
    try:
        document = yaml.safe_load(path.read_text()) if path.exists() else {}
    except yaml.YAMLError as error:
        raise ValueError(f"Invalid settings YAML: {error}") from error
    if document is None:
        document = {}
    if not isinstance(document, dict):
        raise TypeError("settings.yaml must contain a mapping")
    unknown = document.keys() - {field.name for field in fields(Settings)}
    if unknown:
        raise ValueError(f"Unknown settings: {', '.join(sorted(unknown))}")
    settings = Settings(**document)
    for name in ("opencode_path", "opencode_server", "host"):
        value = getattr(settings, name)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{name} must be a string")
    if not settings.host:
        raise ValueError("host must not be empty")
    if type(settings.port) is not int or not 1 <= settings.port <= 65535:
        raise ValueError("port must be an integer between 1 and 65535")
    for name, minimum in (("refresh_seconds", 2), ("request_timeout_seconds", 1)):
        value = getattr(settings, name)
        if type(value) not in (int, float) or not minimum <= value <= 300:
            raise ValueError(f"{name} must be between {minimum} and 300")
    if settings.opencode_server and not settings.opencode_server.startswith(("http://", "https://")):
        raise ValueError("opencode_server must be an HTTP(S) URL")
    if settings.opencode_path:
        expanded = Path(os.path.expandvars(settings.opencode_path)).expanduser()
        if not expanded.is_absolute():
            expanded = path.resolve().parent / expanded
        document["opencode_path"] = str(expanded)
    return Settings(**document)


def find_opencode(configured: str | None) -> str:
    if configured:
        path = Path(configured).expanduser()
        candidates = [path / "opencode", path / "bin" / "opencode"] if path.is_dir() else [path]
    else:
        discovered = shutil.which("opencode")
        candidates = ([Path(discovered)] if discovered else []) + [Path.home() / ".opencode/bin/opencode"]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
    raise ValueError("OpenCode executable not found. Set opencode_path in settings.yaml.")
