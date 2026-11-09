import asyncio
from copy import deepcopy

import httpx
import pytest
from analysis_fixtures import Counter, DemoClient, message, tool
from fastapi.testclient import TestClient

from viewer.server import create_app
from viewer.settings import Settings

BASE = "/api/sessions/ses_example"


def source():
    return DemoClient([message("user", "msg_user", text="Inspect the cart"),
                       message("assistant", "msg_tools", content=[{**tool(), "id": "call_one"}])])


def test_historical_routes_are_snapshot_bound_and_read_only():
    upstream = source()
    with TestClient(create_app(Settings(refresh_seconds=0), upstream, Counter()), base_url="http://127.0.0.1:9193") as client:
        original = client.get(BASE + "/context").json()
        listing = client.get(BASE + "/history").json()
        old = listing["observations"][0]["snapshot_id"]
        upstream.messages.pop()
        client.get(BASE + "/context")
        new = client.get(BASE + "/history").json()["observations"][-1]["snapshot_id"]
        calls = deepcopy(upstream.calls)
        params = {"run_id": original["run_id"]}
        frozen = client.get(BASE + f"/history/{old}", params=params).json()
        assert len(frozen["parts"]) == 3 and all("text" not in part for part in frozen["parts"])
        detail = client.get(BASE + f"/history/{old}/part", params={**params, "id": "msg_tools:0:result:0"})
        assert detail.status_code == 200 and "cart validation" in detail.json()["text"]
        diff = client.get(BASE + "/diff", params={**params, "before": old, "after": new}).json()
        assert diff["counts"]["removed"] == 2
        assert client.get(BASE + f"/history/{old}", params={"run_id": "old_run"}).status_code == 409
        assert client.get(BASE + "/history/missing", params=params).status_code == 410
        assert client.get(BASE + "/diff", params={**params, "before": old, "after": "missing"}).status_code == 410
        assert upstream.calls == calls


def test_pin_whole_unit_reconcile_conflict_and_atomic_preview_rejection():
    upstream = source()
    with TestClient(create_app(Settings(refresh_seconds=0), upstream, Counter()), base_url="http://127.0.0.1:9193") as client:
        context = client.get(BASE + "/context").json()
        body = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0,
                "part_ids": ["msg_tools:0:result:0"]}
        pinned = client.post(BASE + "/pins", json=body).json()
        assert pinned["pin_version"] == 1 and len(pinned["pins"][0]["part_ids"]) == 2
        assert client.post(BASE + "/pins", json=body).status_code == 409
        analysis = client.get(BASE + "/analysis", params={"revision": context["revision"]}).json()
        assert analysis["units"][0]["eligible"] and analysis["units"][0]["pinned"]
        assert not analysis["units"][0]["selectable"]
        preview = client.post(BASE + "/cleanup-preview", json={"revision": context["revision"], "unit_ids": ["msg_tools:0"]})
        assert preview.status_code == 422 and preview.json()["detail"]["pinned_unit_ids"] == ["msg_tools:0"]
        upstream.messages[-1]["content"][0]["state"]["content"][0]["text"] = "changed output"
        client.get(BASE + "/context")
        assert client.get(BASE + "/pins").json()["pins"][0]["resolved"]
        for index in range(9):
            client.get(f"/api/sessions/ses_other{index}/context")
        assert len(client.get(BASE + "/pins").json()["pins"]) == 1
        upstream.messages.pop()
        client.get(BASE + "/context")
        unresolved = client.get(BASE + "/pins").json()["pins"][0]
        assert not unresolved["resolved"]
        removed = client.request("DELETE", BASE + "/pins/" + unresolved["id"],
                                 json={"run_id": context["run_id"], "pin_version": 1})
        assert removed.json()["pin_version"] == 2 and not removed.json()["pins"]


def test_pin_capacity_and_invalid_member_do_not_partially_mutate():
    app = create_app(Settings(), source(), Counter())
    app.state.pins.limit = 1
    with TestClient(app, base_url="http://127.0.0.1:9193") as client:
        context = client.get(BASE + "/context").json()
        body = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0,
                "part_ids": ["msg_user:text", "missing"]}
        assert client.post(BASE + "/pins", json=body).status_code == 422
        assert not client.get(BASE + "/pins").json()["pins"]
        body["part_ids"] = ["msg_user:text", "msg_tools:0:call"]
        assert client.post(BASE + "/pins", json=body).status_code == 429
        assert not client.get(BASE + "/pins").json()["pins"]


def test_concurrent_refresh_coalesces_without_blocking_another_session():
    async def exercise():
        upstream = source()
        original = upstream.get
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(path, **query):
            if path == "/api/session/ses_example/context":
                started.set()
                await release.wait()
            return await original(path, **query)

        upstream.get = delayed
        app = create_app(Settings(refresh_seconds=0), upstream, Counter())
        async with app.router.lifespan_context(app), httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            first = asyncio.create_task(client.get(BASE + "/context"))
            await asyncio.wait_for(started.wait(), 2)
            second = asyncio.create_task(client.get(BASE + "/context"))
            other = await asyncio.wait_for(client.get("/api/sessions/ses_other/context"), 2)
            assert other.status_code == 200
            release.set()
            assert (await first).status_code == (await second).status_code == 200
            assert sum(path == "/api/session/ses_example/context" for path, _ in upstream.calls) == 1
            assert len((await client.get(BASE + "/history")).json()["observations"]) == 1

    asyncio.run(exercise())


@pytest.mark.parametrize("setting,value", [("history_sessions", 0), ("history_max_bytes", 1),
                                          ("history_snapshots_per_session", True)])
def test_history_settings_validation(tmp_path, setting, value):
    import yaml

    from viewer.settings import load_settings
    path = tmp_path / "settings.yaml"
    path.write_text(yaml.safe_dump({setting: value}))
    with pytest.raises(ValueError, match=setting):
        load_settings(path)
