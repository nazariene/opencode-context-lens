import asyncio
import threading
from copy import deepcopy

import httpx
import pytest
from analysis_fixtures import MODEL, SESSION, Counter, DemoClient, demo_messages, message, tool
from fastapi.testclient import TestClient

from viewer import server
from viewer.server import build_snapshot, create_app
from viewer.settings import Settings

BASE = "/api/sessions/ses_example"


def test_revision_bound_analysis_and_preview_use_retained_snapshot_without_upstream_calls():
    source = DemoClient()
    with TestClient(create_app(Settings(refresh_seconds=0), source, Counter())) as client:
        assert client.get(BASE + "/analysis", params={"revision": "absent"}).status_code == 409
        assert source.calls == []
        context = client.get(BASE + "/context").json()
        calls = deepcopy(source.calls)
        revision = context["revision"]
        response = client.get(BASE + "/analysis", params={"revision": revision})
        analysis = response.json()
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert analysis["session_id"] == "ses_example"
        assert len(analysis["units"]) == 6
        assert "provenance" not in context and "analysis" not in context
        assert all("text" not in part for part in context["parts"])
        preview = client.post(BASE + "/cleanup-preview", json={"revision": revision, "unit_ids": ["msg_old:0"]})
        assert preview.status_code == 200 and preview.headers["cache-control"] == "no-store"
        assert preview.json()["applies_changes"] is False
        detail = client.get(BASE + "/part", params={"revision": revision, "id": "msg_old:0:result:0"})
        assert detail.status_code == 200
        assert source.calls == calls
        assert context["reported"]["input"] == 1000


@pytest.mark.parametrize("body", [
    {}, {"revision": "", "unit_ids": []}, {"revision": "r" * 129, "unit_ids": []},
    {"revision": "r", "unit_ids": [""]}, {"revision": "r", "unit_ids": [1]},
    {"revision": "r", "unit_ids": "unit"}, {"revision": 1, "unit_ids": []},
    {"revision": "r", "unit_ids": [], "apply": True},
])
def test_preview_request_shape_is_strict(body):
    with TestClient(create_app(Settings(), DemoClient(), Counter())) as client:
        response = client.post(BASE + "/cleanup-preview", json=body)
        assert response.status_code == 422
        assert isinstance(response.json()["detail"], list)


def test_route_validation_conflict_precedence_and_atomic_selection_errors():
    source = DemoClient()
    with TestClient(create_app(Settings(), source, Counter())) as client:
        for query in ({}, {"revision": ""}, {"revision": "x" * 129}):
            assert client.get(BASE + "/analysis", params=query).status_code == 422
        assert client.get("/api/sessions/invalid/analysis", params={"revision": "r"}).status_code == 400
        context = client.get(BASE + "/context").json()
        selection = {"revision": context["revision"], "unit_ids": ["msg_old:0", "msg_blocked:0", "part", "part"]}
        response = client.post(BASE + "/cleanup-preview", json=selection)
        assert response.status_code == 422
        assert response.json()["detail"]["unknown_unit_ids"] == ["part"]
        assert response.json()["detail"]["ineligible_unit_ids"] == ["msg_blocked:0"]
        response = client.post(BASE + "/cleanup-preview", json={**selection, "revision": "stale"})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "snapshot_changed"
        assert client.post("/api/sessions/invalid/cleanup-preview", json=selection).status_code == 400


def test_revision_reuse_replacement_eviction_and_analysis_failure_isolation(monkeypatch):
    source = DemoClient()
    analyzed = []
    original = server.build_analysis

    def counted(context, provenance):
        analyzed.append(context["revision"])
        return original(context, provenance)

    monkeypatch.setattr(server, "build_analysis", counted)
    with TestClient(create_app(Settings(refresh_seconds=0), source, Counter())) as client:
        context = client.get(BASE + "/context").json()
        source.messages[0]["time"]["created"] = 500
        same = client.get(BASE + "/context").json()
        assert context["revision"] == same["revision"]
        assert len(analyzed) == 1
        source.messages[-1]["content"][1]["state"]["status"] = "completed"
        changed = client.get(BASE + "/context").json()
        assert context["revision"] != changed["revision"] and len(analyzed) == 2
        assert client.get(BASE + "/analysis", params={"revision": context["revision"]}).status_code == 409
        for index in range(8):
            client.get(f"/api/sessions/ses_other{index}/context")
        assert client.get(BASE + "/analysis", params={"revision": changed["revision"]}).status_code == 409
        assert client.post(BASE + "/cleanup-preview", json={"revision": changed["revision"], "unit_ids": []}).status_code == 409
        assert client.get(BASE + "/part", params={"revision": changed["revision"], "id": "msg_old:0:call"}).status_code == 409

    def unavailable(*args):
        raise ValueError("Analysis failure")

    monkeypatch.setattr(server, "build_analysis", unavailable)
    with TestClient(create_app(Settings(), source, Counter())) as client:
        context = client.get(BASE + "/context").json()
        assert context["tokens"] > 0
        response = client.get(BASE + "/analysis", params={"revision": context["revision"]})
        assert response.status_code == 500 and response.json()["detail"]["code"] == "analysis_unavailable"
        assert client.post(BASE + "/cleanup-preview", json={"revision": context["revision"], "unit_ids": []}).status_code == 500
        assert client.get(BASE + "/part", params={"revision": context["revision"], "id": "msg_old:0:call"}).status_code == 200


