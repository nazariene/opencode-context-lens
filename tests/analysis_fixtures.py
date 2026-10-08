"""Fictional sessions shared by semantic, API, and browser checks."""
from copy import deepcopy

SESSION = {"id": "ses_example", "title": "Review checkout validation",
           "model": {"id": "example", "providerID": "demo"}, "location": {"directory": "/workspace/storefront"}}
MODEL = {"id": "example", "providerID": "demo", "name": "Example model", "limit": {"context": 100000}}


class Counter:
    method = "test word estimate"

    def count(self, text):
        return len(text.split())


def message(kind, id, **fields):
    return {"id": id, "type": kind, "time": {"created": 1}, **fields}


def tool(name="read", input=None, outputs=None, status="completed", **state):
    return {"type": "tool", "name": name, "state": {
        "status": status, "input": {"path": "src/cart.py"} if input is None else input,
        "content": [{"type": "text", "text": "cart validation " * 40}] if outputs is None else outputs, **state,
    }}


def demo_messages():
    return [
        message("compaction", "msg_checkpoint", status="completed", summary="Retain checkout API compatibility."),
        message("user", "msg_user", text="Review checkout validation.",
                files=[{"name": "cart.png", "mime": "image/png", "data": "private-base64"}]),
        message("assistant", "msg_old", content=[tool()]),
        message("assistant", "msg_new", content=[tool(), tool("shell", {"command": "pytest"},
                [{"type": "text", "text": "Passing checkout test\n" * 1500}])],
                model=SESSION["model"], time={"created": 2, "completed": 3},
                tokens={"input": 200, "cache": {"read": 800}, "output": 20}),
        message("assistant", "msg_blocked", content=[
            tool(outputs=[{"type": "file", "name": "cart.png", "data": "private-base64"}]),
            tool("shell", {"command": "pytest"}, [], "running"),
            tool("skill", {"id": "testing-guide"}),
        ]),
    ]


class DemoClient:
    executable = "/example/opencode"

    def __init__(self, messages=None):
        self.messages = demo_messages() if messages is None else messages
        self.calls = []
        self.model = deepcopy(MODEL)

    async def get(self, path, **query):
        self.calls.append((path, query))
        if path == "/api/session":
            return {"data": [SESSION, {**SESSION, "id": "ses_other", "title": "Review catalog filters"}], "cursor": {}}
        if path == "/api/session/active":
            return {"data": {}}
        if path == "/api/model":
            return {"data": [deepcopy(self.model)]}
        if path.endswith("/context"):
            return {"data": deepcopy(self.messages)}
        if path.startswith("/api/session/"):
            return {"data": {**deepcopy(SESSION), "id": path.rsplit("/", 1)[-1]}}
        raise AssertionError(f"Unexpected endpoint {path}")
