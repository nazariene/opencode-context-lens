import asyncio
import json
import sys

import pytest

from viewer.client import OpenCodeClient, OpenCodeError
from viewer.settings import Settings


def make_cli(tmp_path, body):
    binary = tmp_path / "opencode"
    binary.write_text(f"#!{sys.executable}\n{body}\n")
    binary.chmod(0o755)
    return str(binary)


def test_large_responses_use_regular_file_and_preserve_all_content(tmp_path):
    executable = make_cli(tmp_path, """import json, os, stat, sys
assert stat.S_ISREG(os.fstat(sys.stdout.fileno()).st_mode)
print(json.dumps({'data': 'x' * 1_000_000, 'args': sys.argv[1:]}))
""")
    client = OpenCodeClient(Settings(opencode_path=executable))
    response = asyncio.run(client.get("/api/session", search="text & another=value"))
    assert len(response["data"]) == 1_000_000
    assert response["args"] == ["api", "get", "/api/session?search=text+%26+another%3Dvalue"]


def test_timeout_terminates_cli(tmp_path):
    executable = make_cli(tmp_path, "import time\ntime.sleep(20)")
    client = OpenCodeClient(Settings(opencode_path=executable, request_timeout_seconds=.05))
    with pytest.raises(OpenCodeError, match="timed out"):
        asyncio.run(client.get("/api/session"))


@pytest.mark.parametrize("body", ["not json", json.dumps({"error": "missing"})])
def test_unusable_responses_are_errors(tmp_path, body):
    executable = make_cli(tmp_path, f"print({body!r})")
    client = OpenCodeClient(Settings(opencode_path=executable))
    with pytest.raises(OpenCodeError):
        asyncio.run(client.get("/api/session"))
