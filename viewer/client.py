import asyncio
import json
import tempfile
from urllib.parse import urlencode

from .settings import Settings, find_opencode


class OpenCodeError(Exception):
    pass


class OpenCodeClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.executable = find_opencode(settings.opencode_path)
        self.slots = asyncio.Semaphore(4)

    async def get(self, path: str, **query):
        parameters = {key: value for key, value in query.items() if value is not None}
        if parameters:
            path += "?" + urlencode(parameters)
        command = [self.executable, "api"]
        if self.settings.opencode_server:
            command += ["--server", self.settings.opencode_server]
        command += ["get", path]
        async with self.slots:
            # Some OpenCode builds exit before flushing large stdout pipes. A regular
            # anonymous file preserves the entire response without shell redirection.
            with tempfile.TemporaryFile() as output:
                try:
                    process = await asyncio.create_subprocess_exec(
                        *command, stdout=output, stderr=asyncio.subprocess.PIPE
                    )
                except OSError as error:
                    raise OpenCodeError("Could not run OpenCode. Check opencode_path in settings.yaml.") from error
                try:
                    _, stderr = await asyncio.wait_for(
                        process.communicate(), timeout=self.settings.request_timeout_seconds
                    )
                except (TimeoutError, asyncio.CancelledError) as error:
                    if process.returncode is None:
                        process.kill()
                    await process.communicate()
                    if isinstance(error, asyncio.CancelledError):
                        raise
                    raise OpenCodeError("OpenCode timed out. Check `opencode service status`.") from error
                if process.returncode:
                    detail = stderr.decode(errors="replace").strip()[-600:]
                    raise OpenCodeError(f"OpenCode API request failed. {detail}")
                output.seek(0)
                try:
                    response = await asyncio.to_thread(json.load, output)
                except (ValueError, UnicodeError) as error:
                    raise OpenCodeError("OpenCode returned an invalid response. OpenCode V2 is required.") from error
            if not isinstance(response, dict) or "data" not in response:
                raise OpenCodeError("OpenCode returned an unexpected response. OpenCode V2 is required.")
            return response