def test_cache_identity_covers_capacity_and_analysis_inputs():
    first = build_snapshot(SESSION, demo_messages(), MODEL, Counter())
    same = build_snapshot(SESSION, demo_messages(), MODEL, Counter(), first)
    assert same.analysis is first.analysis
    changed = build_snapshot(SESSION, demo_messages(), {**MODEL, "limit": {"context": 200000}}, Counter(), first)
    assert changed.context["revision"] != first.context["revision"]
    assert changed.analysis is not first.analysis


def test_preview_calculation_error_is_not_zero_success(monkeypatch):
    def unavailable(*args):
        raise ValueError("Cannot calculate")

    monkeypatch.setattr(server, "preview_selection", unavailable)
    with TestClient(create_app(Settings(), DemoClient(), Counter())) as client:
        context = client.get(BASE + "/context").json()
        response = client.post(BASE + "/cleanup-preview", json={"revision": context["revision"], "unit_ids": []})
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "analysis_unavailable"


def test_large_snapshot_analysis_is_off_loop_bounded_and_reused(monkeypatch):
    text = "synthetic result " * 90
    source = DemoClient([message("assistant", f"msg_{index}", content=[
        tool(outputs=[{"type": "text", "text": text}])]) for index in range(1000)])
    assert len(text.encode()) * 1000 >= 1024 * 1024
    started, release = threading.Event(), threading.Event()
    original = server.build_analysis
    analyzed = []

    def delayed(context, provenance):
        analyzed.append(context["revision"])
        started.set()
        if not release.wait(10):
            raise TimeoutError("Analysis gate timed out")
        return original(context, provenance)

    monkeypatch.setattr(server, "build_analysis", delayed)

    async def exercise():
        app = create_app(Settings(refresh_seconds=0), source, Counter())
        async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            pending = asyncio.create_task(client.get(BASE + "/context"))
            try:
                assert await asyncio.to_thread(started.wait, 5)
                assert (await asyncio.wait_for(client.get("/api/settings"), 1)).status_code == 200
            finally:
                release.set()
            response = await pending
            assert response.status_code == 200
            context = response.json()
            assert text not in response.text and all("text" not in p for p in context["parts"])
            analysis = (await client.get(BASE + "/analysis", params={"revision": context["revision"]})).json()
            assert len(analysis["units"]) == 1000
            assert len(analysis["findings"]) == 1998
            assert (await client.get(BASE + "/context")).json()["revision"] == context["revision"]
            assert len(analyzed) == 1
            for index in range(8):
                await client.get(f"/api/sessions/ses_large{index}/context")
            assert (await client.get(BASE + "/analysis", params={"revision": context["revision"]})).status_code == 409

    asyncio.run(exercise())


def test_concurrent_replacement_cannot_mix_preview_members_and_denominator(monkeypatch):
    source = DemoClient()
    started, release = threading.Event(), threading.Event()
    original = server.preview_selection

    def delayed(*args):
        started.set()
        if not release.wait(10):
            raise TimeoutError("Preview gate timed out")
        return original(*args)

    monkeypatch.setattr(server, "preview_selection", delayed)

    async def exercise():
        app = create_app(Settings(refresh_seconds=0), source, Counter())
        async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            context = (await client.get(BASE + "/context")).json()
            pending = asyncio.create_task(client.post(BASE + "/cleanup-preview", json={
                "revision": context["revision"], "unit_ids": ["msg_old:0"]}))
            try:
                assert await asyncio.to_thread(started.wait, 5)
                source.messages.append(message("user", "msg_later", text="Additional tokens"))
                newer = (await client.get(BASE + "/context")).json()
                assert newer["tokens"] > context["tokens"]
            finally:
                release.set()
            preview = (await pending).json()
            assert preview["revision"] == context["revision"]
            assert preview["before_visible_tokens"] == context["tokens"]

    asyncio.run(exercise())
