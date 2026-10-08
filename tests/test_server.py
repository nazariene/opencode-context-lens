from fastapi.testclient import TestClient

from viewer.client import OpenCodeError
from viewer.server import create_app
from viewer.settings import Settings


class Counter:
    method = "test estimate"

    def count(self, text):
        return len(text.split())


class Client:
    executable = "/example/opencode"

    def __init__(self):
        self.calls = []
        self.fail_models = False
        self.fail_context = False

    async def get(self, path, **query):
        self.calls.append((path, query))
        session = {"id": "ses_test", "title": "Demo", "model": {"id": "test", "providerID": "test"},
                   "location": {"directory": "/example"}}
        if path == "/api/session":
            return {"data": [session], "cursor": {"next": "next-cursor"}}
        if path == "/api/session/active":
            return {"data": {"ses_test": {}}}
        if path == "/api/session/ses_test":
            return {"data": session}
        if path == "/api/model":
            if self.fail_models:
                raise OpenCodeError("Models unavailable")
            return {"data": [{"id": "test", "providerID": "test", "name": "Model", "limit": {"context": 1000}}]}
        if path == "/api/session/ses_test/context":
            if self.fail_context:
                raise OpenCodeError("Service unavailable")
            return {"data": [{"id": "msg_test", "type": "user", "time": {"created": 1}, "text": "hello world"}]}
        raise AssertionError(f"Unexpected endpoint {path}")


def test_context_summary_lazy_content_cache_and_revision_safety():
    source = Client()
    with TestClient(create_app(Settings(), source, Counter())) as client:
        response = client.get("/api/sessions/ses_test/context")
        assert response.status_code == 200
        context = response.json()
        assert context["tokens"] == 2
        assert "text" not in context["parts"][0]
        assert context["parts"][0]["preview"] == "hello world"
        assert client.get("/api/sessions/ses_test/context").json()["revision"] == context["revision"]
        assert sum(path.endswith("/context") for path, _ in source.calls) == 1
        detail = client.get("/api/sessions/ses_test/part", params={"id": context["parts"][0]["id"], "revision": context["revision"]})
        assert detail.json()["text"] == "hello world"
        assert client.get("/api/sessions/ses_test/part", params={"id": "msg_test:text", "revision": "stale"}).status_code == 409
        assert client.get("/api/sessions/ses_test/part", params={"id": "missing", "revision": context["revision"]}).status_code == 404
        assert response.headers["cache-control"] == "no-store"


def test_session_switching_discovery_search_and_pagination():
    source = Client()
    with TestClient(create_app(Settings(), source, Counter())) as client:
        response = client.get("/api/sessions", params={"search": "Demo", "cursor": "cursor with spaces"}).json()
        assert response["sessions"][0]["active"] is True
        assert response["next"] == "next-cursor"
        assert ("/api/session", {"limit": 50, "search": "Demo", "cursor": "cursor with spaces"}) in source.calls
        assert client.get("/api/settings").json()["executable"] == "/example/opencode"
        assert client.get("/").status_code == 200


def test_model_failure_keeps_context_inspectable():
    source = Client()
    source.fail_models = True
    with TestClient(create_app(Settings(), source, Counter())) as client:
        context = client.get("/api/sessions/ses_test/context").json()
        assert context["tokens"] == 2
        assert context["window"] is None
        assert context["warning"]


def test_unavailable_service_and_invalid_session_are_errors_not_zero_usage():
    source = Client()
    source.fail_context = True
    with TestClient(create_app(Settings(), source, Counter())) as client:
        assert client.get("/api/sessions/ses_test/context").status_code == 502
        assert client.get("/api/sessions/not-a-session/context").status_code == 400
