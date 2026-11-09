import asyncio
import json
import tempfile
from urllib.parse import urlencode

from .settings import Settings, find_opencode


class OpenCodeError(Exception):
    pass


class PluginRejected(OpenCodeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class OpenCodeClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.executable = find_opencode(settings.opencode_path)
        self.slots = asyncio.Semaphore(4)

    async def get(self, path: str, **query):
        return await self.request("get", path, **query)

    async def rpc(self, directory, method, body):
        if method not in {"capabilities", "status", "generate", "generationStatus", "cancelGeneration",
                           "activate", "deactivate", "renew", "pruningInspect", "pruningPreview",
                           "pruningApply", "pruningRestore", "pruningProtect"}:
            raise ValueError("Unknown Context Lens RPC method")
        response = await self.request("post", f"/api/rpc/context-lens/{method}",
                                      body={"input": body}, envelope="output",
                                      timeout=max(self.settings.request_timeout_seconds, 125) if method == "pruningPreview" and body.get("action", "").startswith("summarize-") else None,
                                      **{"location[directory]": directory})
        return response["output"]

    async def request(self, method, path, body=None, envelope="data", timeout=None, **query):
        parameters = {key: value for key, value in query.items() if value is not None}
        if parameters:
            path += "?" + urlencode(parameters)
        command = [self.executable, "api"]
        if self.settings.opencode_server:
            command += ["--server", self.settings.opencode_server]
        command += [method, path]
        if body is not None:
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
            if len(encoded.encode()) > 65536:
                raise OpenCodeError("Control request exceeds the 64 KiB limit. Select fewer tool invocations.")
            command += ["--data", encoded]
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
                    await asyncio.wait_for(
                        process.communicate(), timeout=timeout or self.settings.request_timeout_seconds
                    )
                except (TimeoutError, asyncio.CancelledError) as error:
                    if process.returncode is None:
                        process.kill()
                    await process.communicate()
                    if isinstance(error, asyncio.CancelledError):
                        raise
                    raise OpenCodeError("OpenCode timed out. Check `opencode service status`.") from error
                output.seek(0)
                try:
                    response = await asyncio.to_thread(json.load, output)
                except (ValueError, UnicodeError) as error:
                    if process.returncode:
                        raise OpenCodeError("OpenCode API request failed. Check the configured server and plugin.") from error
                    raise OpenCodeError("OpenCode returned an invalid response. OpenCode V2 is required.") from error
                if process.returncode:
                    error = response if isinstance(response, dict) and response.get("_tag") == "RpcError" else (
                        response.get("error", {}) if isinstance(response, dict) else {})
                    data = error.get("data", {}) if isinstance(error, dict) else {}
                    if isinstance(data, dict) and isinstance(data.get("code"), str) and isinstance(data.get("message"), str):
                        raise PluginRejected(data["code"], data["message"])
                    raise OpenCodeError("OpenCode API request failed. Check the configured server and plugin.")
            if not isinstance(response, dict) or envelope not in response:
                raise OpenCodeError("OpenCode returned an unexpected response. OpenCode V2 is required.")
            return response
