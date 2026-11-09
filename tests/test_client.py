import asyncio
import json
import sys

import pytest

from viewer.client import OpenCodeClient, OpenCodeError, PluginRejected
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


def test_location_rpc_output_envelope_server_routing_and_body_bound(tmp_path):
    executable = make_cli(tmp_path, """import json, sys
print(json.dumps({'output': {'args': sys.argv[1:], 'large': 'x' * 1_000_000}}))
""")
    client = OpenCodeClient(Settings(opencode_path=executable, opencode_server="http://fixture:1234"))
    result = asyncio.run(client.rpc("/workspace/a & b", "activate", {"value": "café"}))
    assert len(result["large"]) == 1_000_000
    assert result["args"][:4] == ["api", "--server", "http://fixture:1234", "post"]
    assert "location%5Bdirectory%5D=%2Fworkspace%2Fa+%26+b" in result["args"][4]
    assert json.loads(result["args"][-1]) == {"input": {"value": "café"}}
    with pytest.raises(OpenCodeError, match="64 KiB"):
        asyncio.run(client.rpc("/workspace", "activate", {"text": "😀" * 17000}))


def test_rpc_declared_errors_preserve_code_without_logging_bodies(tmp_path):
    executable = make_cli(tmp_path, """import json, sys
print(json.dumps({'_tag': 'RpcError', 'type': 'rejected', 'message': 'Source changed',
                  'data': {'code': 'source_changed', 'message': 'Source changed'}}))
sys.exit(1)
""")
    client = OpenCodeClient(Settings(opencode_path=executable))
    with pytest.raises(PluginRejected) as error:
        asyncio.run(client.rpc("/workspace", "activate", {}))
    assert error.value.code == "source_changed"


def test_subprocess_concurrency_and_cancellation(tmp_path):
    import os

    counts = tmp_path / "counts.json"
    counts.write_text('[0,0]')
    executable = make_cli(tmp_path, f"""import fcntl, json, time
path = {str(counts)!r}
def change(delta):
    with open(path, 'r+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        active, maximum = json.load(f)
        active += delta
        f.seek(0); f.truncate(); json.dump([active, max(maximum,active)], f)
change(1)
time.sleep(.08)
change(-1)
print('{{"data":true}}')
""")
    async def concurrent():
        client = OpenCodeClient(Settings(opencode_path=executable))
        return await asyncio.gather(*(client.get("/api/session") for _ in range(12)))
    assert len(asyncio.run(concurrent())) == 12
    assert json.loads(counts.read_text()) == [0, 4]
    pid_path = tmp_path / "pid"
    executable = make_cli(tmp_path, f"import os, pathlib, time\npathlib.Path({str(pid_path)!r}).write_text(str(os.getpid()))\ntime.sleep(20)")
    async def cancel():
        client = OpenCodeClient(Settings(opencode_path=executable))
        task = asyncio.create_task(client.get("/api/session"))
        async with asyncio.timeout(2):
            while not pid_path.exists():
                await asyncio.sleep(.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(cancel())
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_path.read_text()), 0)
